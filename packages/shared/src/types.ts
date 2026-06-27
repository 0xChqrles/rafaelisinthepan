// Per-puzzle schema: one file = one self-contained playable sentence.
// Produced by packages/generation/scripts/gen_phrase.py (see its slug() conventions).

// A displayed word plus its ASCII-folded lookup key (accents kept for display,
// folded for comparison). slug == word is common but always carried explicitly.
export interface Word {
  word: string;
  slug: string;
}

export interface Hole {
  pos: number; // index of the secret in Puzzle.words
  secret: Word;
  start: Word;
  start_rank: number;
}

// One ranked candidate for a secret: its display form + integer distance rank
// (0 = the secret itself, lower is closer).
export interface RankEntry {
  word: string;
  rank: number;
}

// ranks[secretSlug][inputSlug] -> { word, rank }
export type RankMap = Record<string, Record<string, RankEntry>>;

export interface Puzzle {
  lang: string;
  words: string[]; // full sentence, accents kept
  holes: Hole[]; // sorted by pos ascending
  ranks: RankMap; // keyed by secret slug, then input slug
}

export interface RuntimeHole {
  pos: number;
  secret: string; // secret slug -> key into RankMap
  word: string; // currently displayed (accented) word
  rank: number;
  startRank: number;
}

export interface HitState {
  holeIndex: number;
  value: number;
  id: number;
  miss?: boolean; // true => the guess was too far for this hole; render "MISS", not a number
}
