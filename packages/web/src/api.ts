// Client of the daily-puzzle backend (Lambda Function URL behind CloudFront, #2).
// The SERVER is the authoritative time source: it decides "today" (the 22:00 ET,
// DST-correct flip) and serves the matching puzzle. The client never computes the
// date for normal play — it just asks the backend.

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

// The active day's puzzle for a language: GET <base>/?lang=<lang>&v=<version>. The server
// resolves which day it is; the client passes the language + the content `version` it read
// from /today. `version` is REQUIRED (issue #42): the endpoint is version-addressed, so a
// corrected puzzle gets a new version -> a new URL -> a guaranteed CDN + browser miss, and
// the fresh puzzle shows on a normal reload with no CloudFront invalidation. A request
// without `v` is a protocol violation the backend rejects with 400.
export function puzzleUrl(lang: string, version: string, base: string = apiBase()): string {
  return `${requireApiBase(base)}/?lang=${encodeURIComponent(lang)}&v=${encodeURIComponent(version)}`;
}

// The server's day metadata + version pointer: GET <base>/today[?lang=<lang>] ->
// { date, dayNumber, version, ... }. The front keys on `dayNumber` (stable,
// language-independent) for persistence (#7) and the already-solved-today screen (#9);
// `version` (present only when a `lang` is passed) builds the cache-busting puzzle URL
// (#42). This response is `no-store`, so it always reflects the current version. `lang`
// is optional: callers that only need `dayNumber` (e.g. useToday) can omit it.
export function todayUrl(lang?: string, base: string = apiBase()): string {
  const q = lang ? `?lang=${encodeURIComponent(lang)}` : '';
  return `${requireApiBase(base)}/today${q}`;
}

// Shape of GET /today the front keys on (the backend returns more fields, ignored).
export interface Today {
  date: string; // "YYYY-MM-DD"
  dayNumber: number; // whole days since the Unix epoch
  version?: string | null; // content version of today's puzzle (null when none) — #42
  secondsUntilNextReset?: number; // whole seconds until the 22:00-ET flip (caches expire then)
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
// Not exhaustive — it asserts only the structure Game depends on (lang, words, each
// hole's secret/start {word,slug} + start_rank, and a ranks map that has an entry for
// every secret, since Game does ranks[secret][typed] on the first guess).
export function parsePuzzle(data: unknown): Puzzle {
  if (!isRecord(data)) throw new Error('malformed puzzle: not an object');
  const { lang, words, holes, ranks } = data;
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
  return data as unknown as Puzzle;
}
