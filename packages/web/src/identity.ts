// The player's secret key (#187): generated on FIRST NEED (the first score POST — never
// at startup), kept in localStorage, and sent in the POST body as the proof of identity.
// It is simultaneously the ID and the password: the server derives the publicId from it
// and stores nothing secret. Losing localStorage loses the identity — accepted; the
// remedy is the copyable-key backup in the profile editor (#188), which doubles as
// device linking (pasting the key elsewhere IS the same identity).

import { generateSecret, isValidSecret } from '@whippin/shared';

const SECRET_STORAGE_KEY = 'whippin-player-key';

// One identity per session even when storage is unavailable (private mode, a throwing
// quota): the fallback secret lives here so repeated calls stay one player.
let sessionSecret: string | null = null;

function defaultStorage(): Storage | null {
  // The `localStorage` PROPERTY itself throws a SecurityError when storage is disabled
  // (e.g. blocked cookies) — that read happens while evaluating the default parameter,
  // outside playerSecret's own try — so it needs its own catch or a denied storage
  // would fail score submission instead of degrading to the session identity.
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function playerSecret(storage: Storage | null = defaultStorage()): string {
  try {
    const stored = storage?.getItem(SECRET_STORAGE_KEY);
    // A corrupted value is no identity at all — regenerate rather than send garbage the
    // server would refuse on every submission forever.
    if (isValidSecret(stored)) return stored;
  } catch {
    // Unreadable storage falls through to the session identity.
  }
  sessionSecret ??= generateSecret();
  try {
    storage?.setItem(SECRET_STORAGE_KEY, sessionSecret);
  } catch {
    // Unwritable storage: the identity simply lives for this session.
  }
  return sessionSecret;
}

// Device linking (#188): pasting a key IS the same identity, so adopting one replaces
// whatever this device held. Returns false (and changes nothing) on a malformed key.
export function adoptPlayerSecret(
  secret: string,
  storage: Storage | null = defaultStorage(),
): boolean {
  if (!isValidSecret(secret)) return false;
  sessionSecret = secret;
  try {
    storage?.setItem(SECRET_STORAGE_KEY, secret);
  } catch {
    // Unwritable storage: the linked identity lives for this session.
  }
  return true;
}
