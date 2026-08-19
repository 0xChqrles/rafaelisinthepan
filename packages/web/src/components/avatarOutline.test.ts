import { describe, expect, it } from 'vitest';
import { AVATAR_SIZE } from '@whippin/shared';
import { avatarOutlinePath } from './avatarOutline';

// The tracer's contract: filled cells become one path of closed loops — outer
// boundaries clockwise on screen, holes counter-clockwise (so the default nonzero
// fill rule subtracts them), collinear runs merged, diagonal touches kept as two
// separate loops. Exact strings pin the geometry AND the winding.

const grid = (...on: Array<[number, number]>) => {
  const cells = new Array<number>(AVATAR_SIZE * AVATAR_SIZE).fill(0);
  for (const [x, y] of on) cells[y * AVATAR_SIZE + x] = 1;
  return cells;
};

describe('avatarOutlinePath', () => {
  it('draws nothing for an empty grid', () => {
    expect(avatarOutlinePath(grid(), 10)).toBe('');
  });

  it('traces a lone cell clockwise from its top-left corner', () => {
    expect(avatarOutlinePath(grid([0, 0]), 10)).toBe('M0 0L10 0L10 10L0 10Z');
  });

  it('merges collinear runs: two adjacent cells are one four-corner loop', () => {
    expect(avatarOutlinePath(grid([0, 0], [1, 0]), 10)).toBe('M0 0L20 0L20 10L0 10Z');
  });

  it('scales by the cell size', () => {
    expect(avatarOutlinePath(grid([0, 0]), 4)).toBe('M0 0L4 0L4 4L0 4Z');
  });

  it('cuts a hole as its own counter-clockwise loop', () => {
    const ring = grid([0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]);
    expect(avatarOutlinePath(ring, 10)).toBe(
      'M0 0L30 0L30 30L0 30ZM10 10L10 20L20 20L20 10Z',
    );
  });

  it('keeps diagonally touching cells as two separate loops', () => {
    expect(avatarOutlinePath(grid([0, 0], [1, 1]), 10)).toBe(
      'M0 0L10 0L10 10L0 10ZM10 10L20 10L20 20L10 20Z',
    );
  });

  it('walks a non-convex region as one loop', () => {
    // An L: (0,0) above (0,1)-(1,1).
    expect(avatarOutlinePath(grid([0, 0], [0, 1], [1, 1]), 10)).toBe(
      'M0 0L10 0L10 10L20 10L20 20L0 20Z',
    );
  });
});
