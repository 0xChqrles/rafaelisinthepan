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

// The two daily artifact types (#156): the sentence puzzle, and Word mode's single-word
// artifact (#154). Both are day-addressed the same way; the mode only picks the key.
export type PuzzleMode = 'sentence' | 'word';

// The store key (also the basename, the layout is flat) for a (game day, language, mode):
// "<date>.<lang>.json" for the sentence puzzle, "<date>.<lang>.word.json" for the Word
// mode artifact (#154/#156). Used by the readers to GetObject/readFile directly and by
// `publish` to write — one key per (date, lang, mode), so there is never ambiguity.
export function storeKey(date: string, lang: string, mode: PuzzleMode = 'sentence'): string {
  return mode === 'word' ? `${date}.${lang}.word.json` : `${date}.${lang}.json`;
}

// #203's derivation slice, published BESIDE the sentence puzzle by `puzzle:publish` and
// read straight from the store by the round route — never through CloudFront, so there is
// no new route and no cache-policy change. Same flat, fully-determined layout as the
// puzzle; the `.gz` is literal, because the object IS gzip bytes (these slugs share long
// prefixes and compress 5.3x, so a 66.7 KB slice travels as 12.5 KB).
export function sliceKey(date: string, lang: string): string {
  return `${date}.${lang}.slice.json.gz`;
}

// Default local store root: packages/backend/.local-store (gitignored). Override with
// the PUZZLE_STORE env var. Resolved from this module so it is the same dir whether
// `serve` or `publish` is run from the repo root or the package directory.
export function defaultLocalStoreRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // packages/backend/src
  return path.resolve(here, '..', '.local-store');
}
