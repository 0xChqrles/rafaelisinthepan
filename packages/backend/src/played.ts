// The PLAY RECORD: `packages/generation/played.jsonl`, beside the publish ledger, one line per
// CLOSED sentence day per language that real players played ON THE DAY — how hard the day
// actually was. The curator reads it to calibrate its difficulty forecast against real play:
// the line carries what the forecast was asked about (the sentence, the holes, the nearest
// words of each secret's map) next to what players did with it.
//
// It holds per-day AGGREGATES only: never a player id, never a guess, never a word a player
// typed. The `nearest` words are the published map's own (a day already played), not play.
//
// What counts, and why:
//   - the day is CLOSED (before the server's active day now): an open day is still filling;
//   - its puzzle was last written BEFORE the day closed: an artifact rewritten after the fact
//     no longer holds the maps its players played;
//   - a round counts only on the artifact's REVISION (a corrected day's older rounds answered
//     another question), only ON TIME (created on that very game day: an archive replay or
//     an early preview is another kind of play) and only ENGAGED (at least one counted try).
//
// APPEND-ONLY per day: a (day, lang) already in the file is never rewritten nor repeated, so
// the first recording stands. GITIGNORED, like the ledger. `pnpm puzzle:played --s3` scans
// the score table's round rows and reads each day's puzzle from the bucket — READ-ONLY.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import {
  activeDate,
  dayNumber,
  guessKey,
  isBonusAddress,
  isCalendarDate,
  nextResetAt,
  type Hole,
  type Puzzle,
  type RankMap,
} from '@whippin/shared';
import { storeKey } from './layout';
import { roundSortKeyParts, type RoundKey } from './roundStore';
import { STACK_REGION, stackOutputs, stackScoreTable } from './stack';
import { isNotFound } from './store';

// The caps the per-day numbers read tries through: a hole found after 20 tries is as hard as
// one never found, a day finished after 30 as hard as one never finished.
const HOLE_CAP = 20;
const DAY_CAP = 30;
// A hole's second number: the share of players who found it within this many tries.
const FOUND_WITHIN = 30;
// How many of each secret's nearest ranks the line carries.
const NEAREST = 15;

// What the record reads of one stored round.
export interface PlayedRound {
  guesses: string[];
  createdAt: string;
  puzzle: string;
}

export interface PlayedFound {
  logTries20: number; // mean of ln(min(T_find, 20)), a player who never found it counting ln 20
  within30: number; // share of players who found it within 30 tries
}

export interface PlayedEntry {
  day: string;
  lang: string;
  revision: string;
  recordedAt: string; // ISO instant this line was computed
  words: string[]; // the puzzle's, verbatim
  holes: Hole[]; // the puzzle's, verbatim
  // Per secret slug: its first NEAREST ranks >= 1, ascending, each with the display word of
  // the FIRST key met for that rank in the map's own order.
  nearest: Record<string, [number, string][]>;
  players: number;
  finished: number; // share of players who found every secret
  logTries30: number; // mean of ln(min(T_finish, 30)), an unfinished round counting ln 30
  found: Record<string, PlayedFound>;
}

// packages/backend/src -> packages/generation/played.jsonl, the same file whether the
// command runs from the repo root or the package.
export function playedRecordPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'generation', 'played.jsonl');
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

// The instant game day `day` closes: the flip onto the next one. Asked of the ONE day
// definition from an instant inside the day — noon UTC on its date always is, since the day
// runs from 22:00 New York the evening before to 22:00 New York on the date.
export function dayClosesAt(day: string): Date {
  return nextResetAt(new Date(`${day}T12:00:00Z`));
}

// Whether a round was created on game day `day` itself.
function createdOn(createdAt: string, day: string): boolean {
  const ms = Date.parse(createdAt);
  return Number.isFinite(ms) && activeDate(new Date(ms)) === day;
}

// The PLAY LOG: the raw log deduped by the game's own identity (`guessKey`), the first
// occurrence kept, in order — exactly the tries `countTries` counts.
export function playLog(ranks: RankMap, guesses: readonly string[]): string[] {
  const seen = new Set<string>();
  const log: string[] = [];
  for (const typed of guesses) {
    const key = guessKey(ranks, typed);
    if (seen.has(key)) continue;
    seen.add(key);
    log.push(typed);
  }
  return log;
}

// Which of a day's rounds count (their play logs), and how many were dropped for each reason.
export interface RoundTally {
  counted: string[][];
  retired: number; // played on another revision
  offDay: number; // created before or after the day (a preview, an archive replay)
  empty: number; // no counted try
}

export function tallyRounds(puzzle: Puzzle, day: string, rounds: readonly PlayedRound[]): RoundTally {
  const tally: RoundTally = { counted: [], retired: 0, offDay: 0, empty: 0 };
  for (const round of rounds) {
    if (round.puzzle !== puzzle.revision) tally.retired += 1;
    else if (!createdOn(round.createdAt, day)) tally.offDay += 1;
    else {
      const log = playLog(puzzle.ranks, round.guesses);
      if (log.length === 0) tally.empty += 1;
      else tally.counted.push(log);
    }
  }
  return tally;
}

// Per secret, the 1-based try at which the play log first hit its rank 0; null when never.
function findTimes(ranks: RankMap, log: readonly string[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const secret of Object.keys(ranks)) {
    const map = ranks[secret];
    const at = log.findIndex((typed) => Object.hasOwn(map, typed) && map[typed].rank === 0);
    out[secret] = at < 0 ? null : at + 1;
  }
  return out;
}

// One secret's nearest ranks (see `PlayedEntry.nearest`).
function nearestOf(map: RankMap[string]): [number, string][] {
  const first = new Map<number, string>();
  for (const key of Object.keys(map)) {
    const { rank, word } = map[key];
    if (rank >= 1 && !first.has(rank)) first.set(rank, word);
  }
  return [...first.keys()]
    .sort((a, b) => a - b)
    .slice(0, NEAREST)
    .map((rank): [number, string] => [rank, first.get(rank)!]);
}

// Pure: the line a closed day earns from its round records, or null when no engaged on-time
// round of this revision exists. The day's closed / artifact-age rules are the caller's.
export function playedEntry(
  puzzle: Puzzle,
  day: string,
  rounds: readonly PlayedRound[],
  recordedAt: Date,
): PlayedEntry | null {
  const { counted } = tallyRounds(puzzle, day, rounds);
  if (counted.length === 0) return null;
  const secrets = Object.keys(puzzle.ranks);
  const times = counted.map((log) => findTimes(puzzle.ranks, log));
  const finishes = times.map((t) => {
    const each = secrets.map((s) => t[s]);
    return each.every((x) => x !== null) ? Math.max(...(each as number[])) : null;
  });
  const found: Record<string, PlayedFound> = {};
  for (const s of secrets) {
    const at = times.map((t) => t[s]);
    found[s] = {
      logTries20: round4(mean(at.map((x) => Math.log(Math.min(x ?? HOLE_CAP, HOLE_CAP))))),
      within30: round4(at.filter((x) => x !== null && x <= FOUND_WITHIN).length / at.length),
    };
  }
  return {
    day,
    lang: puzzle.lang,
    revision: puzzle.revision,
    recordedAt: recordedAt.toISOString(),
    words: puzzle.words,
    holes: puzzle.holes,
    nearest: Object.fromEntries(secrets.map((s) => [s, nearestOf(puzzle.ranks[s])])),
    players: counted.length,
    finished: round4(finishes.filter((x) => x !== null).length / finishes.length),
    logTries30: round4(mean(finishes.map((x) => Math.log(Math.min(x ?? DAY_CAP, DAY_CAP))))),
    found,
  };
}

// One round row of the score table, as the scan returns it: the (day, lang) it played and
// what the record reads of it. A BONUS round is no day (null), nor is anything that is not a
// round row.
export function playedRoundFromItem(
  item: Record<string, AttributeValue>,
): { day: string; lang: string; round: PlayedRound } | null {
  const sk = item.sk?.S;
  if (!sk) return null;
  let key: RoundKey;
  try {
    key = roundSortKeyParts(sk);
  } catch {
    return null;
  }
  if (isBonusAddress(key.date) || !isCalendarDate(key.date)) return null;
  return {
    day: key.date,
    lang: key.lang,
    round: {
      guesses: item.guesses?.L?.map((v) => v.S ?? '') ?? [],
      createdAt: item.createdAt?.S ?? '',
      puzzle: item.puzzle?.S ?? '',
    },
  };
}

// The rounds grouped by (day, lang), sorted by day then lang.
export function groupRounds(
  items: readonly Record<string, AttributeValue>[],
): { day: string; lang: string; rounds: PlayedRound[] }[] {
  const days = new Map<string, { day: string; lang: string; rounds: PlayedRound[] }>();
  for (const item of items) {
    const parsed = playedRoundFromItem(item);
    if (!parsed) continue;
    const id = recordKey(parsed);
    const group = days.get(id) ?? { day: parsed.day, lang: parsed.lang, rounds: [] };
    group.rounds.push(parsed.round);
    days.set(id, group);
  }
  return [...days.values()].sort(byDayThenLang);
}

const recordKey = (e: { day: string; lang: string }) => `${e.day}.${e.lang}`;
const byDayThenLang = (a: { day: string; lang: string }, b: { day: string; lang: string }) =>
  a.day === b.day ? a.lang.localeCompare(b.lang) : a.day.localeCompare(b.day);

// The (day, lang) pairs the file already holds; an absent file holds none.
export async function recordedDays(file = playedRecordPath()): Promise<Set<string>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw err;
  }
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const { day, lang } = JSON.parse(line) as { day: string; lang: string };
    keys.add(recordKey({ day, lang }));
  }
  return keys;
}

// Append the days the file does not hold yet, sorted by day then lang; the lines already
// there are never touched. Answers what was appended.
export async function appendPlayed(
  entries: readonly PlayedEntry[],
  file = playedRecordPath(),
): Promise<PlayedEntry[]> {
  const held = await recordedDays(file);
  const fresh: PlayedEntry[] = [];
  for (const entry of [...entries].sort(byDayThenLang)) {
    if (held.has(recordKey(entry))) continue;
    held.add(recordKey(entry));
    fresh.push(entry);
  }
  if (fresh.length === 0) return fresh;
  await mkdir(path.dirname(file), { recursive: true });
  // A file whose last line lacks its newline (written by hand) must not glue onto ours.
  const existing = await readFile(file, 'utf8').catch(() => '');
  const lead = existing && !existing.endsWith('\n') ? '\n' : '';
  await appendFile(file, lead + fresh.map((e) => JSON.stringify(e) + '\n').join(''), 'utf8');
  return fresh;
}

// ---------------------------------------------------------------------------------------
// `pnpm puzzle:played --s3`: scan the score table's round rows, read each closed day's
// puzzle from the bucket, append the days not recorded yet. Read-only on AWS.

function die(msg: string): never {
  console.error(`[played] ${msg}`);
  process.exit(1);
}

async function scanRoundItems(table: string): Promise<Record<string, AttributeValue>[]> {
  const { DynamoDBClient, ScanCommand } = await import('@aws-sdk/client-dynamodb');
  const client = new DynamoDBClient({ region: STACK_REGION });
  const items: Record<string, AttributeValue>[] = [];
  let cursor: Record<string, AttributeValue> | undefined;
  do {
    const page = await client.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: 'begins_with(#pk, :round)',
        ProjectionExpression: '#sk, #g, #p, #created',
        ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk', '#g': 'guesses', '#p': 'puzzle', '#created': 'createdAt' },
        ExpressionAttributeValues: { ':round': { S: 'round#' } },
        ExclusiveStartKey: cursor,
      }),
    );
    items.push(...(page.Items ?? []));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return items;
}

async function recordFromS3(now: Date): Promise<void> {
  const file = playedRecordPath();
  const recorded = await recordedDays(file);
  const [{ bucket }, table] = await Promise.all([stackOutputs(), stackScoreTable()]);
  const items = await scanRoundItems(table);
  const days = groupRounds(items);
  console.log(`[played] ${items.length} round row(s) over ${days.length} (day, lang) from ${table}`);

  const { S3Client, GetObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: STACK_REGION });
  const active = dayNumber(activeDate(now));
  const entries: PlayedEntry[] = [];
  let already = 0;
  for (const { day, lang, rounds } of days) {
    const id = `${day} ${lang}`;
    if (recorded.has(recordKey({ day, lang }))) {
      already += 1;
      continue;
    }
    if (dayNumber(day) >= active) {
      console.log(`[played] ${id}: skipped — not closed yet`);
      continue;
    }
    // HEAD first: the artifact's age decides whether its body is worth reading at all.
    let head;
    try {
      head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: storeKey(day, lang) }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
      console.log(`[played] ${id}: skipped — no puzzle in the bucket`);
      continue;
    }
    const closes = dayClosesAt(day);
    const written = head.LastModified;
    if (!written || written.getTime() >= closes.getTime()) {
      console.log(
        `[played] ${id}: skipped — its puzzle was written ${written?.toISOString() ?? 'at an unknown time'}, ` +
          `after the day closed (${closes.toISOString()}), so it may not hold the maps its players played`,
      );
      continue;
    }
    // The GET names the version the HEAD judged (a publish in between answers 412).
    const got = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: storeKey(day, lang), IfMatch: head.ETag }),
    );
    const puzzle = JSON.parse(await got.Body!.transformToString('utf8')) as Puzzle;
    const tally = tallyRounds(puzzle, day, rounds);
    const dropped =
      `${tally.retired} on another revision, ${tally.offDay} not created on the day, ` +
      `${tally.empty} with no try`;
    const entry = playedEntry(puzzle, day, rounds, now);
    if (!entry) {
      console.log(`[played] ${id}: skipped — no engaged on-time round (dropped: ${dropped})`);
      continue;
    }
    entries.push(entry);
    console.log(`[played] ${id}: ${entry.players} player(s) (dropped: ${dropped})`);
  }
  const appended = await appendPlayed(entries, file);
  console.log(
    `[played] ${file}: ${appended.length} day(s) appended, ${already} already recorded`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--s3')) {
    die('usage: puzzle:played --s3   (appends the closed days real players played to packages/generation/played.jsonl)');
  }
  await recordFromS3(new Date());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => die(err instanceof Error ? err.message : String(err)));
}
