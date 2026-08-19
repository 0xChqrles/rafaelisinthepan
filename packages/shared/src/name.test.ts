import { describe, expect, it } from 'vitest';
import { NAME_MAX_LENGTH, isValidName, sanitizeName } from './name';

// The #188 display-name contract, asserted against the RULE (root AGENTS.md), not the
// implementation: alphanumerics and underscores, case kept, accents FOLDED rather than
// underscored, one underscore per non-alphanumeric CODE POINT, capped at 16 — and a
// valid name is exactly one the sanitizer leaves alone, which is what lets the web and
// the backend enforce one rule from one function.

const BEL = '\u0007'; // a control character
const ZWSP = '\u200B'; // a zero-width format character
const RLO = '\u202E'; // a bidi override
const ACUTE = '\u0301'; // a lone combining mark

describe('sanitizeName', () => {
  it('leaves an already-conforming name alone, case included', () => {
    for (const name of ['Chqrles', 'jean_pierre', 'X4E9', 'a', '', '_'.repeat(16)]) {
      expect(sanitizeName(name)).toBe(name);
    }
  });

  it('FOLDS accents instead of underscoring them — the letters survive', () => {
    expect(sanitizeName('Zoé')).toBe('Zoe');
    expect(sanitizeName('Éléonore')).toBe('Eleonore');
    expect(sanitizeName('François')).toBe('Francois');
    expect(sanitizeName('forêt')).toBe('foret');
  });

  it('expands the ligatures NFKD leaves alone, in both cases', () => {
    expect(sanitizeName('œuf')).toBe('oeuf');
    expect(sanitizeName('Œuvre')).toBe('OEuvre');
    expect(sanitizeName('Ægir')).toBe('AEgir');
  });

  it('is independent of the input normalization form', () => {
    // What macOS and several IMEs hand over is NFD; typing it is usually NFC. Without
    // a normalizing pass the same visible name stores as two different values.
    for (const name of ['café', 'Éléonore', 'forêt']) {
      expect(sanitizeName(name.normalize('NFD'))).toBe(sanitizeName(name.normalize('NFC')));
    }
    expect(sanitizeName('café'.normalize('NFD'))).toBe('cafe');
  });

  it('maps every other character to ONE underscore, per code point', () => {
    expect(sanitizeName('jean pierre!')).toBe('jean_pierre_');
    expect(sanitizeName('Jean-Luc 42')).toBe('Jean_Luc_42');
    // One astral character is one code point, so it costs one underscore — not one
    // per UTF-16 surrogate half.
    expect(sanitizeName('😀')).toBe('_');
    expect(sanitizeName('a😀b')).toBe('a_b');
    // A regional-indicator pair is genuinely TWO code points.
    expect(sanitizeName('🇫🇷')).toBe('__');
    // Control, format and bidi characters go the same way — in a name they are only
    // ever a disguise.
    for (const hidden of [BEL, ZWSP, RLO]) {
      expect(sanitizeName(`a${hidden}b`)).toBe('a_b');
    }
    // A combining mark with nothing to combine with simply goes.
    expect(sanitizeName(ACUTE)).toBe('');
  });

  it('caps at NAME_MAX_LENGTH characters', () => {
    expect(sanitizeName('x'.repeat(NAME_MAX_LENGTH))).toHaveLength(NAME_MAX_LENGTH);
    expect(sanitizeName('x'.repeat(NAME_MAX_LENGTH + 40))).toHaveLength(NAME_MAX_LENGTH);
    // The cap counts the OUTPUT, so a ligature that expands to two letters counts two.
    expect(sanitizeName('œ'.repeat(NAME_MAX_LENGTH))).toBe('oe'.repeat(NAME_MAX_LENGTH / 2));
  });

  it('is idempotent, and its output is always a valid name', () => {
    const samples = [
      'Chqrles',
      'Éléonore',
      'jean pierre!',
      '  Big  Chef  ',
      '😀'.repeat(20),
      'x'.repeat(80),
      'café'.normalize('NFD'),
      ACUTE,
      'Œuvre & Cie',
      `${BEL}${ZWSP}${RLO}`,
      '',
    ];
    for (const sample of samples) {
      const once = sanitizeName(sample);
      expect(sanitizeName(once)).toBe(once);
      expect(isValidName(once)).toBe(true);
      expect(once).toMatch(/^[A-Za-z0-9_]*$/);
      expect(once.length).toBeLessThanOrEqual(NAME_MAX_LENGTH);
    }
  });
});

describe('isValidName', () => {
  it('accepts alphanumerics, underscores and the empty name', () => {
    for (const name of ['Chqrles', 'jean_pierre', '4', '', '_']) {
      expect(isValidName(name)).toBe(true);
    }
  });

  it('refuses anything the sanitizer would change', () => {
    for (const name of [
      'Big Chef', // whitespace
      ' Chqrles', // edge whitespace — no trim, the rule has no room for one
      'Jean-Luc', // punctuation
      'Éléonore', // an accent is a change, even though its fold is a real name
      `a${BEL}b`,
      `a${ZWSP}b`,
      'x'.repeat(NAME_MAX_LENGTH + 1),
      '😀',
    ]) {
      expect(isValidName(name)).toBe(false);
    }
  });
});
