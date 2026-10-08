// CONTRACT (day preview links, user-decided 2026-10-08): a preview code is the first 16
// lowercase hex characters of HMAC-SHA256(server secret, "preview:<lang>:<date>"), so it
// grants exactly ONE (lang, date), and only the secret's holder can mint one. The check is
// constant-time and never throws on a hostile value.

import { describe, expect, it } from 'vitest';
import { isPreviewCode } from '@whippin/shared';
import { previewCode, previewCodeMatches } from './previewCode';

const SECRET = 'x'.repeat(64);

describe('previewCode', () => {
  it('is pinned: the HMAC of "preview:<lang>:<date>", first 16 hex characters', () => {
    // A drift here voids every link already sent.
    expect(previewCode(SECRET, 'fr', '2026-10-12')).toBe('6a834cc89b766e37');
  });

  it('has the shared shape', () => {
    expect(isPreviewCode(previewCode(SECRET, 'en', '2026-10-12'))).toBe(true);
  });

  it('differs per language, per date and per secret', () => {
    const base = previewCode(SECRET, 'fr', '2026-10-12');
    expect(previewCode(SECRET, 'en', '2026-10-12')).not.toBe(base);
    expect(previewCode(SECRET, 'fr', '2026-10-13')).not.toBe(base);
    expect(previewCode('y'.repeat(64), 'fr', '2026-10-12')).not.toBe(base);
  });
});

describe('previewCodeMatches', () => {
  const code = previewCode(SECRET, 'fr', '2026-10-12');

  it('matches only its own (lang, date)', () => {
    expect(previewCodeMatches(SECRET, 'fr', '2026-10-12', code)).toBe(true);
    expect(previewCodeMatches(SECRET, 'en', '2026-10-12', code)).toBe(false);
    expect(previewCodeMatches(SECRET, 'fr', '2026-10-13', code)).toBe(false);
    expect(previewCodeMatches('y'.repeat(64), 'fr', '2026-10-12', code)).toBe(false);
  });

  it('refuses a malformed or wrong value without throwing', () => {
    for (const bad of [
      '',
      code.toUpperCase(),
      code.slice(0, 15),
      `${code}0`,
      'zzzzzzzzzzzzzzzz',
      '0000000000000000',
      // Sixteen characters, but not sixteen BYTES: the shape check must refuse it before
      // a byte comparison of unequal lengths could throw.
      'éééééééééééééééé',
    ]) {
      expect(previewCodeMatches(SECRET, 'fr', '2026-10-12', bad)).toBe(false);
    }
  });
});
