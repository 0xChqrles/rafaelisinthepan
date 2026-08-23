// This device's identity (#216): a REVOCABLE token it holds, and the account the SERVER
// assigned it.
//
// Until #216 the identity WAS a 128-bit secret (#187) that every device on an account
// shared, so there was nothing device-specific to revoke: someone with your key could only
// be shut out by abandoning the account — losing the archive, the streak and every friend.
// A device now holds its own token; the server can delete that token's row without this
// device being present, and the account survives.
//
// **The identity is created LAZILY, on first need — never on page open.** Creating on load
// would make account creation an unauthenticated write that every crawler and every bot
// triggers. A visit that performs none of the deliberate acts below mints no token and no
// server row:
//
//   the first guess (sentence or word) · starting a word round · opening the leaderboard ·
//   sending an invite link · accepting one · saving a profile
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
}

export const useIdentityStore = create<IdentityState>(() => ({
  identity: null,
  signedOut: false,
}));

// A token that has been minted but whose bootstrap has not answered. It is persisted BEFORE
// the request so a committed-but-lost bootstrap can be retried onto the same identity; it is
// deliberately NOT an identity, because until the answer lands this device does not know
// which account it holds — and, since the client waits for that answer before performing the
// act it bootstrapped for, an account created behind a lost answer is empty.
let pendingToken: string | null = null;

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

// What the shared key says — and, first, whether it can be read at all. The two are
// DIFFERENT answers: an unreadable storage (blocked cookies, a private mode that throws)
// says NOTHING about this device's identity, while a readable empty one says there is none.
// Collapsing them would let a denied storage drop an identity this session is already
// playing on.
type StoredRead =
  | { available: false }
  | { available: true; token: string | null; identity: DeviceIdentity | null };

const UNAVAILABLE: StoredRead = { available: false };
const EMPTY: StoredRead = { available: true, token: null, identity: null };

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
  const { token, accountId, deviceId } = parsed as Record<string, unknown>;
  // A corrupted value is no identity at all — better to mint a fresh one than to send
  // garbage the server would refuse on every call forever.
  if (!isValidDeviceToken(token)) return EMPTY;
  const complete =
    typeof accountId === 'string' &&
    PUBLIC_ID_PATTERN.test(accountId) &&
    typeof deviceId === 'string' &&
    PUBLIC_ID_PATTERN.test(deviceId);
  return { available: true, token, identity: complete ? { token, accountId, deviceId } : null };
}

function write(value: { token: string } | DeviceIdentity): void {
  try {
    store()?.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Unwritable storage: the identity simply lives for this session.
  }
}

// Remove the shared entry, but only while it is still the one we are leaving. Another TAB
// may have written a newer identity into it since — and deleting THAT would orphan the
// account that tab is playing on, which is the one thing a sign-out here may not do.
function clearStored(expected: string | null): void {
  try {
    const stored = readStored();
    if (expected !== null && stored.available && stored.token !== null && stored.token !== expected) {
      return;
    }
    store()?.removeItem(STORAGE_KEY);
  } catch {
    // Unreadable or unwritable storage: nothing to remove.
  }
}

// The epoch every private request is fenced against: WHO this device is acting as right
// now. An answer that lands after the tuple has changed describes an identity that is no
// longer ours, and applying it would repopulate the new identity with the old one's state.
export function identityEpoch(): string | null {
  const identity = useIdentityStore.getState().identity;
  return identity ? `${identity.accountId}:${identity.deviceId}` : null;
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

// What the identity OWNS, cleared whenever it changes. Registered by the modules that hold
// it (the round engines, the history cache) rather than imported here, so this module keeps
// knowing nothing about the game.
//
// The change carries its PREVIOUS value, because acquiring a first identity and leaving one
// are not the same event: a bootstrap is triggered BY an act (a first guess, a word round
// start), so clearing on it would destroy the very thing that asked for it.
export interface IdentityChange {
  previous: DeviceIdentity | null;
  next: DeviceIdentity | null;
  accountChanged: boolean;
  deviceChanged: boolean;
}
type Listener = (change: IdentityChange) => void;
const listeners = new Set<Listener>();

export function onIdentityChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(next: DeviceIdentity | null, signedOut = false): void {
  const previous = useIdentityStore.getState().identity;
  const accountChanged = (previous?.accountId ?? null) !== (next?.accountId ?? null);
  const deviceChanged = (previous?.deviceId ?? null) !== (next?.deviceId ?? null);
  useIdentityStore.setState({ identity: next, signedOut });
  if (!accountChanged && !deviceChanged) return;
  // Clearing storage WITHOUT fencing in-flight answers would let the identity just left
  // repopulate the one that replaced it, which is why every private request captures the
  // epoch above and drops an answer that outlived it.
  for (const listener of listeners) listener({ previous, next, accountChanged, deviceChanged });
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
  const found = stored.identity;
  if (found) {
    pendingToken = null;
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
  // No complete identity in storage. A PENDING token there is another tab's bootstrap in
  // progress: adopting it is what makes two tabs converge on ONE account, since the server's
  // bootstrap is idempotent by token hash. With storage merely EMPTY, a token this session
  // already minted is still ours to retry — the write simply did not stick.
  pendingToken = stored.token ?? pendingToken;
  // We held one and the key no longer does: another tab signed this device out or started
  // fresh. Drop to "no identity" rather than to the signed-out SCREEN — from storage alone
  // the two are indistinguishable, and the tab that actually got `unknown_device` is already
  // showing it.
  if (held) publish(null);
  return null;
}

// ONE bootstrap in the air at a time, module-level (the `activeScoreFlights` pattern): two
// triggers can fire in the same tick — a first guess while the leaderboard is mounting —
// and each minting its own token would create two accounts for one player.
let flight: Promise<DeviceIdentity> | null = null;

// Create this device's identity, or return the one it already has. Called by the deliberate
// acts listed at the top of this file, and by nothing else — a read never bootstraps.
export function ensureDeviceIdentity(): Promise<DeviceIdentity> {
  // The shared key first, then the in-memory copy: a tab opened before another one
  // bootstrapped would otherwise mint a SECOND token, overwrite the shared entry and orphan
  // the account the other tab is playing on.
  const held = syncFromStorage() ?? useIdentityStore.getState().identity;
  if (held) return Promise.resolve(held);
  flight ??= bootstrap().finally(() => {
    flight = null;
  });
  return flight;
}

async function bootstrap(): Promise<DeviceIdentity> {
  // Re-checked INSIDE the flight: it may have been queued behind a challenge fetch while
  // another tab finished its own bootstrap.
  const adopted = syncFromStorage();
  if (adopted) return adopted;
  // PERSIST the token before the request. Bootstrap is idempotent by its hash, so a
  // committed write whose answer was lost is recovered by retrying with the same value —
  // where a fresh token would silently mint a second identity and orphan the first. It is
  // also what two tabs racing a first bootstrap converge on: whichever writes the pending
  // token first, the other adopts it above and both resolve to ONE account.
  const token = (pendingToken ??= generateDeviceToken());
  write({ token });
  const challenge = await turnstileToken();
  const response = await postDevicesBody(devicesUrl(), { token, turnstileToken: challenge });
  if (!response.ok) throw new Error(`device bootstrap failed: ${response.status}`);
  const { accountId, deviceId } = parseDeviceIdentity(await response.json());
  // Last look before the write. A tab that raced this one to a DIFFERENT token has already
  // stored a complete identity; overwriting it would leave two accounts on one device and
  // orphan the one that is being played. Ours is brand new and empty, so adopting theirs
  // costs nothing.
  const raced = readStored();
  if (raced.available && raced.identity && raced.identity.token !== token) {
    pendingToken = null;
    publish(raced.identity);
    return raced.identity;
  }
  const identity: DeviceIdentity = { token, accountId, deviceId };
  write(identity);
  pendingToken = null;
  publish(identity);
  return identity;
}

// The server answered `unknown_device`: this device was signed out from another one. ONLY
// that explicit answer may call this — a 5xx or a dropped connection must never sign
// anyone out.
export function markDeviceSignedOut(): void {
  if (useIdentityStore.getState().signedOut) return;
  clearStored(useIdentityStore.getState().identity?.token ?? null);
  pendingToken = null;
  flight = null;
  publish(null, true);
}

// SKIP on the signed-out screen: leave the old account behind and start fresh. The new
// token is minted lazily by the next deliberate act, exactly like a first-ever visit.
export function startFreshDevice(): void {
  clearStored(useIdentityStore.getState().identity?.token ?? pendingToken);
  pendingToken = null;
  flight = null;
  publish(null, false);
}

// Adopt what localStorage holds. Called once from `main.tsx`, before React renders, so the
// first paint already knows whether this device has an identity — a private read that fired
// against a not-yet-loaded identity would ask the server about nobody.
export function loadDeviceIdentity(): void {
  // A token with no ids is a bootstrap that never answered. It is not an identity: the
  // account it may have created is empty, because the act it was minted for waits on the
  // answer. `syncFromStorage` holds that token so the next act retries onto the SAME one.
  syncFromStorage();
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
}

let storageListener: ((event: StorageEvent) => void) | null = null;

// Test seam: drop this module's state (it must not leak between tests).
export function resetDeviceIdentity(): void {
  pendingToken = null;
  flight = null;
  storage = undefined;
  if (storageListener && typeof window !== 'undefined') {
    window.removeEventListener('storage', storageListener);
  }
  storageListener = null;
  useIdentityStore.setState({ identity: null, signedOut: false });
}
