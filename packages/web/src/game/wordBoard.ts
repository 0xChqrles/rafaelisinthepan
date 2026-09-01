// Word mode's BOARD model (#156): the day's claimable ZONE, graded by RARITY, with what
// the run claimed marked — the post-mortem's content. The center word is PUBLIC, there is
// no hidden destination, no departure and no "you are here": the whole zone is the
// playing field. Same derivation contract as the sentence side: everything comes from
// (ranks, ordered counted guesses), nothing new is persisted.
//
// Since 2026-09-01 the board is a plain GRID of words (user-decided, applying the
// sentence game's words modal here: "like on a synonyms website"), so the model states
// no geometry — no `dq`, no near misses riding a trunk, no misses shelf, no widest rank
// for a gutter. What survives is what the grid says: every group of the zone, its grade
// (the colour it wears — what a claim PAID, #163), its word once claimed or once the
// run's end names the field, and whether the player claimed it.

import type { RankEntry, WordRanks } from '@whippin/shared';
import { CLAIM_ZONE, RARITY_NAMES, rarityOf, replayWordRun, type Rarity } from './wordGame';

// One group of the zone. `word` is null while unclaimed and the field is still censored
// (`???` on screen); a claim — or the reveal, which names the whole field — gives the
// canonical accented form.
export interface WordStation {
  rank: number;
  // The station's RARITY GRADE (decided 2026-08-10) — its colour. Never null: `rarityOf`
  // floors at COMMON, so every station carries exactly one grade even on an artifact
  // carrying no `freq` at all (which then draws all-common).
  rarity: Rarity;
  word: string | null;
  claimed: boolean;
}

export interface WordBoardModel {
  word: string; // the day's word, accented display form — public from the first frame
  // The grades present, in ladder order (commonest first) — ONLY the grades the day's field
  // actually holds (an English board often has no ARCANE group at all, and a permanently
  // absent grade advertises a bracket nobody can reach). Never empty (COMMON is the
  // floor). Its consumer is the sr census.
  grades: Rarity[];
  stations: WordStation[]; // the zone, rank ascending (1 first)
}

// One pass over the (alias-expanded) flat map, cached per map object — the map is
// immutable for the puzzle's lifetime.
const zoneCache = new WeakMap<WordRanks, Map<number, RankEntry>>();

function zoneOf(ranks: WordRanks): Map<number, RankEntry> {
  const cached = zoneCache.get(ranks);
  if (cached) return cached;
  const zone = new Map<number, RankEntry>();
  for (const key in ranks) {
    const entry = ranks[key];
    if (entry.rank === 0 || entry.rank > CLAIM_ZONE) continue;
    if (!zone.has(entry.rank)) zone.set(entry.rank, entry);
  }
  zoneCache.set(ranks, zone);
  return zone;
}

export function buildWordBoard({
  ranks,
  word,
  tried,
  corpusSize,
  reveal = false,
}: {
  ranks: WordRanks;
  word: string; // the day's accented display form
  tried: readonly string[]; // the round's counted guesses, folded, in try order
  // The language's whole vocabulary — the scale a grade is a FRACTION of (#163). The board's
  // colours are grades, so the drawing needs the same denominator the clock is priced with,
  // or a station could wear one grade and pay for another.
  corpusSize: number;
  // When the post-mortem NAMES the field. Presentation pacing, owned by the screen: the
  // run's end is a DEADLINE fact (#163) and the reveal is its own later beat.
  reveal?: boolean;
}): WordBoardModel {
  // The RULES are `replayWordRun`'s, never restated here: this only reads which groups the
  // counted guesses claimed.
  const { counted } = replayWordRun(ranks, tried);
  const claimed = new Set<number>();
  for (const { judged } of counted) {
    if (judged.kind === 'claim') claimed.add(judged.entry.rank);
  }

  const present = new Set<Rarity>();
  const stations: WordStation[] = [];
  for (const [rank, entry] of [...zoneOf(ranks).entries()].sort((a, b) => a[0] - b[0])) {
    const isClaimed = claimed.has(rank);
    const rarity = rarityOf(entry.freq, corpusSize);
    present.add(rarity);
    stations.push({
      rank,
      rarity,
      // A claim reveals its word; the post-mortem reveals the WHOLE field.
      word: isClaimed || reveal ? entry.word : null,
      claimed: isClaimed,
    });
  }

  return {
    word,
    // Ladder order, commonest to rarest, whatever a given day's field happens to hold —
    // the one thing that lets two boards be read the same way.
    grades: RARITY_NAMES.filter((grade) => present.has(grade)),
    stations,
  };
}
