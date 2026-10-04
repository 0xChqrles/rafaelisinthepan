// THE CALENDAR'S SIZES, off the room it is given: the keys of the month (`keysScene.ts` draws
// them) at one of a few whole sizes, each a WHOLE number of the house's 2px cells with even gaps,
// so every key, digit and dither of the raster lands on whole pixels — never a fractional `1fr`
// track. The first candidate that fits wins:
//
//   WIDE      a desktop column (560): 64px keys, the board's own column filled.
//   MID       a short desktop window: 52px keys, still stacked under the month row.
//   REGULAR   a phone: 44px keys — one line of the boards' pitch, a real target.
//   COMPACT   the commonest Android width (360: a 332px column): 40px keys on the regular
//             gaps — the narrow month would stand lost in that room, its gaps half the rows'.
//   NARROW    a phone under 328px of column (320 wide): 38px keys on 4px gaps, "31" with two
//             cells of air each side.
//   SIDEWAYS  a desktop-width window too short for any stacked month (a landscape phone): the
//             month row and its note on the left, the weekdays and 44 × 32 keys on the right.
//
// Phones are always STACKED (their page scrolls if it must); above 640px the page does not
// scroll, so the stacked month must end above the window's foot (`FOOT_PX` clear of the device
// frame's texts) or the month goes sideways. A resize re-seats the picture (`MonthRaster`) and
// never replays its build.

export const CELL_PX = 2;
// The raster reaches this many cells past the grid on every side: room for a run's wrap stubs,
// today's drop and shake, a pressed key's sink.
export const BLEED = 4;
// The stacked column, top to bottom: the month row, its air, the weekday letters, their air,
// the grid, a gap, and the HOLD (the failed read's note over RETRY, reserved in every state).
export const TABS_PX = 44;
export const WEEKDAYS_PX = 12;
export const HOLD_GAP_PX = 8;
export const HOLD_PX = 72;
// Where the month row's top stands in a desktop window (`.app`'s 24px + the column's 58px:
// the board screen's own), and how far above the window's foot a stacked month must end.
const STACK_TOP_PX = 82;
const FOOT_PX = 40;
// Under this grid width the hold's note steps down a size (fr's failure line on one line).
export const NOTE_NARROW_BELOW_PX = 356;

export type CalName = 'wide' | 'mid' | 'regular' | 'compact' | 'narrow' | 'sideways';
export type CalLayout = 'stacked' | 'sideways';

interface Candidate {
  name: CalName;
  phone: boolean;
  layout: CalLayout;
  // The key (cells), the gaps between keys (px, even), and the air between the column's rows.
  keyW: number;
  keyH: number;
  colGapPx: number;
  rowGapPx: number;
  airPx: number;
}

const CANDIDATES: readonly Candidate[] = [
  { name: 'wide', phone: false, layout: 'stacked', keyW: 32, keyH: 32, colGapPx: 8, rowGapPx: 8, airPx: 8 },
  { name: 'mid', phone: false, layout: 'stacked', keyW: 26, keyH: 26, colGapPx: 8, rowGapPx: 8, airPx: 8 },
  { name: 'regular', phone: true, layout: 'stacked', keyW: 22, keyH: 22, colGapPx: 8, rowGapPx: 8, airPx: 8 },
  { name: 'compact', phone: true, layout: 'stacked', keyW: 20, keyH: 20, colGapPx: 8, rowGapPx: 8, airPx: 8 },
  { name: 'narrow', phone: true, layout: 'stacked', keyW: 19, keyH: 19, colGapPx: 4, rowGapPx: 8, airPx: 4 },
  { name: 'sideways', phone: false, layout: 'sideways', keyW: 22, keyH: 16, colGapPx: 8, rowGapPx: 8, airPx: 8 },
];

export interface CalGeometry {
  name: CalName;
  layout: CalLayout;
  // The key and the gaps between keys, in cells.
  keyW: number;
  keyH: number;
  colGap: number;
  rowGap: number;
  // The same in CSS px, and the grid's box: seven keys across, six weeks down.
  keyWPx: number;
  keyHPx: number;
  colGapPx: number;
  rowGapPx: number;
  gridW: number;
  gridH: number;
  // Where the grid stands in its column (whole px), and the air between the column's rows.
  gridX: number;
  airPx: number;
  // The raster, in cells: the grid and its bleed.
  cols: number;
  rows: number;
}

function geometryOf(c: Candidate, columnPx: number): CalGeometry {
  const keyWPx = c.keyW * CELL_PX;
  const keyHPx = c.keyH * CELL_PX;
  const gridW = 7 * keyWPx + 6 * c.colGapPx;
  const gridH = 6 * keyHPx + 5 * c.rowGapPx;
  return {
    name: c.name,
    layout: c.layout,
    keyW: c.keyW,
    keyH: c.keyH,
    colGap: c.colGapPx / CELL_PX,
    rowGap: c.rowGapPx / CELL_PX,
    keyWPx,
    keyHPx,
    colGapPx: c.colGapPx,
    rowGapPx: c.rowGapPx,
    gridW,
    gridH,
    gridX: c.layout === 'stacked' ? Math.max(0, Math.floor((columnPx - gridW) / 2)) : 0,
    airPx: c.airPx,
    cols: gridW / CELL_PX + 2 * BLEED,
    rows: gridH / CELL_PX + 2 * BLEED,
  };
}

// The stacked column's height from the month row's top to the hold's foot.
export function stackedHeightPx(G: Pick<CalGeometry, 'gridH' | 'airPx'>): number {
  return TABS_PX + G.airPx + WEEKDAYS_PX + G.airPx + G.gridH + HOLD_GAP_PX + HOLD_PX;
}

// `columnPx`: the column's width (the board's, `min(560, room)`); `roomH`: the window's
// height; `phone`: a phone-width window (≤ 640).
export function calGeometry(columnPx: number, roomH: number, phone: boolean): CalGeometry {
  const fits = (c: Candidate) => {
    const G = geometryOf(c, columnPx);
    if (c.layout === 'sideways') return true;
    if (G.gridW > columnPx) return false;
    return phone || STACK_TOP_PX + stackedHeightPx(G) <= roomH - FOOT_PX;
  };
  const mine = CANDIDATES.filter((c) => c.phone === phone || (!phone && c.layout === 'sideways'));
  const pick = mine.find(fits) ?? mine[mine.length - 1];
  return geometryOf(pick, columnPx);
}
