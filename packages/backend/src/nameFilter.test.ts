import { describe, expect, it } from 'vitest';
import { isNameAllowed, normalizeName } from './nameFilter';

describe('name filter (#188)', () => {
  it('rejects banned terms through the easy disguises', () => {
    expect(isNameAllowed('Hitler')).toBe(false);
    expect(isNameAllowed('h i t l e r')).toBe(false);
    expect(isNameAllowed('H1tl3r')).toBe(false);
    expect(isNameAllowed('xX_nazi_Xx')).toBe(false);
    expect(isNameAllowed('N4Zi')).toBe(false);
    expect(isNameAllowed('nègre')).toBe(false);
    expect(isNameAllowed('enculé')).toBe(false);
  });

  // MODERATION only — this filter answers "is this term banned?", never "is this the
  // right shape?". The charset (alphanumerics + underscores, accents folded) is the
  // shared rule `validateName` applies BEFORE this, so several of the names below are
  // allowed here and still refused by the route.
  it('accepts ordinary names, accents and short handles', () => {
    expect(isNameAllowed('')).toBe(true);
    expect(isNameAllowed('Chqrles')).toBe(true);
    expect(isNameAllowed('Éléonore')).toBe(true);
    expect(isNameAllowed('Jean-Luc 42')).toBe(true);
    expect(isNameAllowed('word wizard')).toBe(true);
    // Substring traps the list must not fall into.
    expect(isNameAllowed('Montenegro')).toBe(true);
    expect(isNameAllowed('Niger')).toBe(true);
    expect(isNameAllowed('vinaigre')).toBe(true);
  });

  it('normalizes case, accents, spacing and leet before matching', () => {
    expect(normalizeName('H1tl3r!')).toBe('hitleri');
    expect(normalizeName('É l è v e')).toBe('eleve');
    expect(normalizeName('  A_b-c  ')).toBe('abc');
  });
});
