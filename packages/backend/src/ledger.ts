// The PUBLISH LEDGER (user-decided 2026-09-08): `packages/generation/published.jsonl`, one
// line per sentence puzzle published to S3 — the game day it serves, when it was put
// there, its revision, its source, its sentence and its holes (secret / start / start
// rank). It is THE record of what has been published: the curator's archive (the
// secret cooldown, the secret/start pair blacklist, the works and sentences already
// played) reads it and nothing else. A LOCAL publish never writes it — the local store is
// a test bed. It is GITIGNORED: the bucket is the truth and the file its local, readable
// copy — `pnpm puzzle:ledger --s3` rebuilds it from the bucket on a fresh machine, and
// repairs it if a line was ever lost.
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Puzzle } from '@whippin/shared';
import { STACK_REGION, stackOutputs } from './stack';

export interface PublishedHole {
  secret: string; // the secret's slug — what the curator's archive keys on
  word: string; // its display form
  start: string; // the start word's display form (the pair blacklist compares these)
  startRank: number;
}

export interface PublishedEntry {
  day: string; // the game day the puzzle serves (YYYY-MM-DD)
  lang: string;
  publishedAt: string; // ISO instant of the S3 put
  revision: string;
  source?: Puzzle['source'];
  sentence: string; // words[] joined — the curator's sentence key is computed off it
  holes: PublishedHole[];
}

// packages/backend/src -> packages/generation/published.jsonl, the same file whether the
// command runs from the repo root or the package.
export function publishLedgerPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'generation', 'published.jsonl');
}

// Pure: the line a published sentence puzzle earns.
export function ledgerEntry(puzzle: Puzzle, day: string, publishedAt: Date): PublishedEntry {
  const entry: PublishedEntry = {
    day,
    lang: puzzle.lang,
    publishedAt: publishedAt.toISOString(),
    revision: puzzle.revision,
    sentence: puzzle.words.join(' '),
    holes: puzzle.holes.map((h) => ({
      secret: h.secret.slug,
      word: h.secret.word,
      start: h.start.word,
      startRank: h.start_rank,
    })),
  };
  if (puzzle.source) entry.source = puzzle.source;
  return entry;
}

// Every line, in file order; a malformed line is skipped rather than taking the archive down.
export function parseLedger(text: string): PublishedEntry[] {
  const out: PublishedEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as PublishedEntry;
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      out.push(entry);
    } catch {
      // a broken line is not a reason to lose the rest
    }
  }
  return out;
}

export async function appendPublished(entry: PublishedEntry, file = publishLedgerPath()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------------------
// `pnpm puzzle:ledger --s3`: rebuild the ledger from the bucket — every sentence puzzle
// object (`<day>.<lang>.json`; word artifacts and slices are not recorded), `publishedAt`
// being the object's own last-modified instant. The bucket is the truth of what is served;
// the file is its readable record.

const SENTENCE_KEY = /^(\d{4}-\d{2}-\d{2})\.([a-z]{2})\.json$/;

function die(msg: string): never {
  console.error(`[ledger] ${msg}`);
  process.exit(1);
}

async function rebuildFromS3(): Promise<void> {
  const { bucket } = await stackOutputs();
  const { S3Client, ListObjectsV2Command, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client({ region: STACK_REGION });
  const keys: { key: string; modified: Date }[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    for (const obj of page.Contents ?? []) {
      if (obj.Key && SENTENCE_KEY.test(obj.Key)) {
        keys.push({ key: obj.Key, modified: obj.LastModified ?? new Date(0) });
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  keys.sort((a, b) => a.key.localeCompare(b.key));
  const lines: string[] = [];
  for (const { key, modified } of keys) {
    const m = SENTENCE_KEY.exec(key)!;
    const body = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await body.Body!.transformToString('utf8');
    const puzzle = JSON.parse(text) as Puzzle;
    lines.push(JSON.stringify(ledgerEntry(puzzle, m[1], modified)));
    console.log(`[ledger] ${key}  (${puzzle.holes.map((h) => h.secret.slug).join(' · ')})`);
  }
  const file = publishLedgerPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  console.log(`[ledger] ${file}: ${lines.length} published sentence day(s) from s3://${bucket}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--s3')) {
    die('usage: puzzle:ledger --s3   (rebuilds packages/generation/published.jsonl from the deployed bucket)');
  }
  await rebuildFromS3();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => die(err instanceof Error ? err.message : String(err)));
}
