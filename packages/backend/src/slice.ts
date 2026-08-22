// The DERIVATION SLICE (#203): the small part of a sentence puzzle the server needs to say
// what a stored guess log has reached.
//
// A published sentence puzzle is megabytes of alias-expanded rank maps (median 4.57 MB
// across the 49 fr puzzles in the local store, worst 7.78 MB). Reading and parsing that on
// every append is not viable, and per-instance caching does not rescue it either — /round
// serves any archive day, so one Lambda faces many different artifacts.
//
// It does not need the whole thing. A hole's rank only ever IMPROVES from its `start_rank`,
// so nothing ranked farther than the start can move the percentage or solve anything: the
// slice keeps, per secret, only the keys at or below that rank, plus the two numbers the
// progress formula reads (`n` = distinct ranked groups, `startRank`). Measured on the same
// 49 puzzles that is a median 14.1 KB against 4.57 MB — a 332x reduction — and it covers
// BOTH `progress` and `solved` on every append.
//
// It is bigger than `start_rank x 3` suggests because a rank is a GROUP and a group has
// several typable spellings (`privé`, `privée`, `privés`, `privées` all sit at one rank):
// French averages 2.58 keys per rank and reaches 11.1 in the worst puzzle measured.
//
// PRODUCED BY `pnpm puzzle:publish`, not by generation: the slice is a pure function of the
// puzzle with no authoring decision in it, publish is already where an artifact becomes a
// served thing, and republishing gives an EXISTING puzzle its slice where generation would
// mean regenerating it. It is also TypeScript, like the backend that reads it — there is
// already one cross-language contract to keep in step (slug() <=> fold()) and no reason for
// a second.
//
// SENTENCE ONLY. Word mode reads its artifact once per run, at submit, so ~50 ms once is
// fine and it needs no slice; its round START reads no store at all, which matters — that
// is the one path where the player genuinely waits on the answer.

import { gunzipSync, gzipSync } from 'node:zlib';
import { holeProgress, rankCount, type Puzzle } from '@whippin/shared';

// One secret's slice: what the progress formula needs, plus every key that can still move it.
export interface SliceHole {
  // N — the number of distinct ranked GROUPS in this secret's full map (#104's aliases
  // share a rank). It is the log's base, so it comes from the WHOLE map, never from the
  // truncated key set below.
  n: number;
  startRank: number;
  // inputSlug -> rank, for ranks at or below `startRank` ONLY. Rank 0 (the secret and its
  // aliases) is in here by construction, which is what makes `solved` readable from it.
  ranks: Record<string, number>;
}

export interface PuzzleSlice {
  lang: string;
  // Keyed by SECRET slug, like the puzzle's own `ranks`. Duplicate sentence occurrences of
  // one secret share a single entry — they are one logical progress target (the web's
  // `computeProgress` collapses them the same way).
  holes: Record<string, SliceHole>;
}

// What a round has reached, as the server stores it beside the log (#203).
export interface RoundDerivation {
  // Reconstruction percentage, 0-100 — the same number the web caches on the round and
  // #211 fills a calendar cell from.
  progress: number;
  // Every secret has a guess at rank 0.
  solved: boolean;
}

export function buildSlice(puzzle: Puzzle): PuzzleSlice {
  const holes: Record<string, SliceHole> = {};
  for (const hole of puzzle.holes) {
    const secret = hole.secret.slug;
    // One entry per SECRET: repeated occurrences carry the same map and the same start
    // hint, and generation guarantees it (the schema keys `ranks` by secret slug).
    if (holes[secret]) continue;
    const full = puzzle.ranks[secret];
    if (!full) throw new Error(`puzzle has no ranks for secret "${secret}"`);
    const ranks: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const key of Object.keys(full)) {
      const rank = full[key].rank;
      if (rank <= hole.start_rank) ranks[key] = rank;
    }
    holes[secret] = { n: rankCount(full), startRank: hole.start_rank, ranks };
  }
  return { lang: puzzle.lang, holes };
}

// Read a stored log against the day's slice. Pure, and the ONE place the two stored fields
// come from — the pre-write derivation and the post-write verification call this with
// different logs, never with different rules.
export function deriveRound(slice: PuzzleSlice, guesses: readonly string[]): RoundDerivation {
  const secrets = Object.keys(slice.holes);
  if (secrets.length === 0) return { progress: 0, solved: false };
  let sum = 0;
  let solved = true;
  for (const secret of secrets) {
    const hole = slice.holes[secret];
    let best = hole.startRank;
    for (const guess of guesses) {
      // `Object.hasOwn`, never a bare index read: a folded slug is all lowercase letters,
      // so `constructor` is a guess a player can actually type and a plain lookup would
      // answer it off the prototype chain. (`buildSlice` makes null-prototype maps, but a
      // slice read back from JSON has an ordinary one.)
      if (!Object.hasOwn(hole.ranks, guess)) continue;
      const rank = hole.ranks[guess];
      if (rank < best) best = rank;
    }
    if (best !== 0) solved = false;
    sum += holeProgress(best, hole.startRank, hole.n);
  }
  return { progress: (100 * sum) / secrets.length, solved };
}

// Runtime shape check for a slice read back out of the store — the `parsePuzzle` contract:
// a truncated or wrong-shaped object must surface as a failure, never as a round that
// silently derives 0% and never solves.
//
// It checks the VALUES too, not only the field shapes (tightened on review, where the
// comment above promised more than the code did). The two silent readings it exists to make
// unreachable are exactly the ones a partial object produces: an EMPTY `holes` map, which
// `deriveRound` answers `{progress: 0, solved: false}` for every log forever, and a
// non-numeric rank, which compares false against every `best` and makes a reachable secret
// permanently unreachable. Neither is expensive to rule out — the walk is over the same
// keys `deriveRound` reads, on an object that parses in half a millisecond.
export function parseSlice(data: unknown): PuzzleSlice {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('malformed slice: not an object');
  }
  const { lang, holes } = data as { lang?: unknown; holes?: unknown };
  if (typeof lang !== 'string') throw new Error('malformed slice: missing "lang"');
  if (typeof holes !== 'object' || holes === null || Array.isArray(holes)) {
    throw new Error('malformed slice: "holes" must be an object');
  }
  // A sentence puzzle always has holes, so an empty map is a truncated slice, not a
  // puzzle with nothing to solve.
  if (Object.keys(holes as object).length === 0) {
    throw new Error('malformed slice: "holes" is empty');
  }
  for (const hole of Object.values(holes as Record<string, unknown>)) {
    const h = hole as { n?: unknown; startRank?: unknown; ranks?: unknown };
    if (
      typeof h.n !== 'number' ||
      !Number.isInteger(h.n) ||
      h.n < 1 ||
      typeof h.startRank !== 'number' ||
      !Number.isInteger(h.startRank) ||
      h.startRank < 0 ||
      typeof h.ranks !== 'object' ||
      h.ranks === null ||
      Array.isArray(h.ranks)
    ) {
      throw new Error('malformed slice: bad hole entry');
    }
    for (const rank of Object.values(h.ranks as Record<string, unknown>)) {
      // Non-negative, like every rank in the schema, and no farther than the start —
      // a key beyond it cannot move this hole and has no business in the slice.
      if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 0 || rank > h.startRank) {
        throw new Error('malformed slice: bad rank in a hole');
      }
    }
  }
  return data as PuzzleSlice;
}

// The slice travels and rests GZIPPED — the writer and both readers share one codec, so a
// stored object can never be encoded one way and read another.
//
// It VALIDATES what it is about to write, so the codec can never encode a slice the reader
// would refuse: a malformed puzzle then fails LOUDLY at publish, where a person is watching,
// instead of shipping a day whose every append answers the day-addressed 404.
export function encodeSlice(slice: PuzzleSlice): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(parseSlice(slice)), 'utf8'));
}

export function decodeSlice(bytes: Uint8Array): PuzzleSlice {
  return parseSlice(JSON.parse(gunzipSync(bytes).toString('utf8')));
}
