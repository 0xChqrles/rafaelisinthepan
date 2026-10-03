import { COUNT_EM, COUNT_ROWS } from '@whippin/shared';

// THE RESULT'S COUNT SIZE on the screen (pure): the count `SolvedCard` draws is the face's own
// glyph cells (shared `countCells.ts`), and the face is crisp only at WHOLE SCALES — multiples
// of 8px. So the count's size is the LARGEST multiple of 8 whose box (its ink, shared `inkEms`)
// fits both the hero's width and the height the card can spare it (SHARE must stay above the
// fold), between a floor and a ceiling that depends on the column: a phone's 160, the
// desktop's 192.
export const COUNT_MIN_PX = 32;
export const COUNT_MAX_PX = 160;
export const COUNT_MAX_WIDE_PX = 192;

// The count's size in px: the largest whole multiple of 8 at which its box — `ems` wide on
// its ink, the face's cap height (COUNT_ROWS of the em's 8 rows) tall — fits `width` and
// `height`, under the column's ceiling (`wide`: the desktop's), never under the floor.
export function countSize(width: number, height: number, ems: number, wide: boolean): number {
  const max = wide ? COUNT_MAX_WIDE_PX : COUNT_MAX_PX;
  const fitWidth = Math.floor(width / (ems * COUNT_EM)) * COUNT_EM;
  const fitHeight = Math.floor(height / COUNT_ROWS) * COUNT_EM;
  return Math.max(COUNT_MIN_PX, Math.min(max, fitWidth, fitHeight));
}
