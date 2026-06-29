// Publish a generated puzzle into the store the backend serves (issue #17 / #4).
//
//   pnpm puzzle:publish <puzzle.json> [--day YYYY-MM-DD] [--s3] [--bucket NAME] [--store DIR]
//
// Destination is chosen EXPLICITLY and defaults to LOCAL — the local path never needs
// AWS creds. `--day` targets the GAME DAY (defaults to the active 22:00-ET day, so the
// common "publish for right now" case needs no flag). The name/key encoding is shared
// with the readers via `layout.ts`, so what `publish` writes is exactly what `serve`
// (and S3) select.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Puzzle } from '@rafaelisinthepan/shared';
import { activeDate } from './day';
import { defaultLocalStoreRoot, isValidDate, storeKey } from './layout';

interface Args {
  file?: string;
  day?: string;
  s3: boolean;
  bucket?: string;
  store?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { s3: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--s3':
        args.s3 = true;
        break;
      case '--local':
        args.s3 = false;
        break;
      case '--day':
        args.day = argv[++i];
        break;
      case '--bucket':
        args.bucket = argv[++i];
        break;
      case '--store':
        args.store = argv[++i];
        break;
      default:
        if (a.startsWith('--')) die(`unknown flag: ${a}`);
        if (args.file) die(`unexpected extra argument: ${a}`);
        args.file = a;
    }
  }
  return args;
}

function die(msg: string): never {
  console.error(`[publish] ${msg}`);
  process.exit(1);
}

export interface PublishPlan {
  day: string; // the GAME DAY this puzzle is served as (22:00-ET day of #2/#6)
  key: string; // storeKey(day, lang) — the SAME key the readers GetObject/readFile
  target: { kind: 'local' } | { kind: 's3'; bucket: string };
}

// Pure (day, key, destination) routing — the issue #4 contract, with no fs/AWS/argv/
// process so it is unit-testable. The store key is fully determined by (game day, lang)
// via `storeKey`, identical to what `fsStore`/`s3Store` select. The day defaults to the
// active 22:00-ET day (`activeDate`) unless `--day` overrides it. The destination is
// LOCAL unless `--s3` opts in, in which case a bucket is REQUIRED (flag or PUZZLE_BUCKET)
// — never a silent local fallback. Throws on an invalid day or `--s3` without a bucket;
// the CLI turns that into a clean `die`.
export function planPublish(
  args: Pick<Args, 's3' | 'day' | 'bucket'>,
  lang: string,
  now: Date,
  bucketFromEnv?: string,
): PublishPlan {
  const day = args.day ?? activeDate(now);
  if (!isValidDate(day)) throw new Error(`invalid --day "${day}" (expected YYYY-MM-DD).`);
  const key = storeKey(day, lang);
  if (args.s3) {
    const bucket = args.bucket ?? bucketFromEnv;
    if (!bucket) throw new Error('--s3 requires --bucket NAME (or PUZZLE_BUCKET).');
    return { day, key, target: { kind: 's3', bucket } };
  }
  return { day, key, target: { kind: 'local' } };
}

// Resolve a user-supplied path against the directory the command was INVOKED from,
// not the package dir pnpm `cd`s into. pnpm/npm set INIT_CWD to the original cwd, so
// `pnpm puzzle:publish path/from/repo-root.json` works as typed.
function resolveInput(p: string): string {
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), p);
}

// Minimal shape check — enough to name/route the puzzle and fail loudly on garbage.
function asPuzzle(raw: unknown, file: string): Puzzle {
  const p = raw as Partial<Puzzle>;
  if (!p || typeof p.lang !== 'string' || !/^[a-z]{2}$/.test(p.lang)) {
    die(`${file}: missing/invalid "lang" (expected two lowercase letters).`);
  }
  if (!Array.isArray(p.holes) || p.holes.length === 0) {
    die(`${file}: missing/empty "holes".`);
  }
  return p as Puzzle;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    die(
      'usage: puzzle:publish <puzzle.json> [--day YYYY-MM-DD] [--s3] [--bucket NAME] [--store DIR]',
    );
  }

  const file = resolveInput(args.file);
  const text = await readFile(file, 'utf8').catch(() => die(`cannot read ${file}`));
  const puzzle = asPuzzle(JSON.parse(text), file);

  let plan: PublishPlan;
  try {
    plan = planPublish(args, puzzle.lang, new Date(), process.env.PUZZLE_BUCKET);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  if (plan.target.kind === 's3') {
    const { bucket } = plan.target;
    // Import the SDK only on the S3 path so the local path stays AWS-free.
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({});
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: plan.key,
        Body: text,
        ContentType: 'application/json; charset=utf-8',
      }),
    );
    console.log(`[publish] s3://${bucket}/${plan.key}  (${puzzle.lang}, day ${plan.day})`);
    return;
  }

  const rootArg = args.store ?? process.env.PUZZLE_STORE;
  const root = rootArg ? resolveInput(rootArg) : defaultLocalStoreRoot();
  const dest = path.join(root, plan.key);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, text);
  console.log(`[publish] ${dest}  (${puzzle.lang}, day ${plan.day})`);
}

// Run as a CLI only when executed directly (`tsx src/publish.ts ...`), NOT when this
// module is imported (e.g. by publish.test.ts importing `planPublish`) — importing must
// not read argv or exit the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => die(err instanceof Error ? err.message : String(err)));
}
