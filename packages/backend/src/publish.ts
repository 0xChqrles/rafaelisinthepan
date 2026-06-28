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

  const day = args.day ?? activeDate(new Date());
  if (!isValidDate(day)) die(`invalid --day "${day}" (expected YYYY-MM-DD).`);

  const file = resolveInput(args.file);
  const text = await readFile(file, 'utf8').catch(() => die(`cannot read ${file}`));
  const puzzle = asPuzzle(JSON.parse(text), file);
  const key = storeKey(day, puzzle.lang);

  if (args.s3) {
    const bucket = args.bucket ?? process.env.PUZZLE_BUCKET;
    if (!bucket) die('--s3 requires --bucket NAME (or PUZZLE_BUCKET).');
    // Import the SDK only on the S3 path so the local path stays AWS-free.
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({});
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: text,
        ContentType: 'application/json; charset=utf-8',
      }),
    );
    console.log(`[publish] s3://${bucket}/${key}  (${puzzle.lang}, day ${day})`);
    return;
  }

  const rootArg = args.store ?? process.env.PUZZLE_STORE;
  const root = rootArg ? resolveInput(rootArg) : defaultLocalStoreRoot();
  const dest = path.join(root, key);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, text);
  console.log(`[publish] ${dest}  (${puzzle.lang}, day ${day})`);
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
