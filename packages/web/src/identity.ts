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
// Nothing here hashes anything: `crypto.subtle` is absent outside a secure context (the
// LAN-IP mobile check), which is what forced a leaderboard workaround under #187's derived
// id. Minting uses `crypto.getRandomValues`, which every context has.

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

function readStored(): { token: string; identity: DeviceIdentity | null } | null {
  let raw: string | null = null;
  try {
    raw = store()?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { token, accountId, deviceId } = parsed as Record<string, unknown>;
  // A corrupted value is no identity at all — better to mint a fresh one than to send
  // garbage the server would refuse on every call forever.
  if (!isValidDeviceToken(token)) return null;
  const complete =
    typeof accountId === 'string' &&
    PUBLIC_ID_PATTERN.test(accountId) &&
    typeof deviceId === 'string' &&
    PUBLIC_ID_PATTERN.test(deviceId);
  return { token, identity: complete ? { token, accountId, deviceId } : null };
}

function write(value: { token: string } | DeviceIdentity | null): void {
  try {
    if (value === null) store()?.removeItem(STORAGE_KEY);
    else store()?.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Unwritable storage: the identity simply lives for this session.
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
// it (the round engines, the history cache, the board/profile screens) rather than imported
// here, so this module keeps knowing nothing about the game.
type Listener = (change: { accountChanged: boolean; deviceChanged: boolean }) => void;
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
  for (const listener of listeners) listener({ accountChanged, deviceChanged });
}

// ONE bootstrap in the air at a time, module-level (the `activeScoreFlights` pattern): two
// triggers can fire in the same tick — a first guess while the leaderboard is mounting —
// and each minting its own token would create two accounts for one player.
let flight: Promise<DeviceIdentity> | null = null;

// Create this device's identity, or return the one it already has. Called by the deliberate
// acts listed at the top of this file, and by nothing else — a read never bootstraps.
export function ensureDeviceIdentity(): Promise<DeviceIdentity> {
  const held = useIdentityStore.getState().identity;
  if (held) return Promise.resolve(held);
  flight ??= bootstrap().finally(() => {
    flight = null;
  });
  return flight;
}

async function bootstrap(): Promise<DeviceIdentity> {
  // PERSIST the token before the request. Bootstrap is idempotent by its hash, so a
  // committed write whose answer was lost is recovered by retrying with the same value —
  // where a fresh token would silently mint a second identity and orphan the first.
  const token = (pendingToken ??= generateDeviceToken());
  write({ token });
  const challenge = await turnstileToken();
  const response = await postDevicesBody(devicesUrl(), { token, turnstileToken: challenge });
  if (!response.ok) throw new Error(`device bootstrap failed: ${response.status}`);
  const { accountId, deviceId } = parseDeviceIdentity(await response.json());
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
  write(null);
  pendingToken = null;
  flight = null;
  publish(null, true);
}

// SKIP on the signed-out screen: leave the old account behind and start fresh. The new
// token is minted lazily by the next deliberate act, exactly like a first-ever visit.
export function startFreshDevice(): void {
  write(null);
  pendingToken = null;
  flight = null;
  publish(null, false);
}

// Adopt what localStorage holds. Called once from `main.tsx`, before React renders, so the
// first paint already knows whether this device has an identity — a private read that fired
// against a not-yet-loaded identity would ask the server about nobody.
export function loadDeviceIdentity(): void {
  const stored = readStored();
  if (!stored) return;
  // A token with no ids is a bootstrap that never answered. It is not an identity: the
  // account it may have created is empty, because the act it was minted for waits on the
  // answer. Hold the token so the next act retries onto the SAME identity.
  pendingToken = stored.identity ? null : stored.token;
  if (stored.identity) publish(stored.identity);
}

// Test seam: drop this module's state (it must not leak between tests).
export function resetDeviceIdentity(): void {
  pendingToken = null;
  flight = null;
  storage = undefined;
  useIdentityStore.setState({ identity: null, signedOut: false });
}
