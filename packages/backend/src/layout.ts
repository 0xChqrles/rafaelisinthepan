// The single source of truth for how a puzzle is KEYED in the store — shared by both
// readers (`fsStore` / `s3Store`) and the `publish` writer, so the local FS, real S3,
// and the day/lang contract of #2/#6 cannot drift apart.
//
// Layout (identical for local FS and S3 — the prefix is just a dir vs. a bucket):
//
//     <date>.<lang>.json
//
// Flat and fully determined by (game day, language):
// - directly addressable, so readers GetObject/readFile by key — no list+filter;
// - listable by a date PREFIX (ListObjects "2026-" for a year, "2026-06" for a month);
// - <date> is the GAME DAY this puzzle is served as ("YYYY-MM-DD", the 22:00-ET day of
//   #2/#6), NOT the day it was generated. The puzzle's words live in the file, not the key.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// A strict "YYYY-MM-DD" that is also a real calendar date (rejects 2026-13-40 etc).
export function isValidDate(date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return false;
  const [, y, mo, d] = m.map(Number);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === mo - 1 &&
    probe.getUTCDate() === d
  );
}

// The store key (also the basename, the layout is flat) for a (game day, language):
// "<date>.<lang>.json". Used by the readers to GetObject/readFile directly and by
// `publish` to write — one key per (date, lang), so there is never ambiguity.
export function storeKey(date: string, lang: string): string {
  return `${date}.${lang}.json`;
}

// Default local store root: packages/backend/.local-store (gitignored). Override with
// the PUZZLE_STORE env var. Resolved from this module so it is the same dir whether
// `serve` or `publish` is run from the repo root or the package directory.
export function defaultLocalStoreRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // packages/backend/src
  return path.resolve(here, '..', '.local-store');
}
