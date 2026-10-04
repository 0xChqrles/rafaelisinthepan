// A BOARD'S METRICS (pure): the measures every surface that lists players on a day shares —
// the lines (`BoardRows`), the board screen's podium (`podium/scene.ts`), the group's own
// screen — kept apart from any component so a raster module can read them.

// A mark at an INTEGER cell scale: 10 cells of 3px.
export const MARK = 30;
// A line's PITCH: every item of a board's list — a line, a section's caption, the rail where
// rows are left out — is this tall, so a list is a column of whole slots (and the board
// screen's podium stands in whole slots of it).
export const LINE_PX = 44;
