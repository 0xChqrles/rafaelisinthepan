import { describe, expect, it } from 'vitest';
import {
  AVATAR_CELLS,
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
    return state % 2;
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

  it('round-trips both cell values at every position', () => {
    for (const value of [0, 1]) {
      const cells = new Array<number>(AVATAR_CELLS).fill(value);
      expect(decodeAvatar(encodeAvatar(0, cells)).cells).toEqual(cells);
    }
    // A single foreground pixel in each corner survives at its exact position.
    const cells = new Array<number>(AVATAR_CELLS).fill(0);
    cells[0] = 1;
    cells[9] = 1;
    cells[90] = 1;
    cells[99] = 1;
    expect(decodeAvatar(encodeAvatar(0, cells)).cells).toEqual(cells);
  });

  it('rejects out-of-range palettes and cells at encode time', () => {
    const cells = new Array<number>(AVATAR_CELLS).fill(0);
    expect(() => encodeAvatar(-1, cells)).toThrow(/palette/);
    expect(() => encodeAvatar(AVATAR_PALETTES.length, cells)).toThrow(/palette/);
    expect(() => encodeAvatar(0, cells.slice(1))).toThrow(/100 cells/);
    // Two colours only: any value past the foreground is refused.
    expect(() => encodeAvatar(0, [...cells.slice(1), 2])).toThrow(/cell value/);
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
    // '_' as the first char puts 63 in the palette byte's top bits — far past the list
    // while the string's shape stays valid.
    const good = blankAvatar();
    const tampered = `_${good.slice(1)}`;
    expect(() => decodeAvatar(tampered)).toThrow(/palette/);
  });

  it('accepts only the canonical encoding of a drawing', () => {
    const encoded = blankAvatar();
    // Spare trailing base64 bits set: same bytes, different string.
    const tampered = `${encoded.slice(0, -1)}B`;
    expect(() => decodeAvatar(tampered)).toThrow(/non-canonical/);
    // Spare BYTE bits set (the 4 bits past cell 99 in the last byte): 'AAAAAAAAAAAAAAAAABA'
    // is bytes[13] = 0x10 — same 100 cells, different string.
    expect(() => decodeAvatar('AAAAAAAAAAAAAAAAABA')).toThrow(/non-canonical/);
  });

  it('pins the palette contract: the five duos extracted from the palette drawings', () => {
    // The colours are the user's own drawings (repo-root palette PNGs: 16×16 tiles,
    // each a 10×10 tree — sky = bg, tree = fg; the latest, /palette.png, redrew the
    // last two duos). This pin is the extraction, verbatim: a change here means a
    // NEW drawing was deliberately re-extracted.
    expect(AVATAR_PALETTES.map(({ bg, fg }) => ({ bg, fg }))).toEqual([
      { bg: '#222431', fg: '#4a6aff' },
      { bg: '#8f06ff', fg: '#30fff8' },
      { bg: '#ff1a85', fg: '#c6ff1a' },
      { bg: '#007fff', fg: '#f6f6ff' },
      // The last ink is the user's spoken adjustment over the extraction (#ff5ce0).
      { bg: '#30fff8', fg: '#ff3dbe' },
    ]);
    for (const palette of AVATAR_PALETTES) {
      expect(palette.fg).not.toBe(palette.bg);
    }
    // Each palette carries its own background — a shared ground was explicitly refused.
    const grounds = new Set(AVATAR_PALETTES.map((palette) => palette.bg));
    expect(grounds.size).toBe(AVATAR_PALETTES.length);
  });
});
