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
// - A BONUS puzzle (shared bonus.ts) takes its ADDRESS, `bonus/<id>`, in the day's slot:
//   `bonus/<id>.<lang>.json`, one prefix apart, so no day listing ever meets it.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The store key (also the basename, the layout is flat) for a (game day, language):
// "<date>.<lang>.json". Used by the readers to GetObject/readFile directly and by `publish`
// to write — one key per (date, lang), so there is never ambiguity.
export function storeKey(date: string, lang: string): string {
  return `${date}.${lang}.json`;
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
function defaultLocalStoreRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // packages/backend/src
  return path.resolve(here, '..', '.local-store');
}

// The local store root every local tool reads and writes: `override` (publish's `--store`)
// if given, else PUZZLE_STORE, else the default above. A RELATIVE path resolves against the
// directory the command was INVOKED from (pnpm/npm set INIT_CWD to it), not the package dir
// pnpm `cd`s into — ONE resolution, so `publish`, `serve`, `inventory` and `board:seed`
// given the same value can never land in different directories.
export function localStoreRoot(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = override ?? env.PUZZLE_STORE;
  return raw ? path.resolve(env.INIT_CWD ?? process.cwd(), raw) : defaultLocalStoreRoot();
}
