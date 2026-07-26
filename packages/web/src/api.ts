// Client of the daily-puzzle backend (Lambda Function URL behind CloudFront, #2).
// The puzzle URL is DATE-addressed: the client computes the active 22:00-ET game day
// itself (the shared day.ts — the same DST-correct code the server validates with)
// and asks for that date's puzzle in ONE fetch. The server only serves dates within
// a ±1-day clock-skew window of its own active day.

import { fold } from '@whippin/shared';
import type { Puzzle, Word } from '@whippin/shared';

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

// The optional distance annotations on a rank entry (#115). They are group properties
// generation adds — every puzzle published before them carries none, so ABSENT stays
// valid — but a PRESENT one must be well formed: scoring and the route view read them
// as numbers, so a string or an out-of-byte-range value would corrupt both silently.
// `road` is only bounded below: how many roads generation may cut is its knob, and the
// front stays as agnostic of it as it is of TOP_K.
function checkRankAnnotations(entry: Record<string, unknown>): void {
  const { dq, road } = entry;
  if (dq !== undefined && (typeof dq !== 'number' || !Number.isInteger(dq) || dq < 0 || dq > 255)) {
    throw new Error('malformed puzzle: "dq" must be an integer 0-255');
  }
  if (road !== undefined && (typeof road !== 'number' || !Number.isInteger(road) || road < 0)) {
    throw new Error('malformed puzzle: "road" must be a non-negative integer');
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
