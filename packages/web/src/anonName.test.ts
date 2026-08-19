import { describe, expect, it } from 'vitest';
import { decodeAvatar, isValidAvatar, sanitizeName, NAME_MAX_LENGTH } from '@whippin/shared';
import { anonName } from './anonName';
import { defaultAvatar } from './defaultAvatar';

// The fallback identity's contract: pure (the same player reads the same everywhere,
// with nothing stored), shaped like what it stands in for — a gamertag the name rule
// would accept unchanged, an avatar string the renderer decodes — and stable across
// calls. The exact words and pixels are free to change, so nothing pins an output.

describe('anonName', () => {
  it('is deterministic and shaped like a gamertag (AdjectiveNoun##)', () => {
    const id = 'abcdefghij234567';
    expect(anonName(id)).toBe(anonName(id));
    expect(anonName(id)).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+\d{2}$/);
  });

  it('fits the shared name cap and survives the name rule unchanged', () => {
    for (const id of ['abcdefghij234567', 'zwjxqk37xfkvtxqu', 'a3xqnm37bnnlygdk']) {
      const name = anonName(id);
      expect(name.length).toBeLessThanOrEqual(NAME_MAX_LENGTH);
      expect(sanitizeName(name)).toBe(name);
    }
  });

  it('distinguishes different ids (spot check)', () => {
    expect(anonName('abcdefghij234567')).not.toBe(anonName('zwjxqk37xfkvtxqu'));
  });
});

describe('defaultAvatar', () => {
  it('is deterministic and a valid encoded avatar the renderer accepts', () => {
    const id = 'abcdefghij234567';
    expect(defaultAvatar(id)).toBe(defaultAvatar(id));
    expect(isValidAvatar(defaultAvatar(id))).toBe(true);
  });

  it('draws a mirrored, non-empty creature', () => {
    const { cells } = decodeAvatar(defaultAvatar('zwjxqk37xfkvtxqu'));
    expect(cells.some((cell) => cell === 1)).toBe(true);
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        expect(cells[y * 10 + x]).toBe(cells[y * 10 + (9 - x)]);
      }
    }
  });

  it('assigns different marks to different ids (spot check)', () => {
    expect(defaultAvatar('abcdefghij234567')).not.toBe(defaultAvatar('zwjxqk37xfkvtxqu'));
  });
});
