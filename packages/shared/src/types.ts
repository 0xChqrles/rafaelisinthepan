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
  // Display-only text around the blank, kept out of the secret so the player still
  // types only the word (slug/fold unchanged). Optional; absent when empty.
  prefix?: string; // before the blank: a leading clitic ("t'", "l'") or opening punctuation
  suffix?: string; // after the blank: trailing punctuation (",", ".", "»"…)
}

// One ranked candidate for a secret: its display form + integer distance rank
// (0 = the secret itself, lower is closer).
export interface RankEntry {
  word: string;
  rank: number;
}

// ranks[secretSlug][inputSlug] -> { word, rank }
export type RankMap = Record<string, Record<string, RankEntry>>;

// What kind of piece the daily sentence comes from (#5). The known values are
// documented for authoring/autocomplete, but the union stays OPEN (`string & {}`)
// so a puzzle authored with a new kind stays valid without a schema bump.
export type SourceKind = 'book' | 'movie' | 'music' | 'quote' | 'poem' | (string & {});

// Optional literary metadata about the sentence's origin, revealed on the solved
// screen (#8). EVERY field is optional so partial metadata is valid, and the whole
// object may be absent so existing puzzles stay byte-compatible. Like the rest of
// the schema, values are DISPLAY forms: accents kept, never folded/slugged.
export interface Source {
  kind?: SourceKind;
  author?: string;
  work?: string; // the piece's title
}

// Offline LLM opponent result (#68/#80). The full label is used on the solved screen;
// the short tag is used by compact race UI. `run` is the selected median run's counted
// display-form guesses in submission order. Null tries means the model hit the curator's
// counted-try cap without solving (DNF); its full run is still retained.
export interface BenchmarkEntry {
  model: string;
  label: string;
  tag: string;
  tries: number | null;
  run: string[];
}

// The player-facing model set is one fixed trio. Wider benchmark rosters remain in the
// unpublished lab artifact and never enter the puzzle payload.
export type BenchmarkResults = [BenchmarkEntry, BenchmarkEntry, BenchmarkEntry];

export interface Puzzle {
  lang: string;
  words: string[]; // full sentence, accents kept
  holes: Hole[]; // one per selected occurrence, sorted by pos ascending
  ranks: RankMap; // keyed by secret slug, then input slug
  source?: Source; // optional origin metadata (#5), shown on the solved screen (#8)
  benchmark?: BenchmarkResults; // optional player-facing model trio (#68/#80)
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
  startDelayMs: number;
  fadeDelayMs: number;
  miss?: boolean; // true => the guess was too far for this hole; render "MISS", not a number
}
