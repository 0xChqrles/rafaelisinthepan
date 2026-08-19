import { describe, expect, it } from 'vitest';
import { sanitizeName } from '@whippin/shared';
import { anonName } from './anonName';

// The pseudonym's contract: pure (the same player reads the same everywhere, with
// nothing stored), shaped like a name, and something the name rule would accept — the
// exact syllables are free to change, so no test pins a specific output string.

describe('anonName', () => {
  it('is deterministic and shaped like a pronounceable capitalized name', () => {
    const id = 'abcdefghij234567';
    expect(anonName(id)).toBe(anonName(id));
    expect(anonName(id)).toMatch(/^[A-Z][a-z]{5}$/);
  });

  it('is a value the shared name rule accepts unchanged', () => {
    const name = anonName('zwjxqk37xfkvtxqu');
    expect(sanitizeName(name)).toBe(name);
  });

  it('distinguishes different ids (spot check)', () => {
    expect(anonName('abcdefghij234567')).not.toBe(anonName('zwjxqk37xfkvtxqu'));
  });
});
