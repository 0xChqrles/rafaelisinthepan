// CONTRACT (#187): the localStorage secret IS the account. One identity per device —
// generated once, returned verbatim forever after — and a corrupted stored value is
// replaced rather than sent to be refused on every submission.

import { describe, expect, it } from 'vitest';
import { isValidSecret } from '@whippin/shared';
import { playerSecret } from './identity';

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: () => null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe('playerSecret (#187)', () => {
  it('generates a valid secret on first need and persists it', () => {
    const storage = fakeStorage();
    const secret = playerSecret(storage);
    expect(isValidSecret(secret)).toBe(true);
    expect(storage.getItem('whippin-player-key')).toBe(secret);
    // The identity is stable: every later call is the same player.
    expect(playerSecret(storage)).toBe(secret);
  });

  it('returns a stored valid secret verbatim — pasting a key IS device linking', () => {
    const stored = '00112233445566778899aabbccddeeff';
    expect(playerSecret(fakeStorage({ 'whippin-player-key': stored }))).toBe(stored);
  });

  it('replaces a corrupted stored value with a fresh identity', () => {
    const storage = fakeStorage({ 'whippin-player-key': 'not-a-key' });
    const secret = playerSecret(storage);
    expect(isValidSecret(secret)).toBe(true);
    expect(storage.getItem('whippin-player-key')).toBe(secret);
  });

  it('still hands out ONE stable identity when storage is unavailable', () => {
    const first = playerSecret(null);
    expect(isValidSecret(first)).toBe(true);
    expect(playerSecret(null)).toBe(first);
  });
});
