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

import type { RuntimeHole } from './types';
import type { HoleCharge } from './charge';
import type { HistoryStop } from './history';

// Top to bottom: farthest first, closest last.
export function wheelOrder(stops: readonly HistoryStop[]): HistoryStop[] {
  return [...stops].sort((a, b) => b.rank - a.rank);
}

export interface WordPick {
  word: string;
  rank: number;
  at: number;
  slug?: string;
  order: number;
}

// Keep selection order separately from sentence order. Each hole retains its display pick.
export function selectWord(
  picks: Record<number, WordPick>,
  index: number,
  stop: HistoryStop,
  at: number,
): Record<number, WordPick> {
  const order = Math.max(0, ...Object.values(picks).map((p) => p.order)) + 1;
  return {
    ...picks,
    [index]: { word: stop.display, rank: stop.rank, at, slug: stop.masked ? stop.slug : undefined, order },
  };
}

// The board as the sentence shows it: a live pick stands in its hole's place. A pick made
// against another rank, on a solved hole, or of the hole's own word is simply the hole; so
// is a masked pick the meters no longer offer — or any masked pick on a board that shows
// no meters (`charges` undefined). A picked MASK shows the mask until the reveal lands:
// the revealed word is closer than the best it was picked against, so the hole improves
// to it and shows it as its own.
export function shownHolesFor(
  holes: readonly RuntimeHole[],
  picked: Record<number, WordPick>,
  charges: readonly HoleCharge[] | undefined,
): RuntimeHole[] {
  return holes.map((h, i) => {
    const p = picked[i];
    if (!p || h.rank === 0 || p.at !== h.rank || p.rank === h.rank) return h;
    if (p.slug && !charges?.[i].given.some((g) => g.rank === p.rank)) return h;
    return { ...h, word: p.word, rank: p.rank };
  });
}

// THE GHOST: the latest masked pick still standing — picked against the hole's current
// best and still on offer in `charges` — is the one the REVEAL submits. A taken, improved
// or replaced pick is no ghost.
export function latestMaskedPick(
  picks: Record<number, WordPick>,
  holes: readonly RuntimeHole[],
  charges: readonly HoleCharge[],
): { index: number; slug: string } | null {
  let latest: { index: number; slug: string; order: number } | null = null;
  for (let index = 0; index < holes.length; index += 1) {
    const h = holes[index];
    const p = picks[index];
    if (!p?.slug || h.rank === 0 || p.at !== h.rank) continue;
    if (!charges[index]?.given.some((g) => g.rank === p.rank && !g.consumed)) continue;
    if (!latest || p.order > latest.order) latest = { index, slug: p.slug, order: p.order };
  }
  if (!latest) return null;
  const { index, slug } = latest;
  return { index, slug };
}

// BACK: every masked pick undone — each hole shows its own word again and no ghost stands,
// so the keyboard returns. Picks of words the player holds stay.
export function withoutMaskedPicks(picks: Record<number, WordPick>): Record<number, WordPick> {
  return Object.fromEntries(Object.entries(picks).filter(([, p]) => !p.slug));
}
