// Client of the daily-puzzle backend (Lambda Function URL behind CloudFront, #2).
// The puzzle URL is DATE-addressed: the client computes the active 22:00-ET game day
// itself (the shared day.ts — the same DST-correct code the server validates with)
// and asks for that date's puzzle in ONE fetch. The server only serves dates within
// a ±1-day clock-skew window of its own active day.

import type { Puzzle, Word } from '@whippin/shared';

// Base URL of the backend, configured at build time via VITE_API_BASE_URL.
// Trailing slashes are trimmed so callers can append paths cleanly. Empty when
// unset (e.g. local dev with no backend) — normal play then can't resolve a
// puzzle, and the ?puzzle= override is the way to load a file directly.
export function apiBase(env: ImportMetaEnv = import.meta.env): string {
  return (env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');
}

function requireApiBase(base: string): string {
  if (!base) {
    throw new Error('VITE_API_BASE_URL is not set. Set it, or use ?puzzle=<path> for a file override.');
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

// A ?puzzle= test override resolves a puzzle FILE directly, bypassing the backend
// (for local dev / preview without a deployed endpoint). An absolute http(s) URL is
// used verbatim; a relative path is resolved against BASE_URL like the other static
// assets. No override -> null (normal play goes to the backend). The old ?date=
// override is intentionally dropped: the server now owns the date, and the deployed
// endpoint accepts no date parameter, so a client-side date would be meaningless.
export function resolveOverride(search: string, baseUrl: string): string | null {
  const override = new URLSearchParams(search).get('puzzle');
  if (override == null) return null;
  if (/^https?:\/\//.test(override)) return override;
  return `${baseUrl}${override.replace(/^\/+/, '')}`;
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

// Runtime shape check for a fetched puzzle (issue #14). The backend/store normally
// returns a well-formed Puzzle, but a truncated body, the wrong file behind ?puzzle=,
// or a store/CDN mishap can yield valid JSON of the WRONG shape — which would then
// crash Game mid-render (a blank screen), not surface as an error. So validate the
// load-bearing fields the game actually reads here: on success return a typed Puzzle;
// on a bad shape throw a descriptive Error the fetch hook turns into the error state.
// Not exhaustive — it asserts the structure Game depends on (lang, words, each hole's
// secret/start {word,slug} + start_rank, a ranks map for every secret, and the optional
// solved-screen benchmark contract).
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
  if (benchmark !== undefined) {
    if (!Array.isArray(benchmark) || benchmark.length === 0) {
      throw new Error('malformed puzzle: "benchmark" must be a non-empty array');
    }
    for (const entry of benchmark) {
      if (
        !isRecord(entry) ||
        typeof entry.model !== 'string' ||
        entry.model.trim().length === 0 ||
        typeof entry.label !== 'string' ||
        entry.label.trim() !== entry.label ||
        !/^[A-Z0-9][A-Z0-9 -]{0,7}$/.test(entry.label) ||
        !(
          entry.tries === null ||
          (typeof entry.tries === 'number' && Number.isInteger(entry.tries) && entry.tries > 0)
        )
      ) {
        throw new Error('malformed puzzle: bad "benchmark" entry');
      }
    }
  }
  return data as unknown as Puzzle;
}
