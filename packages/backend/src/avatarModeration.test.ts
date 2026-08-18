import { describe, expect, it } from 'vitest';
import { AVATAR_CELLS, AVATAR_SIZE } from '@whippin/shared';
import { containsSwastika } from './avatarModeration';

// Build the 10×10 cell array from row strings ('.' = background, any other char = that
// ink digit, 'X' = ink 1).
function grid(rows: string[]): number[] {
  const cells = new Array<number>(AVATAR_CELLS).fill(0);
  rows.forEach((row, r) => {
    [...row].forEach((char, c) => {
      if (char === '.') return;
      cells[r * AVATAR_SIZE + c] = char === 'X' ? 1 : Number(char);
    });
  });
  return cells;
}

const SWASTIKA = ['X.XXX', 'X.X..', 'XXXXX', '..X.X', 'XXX.X'];

function placed(top: number, left: number, rows: string[] = SWASTIKA): string[] {
  const out = Array.from({ length: AVATAR_SIZE }, () => '.'.repeat(AVATAR_SIZE));
  rows.forEach((row, r) => {
    const line = out[top + r];
    out[top + r] = line.slice(0, left) + row + line.slice(left + row.length);
  });
  return out;
}

function mirrored(rows: string[]): string[] {
  return rows.map((row) => [...row].reverse().join(''));
}

describe('avatar swastika detector (#188)', () => {
  it('detects the symbol at any position', () => {
    expect(containsSwastika(grid(placed(0, 0)))).toBe(true);
    expect(containsSwastika(grid(placed(5, 5)))).toBe(true);
    expect(containsSwastika(grid(placed(2, 3)))).toBe(true);
  });

  it('detects the reflected chirality and rotations', () => {
    expect(containsSwastika(grid(placed(1, 1, mirrored(SWASTIKA))))).toBe(true);
    // The symbol is C4-symmetric, so a 90° rotation IS the base shape — the reflected
    // one covers the other chirality; a rotation of the mirror is still the mirror.
    const rotatedMirror = mirrored(SWASTIKA).map((_, r, rows) =>
      rows.map((row) => row[r]).reverse().join(''),
    );
    expect(containsSwastika(grid(placed(4, 0, rotatedMirror)))).toBe(true);
  });

  it('detects the double-scale symbol filling the grid', () => {
    const doubled = SWASTIKA.flatMap((row) => {
      const wide = [...row].map((c) => c.repeat(2)).join('');
      return [wide, wide];
    });
    expect(containsSwastika(grid(doubled))).toBe(true);
  });

  it('detects the carved (negative-space) symbol', () => {
    const cells = new Array<number>(AVATAR_CELLS).fill(2);
    SWASTIKA.forEach((row, r) => {
      [...row].forEach((char, c) => {
        if (char === 'X') cells[(r + 2) * AVATAR_SIZE + c + 3] = 0;
      });
    });
    // Blank template cells inside the window must be ink — they already are (fill 2).
    expect(containsSwastika(cells)).toBe(true);
  });

  it('detects the symbol drawn in mixed inks', () => {
    const mixed = SWASTIKA.map((row, r) =>
      [...row].map((char) => (char === 'X' ? String((r % 3) + 1) : '.')).join(''),
    );
    expect(containsSwastika(grid(placed(3, 2, mixed)))).toBe(true);
  });

  it('passes benign drawings', () => {
    // Empty and full.
    expect(containsSwastika(new Array<number>(AVATAR_CELLS).fill(0))).toBe(false);
    expect(containsSwastika(new Array<number>(AVATAR_CELLS).fill(1))).toBe(false);
    // Checkerboard.
    const checker = Array.from({ length: AVATAR_CELLS }, (_, i) =>
      (Math.floor(i / AVATAR_SIZE) + i) % 2,
    );
    expect(containsSwastika(checker)).toBe(false);
    // A plus/cross — bars with no hooks must NOT match.
    expect(
      containsSwastika(
        grid(placed(2, 2, ['..X..', '..X..', 'XXXXX', '..X..', '..X..'])),
      ),
    ).toBe(false);
    // A smiley.
    expect(
      containsSwastika(
        grid([
          '..........',
          '..XX..XX..',
          '..XX..XX..',
          '..........',
          '.X......X.',
          '..X....X..',
          '...XXXX...',
          '..........',
          '..........',
          '..........',
        ]),
      ),
    ).toBe(false);
    // A border ring.
    const ring = Array.from({ length: AVATAR_SIZE }, (_, r) =>
      r === 0 || r === AVATAR_SIZE - 1 ? 'X'.repeat(10) : `X${'.'.repeat(8)}X`,
    );
    expect(containsSwastika(grid(ring))).toBe(false);
  });
});
