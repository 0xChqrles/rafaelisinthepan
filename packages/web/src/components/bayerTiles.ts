import type { CSSProperties } from 'react';
import { BAYER_8 } from '@whippin/shared';

// THE BOARDS' ORDERED DITHER AS CSS MASKS: the house's texture (the run's heat, the meter's
// charge, the foil) said by the browser itself, on the house's 2px cell, for the two things
// the board screen thins through it — a line ARRIVING, and the EDGE where your own line, held
// at the list's edge, meets the lines passing under it. A tile is an SVG of whole 2px cells,
// drawn where the Bayer 8×8 threshold (shared `bayer.ts`) is under the density at that cell,
// and used as a mask: a cell is shown or it is not, never half of one.

const CELL = 2;
const tile = (w: number, h: number, rects: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' shape-rendering='crispEdges'>${rects}</svg>`,
  )}")`;

// THE EDGE, short: EDGE_CELLS deep and the matrix's 8 across, solid at the inner side (the line
// it guards) and thinning to nothing away from it. As deep as a line's empty margin above and
// below its mark, so on a list resting on whole lines it falls on bare ground and only ever
// touches a name while one is passing.
export const EDGE_CELLS = 3;
function edgeTile(towardBottom: boolean): string {
  let rects = '';
  for (let r = 0; r < EDGE_CELLS; r += 1) {
    for (let c = 0; c < 8; c += 1) {
      const k = (r + 0.5) / EDGE_CELLS;
      const density = towardBottom ? 1 - k : k;
      if (BAYER_8[r * 8 + c] < density * 64) rects += `<rect x='${c * CELL}' y='${r * CELL}' width='2' height='2'/>`;
    }
  }
  return tile(8 * CELL, EDGE_CELLS * CELL, rects);
}
export const EDGES = {
  '--edge-d': edgeTile(true),
  '--edge-u': edgeTile(false),
} as CSSProperties;

// THE DISSOLVE: the matrix's own tile at DISSOLVE_LEVELS densities, from nothing (`--dz-0`) to
// all but the last cells (`--dz-7`) — the board's `board-dissolve` keyframes step a line's mask
// through them, so a line comes in the way the meter charges: its cells lighting in threshold
// order, in hard steps, nothing travelling. Worn by the surfaces whose lines arrive that way
// (the board screen, the group's own screen), as custom properties on their root.
export const DISSOLVE_LEVELS = 8;
function levelTile(level: number): string {
  let rects = '';
  for (let r = 0; r < 8; r += 1) {
    for (let c = 0; c < 8; c += 1) {
      if (BAYER_8[r * 8 + c] < (level * 64) / DISSOLVE_LEVELS) {
        rects += `<rect x='${c * CELL}' y='${r * CELL}' width='2' height='2'/>`;
      }
    }
  }
  return tile(8 * CELL, 8 * CELL, rects);
}
export const DISSOLVES = Object.fromEntries(
  Array.from({ length: DISSOLVE_LEVELS }, (_, level) => [`--dz-${level}`, levelTile(level)]),
) as CSSProperties;
