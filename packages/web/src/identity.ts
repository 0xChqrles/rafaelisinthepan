// This device's identity (#216): a REVOCABLE token it holds, and the account the SERVER
// assigned it.
//
// Until #216 the identity WAS a 128-bit secret (#187) that every device on an account
// shared, so there was nothing device-specific to revoke: someone with your key could only
// be shut out by abandoning the account — losing the archive, the streak and every friend.
// A device now holds its own token; the server can delete that token's row without this
// device being present, and the account survives.
//
// **The identity is created on the DEPLOY BUTTONS alone — never on a page load, never as
// a side effect** (#216 trigger rework, user-decided 2026-08-24, narrowing the original
// lazy-on-first-need list). Creating on load would make account creation an
// unauthenticated write that every crawler triggers; creating inside an engine made it a
// side effect nobody saw. A visit that taps none of these primary buttons mints no token
// and no server row:
//
//   the sentence gate's PLAY · Word mode's PLAY · accepting an invite (its button) ·
//   sending an invite link · saving a profile
//
// Each is a SINGLE tap that chains its real action behind the bootstrap, shows a loading
// state on the button, and reports failure on the app's error surface (ErrorSheet).
// Surfaces that used to mint by being opened — the leaderboard, the profile editor — show
// the LOCAL placeholder identity instead (the persisted seed in the game store).
//
// Turnstile gates the bootstrap, because that is the request that CREATES state. The token
// is generated and PERSISTED immediately before it, so a lost answer is recovered by
// retrying: the bootstrap is idempotent by token hash and returns the identity it already
// created rather than minting a second one.
//
// **No token means no private fetch.** A puzzle, a calendar or a language summary with no
// local identity KNOWS the player's server state is empty; it must not call `/round` or the
// private history routes merely to learn that. `deviceIdentity()` returning null is exactly
// that signal, and the callers branch on it.
//
// Minting uses `crypto.getRandomValues`, which every context has — where #187 derived the
// account id with `crypto.subtle`, which is absent outside a secure context (the LAN-IP
// mobile check). That removes the derivation from the ANONYMOUS paths that used to need it:
// the global board's own-window `id` and the leaderboard's identity strip, which each carried
// their own try/catch for exactly this. It does NOT make an insecure context playable — every
// live POST still signs its body with `crypto.subtle` for the OAC contract (`api.ts`
// `postSignedJson`), so a bootstrap there fails before its fetch. That boundary is older than
// #216 and unchanged by it.
//
// **localStorage is shared by every TAB of this origin**, so this module's copy is a CACHE of
// it, never the authority: it re-reads before minting, adopts what another tab wrote, and
// only ever removes the entry it can still recognise as its own.

import { create } from 'zustand';
import { generateDeviceToken, isValidDeviceToken, PUBLIC_ID_PATTERN } from '@whippin/shared';
import { devicesUrl, parseDeviceIdentity, postDevicesBody } from './api';
import { turnstileToken } from './turnstile';

export interface DeviceIdentity {
  // What travels in every authenticated body. Never displayed, never logged.
  token: string;
  // What the SERVER assigned: the account every stored row is keyed by, and what the
  // pseudonym and the mark are derived from (`@whippin/shared` assigned.ts).
  accountId: string;
  // This device's handle on the sign-out screen. It authenticates nothing.
  deviceId: string;
}

const STORAGE_KEY = 'whippin-device';

interface IdentityState {
  // The bootstrapped identity, or null when this device has none yet.
  identity: DeviceIdentity | null;
  // The server answered `unknown_device`: this device was signed out from elsewhere. It is
  // a SCREEN, not a retry — see `state/signedOut` in the web AGENTS.
  signedOut: boolean;
  // Changes on every identity-scope transition except the FIRST acquisition. App keys every
  // identity-owned screen on it, so component-local caches are discarded on sign-out/account
  // swap and remounted when a replacement arrives, while the first bootstrap (which is
  // triggered by the state already on screen) stays mounted.
  scopeRevision: number;
}

export const useIdentityStore = create<IdentityState>(() => ({
  identity: null,
  signedOut: false,
  scopeRevision: 0,
}));

// One origin-wide critical section around the entire read -> mint -> bootstrap -> commit
// sequence. localStorage has no compare-and-swap: two tabs can both read EMPTY before
// either writes its pending token, and would then create two accounts. Web Locks is the
// browser primitive that makes that sequence exclusive across tabs and workers.
export const DEVICE_BOOTSTRAP_LOCK = 'whippin-device-bootstrap';

// A token that has been minted but whose bootstrap has not answered. It is persisted BEFORE
// the request so a committed-but-lost bootstrap can be retried onto the same identity; it is
// deliberately NOT an identity, because until the answer lands this device does not know
// which account it holds. An account behind that token is provably empty only while it is
// THIS session's own mint AND no attempt for it has failed out of this tab's hands — the
// `pendingUnproven` rule below; a recovered or once-released token proves nothing.
let pendingToken: string | null = null;

// Whether the pending token's account can still be PROVEN EMPTY (PR-219 round-2 and
// round-3 reviews). A token this session minted, whose bootstrap has not yet been let out
// of this tab's hands, fronts an empty account by construction — the act that asked waits
// on the answer. The proof dies two ways:
//   - the token was ADOPTED from storage: it may be the residue of a bootstrap whose
//     ANSWER arrived and whose acts ran, with only the completed identity's write failing
//     behind it (a session-only identity leaves exactly this);
//   - a bootstrap ATTEMPT for it FAILED after the token was persisted: the flight and the
//     Web Lock release, and another tab or session can recover the SAME token, complete
//     the bootstrap and act on the account before this tab's retry.
// An unproven token's eventual bootstrap publishes as an ADOPTION — the scope owner
// re-reads the tokenless projections — never as a fresh mint. Conservative on purpose: a
// truly empty account merely re-reads empty answers.
let pendingUnproven = false;

// The completed identity could not be persisted. A later readable EMPTY value cannot then
// mean "another tab removed it": it may simply be the result of our own failed write. Keep
// the live identity until this tab deliberately leaves it. This knowingly gives up the
// cross-tab removal signal for that session-only identity.
let sessionOnly = false;

// A token this tab has AUTHORITATIVELY left. Conditional removal can fail (blocked or
// throwing storage), but that must not make the next `ensure` re-adopt the revoked value
// that is still readable from the shared key. Keep the fence in memory until a different
// stored identity proves that the origin has moved on. It also protects a replacement
// identity whose own completed write had to fall back to `sessionOnly`.
const departedTokens = new Set<string>();

// A tombstone this tab deliberately DISMISSED (START FRESH) but could not remove —
// unwritable storage. Without this fence the next sync would re-adopt the verdict it can
// still read and SKIP would loop forever; with it, the still-readable tombstone reads as
// emptiness for this session (the departedTokens shape, for the tombstone).
let dismissedTombstone: SignedOutTombstone | null = null;

function defaultStorage(): Storage | null {
  // The `localStorage` PROPERTY itself throws a SecurityError when storage is disabled
  // (blocked cookies, some private modes), so the read needs its own catch or every
  // authenticated call would fail instead of degrading to a session-lived identity.
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

let storage: Storage | null | undefined;
function store(): Storage | null {
  storage ??= defaultStorage();
  return storage;
}

// The persisted SIGNED-OUT verdict (#216, user-decided 2026-08-24 on the PR-219
// follow-up review): the shared key holds this TOMBSTONE instead of the removed identity,
// so the verdict survives a reload and reaches sibling tabs through the same storage
// channel everything else does. It names WHICH identity was signed out — the two PUBLIC
// ids, never a token, so it authenticates nothing — which is what lets a tab holding a
// DIFFERENT identity ignore it. It stands until the player chooses: START FRESH removes
// it (a #204 reconnect will too), and until then no ordinary act may mint a replacement
// account through it (`bootstrap` fails closed on `signedOut`).
interface SignedOutTombstone {
  accountId: string;
  deviceId: string;
}

// What the shared key says — and, first, whether it can be read at all. The two are
// DIFFERENT answers: an unreadable storage (blocked cookies, a private mode that throws)
// says NOTHING about this device's identity, while a readable empty one says there is none.
// Collapsing them would let a denied storage drop an identity this session is already
// playing on. `signedOut` is the third readable state: not an identity and not emptiness,
// but the recorded verdict that one was signed out (exclusive with the other two fields).
type StoredRead =
  | { available: false }
  | {
      available: true;
      token: string | null;
      identity: DeviceIdentity | null;
      signedOut: SignedOutTombstone | null;
    };

const UNAVAILABLE: StoredRead = { available: false };
const EMPTY: StoredRead = { available: true, token: null, identity: null, signedOut: null };

function publicIdPair(value: Record<string, unknown>): SignedOutTombstone | null {
  const { accountId, deviceId } = value;
  const complete =
    typeof accountId === 'string' &&
    PUBLIC_ID_PATTERN.test(accountId) &&
    typeof deviceId === 'string' &&
    PUBLIC_ID_PATTERN.test(deviceId);
  return complete ? { accountId: accountId as string, deviceId: deviceId as string } : null;
}

function readStored(): StoredRead {
  let raw: string | null;
  try {
    const held = store();
    if (!held) return UNAVAILABLE;
    raw = held.getItem(STORAGE_KEY);
  } catch {
    return UNAVAILABLE;
  }
  if (!raw) return EMPTY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY;
  const value = parsed as Record<string, unknown>;
  if (value.signedOut === true) {
    // The tombstone. A malformed one follows the corrupted-value rule below: it can fence
    // nothing it cannot name, so it reads as no value at all.
    const tombstone = publicIdPair(value);
    return tombstone ? { available: true, token: null, identity: null, signedOut: tombstone } : EMPTY;
  }
  const { token } = value;
  // A corrupted value is no identity at all — better to mint a fresh one than to send
  // garbage the server would refuse on every call forever.
  if (!isValidDeviceToken(token)) return EMPTY;
  const ids = publicIdPair(value);
  return {
    available: true,
    token,
    identity: ids ? { token, ...ids } : null,
    signedOut: null,
  };
}

function write(
  value: { token: string } | DeviceIdentity | ({ signedOut: true } & SignedOutTombstone),
): boolean {
  try {
    const held = store();
    if (!held) return false;
    held.setItem(STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// Remove the shared entry, but only while it is still the one we are leaving. Another TAB
// may have written a newer identity into it since — and deleting THAT would orphan the
// account that tab is playing on, which is the one thing a sign-out here may not do.
function clearStored(expected: string | null): void {
  // No token means this tab cannot prove the shared entry is its own. This is especially
  // important for SKIP after the signed-out screen: `markDeviceSignedOut` already replaced
  // the revoked token conditionally, and another tab may have installed a fresh identity
  // since. An unconditional second removal would delete that newer account.
  if (expected === null) return;
  try {
    const stored = readStored();
    // If the key cannot be read, it cannot be proved to still name `expected`. A blind
    // remove here would turn denied storage into permission to delete another tab's B.
    if (!stored.available) return;
    if (stored.token !== null && stored.token !== expected) return;
    store()?.removeItem(STORAGE_KEY);
  } catch {
    // Unreadable or unwritable storage: nothing to remove.
  }
}

// Replace the stored identity with its signed-out TOMBSTONE — under the same proof of
// ownership as `clearStored`: only while the shared key still holds the token being signed
// out (an existing tombstone, which holds none, may be replaced — both say "signed out").
// A write that cannot happen leaves the verdict in-memory only, exactly as before.
function installTombstone(expected: string, identity: SignedOutTombstone): void {
  try {
    const stored = readStored();
    if (!stored.available) return;
    if (stored.token !== null && stored.token !== expected) return;
    write({ signedOut: true, accountId: identity.accountId, deviceId: identity.deviceId });
  } catch {
    // Unreadable or unwritable storage: the in-memory fence still stands for this tab.
  }
}

// START FRESH's other half: the tombstone holds no token, so `clearStored`'s proof of
// ownership can never remove it. Removing it unconditionally is safe BECAUSE it
// authenticates nothing — and START FRESH is exactly the choice it exists to wait for.
function removeTombstone(): void {
  try {
    const stored = readStored();
    if (!stored.available || stored.signedOut === null) return;
    store()?.removeItem(STORAGE_KEY);
  } catch {
    // Unwritable storage: the next load reads the tombstone again, and SKIP re-offers.
  }
}

// The epoch every private request is fenced against: WHO this device is acting as right
// now. An answer that lands after the tuple has changed describes an identity that is no
// longer ours, and applying it would repopulate the new identity with the old one's state.
export function identityEpoch(): string | null {
  const identity = useIdentityStore.getState().identity;
  return identity ? identityEpochOf(identity) : null;
}

// Capture the epoch FROM THE IDENTITY USED TO BUILD A REQUEST. Reading the store again
// after `ensureDeviceIdentity()` would leave a tiny but real race: a storage event could
// replace A with B between those two lines, causing A's request to be fenced as B's.
export function identityEpochOf(identity: Pick<DeviceIdentity, 'accountId' | 'deviceId'>): string {
  return `${identity.accountId}:${identity.deviceId}`;
}

// The identity this device holds RIGHT NOW, or null when it has none. Synchronous by
// design: it is the "should I even ask the server?" test every private read makes.
export function deviceIdentity(): DeviceIdentity | null {
  return useIdentityStore.getState().identity;
}

export function useDeviceIdentity(): DeviceIdentity | null {
  return useIdentityStore((state) => state.identity);
}

export function useSignedOut(): boolean {
  return useIdentityStore((state) => state.signedOut);
}

export function identityScopeRevision(): number {
  return useIdentityStore.getState().scopeRevision;
}

export function useIdentityScopeRevision(): number {
  return useIdentityStore((state) => state.scopeRevision);
}

// What the identity OWNS, cleared whenever it changes. Registered by the modules that hold
// it (the round engines, the history cache) rather than imported here, so this module keeps
// knowing nothing about the game.
//
// The change carries its PREVIOUS value, because acquiring a first identity and leaving one
// are not the same event: a bootstrap is triggered BY a deploy button (a PLAY, an invite,
// a save), so clearing on it would destroy the very thing that asked for it.
export interface IdentityChange {
  previous: DeviceIdentity | null;
  next: DeviceIdentity | null;
  accountChanged: boolean;
  deviceChanged: boolean;
  // A FIRST acquisition that ADOPTED an identity another tab created (a storage event, the
  // pre-mint re-read, losing the bootstrap race), as opposed to committing one this tab's
  // own bootstrap just minted. The minted account is empty BY CONSTRUCTION, so everything
  // published as known-empty while tokenless stays true; an adopted one may already hold
  // rounds and history, so those tokenless projections must be re-read (identityScope's
  // re-arm) — without clearing anything, since there was no previous owner to leave.
  adopted: boolean;
}
type Listener = (change: IdentityChange) => void;
const listeners = new Set<Listener>();

export function onIdentityChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(next: DeviceIdentity | null, signedOut = false, minted = false): void {
  const current = useIdentityStore.getState();
  const previous = current.identity;
  const accountChanged = (previous?.accountId ?? null) !== (next?.accountId ?? null);
  const deviceChanged = (previous?.deviceId ?? null) !== (next?.deviceId ?? null);
  const changed = accountChanged || deviceChanged;
  // Only the bootstrap's own commit passes `minted`; every other null -> identity publish
  // is an ADOPTION of an account that may already hold server state (see IdentityChange).
  const adopted = previous === null && next !== null && !minted;
  // A -> null -> B is two real UI scopes. The first transition clears/remounts away from A;
  // the second must mount B's private reads instead of leaving the tokenless projection that
  // existed between storage events. Only null -> A at revision zero is the first-bootstrap
  // exception: the act already on screen must survive it.
  const firstAcquisition = previous === null && next !== null && current.scopeRevision === 0;
  useIdentityStore.setState({
    identity: next,
    signedOut,
    scopeRevision:
      changed && !firstAcquisition ? current.scopeRevision + 1 : current.scopeRevision,
  });
  if (!changed) return;
  // Clearing storage WITHOUT fencing in-flight answers would let the identity just left
  // repopulate the one that replaced it, which is why every private request captures the
  // epoch above and drops an answer that outlived it.
  for (const listener of listeners)
    listener({ previous, next, accountChanged, deviceChanged, adopted });
}

// Re-read the shared key and adopt what it says. Called before every mint and on every
// `storage` event, because another TAB may have bootstrapped, signed out or started fresh
// since this module last looked — and this module's copy is a cache of that key, not the
// authority.
function syncFromStorage(): DeviceIdentity | null {
  const stored = readStored();
  const held = useIdentityStore.getState().identity;
  // Storage that cannot be READ is not storage that is empty. There, this session's
  // in-memory identity is all there is, and it stands.
  if (!stored.available) return held;
  // The persisted signed-out verdict, from another tab or an earlier session of this one.
  // It names the identity it fences by PUBLIC ids, so a tab holding a DIFFERENT identity
  // ignores it (that identity may overwrite it when it next persists); a tab holding the
  // named one — or none at all — adopts the signed-out SCREEN, never ordinary emptiness:
  // the whole point of the tombstone is that reloading, and every sibling tab, keep the
  // explanation instead of silently becoming a brand-new visitor.
  if (stored.signedOut !== null) {
    const tombstone = stored.signedOut;
    const dismissed =
      dismissedTombstone !== null &&
      dismissedTombstone.accountId === tombstone.accountId &&
      dismissedTombstone.deviceId === tombstone.deviceId;
    if (!dismissed) {
      if (
        held !== null &&
        (held.accountId !== tombstone.accountId || held.deviceId !== tombstone.deviceId)
      ) {
        return held;
      }
      // Fence the held token too: the server's verdict reached this tab through storage
      // rather than through its own refused call, and re-adopting that token later would
      // resurrect an identity the server already rejected.
      if (held !== null) departedTokens.add(held.token);
      sessionOnly = false;
      pendingToken = null;
      pendingUnproven = false;
      flight = null;
      publish(null, true);
      return null;
    }
    // Dismissed and unremovable: this tab already chose START FRESH, so the verdict it
    // can still read counts as emptiness for the rest of this session.
  }
  // A failed remove may leave the revoked token perfectly readable. It is no longer an
  // identity merely because localStorage still says so: the authoritative server answer
  // that fenced the token wins. A DIFFERENT token is a real cross-tab replacement and
  // may be adopted normally.
  const ignored = stored.token !== null && departedTokens.has(stored.token);
  const found = ignored ? null : stored.identity;
  if (found) {
    sessionOnly = false;
    departedTokens.clear();
    dismissedTombstone = null;
    pendingToken = null;
    pendingUnproven = false;
    const same =
      held !== null &&
      held.token === found.token &&
      held.accountId === found.accountId &&
      held.deviceId === found.deviceId;
    // A live identity exists again, so any signed-out screen is stale.
    if (!same) publish(found);
    else if (useIdentityStore.getState().signedOut) useIdentityStore.setState({ signedOut: false });
    return found;
  }
  // Our completed write failed, so EMPTY — or the same pending token that was successfully
  // written just before it — does not disprove the identity this tab already holds. A
  // different pending token remains a real cross-tab signal and follows the adoption path.
  if (held && sessionOnly && (stored.token === null || stored.token === held.token || ignored)) {
    return held;
  }
  // No complete identity in storage. A PENDING token there is another tab's bootstrap in
  // progress: adopting it makes retries converge on the same server idempotency key. The
  // origin-wide lock below closes the earlier EMPTY/EMPTY race, before either tab has had a
  // chance to publish that pending token. With storage merely EMPTY, a token this session
  // already minted is still ours to retry — the write simply did not stick.
  if (!ignored && stored.token !== null && stored.token !== pendingToken) {
    pendingToken = stored.token;
    // Not ours-fresh: another tab's bootstrap in progress, or a prior session's residue —
    // either way, an account whose emptiness this session cannot vouch for.
    pendingUnproven = true;
  }
  // We held one and the key no longer does: another tab started fresh (a sign-out now
  // leaves the TOMBSTONE above, so plain emptiness no longer ambiguously means one).
  // Ordinary identity loss, not the signed-out screen.
  if (held) publish(null);
  return null;
}

// ONE bootstrap in the air at a time, module-level (the `activeScoreFlights` pattern): two
// deploy taps can land in the same tick — a PLAY while an invite accept is still in
// flight — and each minting its own token would create two accounts for one player.
let flight: Promise<DeviceIdentity> | null = null;

async function lockedBootstrap(): Promise<DeviceIdentity> {
  // This module runs in the browser. Keeping the no-window branch makes the pure module
  // usable in non-DOM tooling, while a real browser without Web Locks fails closed: racing
  // two account creations is worse than surfacing a bootstrap failure, and localStorage
  // cannot implement an atomic substitute.
  if (typeof window === 'undefined') return bootstrap();
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) throw new Error('Device bootstrap requires Web Locks support.');
  return locks.request(DEVICE_BOOTSTRAP_LOCK, () => bootstrap());
}

// Create this device's identity, or return the one it already has. Called by the deliberate
// acts listed at the top of this file, and by nothing else — a read never bootstraps.
export function ensureDeviceIdentity(): Promise<DeviceIdentity> {
  // The shared key first, then the in-memory copy: a tab opened before another one
  // bootstrapped would otherwise mint a SECOND token, overwrite the shared entry and orphan
  // the account the other tab is playing on.
  const held = syncFromStorage() ?? useIdentityStore.getState().identity;
  if (held) return Promise.resolve(held);
  flight ??= lockedBootstrap().finally(() => {
    flight = null;
  });
  return flight;
}

// Resolve the identity for a REQUEST whose inputs were captured in `expectedEpoch`.
// `ensureDeviceIdentity` may synchronously adopt another tab's B while a closure still
// holds A's outbox/profile/invite inputs. Returning B there would authenticate A's body as
// B. This boundary permits the deliberate null -> first-identity transition, but refuses
// every transition away from an identity that already owned the request.
export interface RequestIdentity {
  identity: DeviceIdentity;
  epoch: string;
}

export async function ensureRequestIdentity(
  expectedEpoch: string | null = identityEpoch(),
): Promise<RequestIdentity | null> {
  const identity = await ensureDeviceIdentity();
  const epoch = identityEpochOf(identity);
  if (identityEpoch() !== epoch) return null;
  if (expectedEpoch !== null && expectedEpoch !== epoch) return null;
  return { identity, epoch };
}

// Resolve the identity a private request should travel as WITHOUT ever creating one
// (#216 trigger rework, user-decided 2026-08-24: the account deploys on the primary
// buttons alone — the two PLAY gates, the invite accept, the invite send, the profile
// save — so everything else resolves what exists and stands down when nothing does).
// Null when the device holds no identity, or when the one it holds no longer matches the
// epoch the request's inputs were captured under — `ensureRequestIdentity`'s own fence,
// minus the bootstrap.
export function currentRequestIdentity(
  expectedEpoch: string | null = identityEpoch(),
): RequestIdentity | null {
  const identity = deviceIdentity();
  if (!identity) return null;
  const epoch = identityEpochOf(identity);
  if (expectedEpoch !== null && expectedEpoch !== epoch) return null;
  return { identity, epoch };
}

async function bootstrap(): Promise<DeviceIdentity> {
  // Re-checked INSIDE the flight: it may have been queued behind a challenge fetch while
  // another tab finished its own bootstrap.
  const adopted = syncFromStorage();
  if (adopted) return adopted;
  // THE SIGNED-OUT VERDICT FAILS THE MINT CLOSED (user-decided 2026-08-24): while the
  // tombstone stands — read from storage just above, or held in memory when storage could
  // not be written — no ordinary act may create a replacement account. Leaving the old one
  // behind is the player's explicit choice (START FRESH clears the tombstone; #204's
  // reconnect will too), never a side effect of the next guess or tap. The signed-out
  // SCREEN is over the app wherever this flag is true, so this throw is the backstop for
  // anything that asks without a screen.
  if (useIdentityStore.getState().signedOut) throw new Error('This device is signed out.');
  // PERSIST the token before the request. Bootstrap is idempotent by its hash, so a
  // committed write whose answer was lost is recovered by retrying with the same value —
  // where a fresh token would silently mint a second identity and orphan the first. It also
  // lets a waiter or a later session adopt a pending bootstrap that was interrupted after
  // this write, and resolve through the server's idempotence instead of starting another.
  let token = pendingToken;
  if (token === null) {
    token = generateDeviceToken();
    pendingToken = token;
    pendingUnproven = false;
  }
  write({ token });
  let accountId: string;
  let deviceId: string;
  try {
    const challenge = await turnstileToken();
    const response = await postDevicesBody(devicesUrl(), { token, turnstileToken: challenge });
    if (!response.ok) throw new Error(`device bootstrap failed: ${response.status}`);
    ({ accountId, deviceId } = parseDeviceIdentity(await response.json()));
  } catch (error) {
    // The token is persisted and this flight (and its Web Lock) is about to release:
    // another tab or a later session can recover the SAME token, complete the bootstrap
    // and ACT on the account before this tab retries. Whatever this attempt could have
    // proven about emptiness is gone with it (PR-219 round-3 review) — the retry, wherever
    // it succeeds, must publish as an adoption.
    pendingUnproven = true;
    throw error;
  }
  // Re-checked AFTER the network legs too: a sign-out verdict can land while the request
  // is in flight — both verdict paths null `flight` but cannot cancel this one, and each
  // sets the store flag synchronously — and committing the mint would overwrite the
  // tombstone and clear `signedOut`. The verdict wins: the mint fails CLOSED here exactly
  // as it does before the flight.
  if (useIdentityStore.getState().signedOut) throw new Error('This device is signed out.');
  // Last look before the write. A tab that raced this one to a DIFFERENT token has already
  // stored a complete identity; overwriting it would leave two accounts on one device and
  // orphan the one that is being played. Ours is brand new and empty, so adopting theirs
  // costs nothing.
  const raced = readStored();
  if (
    raced.available &&
    raced.identity &&
    raced.identity.token !== token &&
    !departedTokens.has(raced.identity.token)
  ) {
    sessionOnly = false;
    departedTokens.clear();
    pendingToken = null;
    pendingUnproven = false;
    publish(raced.identity);
    return raced.identity;
  }
  const identity: DeviceIdentity = { token, accountId, deviceId };
  sessionOnly = !write(identity);
  if (!sessionOnly) departedTokens.clear();
  const unproven = pendingUnproven;
  pendingToken = null;
  pendingUnproven = false;
  // MINTED here only while the token's emptiness is still PROVEN — ours-fresh, and no
  // failed attempt has let it out of this tab's hands (see `pendingUnproven`): then
  // nothing published while tokenless needs re-reading. Otherwise the bootstrap publishes
  // as an ADOPTION and the scope owner re-reads the tokenless projections (PR-219 round-2
  // and round-3 reviews). (The raced adoption above never says `minted` — the tab that
  // won may already be playing.)
  publish(identity, false, !unproven);
  return identity;
}

// An authoritative answer says THIS epoch no longer owns the device: either a private call
// answered `unknown_device`, or /devices confirmed that this device revoked itself. The
// expected epoch is mandatory. Without it, a late refusal for A can read the now-current B
// and delete B's localStorage entry — signing out the wrong account.
export function markDeviceSignedOut(expectedEpoch: string): boolean {
  if (identityEpoch() !== expectedEpoch) return false;
  if (useIdentityStore.getState().signedOut) return false;
  const identity = useIdentityStore.getState().identity;
  const token = identity?.token ?? null;
  // Fence first: even if the storage write throws, a later ensure may not turn the
  // storage failure into permission to resurrect the token the server just rejected.
  if (token !== null) departedTokens.add(token);
  // The stored identity is REPLACED with its signed-out tombstone rather than removed
  // (user-decided 2026-08-24): removal read as ordinary identity loss, so a reload lost
  // the explanation and a sibling tab could mint a fresh account on its next act. The
  // tombstone keeps the verdict durable and broadcast until START FRESH clears it.
  if (token !== null && identity !== null) {
    installTombstone(token, { accountId: identity.accountId, deviceId: identity.deviceId });
  }
  // A NEW verdict re-arms the fence: whatever tombstone this tab once dismissed, this one
  // is fresh and stands until the player chooses again.
  dismissedTombstone = null;
  sessionOnly = false;
  pendingToken = null;
  pendingUnproven = false;
  flight = null;
  publish(null, true);
  return true;
}

// SKIP on the signed-out screen: leave the old account behind and start fresh. The new
// token is minted lazily by the next deliberate act, exactly like a first-ever visit.
// This is also what lifts the signed-out TOMBSTONE — the one gesture the fenced state
// waits for — so the next act may mint again, origin-wide.
export function startFreshDevice(): void {
  const stored = readStored();
  const departedStored =
    stored.available && stored.token !== null && departedTokens.has(stored.token)
      ? stored.token
      : null;
  const token = useIdentityStore.getState().identity?.token ?? pendingToken ?? departedStored;
  if (token !== null) departedTokens.add(token);
  // DISMISS the stored tombstone before attempting its removal: if the removal cannot
  // stick (unwritable storage), the fence keeps the still-readable verdict from being
  // re-adopted, or SKIP would loop this tab back onto the screen forever.
  if (stored.available && stored.signedOut !== null) dismissedTombstone = stored.signedOut;
  clearStored(token);
  removeTombstone();
  sessionOnly = false;
  pendingToken = null;
  pendingUnproven = false;
  flight = null;
  publish(null, false);
}

// Adopt what localStorage holds. Called once from `main.tsx`, before React renders, so the
// first paint already knows whether this device has an identity — a private read that fired
// against a not-yet-loaded identity would ask the server about nobody.
export interface LoadedDeviceIdentity {
  identity: DeviceIdentity | null;
  // A persisted token without server ids is a lost bootstrap, and therefore proof that
  // ownerless local state came from the deliberate act that began that bootstrap.
  pending: boolean;
  // Whether the shared key could be READ at all. `false` says NOTHING about this device's
  // identity (`StoredRead`'s own rule): the caller must not treat the null above as
  // proven emptiness — startup's reconciliation would otherwise clear identity-owned
  // state (the outbox, the Word rounds) off a denied localStorage read while the game
  // database and the account are both intact.
  readable: boolean;
}

export function loadDeviceIdentity(): LoadedDeviceIdentity {
  // A token with no ids is a bootstrap that never answered THIS storage. It is not an
  // identity — but its account is NOT assumed empty (the `pendingUnproven` rule): the
  // original session's answer may have arrived and its acts run, with only the identity's
  // write failing behind it. `syncFromStorage` holds that token so the next deploy retries
  // onto the SAME one, and that retry publishes as an adoption.
  const identity = syncFromStorage();
  // Another TAB writing the shared key is the only way this device's identity changes
  // without this tab asking, and it is not rare: two tabs of a game are ordinary. Adopting
  // it here is what keeps them on one account instead of two.
  if (typeof window !== 'undefined' && !storageListener) {
    storageListener = (event: StorageEvent) => {
      if (event.key !== null && event.key !== STORAGE_KEY) return;
      syncFromStorage();
    };
    window.addEventListener('storage', storageListener);
  }
  return {
    identity,
    pending: identity === null && pendingToken !== null,
    readable: readStored().available,
  };
}

let storageListener: ((event: StorageEvent) => void) | null = null;

// Test seam: drop this module's state (it must not leak between tests).
export function resetDeviceIdentity(): void {
  sessionOnly = false;
  departedTokens.clear();
  dismissedTombstone = null;
  pendingToken = null;
  pendingUnproven = false;
  flight = null;
  storage = undefined;
  if (storageListener && typeof window !== 'undefined') {
    window.removeEventListener('storage', storageListener);
  }
  storageListener = null;
  useIdentityStore.setState({ identity: null, signedOut: false, scopeRevision: 0 });
}
