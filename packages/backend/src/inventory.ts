// Publish-buffer coverage report (issue #61). READ-ONLY: probes the store for the next N
// game days × langs and reports which (date, lang) puzzles exist, so a thinning buffer is
// visible BEFORE players hit a gap.
//
//   pnpm puzzle:inventory [--s3] [--days N] [--langs en,fr] [--mode sentence|word] [--ci]
//
// By default it just REPORTS and exits 0 — a gap is normal while buffering, not a command
// failure, so an interactive run stays clean. `--ci` turns a gap into exit 1 for the
// machine path, so a cron/CI step can `pnpm puzzle:inventory --ci || alarm`.
//
// Local by default — probes the filesystem store via the SAME root resolution as
// `serve`/`fsStore` (`PUZZLE_STORE`, default backend/.local-store), no AWS creds. `--s3`
// probes the deployed bucket with HeadObject; the bucket is discovered from the
// WhippinBackendStack outputs exactly like `publish` (reusing `stack.ts`), so the flat key
// layout means ≤ ~30 requests at the default window with no listing.
import { access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { activeDate, dateForDayNumber, dayNumber } from '@whippin/shared';
import { defaultLocalStoreRoot, isValidDate, storeKey, type PuzzleMode } from './layout';
import { isNotFound } from './store';
import { STACK_REGION, stackOutputs } from './stack';

const DEFAULT_DAYS = 14;
const DEFAULT_LANGS = ['en', 'fr'];

interface Args {
  s3: boolean;
  days: number;
  langs: string[];
  // Which daily artifact to probe (#156): the sentence puzzle (default) or Word mode's
  // #154 artifact. A separate run per mode, so the existing --ci cron alarm keeps its
  // meaning while the word buffer gets its own report.
  mode: PuzzleMode;
  ci: boolean; // opt in to exit 1 on a gap (the CI/cron alarm); default: report + exit 0
}

function die(msg: string): never {
  console.error(`[inventory] ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    s3: false,
    days: DEFAULT_DAYS,
    langs: DEFAULT_LANGS,
    mode: 'sentence',
    ci: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--s3':
        args.s3 = true;
        break;
      case '--ci':
        args.ci = true;
        break;
      case '--days': {
        const raw = argv[++i];
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) {
          die(`--days must be a positive integer (got "${raw ?? ''}")`);
        }
        args.days = n;
        break;
      }
      case '--langs': {
        const raw = argv[++i];
        if (!raw) die('--langs requires a comma-separated list, e.g. en,fr');
        args.langs = raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (args.langs.length === 0) die('--langs is empty');
        break;
      }
      case '--mode': {
        const raw = argv[++i];
        if (raw !== 'sentence' && raw !== 'word') {
          die(`--mode must be "sentence" or "word" (got "${raw ?? ''}")`);
        }
        args.mode = raw;
        break;
      }
      default:
        die(`unknown flag: ${a}`);
    }
  }
  return args;
}

// The next `n` GAME days starting at (and INCLUDING) `startDate` — plain calendar dates,
// since a game day IS a calendar date. Walked with the shared `dayNumber` /
// `dateForDayNumber` pair (day.ts), which is the same offset-free UTC arithmetic the day
// logic itself uses, so DST never shifts a boundary here.
export function upcomingDays(startDate: string, n: number): string[] {
  if (!isValidDate(startDate)) {
    throw new Error(`invalid start date "${startDate}" (expected YYYY-MM-DD)`);
  }
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`day count must be a positive integer (got ${n})`);
  }
  const start = dayNumber(startDate);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(dateForDayNumber(start + i));
  return out;
}

// Whether one (date, lang) puzzle exists in the store — the fs/S3 detail is hidden here so
// the reduce below (and the exit-code decision) is pure over the probe and testable with an
// in-memory one.
export type Probe = (date: string, lang: string) => Promise<boolean>;

interface Summary {
  present: Record<string, Record<string, boolean>>; // present[date][lang]
  fullyCovered: number; // days where EVERY lang exists
  total: number; // = days.length
  firstGap: { date: string; lang: string } | null; // earliest (date, then lang order) miss
  complete: boolean; // true iff no gap -> exit 0
}

// Probe every (day, lang) cell and reduce it to the coverage summary. Pure over `probe`.
// `firstGap` is the EARLIEST missing cell scanning days ascending, then langs in order.
export async function takeInventory(
  days: string[],
  langs: string[],
  probe: Probe,
): Promise<Summary> {
  const cells = days.flatMap((date) => langs.map((lang) => ({ date, lang })));
  const results = await Promise.all(cells.map((c) => probe(c.date, c.lang)));
  const present: Record<string, Record<string, boolean>> = {};
  cells.forEach((c, i) => {
    (present[c.date] ??= {})[c.lang] = results[i];
  });

  let fullyCovered = 0;
  let firstGap: { date: string; lang: string } | null = null;
  for (const date of days) {
    let all = true;
    for (const lang of langs) {
      if (!present[date][lang]) {
        all = false;
        firstGap ??= { date, lang };
      }
    }
    if (all) fullyCovered++;
  }
  return { present, fullyCovered, total: days.length, firstGap, complete: firstGap === null };
}

// An existence probe over the local filesystem store — the same key the readers GET.
export function fsProbe(root: string, mode: PuzzleMode = 'sentence'): Probe {
  return async (date, lang) => {
    try {
      await access(path.join(root, storeKey(date, lang, mode)));
      return true;
    } catch {
      return false;
    }
  };
}

// A small aligned table: date rows × lang columns, each cell `ok` / `MISSING`.
function renderTable(days: string[], langs: string[], present: Summary['present']): string {
  const cell = (ok: boolean) => (ok ? 'ok' : 'MISSING');
  const dateW = Math.max('date'.length, 10); // "YYYY-MM-DD"
  const colW = langs.map((l) => Math.max(l.length, 'MISSING'.length));
  const row = (first: string, cells: string[]) =>
    [first.padEnd(dateW), ...cells.map((c, i) => c.padEnd(colW[i]))].join('  ');
  const lines = [row('date', langs)];
  for (const date of days) lines.push(row(date, langs.map((l) => cell(present[date][l]))));
  return lines.join('\n');
}

// The one-line summary, e.g. "buffer: 9/14 days fully covered — first gap: 2026-07-16 (fr)".
function renderSummary(s: Summary): string {
  const gap = s.firstGap ? ` — first gap: ${s.firstGap.date} (${s.firstGap.lang})` : '';
  return `buffer: ${s.fullyCovered}/${s.total} days fully covered${gap}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const days = upcomingDays(activeDate(new Date()), args.days);

  let probe: Probe;
  if (args.s3) {
    const { bucket } = await stackOutputs();
    const { S3Client, HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({ region: STACK_REGION });
    probe = async (date, lang) => {
      try {
        await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: storeKey(date, lang, args.mode) }),
        );
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    };
  } else {
    const root = process.env.PUZZLE_STORE ?? defaultLocalStoreRoot();
    probe = fsProbe(root, args.mode);
  }

  const summary = await takeInventory(days, args.langs, probe);
  if (args.mode === 'word') console.log('artifact: word (#154)');
  console.log(renderTable(days, args.langs, summary.present));
  console.log('');
  console.log(renderSummary(summary));
  // Report-only by default (exit 0); the gap becomes a failing code only when the caller
  // opted into the alarm with --ci.
  process.exit(args.ci && !summary.complete ? 1 : 0);
}

// Run as a CLI only when executed directly (`tsx src/inventory.ts ...`), NOT when this
// module is imported (e.g. by inventory.test.ts importing the pure helpers) — importing
// must not read argv or exit the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => die(err instanceof Error ? err.message : String(err)));
}
