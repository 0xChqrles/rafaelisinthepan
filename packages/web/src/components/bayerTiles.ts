import { BAYER_8 } from '@whippin/shared';

// THE BOARDS' ORDERED DITHER AS CSS MASKS: the house's texture (the run's heat, the meter's
// charge, the foil) said by the browser itself, on the house's 2px cell, for the two things
// the app thins through it — a line or a screen ARRIVING (and giving way), and the EDGE where
// what scrolls meets a held line (your own line at the list's edge, the header's band, a
// drum's ends). A tile is an SVG of whole 2px cells,
// drawn where the Bayer 8×8 threshold (shared `bayer.ts`) is under the density at that cell,
// and used as a mask: a cell is shown or it is not, never half of one.

const CELL = 2;
const tile = (w: number, h: number, rects: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' shape-rendering='crispEdges'>${rects}</svg>`,
  )}")`;

// AN EDGE: the matrix's 8 cells across, in STEPS of falling density from the inner side (the
// line it guards) outward — each step `rows` cells tall, its cells drawn where the matrix's
// threshold is under the step's density. `-d` is dense at its top (a band hanging DOWN from a
// held line, or a scroller's foot), `-u` dense at its bottom (a scroller's top).
function edgeTile(densities: readonly number[], rows: number, towardBottom: boolean): string {
  const steps = towardBottom ? densities : [...densities].reverse();
  let rects = '';
  steps.forEach((density, s) => {
    for (let i = 0; i < rows; i += 1) {
      const r = s * rows + i;
      for (let c = 0; c < 8; c += 1) {
        if (BAYER_8[(r % 8) * 8 + c] < density * 64) rects += `<rect x='${c * CELL}' y='${r * CELL}' width='2' height='2'/>`;
      }
    }
  });
  return tile(8 * CELL, steps.length * rows * CELL, rects);
}
// THE SHORT EDGE (`--edge-*`, 6px: three single cell rows): as deep as a line's empty margin
// above and below its mark, so on a list resting on whole lines (the board) it falls on bare
// ground and only ever touches a name while one is passing.
const SHORT = [5 / 6, 1 / 2, 1 / 6];
// THE DEEP EDGE (`--edge-deep-*`, 24px: three steps of four cell rows, three quarters, a half,
// a quarter): about a line of text deep, for what scrolls FREELY past an edge (prose under the
// header's band, the result's sticky credit, the words modal's top, the result page's foot) —
// a line passing there steps down through the cells, and is never sliced across a glyph by a
// strip thinner than it.
const DEEP = [3 / 4, 1 / 2, 1 / 4];
const EDGES = {
  '--edge-d': edgeTile(SHORT, 1, true),
  '--edge-u': edgeTile(SHORT, 1, false),
  '--edge-deep-d': edgeTile(DEEP, 4, true),
  '--edge-deep-u': edgeTile(DEEP, 4, false),
};

// THE DISSOLVE: the matrix's own tile at DISSOLVE_LEVELS densities, from nothing (`--dz-0`) to
// all but the last cells (`--dz-7`) — the board's `board-dissolve` keyframes step a line's mask
// through them, so a line comes in the way the meter charges: its cells lighting in threshold
// order, in hard steps, nothing travelling. And the same levels' COMPLEMENT (`--dzo-1` …
// `--dzo-7`, the cells not yet lit): what goes out as something comes in over it — the
// podium's players giving their place to the next — goes through exactly the cells the newcomer
// has not taken (`board-dissolve-out`); stacked in 16px steps, they also thin a drum's ends —
// and the lit levels, masking a veil of the ground, the foot of a list that holds more below.
const DISSOLVE_LEVELS = 8;
function levelTile(level: number, lit: boolean): string {
  let rects = '';
  for (let r = 0; r < 8; r += 1) {
    for (let c = 0; c < 8; c += 1) {
      if (BAYER_8[r * 8 + c] < (level * 64) / DISSOLVE_LEVELS === lit) {
        rects += `<rect x='${c * CELL}' y='${r * CELL}' width='2' height='2'/>`;
      }
    }
  }
  return tile(8 * CELL, 8 * CELL, rects);
}
const DISSOLVES: Record<string, string> = Object.fromEntries(
  Array.from({ length: DISSOLVE_LEVELS }, (_, level) => [
    [`--dz-${level}`, levelTile(level, true)],
    [`--dzo-${level}`, levelTile(level, false)],
  ]).flat(),
);

// THE DISSOLVE'S BEAT, for what script times against it: a slot's dissolve, in or out (the
// CSS keyframes' own 240ms) — the podium's raster gives way over the same — and the loading
// skeleton's lines, which come in only if the read is slow: this long, this far apart, then a
// dissolve each. The stagger is also what a screen's blocks come in apart (`.dissolve-in`,
// `--dz-stagger`).
export const DISSOLVE_MS = 240;
export const SKELETON_WAIT_MS = 320;
export const SKELETON_STAGGER_MS = 50;

// The tiles are custom properties on the DOCUMENT'S ROOT, set once as this module loads: every
// surface whose lines arrive that way (the board screen, its podium, the group's own screen in
// the top layer) inherits them, and none carries them in its own style.
if (typeof document !== 'undefined') {
  for (const [name, value] of Object.entries({
    ...DISSOLVES,
    ...EDGES,
    '--dz-stagger': `${SKELETON_STAGGER_MS}ms`,
  })) {
    document.documentElement.style.setProperty(name, value);
  }
}
