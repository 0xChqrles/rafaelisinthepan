// Solved-screen share (issue #8).
//
// The result is packed into a URL token and shared as `<origin>/s/<token>`, so pasting the
// link unfurls into the rendered image instead of an emoji string. The CARD gets the raw
// per-guess trajectory + solve moments (v2 token, decided 2026-07-25) and draws the RUN RULER
// the solved screen shows. The plain-text emoji row is a BOUNDED summary of that same run
// (3..18 cells, see rowMeans) — a text message can't take a 62-emoji line.

import { computeProgress } from './scoring';
import { RARITY_NAMES, type Rarity } from './wordGame';
import {
  dateForDayNumber,
  encodeResult,
  encodeWordResult,
  progressEmoji,
  wordShareScore,
  type RankMap,
  type RuntimeHole,
  type ShareResult,
  type WordShareResult,
} from '@whippin/shared';

// The ruler's two halves, replayed in ONE walk (they are the same walk: the same ordered
// guesses under the same improvement rule as the live game loop, Game.submit). Keeping
// them in one function is what stops the bar's cells and its ticks from ever disagreeing
// about the same run — and every caller wants both, for the player and for each opponent.
//
// Everything here rests on `tried` being a COMPLETE record of the state changes: a guess the
// log omits is a guess this replay cannot see. That is why the counted-try identity compares
// a guess's outcome on every hole (`guessKey`) — a deduped guess resolves identically
// everywhere, so it provably changed nothing, and the walk always lands on the real board.
// Read that comment before touching either side; they are one contract.
//
//   trajectory — the reconstruction % AFTER each guess. Starts from `freshHoles` (each at
//     its start_rank), monotonic non-decreasing, and the guess that solved the sentence
//     lands at 100. One value per guess, so `.length === guessCount`.
//   solvedAt — per DISTINCT secret in sentence order (first occurrence's pos), the 1-based
//     try that dropped it, or null when the run never does (a DNF opponent). Every
//     occurrence of a repeated secret solves on the same guess (they share one rank map),
//     so one distinct secret = one tick.
export interface RunReplay {
  trajectory: number[];
  solvedAt: (number | null)[];
}

export function replayRun(freshHoles: RuntimeHole[], ranks: RankMap, tried: string[]): RunReplay {
  const holes = freshHoles.map((h) => ({ ...h }));
  const secrets = holes.map((h) => h.secret).filter((s, i, a) => a.indexOf(s) === i);
  const trajectory: number[] = [];
  const solvedAt: (number | null)[] = secrets.map(() => null);
  tried.forEach((typed, i) => {
    for (const h of holes) {
      if (h.rank === 0) continue; // solved holes are locked, exactly as in-game
      const entry = ranks[h.secret]?.[typed];
      if (entry && entry.rank < h.rank) h.rank = entry.rank;
    }
    trajectory.push(computeProgress(holes, ranks));
    secrets.forEach((s, si) => {
      if (solvedAt[si] === null && holes.every((h) => h.secret !== s || h.rank === 0)) {
        solvedAt[si] = i + 1;
      }
    });
  });
  return { trajectory, solvedAt };
}

// The shareable link: the result packed into a URL-safe token at `<origin>/s/<token>` (the
// codec lives in @whippin/shared, so the backend decodes the same token to render the card).
// Pasting the link unfurls into the OG image instead of a string of emoji.
export function shareUrl(origin: string, result: ShareResult): string {
  return `${origin}/s/${encodeResult(result)}`;
}

// --- the shared TEXT's bounded row ------------------------------------------------------
// The row is CAPPED (decided 2026-07-25, superseding the cell-for-cell row shipped earlier
// the same day): pasting 62 emoji into a message is not a result, it's a wall. Same curve
// the heat squares used before this change — 3 at minimum (a sentence always has 3 secrets
// to find), one more cell at each breakpoint, 18 at most — with each cell the MEAN progress
// of its contiguous bucket. Progress is monotonic non-decreasing and the buckets are
// contiguous, so the means are too: the row always reads cold -> hot.
//
// This bound is the ROW's alone. The on-screen ruler and the card still draw one cell per
// counted try (the v2 token carries the raw run), because neither has to fit in a text
// message — so the row is a SUMMARY of the bar now, not the bar itself.
export const ROW_BREAKPOINTS = [4, 6, 10, 15, 22, 33, 48, 70, 100, 120, 150, 180, 215, 255, 300];
export const MIN_ROW_CELLS = 3;
export const MAX_ROW_CELLS = MIN_ROW_CELLS + ROW_BREAKPOINTS.length; // 18

// How many emoji a run of `tries` collapses to. Half-open: `tries >= t` adds a cell.
export function rowCellCount(tries: number): number {
  let m = MIN_ROW_CELLS;
  for (const t of ROW_BREAKPOINTS) {
    if (tries >= t) m += 1;
    else break; // breakpoints ascend, so the first miss ends it
  }
  return m;
}

// Cell i covers trajectory indices [start, end). ONE definition, used by both the means and
// the keycap placement below — they have to agree on which try lands in which cell, and two
// copies of this arithmetic would be free to drift.
function rowBuckets(n: number, m: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (let i = 0; i < m; i += 1) {
    const start = Math.floor((i * n) / m);
    out.push({ start, end: Math.max(start + 1, Math.floor(((i + 1) * n) / m)) });
  }
  return out;
}

// The trajectory collapsed into exactly `rowCellCount(n)` contiguous, as-equal-as-possible
// buckets, each carrying its bucket's mean — EXCEPT the last, which is pinned to the final
// try. Averaging the tail could otherwise end a solved run mid-ramp: a grind that plateaus
// at 61% and solves on its last guess has a final bucket whose mean is nowhere near 100, so
// the row closed on 🟥 and read as unfinished. The last cell is the one cell that always
// means something exact — "this is where you ended" — so it is never a mean. (On a SOLVED
// run the last cell renders as a keycap instead, see below; the pin is what a row without
// solve moments still ends on.)
export function rowMeans(trajectory: number[]): number[] {
  const n = trajectory.length;
  if (n === 0) return [];
  const m = rowCellCount(n);
  const out = rowBuckets(n, m).map(({ start, end }) => {
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += trajectory[j];
    return sum / (end - start);
  });
  out[m - 1] = trajectory[n - 1];
  return out;
}

// Sentence-position keycaps, one per hole (1..3): digit + VS16 + COMBINING ENCLOSING KEYCAP.
const HOLE_KEYCAPS = ['1️⃣', '2️⃣', '3️⃣'];

// The run in plain text: the bounded row above, on the SAME heat ramp as the ruler
// (`progressEmoji` sits with the ramp stops in @whippin/shared — each stop carrying its own
// emoji — so the two can't drift).
// This is the fallback where no card image renders — SMS, forwarded or plain-text messages,
// preview-less clients.
//
// **The row carries the ruler's TICKS too (decided 2026-07-25):** a cell holding a try that
// dropped a secret renders as that hole's sentence-position KEYCAP instead of its ramp color,
// so the row shows the order you cracked the sentence, not just how the reconstruction moved
// — `🟦🟩1️⃣🟧🟧🟧🟧🟧🟧2️⃣3️⃣`. This is what the bar does with a mark between two cells and a
// number under it; a single line has neither, so the number takes the cell. Consequences,
// all accepted: the solve cells lose their color; several secrets dropped inside ONE cell
// show every keycap (in sentence order, the same order the ruler stacks them under a shared
// tick), so the row can run to MAX_ROW_CELLS + 2; and since the final try always solves, a
// finished run ALWAYS ends on a keycap.
//
// Emoji, NOT the ramp's hexes: the row has to survive contexts with zero rendering support
// beyond Unicode. `solvedAt` is optional — without it the row is the plain ramp.
export function emojiRow(trajectory: number[], solvedAt: (number | null)[] = []): string {
  const n = trajectory.length;
  if (n === 0) return '';
  const cells = rowMeans(trajectory);
  const buckets = rowBuckets(n, cells.length);
  // hole index (0-based, sentence order) -> the cell its solving try falls in.
  const keycaps = new Map<number, string[]>();
  solvedAt.forEach((at, hole) => {
    if (at == null || hole >= HOLE_KEYCAPS.length) return;
    const cell = buckets.findIndex(({ start, end }) => at - 1 >= start && at - 1 < end);
    if (cell === -1) return;
    keycaps.set(cell, [...(keycaps.get(cell) ?? []), HOLE_KEYCAPS[hole]]);
  });
  return cells.map((pct, i) => keycaps.get(i)?.join('') ?? progressEmoji(pct)).join('');
}

// BOTH modes' share headline. The two screens each localize their own UNIT — tries against
// words, and only they know which — but the shape of the line is one message format, so it
// lives here with the rest of the composition rather than as a template literal hand-copied
// into two components, where one mode's message could quietly drift from the other's.
//
// The day is named by its CALENDAR DATE, not the internal day index (decided 2026-08-03): a
// reader can date the puzzle, and it is the same string the card draws and the shared link
// resolves to. `dateForDayNumber` is `dayNumber`'s exact inverse, so this is still the
// SERVER-owned game day, never the sharer's local date.
export function shareHeadline(dayNumber: number, score: number, unit: string): string {
  return `Whippin AI ${dateForDayNumber(dayNumber)} — ${score} ${unit}`;
}

// The shared/copied plain text: the headline, then the emoji row on its own line (attached
// to the headline block), a blank line for unfurl separation, then the (unfurling) link. Pure
// + i18n-free (the caller localizes `headline`) so the composition is unit-testable without
// the DOM. Same run the token carries — trajectory AND solve moments — so the row and the
// card it stands in for can disagree about LENGTH but never about the game.
export function shareText(
  headline: string,
  trajectory: number[],
  solvedAt: (number | null)[],
  url: string,
): string {
  return `${headline}\n${emojiRow(trajectory, solvedAt)}\n\n${url}`;
}

// --- Word mode's share (#156; the rarity breakdown 2026-08-11) ---------------------------
// The same job for the other daily, and it lives HERE for that reason: this module is where
// a RESULT becomes the text and the link it travels as, for both modes. `rarityRow` below is
// the exact analogue of `emojiRow` above — the run said in emoji, for a medium that has no
// colour — so the two sit together rather than one hiding in a component.

// A grade's BEAD: the emoji nearest the grade's screen colour (`components/rarity.ts`
// `RARITY_COLORS`). ONE SHAPE for the whole ladder — circles — so the row reads as five
// steps of one thing and the eye compares colours rather than sorting shapes. The pink
// heart is the single exception, and only because Unicode offers no pink circle while red
// stays reserved for MISS; it lands on the rarest grade, where a flourish is the right kind
// of wrong. The loot convention rides along for free: green uncommon, blue rare, purple epic.
export const RARITY_EMOJI: Record<Rarity, string> = {
  COMMON: '⚪',
  UNCOMMON: '🟢',
  RARE: '🔵',
  OBSCURE: '🟣',
  ARCANE: '🩷',
};

// The breakdown as one line: a bead + its count per grade the run CLAIMED, commonest first,
// zero grades omitted — `⚪7 🟢3 🔵1 🩷1`. Omitting the zeroes is what makes the row say
// something: a deep run opens on cyan, and the shape of the line is the shape of the hand.
// Takes the counts in ladder order (the share token's own shape) and returns '' for a
// scoreless run, so the caller drops the line entirely rather than printing an empty one.
export function rarityRow(counts: readonly number[]): string {
  return RARITY_NAMES.map((grade, step) =>
    (counts[step] ?? 0) > 0 ? `${RARITY_EMOJI[grade]}${counts[step]}` : '',
  )
    .filter(Boolean)
    .join(' ');
}

export function wordShareUrl(origin: string, result: WordShareResult): string {
  return `${origin}/s/${encodeWordResult(result)}`;
}

// Word mode's plain text: the headline, then the RESULT BLOCK — the day's word in
// locale-aware uppercase (accents kept, never the slug) with its bead row directly under
// it — then a blank line and the unfurling link. The word carries no leading emoji
// (user-decided 2026-08-11): uppercase on its own line already sets it apart, and a bullet
// on the one line that is not a list reads as a stray. Pure + i18n-free (the caller
// localizes `headline`) like its sentence twin, so the composition is unit-testable and
// the preview tooling renders the REAL string instead of a copy of it.
export function wordShareText(
  headline: string,
  word: string,
  lang: string,
  counts: readonly number[],
  url: string,
): string {
  const beads = rarityRow(counts);
  const block = `${word.toLocaleUpperCase(lang)}${beads ? `\n${beads}` : ''}`;
  return `${headline}\n\n${block}\n\n${url}`;
}

// The claim count a surface names is the breakdown's SUM — re-exported here so a caller
// composing the headline reads it from the same module that composes the body.
export { wordShareScore };
