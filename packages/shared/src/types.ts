// The generated schemas both dailies play on — the sentence puzzle (gen_phrase.py) and
// the #154 single-word artifact (gen_word.py) — plus the web's own runtime round types.
// Keys are slugs, in the sense packages/generation/scripts/slug.py defines.

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
  // Real geometry the uniform ranks erase (#115), computed at generation time from the
  // vectors the client never sees. A GROUP property: every alias key of a lemma group
  // carries its group's value, exactly like `word`/`rank`.
  // Quantized distance to the secret, per hole: 255 at rank 1, 0 at the farthest kept
  // group. Absent on the secret's own entry (rank 0) — the terminus is off-scale.
  dq?: number;
  // How COMMON the group is in the corpus (#163): the 1-based position of its most
  // frequent OWNED KEY among the DISTINCT SLUGS of the frequency-ordered reduced
  // vocabulary — exactly the existence set the client loads, so `freq / vocabSet.size`
  // is a true fraction. 1 = the commonest word the game admits, larger = rarer. The
  // commonest thing a player can TYPE to claim the group — its commonest inflection,
  // not its representative, and never a surface another group owns. Another GROUP
  // property, so every alias key repeats it. Emitted by WORD artifacts only
  // (gen_word.py) — Word mode pays a claim in seconds scaled by it, and a sentence
  // puzzle has no consumer for it.
  freq?: number;
}

// One word's whole ranked neighborhood: inputSlug -> RankEntry. Every alias key of a
// group appears here, carrying that group's values.
export type WordRanks = Record<string, RankEntry>;

// ranks[secretSlug][inputSlug] -> RankEntry
export type RankMap = Record<string, WordRanks>;

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

export interface Puzzle {
  lang: string;
  words: string[]; // full sentence, accents kept
  holes: Hole[]; // one per selected occurrence, sorted by pos ascending
  ranks: RankMap; // keyed by secret slug, then input slug
  source?: Source; // optional origin metadata (#5), shown on the solved screen (#8)
  // WHICH PUBLISHED VERSION of this daily (#203, user-decided 2026-08-22). Stamped by
  // `puzzle:publish` — generation does not write it — as a hash of the file's own content,
  // so re-publishing the SAME file is a no-op while any real correction is a new version.
  //
  // It is the round's identity everywhere: the client sends it, the derivation slice carries
  // it, and the server refuses to derive anything unless all three agree. The sentence's
  // hole layout used to play that part, which could not tell one version of a sentence from
  // a corrected one — and since rank 0 is a GROUP, a correction moves exactly the aliases
  // that decide whether a guess solved the puzzle. A republish means the puzzle was wrong,
  // so the round it retires starts over: its guesses were answers to a different question.
  revision: string;
}

// The second puzzle type: ONE word and its ranked neighborhood, with no sentence
// around it (#154). Produced by packages/generation/scripts/gen_word.py; it is what
// the onboarding tutorial and Word mode play on.
//
// The rank semantics are the sentence schema's, unchanged — rank 0 is the word itself
// and carries no `dq`, every rank >= 1 entry carries one, and `word`/`rank`/`dq` are
// GROUP properties shared by all of a group's alias keys. Two things differ: `ranks` is
// ONE flat map (nothing to key it by, since there is no sentence), and every group
// carries `freq`, the corpus rarity Word mode's clock pays a claim by (#163).
//
// No `words`/`holes`/`start`/`start_rank`, and no `source`: a lone word has no
// attribution.
export interface WordPuzzle {
  lang: string;
  word: Word; // the accented display form + its slug
  ranks: WordRanks;
}

// One fixed score band returned by the backend's live histogram endpoint (#169).
// Bounds are inclusive. The server owns them because changing a boundary changes which
// DynamoDB counter a submission increments; consumers render the ranges they receive
// rather than duplicating those committed edges.
export interface ScoreHistogramBucket {
  min: number;
  max: number;
  count: number;
}

export interface ScoreHistogram {
  buckets: ScoreHistogramBucket[];
  total: number;
  // The submitted score's bucket on POST; null on the read-only GET. A revisiting client
  // already knows its persisted score and can locate it in the inclusive ranges above.
  bucket: number | null;
}

// The #188 player profile, as the API speaks it: the derived publicId (never the
// secret), the display name (possibly empty) and the encoded avatar (see avatar.ts).
export interface PlayerProfile {
  publicId: string;
  name: string;
  avatar: string;
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
