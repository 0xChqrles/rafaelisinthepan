// Client of the daily-puzzle backend (Lambda Function URL behind CloudFront, #2).
// The puzzle URL is DATE-addressed: the client computes the active 22:00-ET game day
// itself (the shared day.ts — the same DST-correct code the server validates with)
// and asks for that date's puzzle in ONE fetch. The server only serves dates within
// a ±1-day clock-skew window of its own active day.

import { fold } from '@whippin/shared';
import type { Puzzle, Word, WordPuzzle } from '@whippin/shared';

// Base URL of the backend, configured at build time via VITE_API_BASE_URL.
// Trailing slashes are trimmed so callers can append paths cleanly. Empty when
// unset (e.g. a misconfigured build) — normal play then can't resolve a puzzle,
// which surfaces as a loud error rather than a silent same-origin fetch.
export function apiBase(env: ImportMetaEnv = import.meta.env): string {
  return (env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');
}

function requireApiBase(base: string): string {
  if (!base) {
    throw new Error('VITE_API_BASE_URL is not set.');
  }
  return base;
}

// A day's puzzle for a language: GET <base>/?lang=<lang>&date=<YYYY-MM-DD>. `date` is
// the active game day the CLIENT computed (shared `activeDate`); the server validates it
// sits within its clock-skew window and serves exactly that day's puzzle — so what the
// front persists under `dayNumber(date)` is always the puzzle it plays (no flip race).
// A request without `date` is a protocol violation the backend rejects with 400.
export function puzzleUrl(lang: string, date: string, base: string = apiBase()): string {
  return `${requireApiBase(base)}/?lang=${encodeURIComponent(lang)}&date=${encodeURIComponent(date)}`;
}

// Word mode's daily artifact (#154/#156): the same date-addressed endpoint, selected by
// `mode=word` — a distinct URL, so the CDN caches the two dailies separately.
export function wordPuzzleUrl(lang: string, date: string, base: string = apiBase()): string {
  return `${puzzleUrl(lang, date, base)}&mode=word`;
}

// Routing outcome of the backend puzzle fetch, by HTTP status:
//   200 -> a puzzle to load;
//   404 -> no puzzle for today/lang -> the graceful "NO PUZZLE TODAY" state (#14);
//   anything else -> a real failure -> the "FAILED TO LOAD" error state.
export type PuzzleOutcome = 'puzzle' | 'missing' | 'error';
export function puzzleOutcome(status: number): PuzzleOutcome {
  if (status === 404) return 'missing';
  if (status >= 200 && status < 300) return 'puzzle';
  return 'error';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isWord(v: unknown): v is Word {
  return isRecord(v) && typeof v.word === 'string' && typeof v.slug === 'string';
}

// A road id is an index into the route view's lanes, and the front stays agnostic of how many
// roads generation may cut — but not INFINITELY so, because this parse is the only thing between
// the network and a number the drawing has to size itself by. `road: 4294967295` is a
// well-formed non-negative integer and nothing downstream could do anything sane with it, so the
// ceiling sits far above any clustering that could plausibly ship (ROAD_KS tops out at 4 today,
// leaving 16× of headroom) and far below a value that could hurt. Generous on purpose: a puzzle
// rejected here fails the whole DAY, which must never be the price of a cosmetic knob moving.
const MAX_ROAD = 63;

// The optional group annotations on a rank entry (#115 distances, #163 rarity). They are
// group properties generation adds — every puzzle published before them carries none, so
// ABSENT stays valid — but a PRESENT one must be well formed: scoring, the route view and
// Word mode's clock read them as numbers, so a string or an out-of-range value would
// corrupt them silently. `freq` is the one whose damage would be invisible rather than
// visual: it buys SECONDS, and a NaN reaching the deadline arithmetic ends a run instantly
// or never. Its upper end is deliberately unbounded — it is a vocabulary position, and an
// implausibly large one simply lands in the rarest bonus tier.
function checkRankAnnotations(entry: Record<string, unknown>): void {
  const { dq, road, freq } = entry;
  if (dq !== undefined && (typeof dq !== 'number' || !Number.isInteger(dq) || dq < 0 || dq > 255)) {
    throw new Error('malformed puzzle: "dq" must be an integer 0-255');
  }
  if (
    road !== undefined &&
    (typeof road !== 'number' || !Number.isInteger(road) || road < 0 || road > MAX_ROAD)
  ) {
    throw new Error(`malformed puzzle: "road" must be an integer 0-${MAX_ROAD}`);
  }
  if (freq !== undefined && (typeof freq !== 'number' || !Number.isInteger(freq) || freq < 1)) {
    throw new Error('malformed puzzle: "freq" must be a positive integer');
  }
}

// Runtime shape check for a fetched puzzle (issue #14). The backend/store normally
// returns a well-formed Puzzle, but a truncated body or a store/CDN mishap can yield
// valid JSON of the WRONG shape — which would then crash Game mid-render (a blank
// screen), not surface as an error. So validate the
// load-bearing fields the game actually reads here: on success return a typed Puzzle;
// on a bad shape throw a descriptive Error the fetch hook turns into the error state.
// Not exhaustive — it asserts the structure Game depends on (lang, words, each hole's
// secret/start {word,slug} + start_rank, a ranks map for every secret, the optional
// per-entry distance annotations (#115), and the optional player-facing benchmark
// contract).
export function parsePuzzle(data: unknown): Puzzle {
  if (!isRecord(data)) throw new Error('malformed puzzle: not an object');
  const { lang, words, holes, ranks, benchmark } = data;
  if (typeof lang !== 'string') throw new Error('malformed puzzle: missing "lang"');
  if (!Array.isArray(words) || !words.every((w) => typeof w === 'string')) {
    throw new Error('malformed puzzle: "words" must be an array of strings');
  }
  if (!isRecord(ranks)) throw new Error('malformed puzzle: "ranks" must be an object');
  if (!Array.isArray(holes)) throw new Error('malformed puzzle: "holes" must be an array');
  for (const h of holes) {
    if (
      !isRecord(h) ||
      typeof h.pos !== 'number' ||
      typeof h.start_rank !== 'number' ||
      !isWord(h.secret) ||
      !isWord(h.start)
    ) {
      throw new Error('malformed puzzle: bad "holes" entry');
    }
    if (!isRecord(ranks[h.secret.slug])) {
      throw new Error(`malformed puzzle: "ranks" missing entry for secret "${h.secret.slug}"`);
    }
  }
  for (const entries of Object.values(ranks)) {
    if (!isRecord(entries)) throw new Error('malformed puzzle: bad "ranks" entry');
    for (const entry of Object.values(entries)) {
      if (!isRecord(entry)) throw new Error('malformed puzzle: bad "ranks" entry');
      // `rank` is read as a number by scoring/feedback AND is a component of the counted-try
      // identity (guessKey, whose "unknown" sentinel is -1) — a negative or non-integer rank
      // would corrupt both silently, so a present entry must carry a well-formed one.
      if (typeof entry.rank !== 'number' || !Number.isInteger(entry.rank) || entry.rank < 0) {
        throw new Error('malformed puzzle: "rank" must be a non-negative integer');
      }
      checkRankAnnotations(entry);
    }
  }
  if (benchmark !== undefined) {
    // Every tested model is recorded (variable length); the front end filters the display
    // trio. Validate shape + uniqueness only, not membership in the display set.
    if (!Array.isArray(benchmark) || benchmark.length === 0) {
      throw new Error('malformed puzzle: "benchmark" must be a non-empty array');
    }
    const benchmarkModels = new Set<string>();
    const benchmarkTags = new Set<string>();
    for (const entry of benchmark) {
      if (
        !isRecord(entry) ||
        typeof entry.model !== 'string' ||
        entry.model.trim() !== entry.model ||
        entry.model.length === 0 ||
        typeof entry.label !== 'string' ||
        entry.label.trim() !== entry.label ||
        !/^[A-Z0-9][A-Z0-9 .-]*$/.test(entry.label) ||
        typeof entry.tag !== 'string' ||
        entry.tag.trim() !== entry.tag ||
        !/^[A-Z0-9][A-Z0-9 -]{0,5}$/.test(entry.tag) ||
        !(
          entry.tries === null ||
          (typeof entry.tries === 'number' && Number.isInteger(entry.tries) && entry.tries > 0)
        ) ||
        !Array.isArray(entry.run) ||
        !entry.run.every(
          (guess) => typeof guess === 'string' && guess.length > 0 && guess.trim() === guess,
        )
      ) {
        throw new Error('malformed puzzle: bad "benchmark" entry');
      }
      const runSlugs = entry.run.map(fold);
      if (
        entry.run.length === 0 ||
        runSlugs.some((guess) => guess.length === 0) ||
        new Set(runSlugs).size !== runSlugs.length ||
        (entry.tries !== null && entry.run.length !== entry.tries)
      ) {
        throw new Error('malformed puzzle: bad "benchmark" run');
      }
      benchmarkModels.add(entry.model);
      benchmarkTags.add(entry.tag);
    }
    if (benchmarkModels.size !== benchmark.length || benchmarkTags.size !== benchmark.length) {
      throw new Error('malformed puzzle: "benchmark" model and tag entries must be unique');
    }
  }
  return data as unknown as Puzzle;
}

// Runtime shape check for Word mode's fetched artifact (#154/#156) — the same job as
// parsePuzzle for the same reason: a truncated/wrong body must surface as the error
// state, never crash the board mid-render. Asserts the load-bearing structure: lang, the
// public word {word, slug}, and the ONE flat rank map with well-formed rank/dq/road/freq
// on every entry.
export function parseWordPuzzle(data: unknown): WordPuzzle {
  if (!isRecord(data)) throw new Error('malformed word puzzle: not an object');
  const { lang, word, ranks } = data;
  if (typeof lang !== 'string') throw new Error('malformed word puzzle: missing "lang"');
  if (!isWord(word)) throw new Error('malformed word puzzle: bad "word"');
  if (!isRecord(ranks)) throw new Error('malformed word puzzle: "ranks" must be an object');
  if (!isRecord(ranks[word.slug]) || (ranks[word.slug] as { rank?: unknown }).rank !== 0) {
    throw new Error('malformed word puzzle: "ranks" must hold the word itself at rank 0');
  }
  for (const entry of Object.values(ranks)) {
    if (!isRecord(entry) || typeof entry.word !== 'string') {
      throw new Error('malformed word puzzle: bad "ranks" entry');
    }
    if (typeof entry.rank !== 'number' || !Number.isInteger(entry.rank) || entry.rank < 0) {
      throw new Error('malformed word puzzle: "rank" must be a non-negative integer');
    }
    checkRankAnnotations(entry);
  }
  return data as unknown as WordPuzzle;
}
