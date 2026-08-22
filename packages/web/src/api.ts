// Client of the daily-puzzle backend (Lambda Function URL behind CloudFront, #2).
// The puzzle URL is DATE-addressed: the client computes the active 22:00-ET game day
// itself (the shared day.ts — the same DST-correct code the server validates with)
// and asks for that date's puzzle in ONE fetch. The server only serves dates within
// a ±1-day clock-skew window of its own active day.

import { isValidAvatar, PUBLIC_ID_PATTERN } from '@whippin/shared';
import type {
  Board,
  BoardPlayer,
  BoardRow,
  PlayerProfile,
  Puzzle,
  ScoreHistogram,
  Word,
  WordPuzzle,
} from '@whippin/shared';
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
  const { lang, words, holes, ranks, revision } = data;
  if (typeof lang !== 'string') throw new Error('malformed puzzle: missing "lang"');
  // WHICH PUBLISHED VERSION this is (#203). It is the round's identity on the wire, so a
  // puzzle without one cannot be played: the server would have nothing to check its slice
  // and its rank maps against. Stamped by `puzzle:publish`; an artifact predating it is
  // republished, never limped on (the no-back-compat rule).
  if (typeof revision !== 'string' || revision.length === 0) {
    throw new Error('malformed puzzle: missing "revision"');
  }
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

// The live score population (#169/#170), READ-ONLY since #203: a finished round no longer
// claims its score — the server derives it from the guess log and records the row itself
// (the round route), so this is a plain GET of the day's bands. Unlike the puzzle route,
// `mode` is REQUIRED here.
export function scoresUrl(
  lang: string,
  date: string,
  mode: Mode,
  id?: string,
  base: string = apiBase(),
): string {
  const root = `${requireApiBase(base)}/scores?lang=${encodeURIComponent(lang)}&date=${encodeURIComponent(
    date,
  )}&mode=${encodeURIComponent(mode)}`;
  // The caller's PUBLIC id (#203, added on review), which is what makes the answer's
  // `bucket` this player's rather than whoever else recorded the same number. `id` is in the
  // score behavior's allowList — the root AGENTS.md three-package contract.
  return id ? `${root}&id=${encodeURIComponent(id)}` : root;
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
async function postSignedJson(url: string, body: unknown): Promise<Response> {
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

// The round route (#201/#202/#203): the server-authoritative state of one player's play on
// one daily, one item per (date, lang, mode, publicId). POST-only like /friends —
// `{secret, puzzle}` reads the stored round (404 = none yet); SENTENCE mode streams into it
// with `{secret, puzzle, guesses}`, carrying a `turnstileToken` on the append that CREATES
// the round, while WORD mode writes twice, `{secret, puzzle, turnstileToken}` to START its
// server-stamped clock and one `{secret, puzzle, guesses}` carrying the whole log at the
// end. EVERY answer, refusals included, carries the full state, so a write is also a
// reconciliation. `puzzle` is the opaque tag naming WHICH puzzle the state belongs to
// (state/roundSync.ts `puzzleTag`), which is how a re-published daily restarts it instead of
// inheriting the retired one's. The three query parameters are in the round CloudFront
// behavior's allowList (the root AGENTS.md three-package contract).
export function roundUrl(lang: string, date: string, mode: Mode, base: string = apiBase()): string {
  return `${requireApiBase(base)}/round?lang=${encodeURIComponent(lang)}&date=${encodeURIComponent(
    date,
  )}&mode=${encodeURIComponent(mode)}`;
}

export async function postRoundBody(
  url: string,
  body: { secret: string; puzzle: string; guesses?: string[]; turnstileToken?: string },
): Promise<Response> {
  return postSignedJson(url, body);
}

export interface RoundState {
  guesses: string[];
  createdAt: string;
  // Word mode's SERVER-stamped clock (#202); null on a sentence round and on a word round
  // nobody has started.
  startedAt: string | null;
  // When the word round's end-of-run log was RECORDED; null while it has not been. It is
  // the submission's own marker because an empty stored log — a run that claimed nothing —
  // reads exactly like an unsubmitted one.
  submittedAt: string | null;
  // The server's own clock at the moment it answered. A client anchors a run's countdown
  // to `now - startedAt` — an ELAPSED span, which both ends agree on — rather than to the
  // instant itself, which a skewed device clock would misread.
  now: string;
  // START only: did THIS call stamp the clock, or join one already running? A resumed
  // clock belongs to another device (or another tab), and this one cannot know what that
  // run has claimed — so it must never write for it.
  resumed: boolean;
  // Sentence mode: has the SERVER read this round's log as solved (#203)? It is the server
  // deriving what it stores, and it is what says the day's score row is recorded — which is
  // when a standing becomes readable. Only ever written true, so `false` means "not yet",
  // never "no longer".
  solved: boolean;
}

// Runtime shape check for the round response — the parsePuzzle contract: a wrong-shaped
// body surfaces as a sync failure (silent by design), never as garbage entering the
// round's try log. The two instants are checked as PARSEABLE, not merely as strings:
// they feed the deadline arithmetic, where a NaN ends a run instantly or never.
function requireInstant(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`malformed round: bad "${field}"`);
  }
  return value;
}

export function parseRound(data: unknown): RoundState {
  if (!isRecord(data)) throw new Error('malformed round: not an object');
  const { guesses, createdAt, startedAt, submittedAt, resumed, solved } = data;
  if (!Array.isArray(guesses) || !guesses.every((g) => typeof g === 'string')) {
    throw new Error('malformed round: "guesses" must be an array of strings');
  }
  if (typeof createdAt !== 'string') throw new Error('malformed round: bad "createdAt"');
  if (resumed !== undefined && typeof resumed !== 'boolean') {
    throw new Error('malformed round: bad "resumed"');
  }
  if (solved !== undefined && typeof solved !== 'boolean') {
    throw new Error('malformed round: bad "solved"');
  }
  return {
    guesses: guesses as string[],
    createdAt,
    startedAt: startedAt === undefined ? null : requireInstant(startedAt, 'startedAt'),
    submittedAt: submittedAt === undefined ? null : requireInstant(submittedAt, 'submittedAt'),
    now: requireInstant(data.now, 'now'),
    // Only a START answers it. Absent means "not a start", and the safe reading of an
    // answer that did not say is that this client did NOT stamp the clock.
    resumed: resumed !== false,
    // Absent means the server holds no solve for this round — a word round, or a sentence
    // one still being played.
    solved: solved === true,
  };
}

// The #188 player profile: GET reads the public row by publicId (what a board renders,
// and what a freshly linked device loads); POST is the authenticated upsert. `id` is in
// the profile CloudFront behavior's allowList — the same three-package contract as the
// score route's parameters.
export function profileUrl(publicId?: string, base: string = apiBase()): string {
  const root = `${requireApiBase(base)}/profile`;
  return publicId ? `${root}?id=${encodeURIComponent(publicId)}` : root;
}

export async function postProfileBody(
  url: string,
  body: { secret: string; name: string; avatar: string },
): Promise<Response> {
  return postSignedJson(url, body);
}

// The #189 friends graph: ONE route, POST-only — the player key authenticates in the body
// (#187) and there is no query to ask with, so a caller can only ever read or change their
// own edges. `{secret}` reads the list, `{secret, add}` records the mutual edge an invite
// link's click makes, `{secret, remove}` deletes both sides. Every call answers with the
// caller's current list.
export function friendsUrl(base: string = apiBase()): string {
  return `${requireApiBase(base)}/friends`;
}

export async function postFriendsBody(
  url: string,
  body: { secret: string; add?: string; remove?: string },
): Promise<Response> {
  return postSignedJson(url, body);
}

// Runtime shape check for the friends response — the parsePuzzle contract: a wrong-shaped
// body surfaces as a failure, never as a board of blank rows.
export function parseFriends(data: unknown): string[] {
  if (!isRecord(data)) throw new Error('malformed friends: not an object');
  const { friends } = data;
  if (!Array.isArray(friends) || !friends.every((id) => typeof id === 'string' && PUBLIC_ID_PATTERN.test(id))) {
    throw new Error('malformed friends: "friends" must be an array of player ids');
  }
  return friends as string[];
}

// The #190 leaderboard: GET is the anonymous GLOBAL top 50 (`id` — the caller's PUBLIC
// id, never the secret — widens it with their own below-the-cut window); POST with
// `{secret}` is the authenticated FRIENDS board, the trusted surface. Addressed per
// (day, lang, mode) like everything else; all four query parameters are in the board
// CloudFront behavior's allowList (the root AGENTS.md three-package contract).
export function boardUrl(
  lang: string,
  date: string,
  mode: Mode,
  id?: string,
  base: string = apiBase(),
): string {
  const root = `${requireApiBase(base)}/board?lang=${encodeURIComponent(lang)}&date=${encodeURIComponent(
    date,
  )}&mode=${encodeURIComponent(mode)}`;
  return id ? `${root}&id=${encodeURIComponent(id)}` : root;
}

export async function postBoardBody(url: string, body: { secret: string }): Promise<Response> {
  return postSignedJson(url, body);
}

// Runtime shape check for a board response — the parsePuzzle contract: a wrong-shaped
// body surfaces as the screen's failure state, never as a board of NaN rows. The avatar
// must be null or a DECODABLE string (isValidAvatar, parseProfile's own rule): "any
// string" would let an empty/garbage value slip past the `?? defaultAvatar` fallback
// (nullish only) into decodeAvatar, where a thrown decode drops the row's mark and
// shifts the whole order-placed row grid.
function isBoardPlayer(row: unknown): row is BoardPlayer {
  return (
    isRecord(row) &&
    typeof row.publicId === 'string' &&
    PUBLIC_ID_PATTERN.test(row.publicId) &&
    typeof row.name === 'string' &&
    (row.avatar === null || isValidAvatar(row.avatar))
  );
}

function checkBoardPlayers(value: unknown, field: string): asserts value is BoardPlayer[] {
  if (!Array.isArray(value)) throw new Error(`malformed board: "${field}" must be an array`);
  for (const row of value) {
    if (!isBoardPlayer(row)) throw new Error(`malformed board: bad "${field}" row`);
  }
}

function checkBoardRows(value: unknown, field: string): asserts value is BoardRow[] {
  if (!Array.isArray(value)) throw new Error(`malformed board: "${field}" must be an array`);
  for (const raw of value) {
    const row = raw as Record<string, unknown>;
    if (
      !isBoardPlayer(raw) ||
      typeof row.score !== 'number' ||
      !Number.isInteger(row.score) ||
      typeof row.rank !== 'number' ||
      !Number.isInteger(row.rank) ||
      row.rank < 1
    ) {
      throw new Error(`malformed board: bad "${field}" row`);
    }
  }
}

export function parseBoard(data: unknown): Board {
  if (!isRecord(data)) throw new Error('malformed board: not an object');
  const { rows, own, waiting } = data;
  checkBoardRows(rows, 'rows');
  if (own !== null) checkBoardRows(own, 'own');
  checkBoardPlayers(waiting, 'waiting');
  return data as unknown as Board;
}

// Runtime shape check for a fetched profile — the parsePuzzle contract: a wrong-shaped
// body surfaces as a failure, never as a broken editor or board row.
export function parseProfile(data: unknown): PlayerProfile {
  if (!isRecord(data)) throw new Error('malformed profile: not an object');
  const { publicId, name, avatar } = data;
  if (typeof publicId !== 'string' || !PUBLIC_ID_PATTERN.test(publicId)) {
    throw new Error('malformed profile: bad "publicId"');
  }
  if (typeof name !== 'string') throw new Error('malformed profile: bad "name"');
  if (!isValidAvatar(avatar)) throw new Error('malformed profile: bad "avatar"');
  return { publicId, name, avatar };
}
