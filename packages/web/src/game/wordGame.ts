// Word mode's rules (#156): one daily word, its ranked neighborhood public knowledge to
// win. The player CLAIMS words in the top zone — the road zone of the #154 artifact —
// until struck out; the score is how many they claimed. Claiming all of it is
// deliberately impossible: the zone is the field, not the goal.
//
// Everything here is PURE and derived from (ranks, ordered counted guesses), so a round
// survives a reload by replaying its `tried` log — exactly the sentence game's contract
// (see game/share.ts replayRun). Rendering and persistence live elsewhere.

import type { RankEntry, WordRanks } from '@whippin/shared';

// The run ends after this many CONSECUTIVE incorrect guesses. A named constant, expected
// to be tuned on user feedback — one-line change.
export const STRIKES_TO_END = 3;

// The claimable zone: the top-CLAIM_ZONE ranked groups — generation's flat road zone
// (ROAD_TOP), which is Word mode's whole playing field (#154). This is a GAME RULE
// mirroring the artifact's road zone, not the TOP_K map cap (which stays untested here:
// off-map is simply "no entry").
export const CLAIM_ZONE = 150;

// What one submitted, vocab-valid guess IS, before dedup:
//   claim — a zone group (1 <= rank <= CLAIM_ZONE): +1 word, resets the strike run.
//   near  — ranked, but outside the zone: a strike that SHOWS its rank (rank 412 strikes,
//           but teaches where the boundary is).
//   miss  — off-map (beyond the TOP_K cap): a strike with no rank to show.
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
// its folded slug — two distinct off-map words are two distinct (counted) strikes,
// exactly like the sentence game's guessKey fallback.
export function wordGuessKey(ranks: WordRanks, typed: string): string {
  const entry = ranks[typed];
  return entry ? `r:${entry.rank}` : `s:${typed}`;
}

// One round replayed from its ordered counted guesses. `tried` holds ONLY counted
// guesses (claims and strikes — free guesses never enter it), but the replay stays
// robust to junk: a repeat or a rank-0 entry in the log is skipped, and nothing past the
// run's end counts.
export interface WordRun {
  // Ranks of the claimed zone groups, in claim order. Its length is the SCORE.
  claimedRanks: number[];
  // Consecutive strikes at the end of the walk (0 after a claim).
  strikes: number;
  // The run is over: STRIKES_TO_END consecutive incorrect guesses landed.
  ended: boolean;
}

export function replayWordRun(ranks: WordRanks, tried: string[]): WordRun {
  const seen = new Set<string>();
  const claimedRanks: number[] = [];
  let strikes = 0;
  let ended = false;
  for (const typed of tried) {
    if (ended) break;
    const key = wordGuessKey(ranks, typed);
    if (seen.has(key)) continue; // repeats are free, never counted
    seen.add(key);
    const judged = judgeWordGuess(ranks, typed);
    if (judged.kind === 'zero') continue; // the word itself is free
    if (judged.kind === 'claim') {
      claimedRanks.push(judged.entry.rank);
      strikes = 0;
      continue;
    }
    strikes += 1;
    if (strikes >= STRIKES_TO_END) ended = true;
  }
  return { claimedRanks, strikes, ended };
}
