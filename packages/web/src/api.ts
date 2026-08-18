// Client of the daily-puzzle backend (Lambda Function URL behind CloudFront, #2).
// The puzzle URL is DATE-addressed: the client computes the active 22:00-ET game day
// itself (the shared day.ts — the same DST-correct code the server validates with)
// and asks for that date's puzzle in ONE fetch. The server only serves dates within
// a ±1-day clock-skew window of its own active day.

import type { Puzzle, ScoreHistogram, Word, WordPuzzle } from '@whippin/shared';
import type { Mode } from './langs';

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
type PuzzleOutcome = 'puzzle' | 'missing' | 'error';
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

// The optional group annotations on a rank entry (#115 distances, #163 rarity). They are
// group properties generation adds — a rank-0 entry carries no `dq` and a borrowed-vector
// group no `freq`, so ABSENT stays valid — but a PRESENT one must be well formed: scoring,
// the history line and Word mode's clock read them as numbers, so a string or an
// out-of-range value would corrupt them silently. `freq` is the one whose damage would be
// invisible rather than visual: it buys SECONDS, and a NaN reaching the deadline arithmetic
// ends a run instantly or never. Its upper end is deliberately unbounded — it is a
// vocabulary position, and an implausibly large one simply lands in the rarest bonus tier.
function checkRankAnnotations(entry: Record<string, unknown>): void {
  const { dq, freq } = entry;
  if (dq !== undefined && (typeof dq !== 'number' || !Number.isInteger(dq) || dq < 0 || dq > 255)) {
    throw new Error('malformed puzzle: "dq" must be an integer 0-255');
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
// secret/start {word,slug} + start_rank, a ranks map for every secret, and the optional
// per-entry distance annotations (#115)).
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
  return data as unknown as Puzzle;
}

// Runtime shape check for Word mode's fetched artifact (#154/#156) — the same job as
// parsePuzzle for the same reason: a truncated/wrong body must surface as the error
// state, never crash the board mid-render. Asserts the load-bearing structure: lang, the
// public word {word, slug}, and the ONE flat rank map with well-formed rank/dq/freq
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
  // `freq` is optional PER ENTRY (a borrowed-vector group has no position to read) but a
  // map carrying NONE is a pre-#163 artifact: every claim would silently grade at the
  // COMMON floor and halve the run's economy with nothing anywhere looking wrong. The
  // standing no-back-compat rule says a stale artifact is republished, never limped on —
  // so it surfaces as the load failure it is.
  if (!Object.values(ranks).some((entry) => isRecord(entry) && entry.freq !== undefined)) {
    throw new Error('malformed word puzzle: no "freq" on any entry (pre-#163 artifact)');
  }
  return data as unknown as WordPuzzle;
}

// The live score histogram (#169/#170): GET reads a day's population, POST records the
// player's score and returns the population WITH it — one round trip on the happy path.
// Unlike the puzzle route, `mode` is REQUIRED here.
export function scoresUrl(lang: string, date: string, mode: Mode, base: string = apiBase()): string {
  return `${requireApiBase(base)}/scores?lang=${encodeURIComponent(lang)}&date=${encodeURIComponent(
    date,
  )}&mode=${encodeURIComponent(mode)}`;
}

// Runtime shape check for the histogram response — the parsePuzzle contract: a truncated
// or wrong-shaped body surfaces as a failure (silent, here), never as NaN bars. An EMPTY
// bucket list is valid since #187 — the bands are derived from the day's recorded rows,
// so a population of zero honestly has none.
export function parseScoreHistogram(data: unknown): ScoreHistogram {
  if (!isRecord(data)) throw new Error('malformed histogram: not an object');
  const { buckets, total, bucket } = data;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) {
    throw new Error('malformed histogram: "total" must be a non-negative integer');
  }
  if (bucket !== null && (typeof bucket !== 'number' || !Number.isInteger(bucket))) {
    throw new Error('malformed histogram: "bucket" must be an integer or null');
  }
  if (!Array.isArray(buckets)) {
    throw new Error('malformed histogram: "buckets" must be an array');
  }
  for (const b of buckets) {
    if (
      !isRecord(b) ||
      typeof b.min !== 'number' ||
      typeof b.max !== 'number' ||
      typeof b.count !== 'number' ||
      !Number.isInteger(b.count) ||
      b.count < 0
    ) {
      throw new Error('malformed histogram: bad bucket entry');
    }
  }
  if (bucket !== null && (bucket < 0 || bucket >= buckets.length)) {
    throw new Error('malformed histogram: "bucket" index is outside "buckets"');
  }
  return data as unknown as ScoreHistogram;
}

// Production POSTs cross CloudFront's OAC in front of the Lambda URL, which refuses an
// unsigned body: the request must carry `x-amz-content-sha256`, the lowercase hex SHA-256
// of the EXACT UTF-8 body bytes. Hash and send the same byte array — never reserialize
// after hashing (the root AGENTS.md records this as a hard contract).
export async function postScoreBody(
  url: string,
  body: { secret: string; score: number; turnstileToken: string },
): Promise<Response> {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-amz-content-sha256': hex },
    body: bytes,
  });
}
