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
const EDGE_CELLS = 3;
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
const EDGES = {
  '--edge-d': edgeTile(true),
  '--edge-u': edgeTile(false),
};

// THE DISSOLVE: the matrix's own tile at DISSOLVE_LEVELS densities, from nothing (`--dz-0`) to
// all but the last cells (`--dz-7`) — the board's `board-dissolve` keyframes step a line's mask
// through them, so a line comes in the way the meter charges: its cells lighting in threshold
// order, in hard steps, nothing travelling. And the same levels' COMPLEMENT (`--dzo-1` …
// `--dzo-7`, the cells not yet lit): what goes out as something comes in over it — the
// podium's players giving their place to the next — goes through exactly the cells the newcomer
// has not taken (`board-dissolve-out`).
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

// The tiles are custom properties on the DOCUMENT'S ROOT, set once as this module loads: every
// surface whose lines arrive that way (the board screen, its podium, the group's own screen in
// the top layer) inherits them, and none carries them in its own style.
if (typeof document !== 'undefined') {
  for (const [name, value] of Object.entries({ ...DISSOLVES, ...EDGES })) {
    document.documentElement.style.setProperty(name, value);
  }
}

// THE DISSOLVE'S BEAT, for what script times against it: a slot's dissolve, in or out (the
// CSS keyframes' own 240ms) — the podium's raster gives way over the same — and the loading
// skeleton's lines, which come in only if the read is slow: this long, this far apart, then a
// dissolve each.
export const DISSOLVE_MS = 240;
export const SKELETON_WAIT_MS = 320;
export const SKELETON_STAGGER_MS = 50;

// Whether a slot dissolving in from `delayMs` had come in after `shownFor` on screen. What gives
// way sends out only the slots that had: one still coming in simply goes (drawn whole to leave,
// it would flash in at full ink first). Slots come in in order, so those are always the first
// ones, and every slot they leave in place is where it was.
export const cameIn = (delayMs: number, shownFor: number): boolean => shownFor >= delayMs + DISSOLVE_MS;
