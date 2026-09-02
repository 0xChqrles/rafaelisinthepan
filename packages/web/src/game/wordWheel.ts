// The WHEEL: the order the words already found for a tapped hole scroll through it in
// (user-decided 2026-09-01, the day's fifth approach and the one that stuck — after the
// history modal's line, a radial net with lines twice revised, and a plain stack: "a
// simple list… maybe with some scroll snapping, an item-by-item scrolling"). ONE ranked
// column runs THROUGH the tapped word's place, which is a fixed SLOT: farther words above
// it, closer words below, so the column reads top to bottom as the walk toward the secret
// — and the word in the slot is the one the sentence shows. EVERY stop is a row the wheel
// can reach and pick (user-decided 2026-09-01: "let the wheel reach all the words", then
// "you should be able to select far words") — the words behind the start included, which
// simply come first by rank.
//
// Pure and tested; rendering is components/HistoryWheel.

import type { HistoryStop } from './history';

// Top to bottom: farthest first, closest last.
export function wheelOrder(stops: readonly HistoryStop[]): HistoryStop[] {
  return [...stops].sort((a, b) => b.rank - a.rank);
}
