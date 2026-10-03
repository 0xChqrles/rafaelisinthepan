import { BAYER_8 } from './bayer';
import { progressHeatColor } from './heat';
import { T0, noise3 } from './noise';

// THE RUN'S HEAT (pure), rising off the result's ruler — on the screen (web `RunHeat`, which
// animates it) and on the share card (`cardSvg.ts`, which draws it still): the run drawn a
// second time, as the cards draw a distance — in the heat's own inks, ORDERED-DITHERED on whole
// cells (`bayer.ts`, the app's one way of turning a density into pixels). Every column stands
// over the ruler cell under it, in that try's ink, and rises as high as that try's
// reconstruction got: a run's climb reads as a skyline climbing toward its cobalt end, densest
// on the bar and thinning to nothing above it. An unfinished run never reaches the full height
// nor the cobalt. A static grain of the app's one value noise (`noise.ts`) breaks the rows, so
// it reads as heat and not as a bar chart.
//
// Measured in CELLS, on a field `cols × rows` whose bottom row stands on the bar's top edge:
// the screen paints it on 2px cells (HEAT_CELL_PX), the card on its own larger cell, so the
// two are the same picture at two scales.

// The screen's cell, in CSS px.
export const HEAT_CELL_PX = 2;
// A column's height: HEAT_FLOOR of the field at 0%, the whole field at 100%, at rest
// HEAT_REST of the field (the screen's landing surge rises into the rest).
const HEAT_FLOOR = 0.16;
const HEAT_REST = 0.78;
// The density on the bar, falling to nothing at the column's top along a power curve.
const HEAT_BASE = 0.62;
const HEAT_GAMMA = 1.7;
// The grain: one octave of value noise, a lattice unit of GRAIN_X × GRAIN_Y cells, scaling
// the density between GRAIN_FLOOR and GRAIN_FLOOR + GRAIN_SPAN.
const GRAIN_X = 3;
const GRAIN_Y = 5;
const GRAIN_FLOOR = 0.55;
const GRAIN_SPAN = 0.9;
// The field's TOP is ragged, never a ruled line: each column's height is scaled by the same
// noise read along the bar (a lattice unit of EDGE_X cells), between 1 − EDGE_JAG and
// 1 + EDGE_JAG — so a plateau of equal tries (or a one-try run's single column) still
// rises as heat, not as a block.
const EDGE_X = 5;
const EDGE_JAG = 0.22;
// The landing surge (the screen's): at its full `lift` the field is SURGE_GAIN denser and
// rises to the whole field.
const SURGE_GAIN = 0.9;

export interface HeatField {
  cols: number;
  rows: number;
  // The bar's width the columns are laid over, in the same unit as `cell` — the try under a
  // column is the one under its centre.
  width: number;
  cell: number;
  trajectory: readonly number[];
  // How many tries are written (the tally's count): a later try's columns stay bare.
  shown: number;
  // How far try `i`'s column has risen, 0–1 (1: whole).
  rise: (i: number) => number;
  // The landing surge, 0 (at rest) to 1 (its hit).
  lift: number;
  // THE CLEARING: a density multiplier at a cell (column `cx`, row `cy` counted UP from the
  // bar), 0 at what stands in the heat, rising to 1 away from it — or null for none.
  clear: ((cx: number, cy: number) => number) | null;
}

// Every inked cell of the field: `put(colour, cx, cy)`, column by column from the bar up, `cy`
// counted up from the bar.
export function heatCells(
  { cols, rows, width, cell, trajectory, shown, rise, lift, clear }: HeatField,
  put: (color: string, cx: number, cy: number) => void,
): void {
  const n = trajectory.length;
  if (n === 0) return;
  const restRows = rows * HEAT_REST;
  const peakRows = restRows + (rows - restRows) * lift;
  const gain = 1 + SURGE_GAIN * lift;
  for (let cx = 0; cx < cols; cx += 1) {
    // The try under this column's centre.
    const i = Math.min(n - 1, Math.floor((((cx + 0.5) * cell) / width) * n));
    if (i >= shown) continue;
    const pct = trajectory[i];
    const up = rise(i);
    const jag = 1 + EDGE_JAG * (2.4 * (noise3(cx / EDGE_X, 0.5, T0 + 7.3) - 0.5));
    const tall = Math.min(rows, peakRows * (HEAT_FLOOR + (1 - HEAT_FLOOR) * (pct / 100)) * up * jag);
    if (tall <= 0) continue;
    const color = progressHeatColor(pct);
    for (let cy = 0; cy < tall && cy < rows; cy += 1) {
      const fall = (1 - cy / tall) ** HEAT_GAMMA;
      const grain = GRAIN_FLOOR + GRAIN_SPAN * noise3(cx / GRAIN_X, cy / GRAIN_Y, T0);
      let d = Math.min(1, HEAT_BASE * fall * grain * gain);
      if (clear) d *= clear(cx, cy);
      if (BAYER_8[((cy & 7) << 3) | (cx & 7)] < d * 64) put(color, cx, cy);
    }
  }
}

// THE CLEARING round what stands IN the heat — the count, its unit: bare for `clear` px round
// each box, the heat returning over `ramp` px, its corners rounded by the distance. A digit
// clears HEAT_CLEAR_PX round its ink box and returns over one of the face's pixels; the unit
// clears HEAT_UNIT_CLEAR_PX and returns over HEAT_UNIT_RAMP_PX — long enough to read as a
// clearing (the screen's px; the card scales them with its cell).
export const HEAT_CLEAR_PX = 4;
export const HEAT_UNIT_CLEAR_PX = 2;
export const HEAT_UNIT_RAMP_PX = 18;

export interface HeatKeep {
  x: number;
  y: number;
  w: number;
  h: number;
  clear: number;
  ramp: number;
}

// The density multiplier at a point: 0 inside a kept box's margin, 1 past its ramp.
export function heatKeepOut(keeps: readonly HeatKeep[], x: number, y: number): number {
  let m = 1;
  for (const k of keeps) {
    const dx = Math.max(0, k.x - x, x - (k.x + k.w));
    const dy = Math.max(0, k.y - y, y - (k.y + k.h));
    m = Math.min(m, Math.max(0, Math.min(1, (Math.hypot(dx, dy) - k.clear) / k.ramp)));
  }
  return m;
}
