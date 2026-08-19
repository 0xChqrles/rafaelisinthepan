// The player's secret key (#187): generated on FIRST NEED (the first score POST — never
// at startup), kept in localStorage, and sent in the POST body as the proof of identity.
// It is simultaneously the ID and the password: the server derives the publicId from it
// and stores nothing secret. Losing localStorage loses the identity — accepted; the
// decided remedy is a copyable-key backup that doubles as device linking (#188 designed
// it; its UI surface was removed from the profile editor 2026-08-19 and is not yet
// re-homed).

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
