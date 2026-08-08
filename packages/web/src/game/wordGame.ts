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

// The five NAMED rarity grades a claim can earn, commonest first. They are shown to the
// player — on the word, as the float that used to be the rank exponent — and they are
// UNTRANSLATED in every language, like MISS / YOU / DNF: one word per grade, identical
// everywhere, so the ladder reads the same to everyone.
export const RARITY_NAMES = ['COMMON', 'UNCOMMON', 'RARE', 'OBSCURE', 'ARCANE'] as const;
export type Rarity = (typeof RARITY_NAMES)[number];

// The ladder itself. `within` is the fraction of the CORPUS a grade reaches: a group is
// COMMON when its most frequent embedded form sits inside the commonest 10% of the words
// the game knows, ARCANE when nothing shallower claims it. `seconds` is what that grade
// pays the clock.
//
// TWO decisions are baked into this shape, both measured on real generated artifacts
// (fr ocean/montagne, en ocean/mountain — 1000 zone groups):
//
//   1. RARITY IS RELATIVE TO THE CORPUS, not an absolute frequency rank. The two
//      languages' vocabularies are very different sizes (en 75k, fr 128k), so the same
//      absolute rank means very different things in them. Measured on the same artifacts
//      with the same seconds ladder, absolute cutoffs pay an average claim 5.26s in en
//      against 10.12s in fr — fr runs last 1.93x longer for no reason but the size of its
//      dictionary. Dividing by the corpus size brings that to 1.47x and makes "rare" mean
//      one thing in every language. It is also why `rarityOf` needs the corpus size at
//      all: it is `vocabSet.size`, the existence set the round already loads before it can
//      accept a single guess — and generation ranks `freq` over that SAME population
//      (distinct slugs), so the division is a true fraction rather than one off by the
//      accent collisions, which alone were 4.1% in fr against 0.0% in en.
//   2. THE SECONDS ARE EXPONENTIAL, not linear — a geometric x1.5 ladder. Rarity should
//      pay off, not merely tick up: ARCANE is a jackpot worth five COMMONs, which is what
//      makes hunting for depth a real strategy against spamming short frequent words.
//      The whole ladder is also worth about DOUBLE what a claim used to pay: the retired
//      flat-base-plus-tier scheme averaged 3.34s a claim over real zones, this one 6.50s.
//
// The 1.47x that remains is NOT a tuning failure, and no cut set can remove it: en's
// 250-word neighborhoods simply do not reach as far down their corpus as fr's (zone p98 at
// 0.43 of the vocabulary against fr's 0.94). Cuts low enough to give en a real ARCANE hand
// fr ~19% of every board as ARCANE. The cuts below therefore favour a healthy fr pyramid
// and the doubling target, and en tops out at RARE in practice (measured mix: en
// 59/29/12/1/0, fr 36/28/15/15/5). That is a product call to revisit with the tuning
// sessions, not a bug to code around — the alternative measured is 0.08/0.18/0.34/0.55,
// which makes all five reachable in en (52/28/16/4/1) at the cost of fr's shape.
//
// Rarity is the bonus axis because it is ORTHOGONAL to the score: a closeness-scaled
// bonus would double-pay what the count already measures, where corpus rarity pays for
// vocabulary depth. It is also the knob that keeps long words worth their typing cost in
// a spam meta — rare words tend to be longer, so without it short common words dominate.
export const RARITY_LADDER: readonly { name: Rarity; within: number; seconds: number }[] = [
  { name: 'COMMON', within: 0.1, seconds: 4 },
  { name: 'UNCOMMON', within: 0.22, seconds: 6 },
  { name: 'RARE', within: 0.5, seconds: 9 },
  { name: 'OBSCURE', within: 0.85, seconds: 14 },
  { name: 'ARCANE', within: Infinity, seconds: 21 },
];

// Where a group sits on the ladder. `freq` is OPTIONAL by contract (an artifact generated
// before #163 carries none) and an unknown rarity is COMMON — the floor, never a windfall
// for missing data. `corpusSize` is the language's whole vocabulary; a nonsensical one
// falls to the same floor rather than dividing by zero.
export function rarityOf(freq: number | undefined, corpusSize: number): Rarity {
  if (freq === undefined || !(corpusSize > 0)) return RARITY_LADDER[0].name;
  const within = freq / corpusSize;
  return (RARITY_LADDER.find((grade) => within <= grade.within) ?? RARITY_LADDER[0]).name;
}

// A grade's position on the ladder, 0 (COMMON) .. 4 (ARCANE). The ONE number the
// presentation scales its intensity by, so "ARCANE feels bigger than COMMON" is derived
// from the ladder rather than restating it.
export function rarityStep(rarity: Rarity): number {
  return Math.max(0, RARITY_LADDER.findIndex((grade) => grade.name === rarity));
}

// What one claim adds to the clock.
export function bonusSeconds(freq: number | undefined, corpusSize: number): number {
  return RARITY_LADDER[rarityStep(rarityOf(freq, corpusSize))].seconds;
}

// The wall-clock LENGTH of a run whose claims have earned `bonus` seconds. The deadline
// is `startedAt + runMs(bonus)`, recomputed from the whole log on every write, so the
// clock can never drift away from the guesses that bought it.
export function runMs(bonus: number): number {
  return (START_SECONDS + bonus) * 1000;
}

// The total time a run's claims are WORTH — bounded by construction, since the zone is
// finite: a run cannot be infinite, and the field stays unclearable in practice.
export function totalBonus(claimed: readonly RankEntry[], corpusSize: number): number {
  return claimed.reduce((sum, entry) => sum + bonusSeconds(entry.freq, corpusSize), 0);
}

// What one submitted, vocab-valid guess IS, before dedup:
//   claim — a zone group (1 <= rank <= CLAIM_ZONE): +1 word, +bonusSeconds on the clock,
//           and the word floats its RARITY GRADE.
//   near  — ranked, but outside the zone: nothing gained and nothing lost but the time
//           spent typing it. It floats MISS, like an off-map guess: a timed run has no use
//           for the exact distance of something it cannot claim, and the two outcomes are
//           identical in every way that matters to the player. The rank survives where it
//           still teaches — on the post-mortem board, where the guess rides the trunk at
//           its real distance.
//   miss  — off-map (beyond the TOP_K cap): the same, with no rank at all.
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
  // The claimed zone groups, in claim order. Its length is the SCORE, and the groups
  // themselves are what the clock is priced from — the walk hands back WHAT was claimed
  // and leaves the pricing to `totalBonus`, which is the only part that needs to know
  // how big the corpus is.
  claimed: RankEntry[];
  // Every counted guess, in order — the run as the player played it.
  counted: CountedGuess[];
}

export function replayWordRun(ranks: WordRanks, tried: readonly string[]): WordRun {
  const seen = new Set<string>();
  const counted: CountedGuess[] = [];
  const claimed: RankEntry[] = [];
  for (const typed of tried) {
    const key = wordGuessKey(ranks, typed);
    if (seen.has(key)) continue; // repeats are free, never counted
    seen.add(key);
    const judged = judgeWordGuess(ranks, typed);
    if (judged.kind === 'zero') continue; // the word itself is free
    counted.push({ typed, judged });
    if (judged.kind === 'claim') claimed.push(judged.entry);
  }
  return { claimed, counted };
}
