// Client of the daily-puzzle backend (Lambda Function URL behind CloudFront, #2).
// The SERVER is the authoritative time source: it decides "today" (the 22:00 ET,
// DST-correct flip) and serves the matching puzzle. The client never computes the
// date for normal play — it just asks the backend.

// Base URL of the backend, configured at build time via VITE_API_BASE_URL.
// Trailing slashes are trimmed so callers can append paths cleanly. Empty when
// unset (e.g. local dev with no backend) — normal play then can't resolve a
// puzzle, and the ?puzzle= override is the way to load a file directly.
export function apiBase(env: ImportMetaEnv = import.meta.env): string {
  return (env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');
}

// The active day's puzzle for a language: GET <base>/?lang=<lang>. The server
// resolves which day it is; the client passes only the language.
export function puzzleUrl(lang: string, base: string = apiBase()): string {
  return `${base}/?lang=${encodeURIComponent(lang)}`;
}

// The server's day metadata: GET <base>/today -> { date, dayNumber, ... }. The
// front keys on `dayNumber` (stable, language-independent) for persistence (#7)
// and the already-solved-today screen (#9).
export function todayUrl(base: string = apiBase()): string {
  return `${base}/today`;
}

// Shape of GET /today the front keys on (the backend returns more fields, ignored).
export interface Today {
  date: string; // "YYYY-MM-DD"
  dayNumber: number; // whole days since the Unix epoch
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
