import { describe, expect, it } from 'vitest';
import {
  AVATAR_CELLS,
  AVATAR_INKS,
  AVATAR_PALETTES,
  AVATAR_STRING_LENGTH,
  blankAvatar,
  decodeAvatar,
  encodeAvatar,
  isValidAvatar,
} from './avatar';

function randomCells(seed: number): number[] {
  // Deterministic LCG so the fixture is stable.
  let state = seed;
  return Array.from({ length: AVATAR_CELLS }, () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % (AVATAR_INKS + 1);
  });
}

describe('avatar codec (#188)', () => {
  it('round-trips every palette with arbitrary cell contents', () => {
    for (let palette = 0; palette < AVATAR_PALETTES.length; palette++) {
      const cells = randomCells(palette + 1);
      const encoded = encodeAvatar(palette, cells);
      expect(encoded).toHaveLength(AVATAR_STRING_LENGTH);
      expect(decodeAvatar(encoded)).toEqual({ palette, cells });
    }
  });

  it('round-trips every cell value at every position', () => {
    for (const value of [0, 1, 2, 3]) {
      const cells = new Array<number>(AVATAR_CELLS).fill(value);
      expect(decodeAvatar(encodeAvatar(0, cells)).cells).toEqual(cells);
    }
    // A single ink in each corner survives at its exact position.
    const cells = new Array<number>(AVATAR_CELLS).fill(0);
    cells[0] = 1;
    cells[9] = 2;
    cells[90] = 3;
    cells[99] = 1;
    expect(decodeAvatar(encodeAvatar(0, cells)).cells).toEqual(cells);
  });

  it('rejects out-of-range palettes and cells at encode time', () => {
    const cells = new Array<number>(AVATAR_CELLS).fill(0);
    expect(() => encodeAvatar(-1, cells)).toThrow(/palette/);
    expect(() => encodeAvatar(AVATAR_PALETTES.length, cells)).toThrow(/palette/);
    expect(() => encodeAvatar(0, cells.slice(1))).toThrow(/100 cells/);
    expect(() => encodeAvatar(0, [...cells.slice(1), 4])).toThrow(/cell value/);
    expect(() => encodeAvatar(0, [...cells.slice(1), -1])).toThrow(/cell value/);
  });

  it('rejects malformed strings at decode time', () => {
    const good = blankAvatar();
    expect(() => decodeAvatar(good.slice(1))).toThrow(/length/);
    expect(() => decodeAvatar(`${good}A`)).toThrow(/length/);
    expect(() => decodeAvatar(`${good.slice(0, -1)}+`)).toThrow(/character/);
    expect(isValidAvatar(good)).toBe(true);
    expect(isValidAvatar(123)).toBe(false);
    expect(isValidAvatar('')).toBe(false);
  });

  it('rejects an unknown palette index carried by a well-formed string', () => {
    // Byte 0 = 63 ('_' as the first char encodes its top 6 bits): craft a string whose
    // first byte is beyond the palette list but whose shape is otherwise valid.
    const good = blankAvatar();
    const tampered = `_${good.slice(1)}`;
    expect(() => decodeAvatar(tampered)).toThrow(/palette/);
  });

  it('accepts only the canonical encoding of a drawing', () => {
    const encoded = blankAvatar();
    // Set spare trailing bits in the last character: same bytes, different string.
    const last = encoded[encoded.length - 1];
    const tampered = `${encoded.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
    expect(() => decodeAvatar(tampered)).toThrow(/non-canonical|character/);
  });

  it('pins the palette contract: at least 2 palettes, each with a bg and 3 inks', () => {
    expect(AVATAR_PALETTES.length).toBeGreaterThanOrEqual(2);
    for (const palette of AVATAR_PALETTES) {
      expect(palette.bg).toMatch(/^#[0-9a-f]{6}$/);
      expect(palette.inks).toHaveLength(3);
      for (const ink of palette.inks) expect(ink).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
