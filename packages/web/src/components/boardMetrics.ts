// A BOARD'S METRICS (pure): the measures every surface that lists players on a day shares —
// the lines (`BoardRows`), the board screen's podium (`podium/scene.ts`), the group's own
// screen — kept apart from any component so a raster module can read them.

// A mark at an INTEGER cell scale: 10 cells of 3px.
export const MARK = 30;
// A line's PITCH: every item of the board screen's list — a line, the rail where rows are left
// out — is this tall, so a list is a column of whole slots (and the board screen's podium stands
// in whole slots of it).
export const LINE_PX = 44;
// The RANK COLUMN a list (or every tab of the result's boards) shares, so nothing moves from line
// to line: as wide as its widest rank in the ranks' 16px digits, two at the least.
export const RANK_DIGIT_PX = 16;
export const rankColumnPx = (digits: number): number => Math.max(2, digits) * RANK_DIGIT_PX;
