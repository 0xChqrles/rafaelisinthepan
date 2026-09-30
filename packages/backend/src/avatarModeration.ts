// The #188 avatar symbol check: an exhaustive template match for the swastika over
// rotations, reflections, scales and positions — at 10×10 that is a few thousand cell
// comparisons, trivially cheap. Explicitly BEST-EFFORT/SYMBOLIC (the decided stance):
// it catches the single most-drawn offensive symbol and nothing else; the real
// containment is the groups model (#271), where the default board only shows avatars
// of people you chose to add.

import { AVATAR_SIZE } from '@whippin/shared';

type Grid = string[]; // rows of 'X' (ink) / '.' (background)

// The canonical 5×5 swastika: full vertical + horizontal bars through the centre, each
// arm hooked 90° at its end. Rotating it 90° maps it onto itself (C4 symmetry), so its
// only other orientation is the mirror image: two chiralities per scale.
const BASE: Grid = [
  'X.XXX',
  'X.X..',
  'XXXXX',
  '..X.X',
  'XXX.X',
];

function mirror(grid: Grid): Grid {
  return grid.map((row) => [...row].reverse().join(''));
}

function scale(grid: Grid, factor: number): Grid {
  const out: Grid = [];
  for (const row of grid) {
    const wide = [...row].map((cell) => cell.repeat(factor)).join('');
    for (let i = 0; i < factor; i++) out.push(wide);
  }
  return out;
}

// Both chiralities at every scale that fits the grid: 5×5 and 10×10.
const TEMPLATES: Grid[] = [1, 2].flatMap((factor) => {
  const scaled = scale(BASE, factor);
  return [scaled, mirror(scaled)];
});

// Match one template at one offset. `carved` flips the polarity: a background swastika
// cut out of an inked field is the same symbol. Only the template's own window is
// constrained — whatever surrounds it is free.
function matchesAt(
  cells: readonly number[],
  template: Grid,
  top: number,
  left: number,
  carved: boolean,
): boolean {
  const size = template.length;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const ink = cells[(top + r) * AVATAR_SIZE + left + c] !== 0;
      const wantInk = (template[r][c] === 'X') !== carved;
      if (ink !== wantInk) return false;
    }
  }
  return true;
}

// `cells` is the decoded 10×10 grid (0 = background, non-zero = foreground).
export function containsSwastika(cells: readonly number[]): boolean {
  for (const template of TEMPLATES) {
    const size = template.length;
    for (let top = 0; top + size <= AVATAR_SIZE; top++) {
      for (let left = 0; left + size <= AVATAR_SIZE; left++) {
        if (
          matchesAt(cells, template, top, left, false) ||
          matchesAt(cells, template, top, left, true)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}
