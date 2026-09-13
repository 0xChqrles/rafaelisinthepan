// Client of the daily-puzzle backend (Lambda Function URL behind CloudFront, #2).
// The puzzle URL is DATE-addressed: the client computes the active 22:00-ET game day
// itself (the shared day.ts — the same DST-correct code the server validates with)
// and asks for that date's puzzle in ONE fetch. The server only serves dates within
// a ±1-day clock-skew window of its own active day.

import {
  DEVICE_ID_PATTERN,
  GROUP_ID_PATTERN,
  isBoardPeriod,
  isValidAvatar,
  isValidDeviceToken,
  PUBLIC_ID_PATTERN,
} from '@whippin/shared';
import type {
  Board,
  BoardPeriod,
  BoardPlayer,
  BoardRow,
  GroupStanding,
  GroupSummary,
  PeriodBoard,
  PeriodRow,
  PlayingRow,
  PlayerHistory,
  PlayerProfile,
  PublicGroup,
  Puzzle,
  Word,
  WordPuzzle,
} from '@whippin/shared';
import type { Mode } from './langs';
import { timeoutSignal } from './timeout';

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
  checkSource(data.source);
  return data as unknown as Puzzle;
}

// The optional source (#5) passes through — except its two #270 fields, which the solved
// page RENDERS rather than merely prints: the excerpt has to be two arrays of strings (a
// malformed one would crash the page mid-render), and the url becomes an href, so it has
// to be a web link and nothing else.
function checkSource(source: unknown): void {
  if (source === undefined) return;
  if (!isRecord(source)) throw new Error('malformed puzzle: "source" must be an object');
  const { excerpt, url } = source;
  const isStrings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === 'string');
  if (excerpt !== undefined && (!isRecord(excerpt) || !isStrings(excerpt.before) || !isStrings(excerpt.after))) {
    throw new Error('malformed puzzle: "source.excerpt" must hold "before" and "after" string arrays');
  }
  if (url !== undefined && (typeof url !== 'string' || !/^https?:\/\//i.test(url))) {
    throw new Error('malformed puzzle: "source.url" must be a web link');
  }
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

// Production POSTs cross CloudFront's OAC in front of the Lambda URL, which refuses an
// unsigned body: the request must carry `x-amz-content-sha256`, the lowercase hex SHA-256
// of the EXACT UTF-8 body bytes. Hash and send the same byte array — never reserialize
// after hashing (the root AGENTS.md records this as a hard contract).
async function postSignedJson(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-amz-content-sha256': hex },
    body: bytes,
    ...(signal ? { signal } : {}),
  });
}

// The one refusal that signs a device out (#216): 401 whose body CODE is `unknown_device`.
// One spelling for every caller — the status alone must never do it (a language the server
// does not serve also answers 4xx), and a 5xx or a dropped connection must never sign
// anyone out at all.
export function isUnknownDeviceAnswer(status: number, error: unknown): boolean {
  return status === 401 && error === 'unknown_device';
}

// The device route (#216): the lazy Turnstile-gated bootstrap that MINTS this device's
// identity, and the sign-out screen's list + revocation. POST-only — the
// device token is the auth and it travels in the BODY, never a query string, so the route
// reads no query at all (its CloudFront behavior's allow-list is EMPTY, the same
// three-package contract). The answer never carries the token back: the client already
// holds it, and echoing it would put it somewhere a proxy or a log could see.
export function devicesUrl(base: string = apiBase()): string {
  return `${requireApiBase(base)}/devices`;
}

// Every /devices call is BOUNDED (the invite landing's turnstile rule, sized for a cold
// Lambda + a server-side Siteverify): the bootstrap runs inside the origin-wide Web Lock
// behind a module-level flight, so a request that never settled used to wedge account
// creation for every tab — no error, no retry, PLAY disabled forever.
const DEVICES_TIMEOUT_MS = 15_000;

export async function postDevicesBody(
  url: string,
  body: { token: string; turnstileToken?: string; revoke?: string; revokeKey?: string },
): Promise<Response> {
  return postSignedJson(url, body, timeoutSignal(DEVICES_TIMEOUT_MS));
}

export interface DeviceRow {
  // Opaque SHA-256 handle for the base item. It cannot authenticate, and lets the server
  // revoke this listed row directly without rediscovering it through a lagging GSI.
  revokeKey: string;
  deviceId: string;
  device: string;
  os: string;
  browser: string;
  createdAt: string;
  lastSeenAt: string;
  // Is this the device asking? It holds a token, never a device id, so only the server can
  // say which row is its own.
  current: boolean;
}

export interface DeviceListing {
  accountId: string;
  deviceId: string;
  devices: DeviceRow[];
}

// The two ASSIGNED ids alone — what the BOOTSTRAP consumes. It deliberately does not
// touch the devices list riding the same answer: identity acquisition must never fail on
// a row only the sign-out SCREEN would render — that screen has its own failed state and
// RETRY, where a bootstrap that keeps rejecting retries the same persisted token forever
// while the server has already created the account.
export function parseAssignedIdentity(data: unknown): { accountId: string; deviceId: string } {
  if (!isRecord(data)) throw new Error('malformed device: not an object');
  const { accountId, deviceId } = data;
  if (typeof accountId !== 'string' || !PUBLIC_ID_PATTERN.test(accountId)) {
    throw new Error('malformed device: bad "accountId"');
  }
  if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
    throw new Error('malformed device: bad "deviceId"');
  }
  return { accountId, deviceId };
}

// Runtime shape check for the full list answer — the parsePuzzle contract: a wrong-shaped
// body surfaces as the device screen's failure state, never as rows whose SIGN OUT posts
// `undefined`. The timestamps are checked as strings but NOT as parseable instants: the
// server's own row reader defaults an absent attribute to '', and the screen already
// renders an unparseable date as no date — refusing the whole list over a label would
// hide every OTHER device behind one damaged row.
export function parseDeviceIdentity(data: unknown): DeviceListing {
  parseAssignedIdentity(data);
  const { devices } = data as Record<string, unknown>;
  if (!Array.isArray(devices)) throw new Error('malformed device: "devices" must be an array');
  for (const raw of devices) {
    const row = raw as Record<string, unknown>;
    if (
      !isRecord(raw) ||
      !isValidDeviceToken(row.revokeKey) ||
      typeof row.deviceId !== 'string' ||
      !DEVICE_ID_PATTERN.test(row.deviceId) ||
      typeof row.device !== 'string' ||
      typeof row.os !== 'string' ||
      typeof row.browser !== 'string' ||
      typeof row.createdAt !== 'string' ||
      typeof row.lastSeenAt !== 'string' ||
      typeof row.current !== 'boolean'
    ) {
      throw new Error('malformed device: bad "devices" row');
    }
  }
  return data as unknown as DeviceListing;
}

// The round route (#201/#202/#203): the server-authoritative state of one player's play on
// one daily, one item per (date, lang, mode, account). POST-only —
// `{token, puzzle}` reads the stored round (404 = none yet); SENTENCE mode streams into it
// with `{token, puzzle, guesses}`, carrying a `turnstileToken` on the append that CREATES
// the round, while WORD mode writes twice, `{token, puzzle, turnstileToken}` to START its
// server-stamped clock and one `{token, puzzle, guesses}` carrying the whole log at the
// end. EVERY answer, refusals included, carries the full state, so a write is also a
// reconciliation. In sentence mode `puzzle` is the published revision naming WHICH puzzle
// the state belongs to, which is how a corrected daily restarts instead of inheriting the
// retired one's log. The three query parameters are in the round CloudFront
// behavior's allowList (the root AGENTS.md three-package contract).
export function roundUrl(lang: string, date: string, mode: Mode, base: string = apiBase()): string {
  return `${requireApiBase(base)}/round?lang=${encodeURIComponent(lang)}&date=${encodeURIComponent(
    date,
  )}&mode=${encodeURIComponent(mode)}`;
}

export async function postRoundBody(
  url: string,
  body: { token: string; puzzle: string; guesses?: string[]; turnstileToken?: string },
): Promise<Response> {
  return postSignedJson(url, body);
}

// WHICH DEVICE a word run belongs to (#217): the id the server's own two conditions
// compare, plus the device's parsed user-agent fields — a snapshot taken when the run was
// stamped, so a screen offering to end that run can NAME it without a second lookup.
export interface RoundRunner {
  deviceId: string;
  device: string;
  os: string;
  browser: string;
}

export interface RoundState {
  guesses: string[];
  createdAt: string;
  // Word mode's SERVER-stamped clock (#202); null on a sentence round and on a word round
  // nobody has started.
  startedAt: string | null;
  // WHO holds that clock (#217) — null exactly when `startedAt` is, since one write stamps
  // both. It is half of what the Word screen picks its phase from: a run this device does
  // not own is one it may neither play nor submit, only start over.
  startedBy: RoundRunner | null;
  // When the word round's end-of-run log was RECORDED; null while it has not been. It is
  // the submission's own marker because an empty stored log — a run that claimed nothing —
  // reads exactly like an unsubmitted one.
  submittedAt: string | null;
  // The server's own clock at the moment it answered. A client anchors a run's countdown
  // to `now - startedAt` — an ELAPSED span, which both ends agree on — rather than to the
  // instant itself, which a skewed device clock would misread.
  now: string;
  // Sentence mode: has the SERVER read this round's log as solved (#203)? It is the server
  // deriving what it stores, and it is what says the day's score row is recorded — which is
  // when a standing becomes readable. Only ever written true, so `false` means "not yet",
  // never "no longer".
  solved: boolean;
  // Carried by the answer that CONFIRMS a solve: did it earn the day's rewards — the
  // streak credit and the leaderboard row (#211's one on-time predicate, decided on the
  // SERVER's clock)? The celebration rides this rather than re-making the comparison on
  // the device clock, which the route's skew window lets disagree by a day. Absent means
  // false: nothing was earned, or this answer is not the confirming one.
  credited: boolean;
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

// The run's owner, as strict as the two instants beside it: the phase this decides is
// whether a player may keep playing, so a half-shaped stamp is a malformed answer rather
// than a device to guess at.
function requireRunner(value: unknown): RoundRunner | null {
  if (value === undefined) return null;
  if (
    !isRecord(value) ||
    typeof value.deviceId !== 'string' ||
    value.deviceId.length === 0 ||
    typeof value.device !== 'string' ||
    typeof value.os !== 'string' ||
    typeof value.browser !== 'string'
  ) {
    throw new Error('malformed round: bad "startedBy"');
  }
  return { deviceId: value.deviceId, device: value.device, os: value.os, browser: value.browser };
}

export function parseRound(data: unknown): RoundState {
  if (!isRecord(data)) throw new Error('malformed round: not an object');
  const { guesses, createdAt, startedAt, submittedAt, solved, credited } = data;
  if (!Array.isArray(guesses) || !guesses.every((g) => typeof g === 'string')) {
    throw new Error('malformed round: "guesses" must be an array of strings');
  }
  if (typeof createdAt !== 'string') throw new Error('malformed round: bad "createdAt"');
  if (solved !== undefined && typeof solved !== 'boolean') {
    throw new Error('malformed round: bad "solved"');
  }
  if (credited !== undefined && typeof credited !== 'boolean') {
    throw new Error('malformed round: bad "credited"');
  }
  return {
    guesses: guesses as string[],
    createdAt,
    startedAt: startedAt === undefined ? null : requireInstant(startedAt, 'startedAt'),
    startedBy: requireRunner(data.startedBy),
    submittedAt: submittedAt === undefined ? null : requireInstant(submittedAt, 'submittedAt'),
    now: requireInstant(data.now, 'now'),
    // Absent means the server holds no solve for this round — a word round, or a sentence
    // one still being played.
    solved: solved === true,
    // Absent means nothing was earned (or this answer is not the one confirming a solve).
    credited: credited === true,
  };
}

// The PRIVATE player history (#211): the archive calendar's month, the chooser's status
// strip and the streak's solved-day list, all off what the server already derives from the
// guess log (#203). POST-only — the device token authenticates in the BODY, so
// there is no way to ask for someone else's history. `month` is OPTIONAL: the streak needs
// the solved-day collection alone, and making that read spend a month Query would cost a
// whole calendar per game load. All three queries are in the history CloudFront behavior's
// allowList (the root AGENTS.md three-package contract).
export function historyUrl(
  lang: string,
  mode: Mode,
  month?: string,
  base: string = apiBase(),
): string {
  const root = `${requireApiBase(base)}/history?lang=${encodeURIComponent(
    lang,
  )}&mode=${encodeURIComponent(mode)}`;
  return month ? `${root}&month=${encodeURIComponent(month)}` : root;
}

export async function postHistoryBody(
  url: string,
  // `collection: false` opts out of the solved-day read (the chooser never renders the
  // streak); omitted means true, so the original body shape keeps its meaning.
  body: { token: string; collection?: boolean },
): Promise<Response> {
  return postSignedJson(url, body);
}

// Runtime shape check for the history response — the parsePuzzle contract: a wrong-shaped
// body surfaces as the calendar's failure state, never as a month of NaN fills or a streak
// counted off garbage. Both numbers are checked as REAL values, since one feeds a heat-ramp
// colour and the other the streak arithmetic.
export function parsePlayerHistory(data: unknown): PlayerHistory {
  if (!isRecord(data)) throw new Error('malformed history: not an object');
  const { days, solvedDays } = data;
  if (!Array.isArray(days)) throw new Error('malformed history: "days" must be an array');
  for (const raw of days) {
    const day = raw as Record<string, unknown>;
    if (
      !isRecord(raw) ||
      typeof day.date !== 'string' ||
      typeof day.progress !== 'number' ||
      !Number.isFinite(day.progress) ||
      typeof day.solved !== 'boolean'
    ) {
      throw new Error('malformed history: bad "days" entry');
    }
  }
  if (
    !Array.isArray(solvedDays) ||
    !solvedDays.every((day) => typeof day === 'number' && Number.isInteger(day))
  ) {
    throw new Error('malformed history: "solvedDays" must be an array of game days');
  }
  return data as unknown as PlayerHistory;
}

// The #188 player profile: GET reads the public row by publicId (what a board renders,
// and what a freshly linked device loads); POST is the authenticated upsert. `id` is in
// the profile CloudFront behavior's allowList — the same three-package contract as the
// score route's parameters.
export function profileUrl(publicId?: string, base: string = apiBase()): string {
  const root = `${requireApiBase(base)}/profile`;
  return publicId ? `${root}?id=${encodeURIComponent(publicId)}` : root;
}

// **`GET /profile` HAS THREE ANSWERS, AND THEY ARE NOT INTERCHANGEABLE** (#204). Reading
// only `response.ok` collapses them, which is how a DELETED account ends up drawn with the
// assigned pseudonym and mark that are still its own:
//
//   shown  — 200. The stored profile.
//   blank  — 404. LIVE, never customized: the assigned identity IS this player's face.
//   gone   — 410 `account_gone`. There is no face. Not the stored one, not the assigned
//            one: an account nobody can reach may not be drawn as a person.
//   failed — a transport error, a 5xx, an unparseable body. NOT evidence of a deletion,
//            so a caller that dresses blank keeps dressing blank.
//
// Each caller decides what to DO with `gone` — the account screens draw an account their
// own device token proves live, while the invite landing and the signed-out screen are
// looking at an id somebody else handed them. What none of them may do is guess.
export type ProfileRead =
  | { status: 'shown'; profile: PlayerProfile }
  | { status: 'blank' }
  | { status: 'gone' }
  | { status: 'failed' };

export async function readProfile(publicId: string, signal?: AbortSignal): Promise<ProfileRead> {
  try {
    const response = await fetch(profileUrl(publicId), signal ? { signal } : {});
    if (response.ok) return { status: 'shown', profile: parseProfile(await response.json()) };
    if (response.status === 404) return { status: 'blank' };
    // The CODE, not the status: a 410 is only a deletion when the body says so, and every
    // other refusal is this client getting something wrong rather than a vanished player.
    if (response.status === 410) {
      const error = await response
        .clone()
        .json()
        .then((body) => (body as { error?: unknown }).error)
        .catch(() => undefined);
      return error === 'account_gone' ? { status: 'gone' } : { status: 'failed' };
    }
    return { status: 'failed' };
  } catch {
    return { status: 'failed' };
  }
}

export async function postProfileBody(
  url: string,
  body: { token: string; name: string; avatar: string; createOnly?: true },
  // Optional, and only the BACKGROUND deployment passes one: the editor's own save reports
  // a stall on the error surface with TRY AGAIN, where a task nobody is watching would
  // otherwise hang for the browser's own default and hold its slot the whole time.
  signal?: AbortSignal,
): Promise<Response> {
  return postSignedJson(url, body, signal);
}

// Email account linking (#204): ONE route, POST-only — the device token is the auth and it
// travels in the BODY, so the route reads no query at all (its CloudFront behavior's
// allow-list is EMPTY, the same three-package contract as /devices).
//
//   { token }                                — what this account is saved as.
//   { token, email, turnstileToken, lang }   — send a six-digit code to that address.
//   { token, email, code, erase? }           — verify it, and link.
export function linkUrl(base: string = apiBase()): string {
  return `${requireApiBase(base)}/link`;
}

// Bounded like every /devices call, and for the same reason: the SEND leg waits on a
// server-side Siteverify AND an SES call, so a request that never settles would leave the
// flow's one button spinning with nothing to retry.
//
// Through `timeoutSignal`, NEVER `AbortSignal.timeout()`: that API is above the browser
// floor and is read as an ARGUMENT, so its `TypeError` lands before `fetch` is ever
// called. Here that is not a slow request but a dead feature — every leg of the flow
// surfaces as an ordinary send/verify failure whose TRY AGAIN can only fail again, on a
// browser where the rest of the app works. `timeout.ts` carries the rule and the
// production incident that wrote it; `timeout.test.ts` is what now keeps it.
const LINK_TIMEOUT_MS = 20_000;

export async function postLinkBody(
  url: string,
  body: {
    token: string;
    email?: string;
    turnstileToken?: string;
    lang?: string;
    code?: string;
    // The three CONSENTS a verify may carry: what may be created, and what may be left.
    // The server does only what the caller authorized — it never guesses which of them
    // the player meant.
    bind?: boolean;
    erase?: string;
    leave?: string;
  },
): Promise<Response> {
  return postSignedJson(url, body, timeoutSignal(LINK_TIMEOUT_MS));
}

// What the `{token}` READ answers: what this account IS, from the one row that authenticated
// the call. `email` is null until the player saves it — that absence is the ACCOUNT SCREEN's
// whole state, so it is a value rather than a missing field.
export interface AccountSummary {
  accountId: string;
  deviceId: string;
  email: string | null;
  createdAt: string;
  // A group departure an interrupted link left queued (#271). The client asks again until
  // it is not.
  departurePending: boolean;
}

export function parseAccountSummary(data: unknown): AccountSummary {
  if (!isRecord(data)) throw new Error('malformed account: not an object');
  const { accountId, deviceId, email, createdAt } = data;
  if (typeof accountId !== 'string' || !PUBLIC_ID_PATTERN.test(accountId)) {
    throw new Error('malformed account: bad "accountId"');
  }
  if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
    throw new Error('malformed account: bad "deviceId"');
  }
  if (email !== null && (typeof email !== 'string' || email.length === 0)) {
    throw new Error('malformed account: bad "email"');
  }
  if (typeof createdAt !== 'string') {
    throw new Error('malformed account: bad "createdAt"');
  }
  if (typeof data.departurePending !== 'boolean') {
    throw new Error('malformed account: bad "departurePending"');
  }
  return {
    accountId,
    deviceId,
    email,
    // Checked as a string but NOT as a parseable instant: the screen already renders an
    // unreadable date as no date (the device list's rule), and refusing the whole summary
    // over a label would hide the email state this screen exists for.
    createdAt,
    departurePending: data.departurePending,
  };
}

// What a VERIFY that succeeded did. `bound` saved the account this device already held;
// `adopted` moved this device onto the account behind the address — which is what a second
// device, and a reconnect after a sign-out, both are; `already_bound` is the no-op.
export interface LinkResult {
  outcome: 'bound' | 'adopted' | 'already_bound';
  accountId: string;
  deviceId: string;
  email: string;
  // Whether a group departure is still queued (#271): the deleted account's memberships
  // still to drop. The client RESUMES the drain off this, rather than leaving a ghost on
  // every one of those groups for whenever the player next opens `/account` (#204).
  //
  // REQUIRED, and validated as strictly as `parseAccountSummary` validates its own copy
  // (PR-227 follow-up review). It was optional and coerced with `=== true`, so a body that
  // omitted it — or sent it wrong — silently answered "nothing queued" and the resumed
  // drain never ran. A field whose absence disables a job is a field that has to be present.
  departurePending: boolean;
  // THE RECEIPT on an ADOPT: what the recovered account holds, which is the evidence for
  // the claim "we found your account". Absent on the other two outcomes — nothing was
  // recovered, so there is nothing to vouch for.
  stakes?: AccountStakes | null;
}

// What an account is worth, in the two numbers a player would name if asked what they
// would miss. Shown as a RECEIPT under a recovered face, and as the PRICE under a face
// about to be deleted — one shape, because they are the same measure.
export interface AccountStakes {
  streak: number;
  best: number;
  days: number;
}

function parseStakes(data: unknown): AccountStakes | null {
  if (!isRecord(data)) return null;
  const { streak, best, days } = data;
  if (typeof streak !== 'number' || typeof best !== 'number' || typeof days !== 'number') {
    return null;
  }
  return { streak, best, days };
}

// Runtime shape check for a link answer — the parsePuzzle contract. An identity is being
// REPLACED off this body, so a wrong-shaped one must surface as a failure rather than
// re-parenting the device onto an id nothing minted.
export function parseLinkResult(data: unknown): LinkResult {
  if (!isRecord(data)) throw new Error('malformed link: not an object');
  const { outcome, accountId, deviceId, email } = data;
  if (outcome !== 'bound' && outcome !== 'adopted' && outcome !== 'already_bound') {
    throw new Error('malformed link: bad "outcome"');
  }
  if (typeof accountId !== 'string' || !PUBLIC_ID_PATTERN.test(accountId)) {
    throw new Error('malformed link: bad "accountId"');
  }
  if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
    throw new Error('malformed link: bad "deviceId"');
  }
  if (typeof email !== 'string') throw new Error('malformed link: bad "email"');
  if (typeof data.departurePending !== 'boolean') {
    throw new Error('malformed link: bad "departurePending"');
  }
  return {
    outcome,
    accountId,
    deviceId,
    email,
    departurePending: data.departurePending,
    // Decorative, so a missing or malformed one is simply no receipt — never a failed
    // link, which would strand a device whose identity has already moved.
    stakes: parseStakes(data.stakes),
  };
}

// WHAT A `bad_code` REFUSAL LEAVES THE PLAYER: how many tries remain on this challenge,
// and whether that was the last one.
//
// **ZERO IS REACHABLE, and that is the whole point** (#204, PR-227 review). A COUNTED
// mismatch is `bad_code` — the LAST allowed one included, with `attemptsLeft: 0` — and
// only a call against an already-exhausted challenge is the `code_spent` 409. The server
// used to answer that 409 for the fifth mismatch itself, which made this branch dead and
// left the screen with nothing to say about how the code ran out.
//
// A missing or malformed count reads as NONE LEFT: the refusal is about a challenge whose
// state this client cannot see, and offering another try it does not have is worse than
// ending the step.
export interface BadCode {
  attemptsLeft: number;
  // The player has no try left: the flow says so and stops asking.
  exhausted: boolean;
}

export function parseBadCode(data: unknown): BadCode {
  const left =
    isRecord(data) && typeof data.attemptsLeft === 'number' && Number.isFinite(data.attemptsLeft)
      ? Math.max(0, Math.floor(data.attemptsLeft))
      : 0;
  return { attemptsLeft: left, exhausted: left === 0 };
}

// The `would_erase` refusal's payload: WHICH account is about to be deleted and what it is
// about to lose. The screen states both before asking for a confirmation — a client bug
// must not be able to destroy a month of play silently.
export interface LinkErasePrompt {
  // WHICH confirmation this is. `erase` — the account being left carries no address of its
  // own, so it becomes unreachable and is deleted. `switch` — it carries one, so it survives
  // and this device is only walking away from it. Nothing is destroyed there, but this
  // device stops BEING that account, which is the thing being confirmed.
  kind: 'erase' | 'switch';
  // The account being LEFT, with what it costs to lose it (a switch costs nothing, and its
  // numbers are not shown).
  accountId: string;
  stakes: AccountStakes | null;
  // The account being ADOPTED. A trade shown from one side reads as pure loss, so the
  // confirmation draws both faces — and this is the other one. Optional in the TYPE only
  // so a malformed field degrades to a one-sided prompt instead of failing a refusal the
  // player has to be able to answer.
  target: string | null;
}

export function parseErasePrompt(
  data: unknown,
  kind: 'erase' | 'switch',
): LinkErasePrompt | null {
  if (!isRecord(data)) return null;
  const { accountId, target } = data;
  if (typeof accountId !== 'string' || !PUBLIC_ID_PATTERN.test(accountId)) return null;
  // The stakes are DECORATIVE on both kinds. A switch has none by construction; an erase
  // normally does, but requiring them there refused the confirmation for exactly the reason
  // the line below already gives for a switch — the player has to be able to answer it. And
  // the refusal was not silent-but-safe: the caller fell through to the generic failure,
  // whose TRY AGAIN re-sends the same code, gets the same 409, and shows the same screen,
  // forever. `showStakes` already draws nothing when they are absent, so the confirmation
  // simply loses three numbers and keeps the fork, the sentence and both buttons.
  const stakes = parseStakes(data);
  return {
    kind,
    accountId,
    stakes,
    target: typeof target === 'string' && PUBLIC_ID_PATTERN.test(target) ? target : null,
  };
}

// GROUPS (#271): ONE route. `GET /groups?id=` is a group's PUBLIC face (what the invite
// landing draws before anyone joins); every POST carries the device token in the body
// (#216) and answers the caller's groups as they now stand:
//   { token }                         — the caller's groups;
//   { token, create: true, name }     — a new group, the caller its first member (`created`);
//   { token, join: id }               — the membership an invite link's tap records;
//   { token, leave: id }              — walk out;
//   { token, remove: id, member }     — the creator shows a member out.
// The `id` query is in the groups CloudFront behavior's allowList (the root AGENTS.md
// three-package contract).
export function groupsUrl(id?: string, base: string = apiBase()): string {
  const root = `${requireApiBase(base)}/groups`;
  return id ? `${root}?id=${encodeURIComponent(id)}` : root;
}

export interface GroupsBody {
  token: string;
  create?: true;
  name?: string;
  join?: string;
  leave?: string;
  remove?: string;
  member?: string;
}

export async function postGroupsBody(url: string, body: GroupsBody): Promise<Response> {
  return postSignedJson(url, body);
}

export interface GroupsAnswer {
  groups: GroupSummary[];
  // The id a `create` minted — the tab the screen opens on.
  created?: string;
}

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === 'string' && PUBLIC_ID_PATTERN.test(id));
}

function isGroupSummary(value: unknown): value is GroupSummary {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    GROUP_ID_PATTERN.test(value.id) &&
    typeof value.name === 'string' &&
    typeof value.createdBy === 'string' &&
    PUBLIC_ID_PATTERN.test(value.createdBy) &&
    typeof value.joinedAt === 'string' &&
    isIdList(value.members)
  );
}

// Runtime shape check for the groups answer — the parsePuzzle contract: a wrong-shaped
// body surfaces as a failure, never as a row of blank tabs.
export function parseGroups(data: unknown): GroupsAnswer {
  if (!isRecord(data)) throw new Error('malformed groups: not an object');
  const { groups, created } = data;
  if (!Array.isArray(groups) || !groups.every(isGroupSummary)) {
    throw new Error('malformed groups: "groups" must be an array of groups');
  }
  if (created !== undefined && (typeof created !== 'string' || !GROUP_ID_PATTERN.test(created))) {
    throw new Error('malformed groups: bad "created"');
  }
  return created === undefined ? { groups } : { groups, created };
}

export function parsePublicGroup(data: unknown): PublicGroup {
  if (!isRecord(data)) throw new Error('malformed group: not an object');
  const { id, name, createdBy, members } = data;
  if (typeof id !== 'string' || !GROUP_ID_PATTERN.test(id)) throw new Error('malformed group: bad "id"');
  if (typeof name !== 'string') throw new Error('malformed group: bad "name"');
  if (typeof createdBy !== 'string' || !PUBLIC_ID_PATTERN.test(createdBy)) {
    throw new Error('malformed group: bad "createdBy"');
  }
  checkBoardPlayers(members, 'members');
  return { id, name, createdBy, members };
}

// **`GET /groups?id=` HAS THREE ANSWERS** (the `readProfile` rule): the group, GONE (404
// `unknown_group` — a link naming nothing, expired for good), and FAILED (a transport
// error, a 5xx, an unparseable body — never evidence of anything).
export type GroupRead =
  | { status: 'shown'; group: PublicGroup }
  | { status: 'gone' }
  | { status: 'failed' };

export async function readGroup(id: string, signal?: AbortSignal): Promise<GroupRead> {
  try {
    const response = await fetch(groupsUrl(id), signal ? { signal } : {});
    if (response.ok) return { status: 'shown', group: parsePublicGroup(await response.json()) };
    if (response.status === 404) {
      const error = await response
        .clone()
        .json()
        .then((body) => (body as { error?: unknown }).error)
        .catch(() => undefined);
      return error === 'unknown_group' ? { status: 'gone' } : { status: 'failed' };
    }
    return { status: 'failed' };
  } catch {
    return { status: 'failed' };
  }
}

// The #190 leaderboard: GET is the anonymous GLOBAL top 50 (`id` — the caller's PUBLIC
// id, never the token — widens it with their own below-the-cut window); POST with
// `{token, group[, period]}` is a GROUP's board (#271), the trusted surface, and
// `{token, standing: true}` where the caller stands today in each of their groups.
// Addressed per (day, lang, mode) like everything else; all four query parameters are in
// the board CloudFront behavior's allowList (the root AGENTS.md three-package contract).
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

export type BoardBody =
  | { token: string; group: string; period?: BoardPeriod }
  | { token: string; standing: true };

export async function postBoardBody(url: string, body: BoardBody): Promise<Response> {
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

// The #206 in-progress rows: a profile-dressed player with the two live numbers — an
// exact try count (a positive integer) and the server-derived reconstruction percentage
// (a real number in [0, 100], not necessarily whole).
function checkPlayingRows(value: unknown, field: string): asserts value is PlayingRow[] {
  if (!Array.isArray(value)) throw new Error(`malformed board: "${field}" must be an array`);
  for (const raw of value) {
    const row = raw as Record<string, unknown>;
    if (
      !isBoardPlayer(raw) ||
      typeof row.tries !== 'number' ||
      !Number.isInteger(row.tries) ||
      row.tries < 1 ||
      typeof row.progress !== 'number' ||
      !Number.isFinite(row.progress) ||
      row.progress < 0 ||
      row.progress > 100
    ) {
      throw new Error(`malformed board: bad "${field}" row`);
    }
  }
}

export function parseBoard(data: unknown): Board {
  if (!isRecord(data)) throw new Error('malformed board: not an object');
  const { rows, own, playing, waiting } = data;
  checkBoardRows(rows, 'rows');
  if (own !== null) checkBoardRows(own, 'own');
  checkPlayingRows(playing, 'playing');
  checkBoardPlayers(waiting, 'waiting');
  return data as unknown as Board;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

// A WEEK / MONTH board (#271): dressed rows carrying the period rule's three numbers and
// a competition rank, plus the inclusive range the screen captions.
export function parsePeriodBoard(data: unknown): PeriodBoard {
  if (!isRecord(data)) throw new Error('malformed period board: not an object');
  const { from, to, rows } = data;
  if (typeof from !== 'string' || typeof to !== 'string') {
    throw new Error('malformed period board: "from"/"to" must be dates');
  }
  if (!Array.isArray(rows)) throw new Error('malformed period board: "rows" must be an array');
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    if (
      !isBoardPlayer(raw) ||
      !isCount(row.rank) ||
      row.rank < 1 ||
      !isCount(row.points) ||
      !isCount(row.solvedDays) ||
      row.solvedDays < 1 ||
      !isCount(row.total)
    ) {
      throw new Error('malformed period board: bad row');
    }
  }
  return { from, to, rows: rows as PeriodRow[] };
}

// Where the caller stands today in each of their groups (#271) — the solved screen's line.
export function parseStandings(data: unknown): GroupStanding[] {
  if (!isRecord(data)) throw new Error('malformed standings: not an object');
  const { standings } = data;
  if (!Array.isArray(standings)) throw new Error('malformed standings: "standings" must be an array');
  for (const raw of standings) {
    const row = raw as Record<string, unknown>;
    if (
      !isRecord(raw) ||
      typeof row.group !== 'string' ||
      !GROUP_ID_PATTERN.test(row.group) ||
      !isCount(row.rank) ||
      row.rank < 1 ||
      !isCount(row.of) ||
      row.of < row.rank
    ) {
      throw new Error('malformed standings: bad row');
    }
  }
  return standings as GroupStanding[];
}

// The period name is the body's, and a screen's tab is typed by the same guard the server
// validates with — one spelling of the three periods.
export { isBoardPeriod };

// Runtime shape check for a fetched profile — the parsePuzzle contract: a wrong-shaped
// body surfaces as a failure, never as a broken editor or board row.
export function parseProfile(data: unknown): PlayerProfile {
  if (!isRecord(data)) throw new Error('malformed profile: not an object');
  const { publicId, name, avatar } = data;
  if (typeof publicId !== 'string' || !PUBLIC_ID_PATTERN.test(publicId)) {
    throw new Error('malformed profile: bad "publicId"');
  }
  if (typeof name !== 'string') throw new Error('malformed profile: bad "name"');
  // The stored EMPTY avatar means "no custom mark" (PR-219 round-2 review): normalized to
  // null here, the board rows' own convention, so every consumer keeps ONE fallback rule
  // (`?? defaultAvatar`) and none can feed '' into a decoder.
  if (avatar === '' || avatar === null) return { publicId, name, avatar: null };
  if (!isValidAvatar(avatar)) throw new Error('malformed profile: bad "avatar"');
  return { publicId, name, avatar };
}
