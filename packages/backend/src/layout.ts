// The single source of truth for how a puzzle is NAMED and LOCATED in the store —
// shared by the local filesystem store (read by `serve` / `fsStore`), the `publish`
// writer, and (eventually, #4) the S3 uploader. Encoding it once keeps the
// local store, real S3, and the day/lang contract of #2/#6 from drifting apart.
//
// Layout (identical for local FS and S3, the prefix is just a dir vs. a bucket):
//
//     <date>/<slug1>-<slug2>-<slug3>.<lang>.json
//
// - <date>  = the GAME DAY this puzzle is served as ("YYYY-MM-DD", the 22:00-ET day
//             of #2/#6), NOT the day it was generated.
// - <slugN> = the secret slugs in SENTENCE order (by `pos`), joined by "-". ASCII
//             slugs only (filenames are slugs; see AGENTS.md), so this is the
//             `_`-joined generator filename with "-" instead.
// - <lang>  = the language suffix the readers (`fsStore` / `s3Store`) select on.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Puzzle } from '@rafaelisinthepan/shared';

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

// The object basename for a puzzle: "<slug>-<slug>-<slug>.<lang>.json", secret slugs
// in sentence order. The readers only match on the ".<lang>.json" suffix, but a stable,
// human-readable, collision-resistant name keeps the store browseable and deterministic.
export function puzzleObjectName(puzzle: Puzzle): string {
  const slugs = [...puzzle.holes]
    .sort((a, b) => a.pos - b.pos)
    .map((h) => h.secret.slug);
  return `${slugs.join('-')}.${puzzle.lang}.json`;
}

// The full store key relative to the root (local dir or S3 bucket): "<date>/<name>".
export function puzzleKey(date: string, puzzle: Puzzle): string {
  return `${date}/${puzzleObjectName(puzzle)}`;
}

// Default local store root: packages/backend/.local-store (gitignored). Override with
// the PUZZLE_STORE env var. Resolved from this module so it is the same dir whether
// `serve` or `publish` is run from the repo root or the package directory.
export function defaultLocalStoreRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // packages/backend/src
  return path.resolve(here, '..', '.local-store');
}
