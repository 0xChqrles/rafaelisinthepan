// Word mode's rules (#156, retimed by #163): one daily word, its ranked neighborhood
// public knowledge to win. The player CLAIMS words in the top zone — the road zone of
// the #154 artifact — against a COUNTDOWN, and the score is how many they claimed.
// Claiming all of it is deliberately impossible: the zone is the field, not the goal.
//
// The clock REPLACED the strike system (#163). Two dailies should be two games:
// Sentence mode is think slowly and beat the AI, Word mode is think fast and beat the
// clock. The timer also legislates everything the strikes used to — a repeat, an
// invalid word or a far miss punishes itself, in the seconds it cost to type — so
// there is no strike bookkeeping, no consecutive rule, and nothing here ends a run.
//
// Everything in this module is PURE and derived from (ranks, ordered counted guesses),
// so a round survives a reload by replaying its `tried` log — exactly the sentence
// game's contract (see game/share.ts replayRun). The ONE thing replay does NOT decide
// is whether the run is over: that is a DEADLINE fact, wall-clock, held by the round
// state (state/gameStore.ts). Rendering and persistence live elsewhere.

import type { RankEntry, WordRanks } from '@whippin/shared';

// The claimable zone: the top-CLAIM_ZONE ranked groups — generation's flat road zone
// (ROAD_TOP), which is Word mode's whole playing field (#154). This is a GAME RULE
// mirroring the artifact's road zone, not the TOP_K map cap (which stays untested here:
// off-map is simply "no entry").
//
// It is NOT independently tunable: the field the board DRAWS is the set generation stamped
// a road on, so this number and ROAD_TOP move together or the board grows lane-less
// stations (wordGame.test.ts pins them). Widened 150 -> 250 on 2026-08-07 — a longer run,
// and an artifact generated at the old ceiling must be regenerated to carry roads that far.
export const CLAIM_ZONE = 250;

// ---- The economy (#163). Every constant below is a declared TUNING KNOB: nothing
// restates them, the HUD reads them and the tests derive their expectations from them,
// so retuning after a play session is a one-line change by construction. The values are
// PLACEHOLDERS until played — solo first, then beta testers. The margin question they
// answer: should an average claim's bonus roughly cover the typing cost of the next
// guess on MOBILE, the slower device? Too low and every run ends inside 90 seconds and
// reads as unwinnable; too high and every run exhausts the zone.

// What the clock starts at, in seconds, when START is tapped.
export const START_SECONDS = 60;

// What EVERY claim pays, before rarity. The floor of the curve: finding anything at all
// buys time, so a run of common finds still goes somewhere.
export const CLAIM_BASE_SECONDS = 2;

// The rarity ladder, read off the claimed group's `freq` — its most frequent embedded
// form's 1-based position in the reduced vocabulary (1 = the commonest word the game
// admits, larger = rarer; see RankEntry.freq). Ordered COMMONEST FIRST; a claim pays the
// `extra` of the first tier whose `upTo` it is within, and the last tier's `Infinity`
// makes the ladder total.
//
// Rarity is the bonus axis because it is ORTHOGONAL to the score: a closeness-scaled
// bonus would double-pay what the count already measures, where corpus rarity pays for
// vocabulary depth. It is also the knob that keeps long words worth their typing cost in
// a spam meta — rare words tend to be longer, so without it short common words dominate.
export const RARITY_TIERS: readonly { upTo: number; extra: number }[] = [
  { upTo: 3_000, extra: 0 }, // everyday vocabulary
  { upTo: 15_000, extra: 1 },
  { upTo: 60_000, extra: 2 },
  { upTo: Infinity, extra: 3 }, // the deep tail
];

// What one claim adds to the clock. `freq` is OPTIONAL by contract (an artifact
// generated before #163 carries none), and an unknown rarity pays the base alone —
// the run still works, it just stops rewarding depth.
export function bonusSeconds(freq: number | undefined): number {
  if (freq === undefined) return CLAIM_BASE_SECONDS;
  const tier = RARITY_TIERS.find((t) => freq <= t.upTo);
  return CLAIM_BASE_SECONDS + (tier?.extra ?? 0);
}

// The wall-clock LENGTH of a run whose claims have earned `bonus` seconds. The deadline
// is `startedAt + runMs(bonus)`, recomputed from the whole log on every write, so the
// clock can never drift away from the guesses that bought it.
export function runMs(bonus: number): number {
  return (START_SECONDS + bonus) * 1000;
}

// The total time a run's claims are WORTH — bounded by construction, since the zone is
// finite: a run cannot be infinite, and the field stays unclearable in practice.
export function totalBonus(claimed: readonly RankEntry[]): number {
  return claimed.reduce((sum, entry) => sum + bonusSeconds(entry.freq), 0);
}

// What one submitted, vocab-valid guess IS, before dedup:
//   claim — a zone group (1 <= rank <= CLAIM_ZONE): +1 word, +bonusSeconds on the clock.
//   near  — ranked, but outside the zone: nothing gained and nothing lost but the time
//           spent typing it. It still SHOWS its rank — that is the zone's teaching signal.
//   miss  — off-map (beyond the TOP_K cap): the same, with no rank to show.
//   zero  — the day's word itself (rank 0): free — it is public, on the board already.
export type WordJudgement =
  | { kind: 'claim'; entry: RankEntry }
  | { kind: 'near'; entry: RankEntry }
  | { kind: 'miss' }
  | { kind: 'zero' };

export function judgeWordGuess(ranks: WordRanks, typed: string): WordJudgement {
  const entry = ranks[typed];
  if (!entry) return { kind: 'miss' };
  if (entry.rank === 0) return { kind: 'zero' };
  if (entry.rank <= CLAIM_ZONE) return { kind: 'claim', entry };
  return { kind: 'near', entry };
}

// The canonical identity of a guess, for GROUP-LEVEL dedup (#104): inflections and
// accent aliases of one word share their group's rank, and the flat map is rank-unique
// per group, so the rank IS the group. A guess in no map has no group and falls back to
// its folded slug — two distinct off-map words are two distinct (counted) guesses,
// exactly like the sentence game's guessKey fallback.
export function wordGuessKey(ranks: WordRanks, typed: string): string {
  const entry = ranks[typed];
  return entry ? `r:${entry.rank}` : `s:${typed}`;
}

// One guess that COUNTED, in submission order: what was typed and how it landed. Free
// guesses (repeats, the day's word) are absent, so a consumer can partition this list
// without knowing a single rule.
export interface CountedGuess {
  typed: string;
  judged: WordJudgement; // never 'zero' — the word itself is free
}

// One round replayed from its ordered counted guesses. `tried` holds ONLY counted
// guesses (free guesses never enter it), but the replay stays robust to junk: a repeat
// or a rank-0 entry in the log is skipped.
//
// Nothing here decides that the run is OVER. That question is the deadline's — a
// wall-clock fact the log cannot see (#163) — and the store answers it; this walk
// answers what the log MEANS, which is what the board and the score are drawn from.
//
// This is the ONE walk of a word round. The board (game/wordBoard.ts) draws itself from
// `counted` rather than re-deriving the rules, so the score, the clock and the drawing
// can never disagree about what the same log means.
export interface WordRun {
  // Ranks of the claimed zone groups, in claim order. Its length is the SCORE.
  claimedRanks: number[];
  // Seconds those claims bought, in total — the clock's whole extension (see runMs).
  bonus: number;
  // Every counted guess, in order — the run as the player played it.
  counted: CountedGuess[];
}

export function replayWordRun(ranks: WordRanks, tried: readonly string[]): WordRun {
  const seen = new Set<string>();
  const counted: CountedGuess[] = [];
  const claimedRanks: number[] = [];
  const claimed: RankEntry[] = [];
  for (const typed of tried) {
    const key = wordGuessKey(ranks, typed);
    if (seen.has(key)) continue; // repeats are free, never counted
    seen.add(key);
    const judged = judgeWordGuess(ranks, typed);
    if (judged.kind === 'zero') continue; // the word itself is free
    counted.push({ typed, judged });
    if (judged.kind === 'claim') {
      claimedRanks.push(judged.entry.rank);
      claimed.push(judged.entry);
    }
  }
  return { claimedRanks, bonus: totalBonus(claimed), counted };
}
