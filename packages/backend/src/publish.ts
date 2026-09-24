// Publish a generated puzzle into the store the backend serves (issue #17 / #4).
//
//   pnpm puzzle:publish <puzzle.json> [--day YYYY-MM-DD | --bonus [ID]] [--s3] [--store DIR]
//
// `--bonus` publishes a BONUS puzzle (shared bonus.ts, 2026-09-24) instead of a day: a test
// puzzle outside the calendar, played by link only, credited nothing. Alone it MINTS a
// fresh seven-digit id (never one already in the store); `--bonus <id>` republishes that
// bonus (a correction keeps its link). A bonus is never written to the ledger — it is no
// day, and its sentence stays free for one. The command prints the bonus's link.
//
// Destination is chosen EXPLICITLY and defaults to LOCAL — the local path never needs
// AWS creds. `--day` targets the GAME DAY (defaults to the active 22:00-ET day, so the
// common "publish for right now" case needs no flag). The name/key encoding is shared
// with the readers via `layout.ts`, so what `publish` writes is exactly what `serve`
// (and S3) select.
//
// `--s3` always publishes to the ONE bucket the infra package deploys: publish reads its
// name from the `PuzzleBucketName` output of `WhippinBackendStack` — the infra code is the
// single source of truth, so there is no bucket flag/env. Looking it up needs AWS creds
// (already required to upload) + `cloudformation:DescribeStacks`.
import { createHash, randomInt } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  activeDate,
  bonusAddress,
  bonusPath,
  isBonusId,
  BONUS_ID_MAX,
  BONUS_ID_MIN,
  VOCAB_BUILDS,
  type Puzzle,
} from '@whippin/shared';
import { defaultLocalStoreRoot, isValidDate, sliceKey, storeKey } from './layout';
import { buildSlice, encodeSlice } from './slice';
import { appendPublished, ledgerEntry, publishLedgerPath } from './ledger';
import { STACK_REGION, stackOutputs } from './stack';

interface Args {
  file?: string;
  day?: string;
  // `--bonus`: true to mint a fresh id, or the id to republish.
  bonus?: true | string;
  s3: boolean;
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
      case '--bonus':
        // An id right after the flag republishes that bonus; otherwise one is minted.
        if (argv[i + 1] !== undefined && isBonusId(argv[i + 1])) args.bonus = argv[++i];
        else args.bonus = true;
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

interface PublishPlan {
  // WHERE it is served: the GAME DAY (22:00-ET day of #2/#6), or a bonus's ADDRESS
  // (`bonus/<id>`, shared bonus.ts) — `bonusId` then says which.
  day: string;
  bonusId?: string;
  key: string; // storeKey(day, lang) — the SAME key the readers GetObject/readFile
  // #203's derivation slice, published BESIDE the puzzle. The backend has NO fallback for a
  // missing one, so it is part of the same publish rather than a follow-up: a day whose
  // slice is absent cannot derive anything and answers the day-addressed 404.
  slice: string;
  target: { kind: 'local' } | { kind: 's3'; bucket: string };
}

// Pure (day, key, destination) routing — the issue #4 contract, with no fs/AWS/argv/
// process so it is unit-testable. The store key is fully determined by (game day, lang)
// via `storeKey`, identical to what `fsStore`/`s3Store` select. The day defaults to the
// active 22:00-ET day (`activeDate`) unless `--day` overrides it. The destination is
// LOCAL unless `--s3` opts in, in which case `bucket` (the name resolved from the deployed
// stack output) is REQUIRED — never a silent local fallback. The (impure, AWS) lookup is
// kept in main so this stays pure. Throws on an invalid day or `--s3` with no bucket; the
// CLI turns that into a clean `die`.
//
// A BONUS (`bonusId`, already minted or named) is addressed by `bonus/<id>` instead of a
// day, through the same key functions — the readers select it exactly the same way.
export function planPublish(
  args: Pick<Args, 's3' | 'day'> & { bonusId?: string },
  lang: string,
  now: Date,
  bucket?: string,
): PublishPlan {
  if (args.bonusId !== undefined && args.day !== undefined) {
    throw new Error('--bonus and --day are exclusive: a bonus is no day.');
  }
  if (args.bonusId !== undefined && !isBonusId(args.bonusId)) {
    throw new Error(`invalid bonus id "${args.bonusId}" (expected seven digits).`);
  }
  const day = args.bonusId !== undefined ? bonusAddress(args.bonusId) : (args.day ?? activeDate(now));
  if (args.bonusId === undefined && !isValidDate(day)) {
    throw new Error(`invalid --day "${day}" (expected YYYY-MM-DD).`);
  }
  const key = storeKey(day, lang);
  const slice = sliceKey(day, lang);
  const bonus = args.bonusId !== undefined ? { bonusId: args.bonusId } : {};
  if (args.s3) {
    if (!bucket) throw new Error('--s3 requires the deployed bucket (no stack output resolved).');
    return { day, ...bonus, key, slice, target: { kind: 's3', bucket } };
  }
  return { day, ...bonus, key, slice, target: { kind: 'local' } };
}

// A fresh bonus id, never one already published in ANY supported language: `taken(id,
// lang)` probes the store (the local dir or the bucket). Random over the seven-digit range,
// so a link is the only way in.
export async function mintBonusId(taken: (id: string, lang: string) => Promise<boolean>): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = String(randomInt(BONUS_ID_MIN, BONUS_ID_MAX + 1));
    const occupied = await Promise.all(Object.keys(VOCAB_BUILDS).map((lang) => taken(id, lang)));
    if (occupied.every((exists) => !exists)) return id;
  }
  throw new Error('could not mint a free bonus id (20 draws taken).');
}

// Where a player opens it: the site's own origin (SITE_ORIGIN, as the backend is
// configured — the production apex by default) for an S3 publish, the bare path for a
// local one (open it on the dev server).
function bonusLink(lang: string, id: string, s3: boolean): string {
  const origin = s3 ? (process.env.SITE_ORIGIN ?? 'https://whippin.ai') : '';
  return `${origin}${bonusPath(lang, id)}`;
}

// WHICH PUBLISHED VERSION this is (#203, user-decided 2026-08-22). A hash of the puzzle's
// own CONTENT, so re-publishing the identical file is a no-op — nobody's round is disturbed
// — while any real correction is a new version and the rounds playing the old one start over.
//
// Any `revision` already on the input is stripped first, or publishing a file that came back
// out of the store would hash its own stamp and mint a different version every time.
// Generation never writes the field; publish is where an artifact becomes a served thing,
// and this is a property of the SERVING, not of the authoring.
export function puzzleRevision(raw: unknown): string {
  const { revision: _stamped, ...content } = raw as Record<string, unknown>;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
}

// Resolve a user-supplied path against the directory the command was INVOKED from,
// not the package dir pnpm `cd`s into. pnpm/npm set INIT_CWD to the original cwd, so
// `pnpm puzzle:publish path/from/repo-root.json` works as typed.
function resolveInput(p: string): string {
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), p);
}

// Minimal shape check — enough to name/route the puzzle and fail loudly on garbage (a #154
// single-word artifact, which has no holes, included: it is the onboarding board's source,
// never a daily).
function puzzleLang(raw: unknown, file: string): string {
  const p = raw as Partial<Puzzle>;
  if (!p || typeof p.lang !== 'string' || !/^[a-z]{2}$/.test(p.lang)) {
    die(`${file}: missing/invalid "lang" (expected two lowercase letters).`);
  }
  if (!Array.isArray(p.holes) || p.holes.length === 0) {
    die(`${file}: not a sentence puzzle (no holes).`);
  }
  return p.lang;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    die('usage: puzzle:publish <puzzle.json> [--day YYYY-MM-DD | --bonus [ID]] [--s3] [--store DIR]');
  }

  const file = resolveInput(args.file);
  const source = await readFile(file, 'utf8').catch(() => die(`cannot read ${file}`));
  const parsed = JSON.parse(source) as Record<string, unknown>;
  const lang = puzzleLang(parsed, file);
  // The puzzle is published carrying its own version (#203).
  const raw = { ...parsed, revision: puzzleRevision(parsed) };
  const text = JSON.stringify(raw);

  // For S3, the destination is always the deployed bucket, discovered from the stack output.
  const deployed = args.s3 ? await stackOutputs() : undefined;
  const rootArg = args.store ?? process.env.PUZZLE_STORE;
  const root = rootArg ? resolveInput(rootArg) : defaultLocalStoreRoot();

  let bonusId: string | undefined;
  if (args.bonus === true) {
    bonusId = await mintBonusId(async (id, candidateLang) => {
      const key = storeKey(bonusAddress(id), candidateLang);
      if (!deployed) return access(path.join(root, key)).then(() => true, () => false);
      const { S3Client, HeadObjectCommand } = await import('@aws-sdk/client-s3');
      const { isNotFound } = await import('./store');
      try {
        await new S3Client({ region: STACK_REGION }).send(new HeadObjectCommand({ Bucket: deployed.bucket, Key: key }));
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    });
  } else if (typeof args.bonus === 'string') {
    bonusId = args.bonus;
  }

  let plan: PublishPlan;
  try {
    plan = planPublish({ s3: args.s3, day: args.day, bonusId }, lang, new Date(), deployed?.bucket);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  // #203: the derivation slice is derived here, from the same bytes being published, so the
  // two objects can never describe different puzzles. A malformed puzzle fails LOUDLY here
  // rather than publishing a sentence the round route can then never read.
  let slice: Buffer;
  try {
    slice = encodeSlice(buildSlice(raw as unknown as Puzzle));
  } catch (err) {
    die(`${file}: cannot build the derivation slice (${err instanceof Error ? err.message : String(err)}).`);
  }

  if (plan.target.kind === 's3') {
    const { bucket } = plan.target;
    // Import the SDK only on the S3 path so the local path stays AWS-free. The bucket lives
    // in STACK_REGION (the stack is pinned there), so address it explicitly.
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({ region: STACK_REGION });
    // The SLICE goes FIRST: these are two objects, so a reader between them sees one
    // version's puzzle beside another's, and writing the derivation artifact first means the
    // puzzle's appearance implies its slice is there.
    //
    // The window itself is closed by the VERSION both objects carry (#203): a caller names
    // one, and the route derives nothing unless the slice and the artifact both name the
    // same. Between these two writes it is simply a day-addressed 404 — which the ordering
    // then keeps as short as it can be.
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: plan.slice,
        Body: slice,
        ContentType: 'application/json',
        ContentEncoding: 'gzip',
      }),
    );
    console.log(`[publish] s3://${bucket}/${plan.slice}  (${slice.byteLength} bytes gzipped)`);
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: plan.key,
        Body: text,
        ContentType: 'application/json; charset=utf-8',
      }),
    );
    console.log(`[publish] s3://${bucket}/${plan.key}  (${lang}, day ${plan.day})`);

    // The puzzle URL is date-addressed and the CDN holds it via a year-long s-maxage, so a
    // REPUBLISH must invalidate the cached entry or the correction would never reach the
    // edge. `/*` is one invalidation path (well within the free tier) and also covers the
    // 404 negative cache when publishing a late puzzle. Needs cloudfront:CreateInvalidation.
    // This runs BEFORE the ledger append below: the ledger is rebuildable from the bucket
    // (`puzzle:ledger --s3`) while a skipped purge strands the correction behind the edge
    // cache with nothing retrying it, so a local-FS failure must never sit between the S3
    // put and the invalidation.
    const { CloudFrontClient, CreateInvalidationCommand } = await import(
      '@aws-sdk/client-cloudfront'
    );
    const cfr = new CloudFrontClient({ region: STACK_REGION });
    const inv = await cfr.send(
      new CreateInvalidationCommand({
        DistributionId: deployed!.distributionId,
        InvalidationBatch: {
          CallerReference: `publish-${plan.key}-${Date.now()}`,
          Paths: { Quantity: 1, Items: ['/*'] },
        },
      }),
    );
    console.log(
      `[publish] invalidated /* on ${deployed!.distributionId} (${inv.Invalidation?.Id ?? 'pending'})`,
    );

    // THE LEDGER (user-decided 2026-09-08): an S3 publish is recorded — day, instant,
    // revision, source, sentence, the secret/start pairs — in
    // packages/generation/published.jsonl, the one record the curator's archive reads.
    // A local publish never writes it (the local store is a test bed), and neither does a
    // BONUS: it is no day, and its sentence stays free for one. Gitignored: the bucket is
    // the truth.
    if (plan.bonusId !== undefined) {
      console.log(`[publish] bonus ${plan.bonusId}: ${bonusLink(lang, plan.bonusId, true)}  (no ledger line)`);
      return;
    }
    await appendPublished(ledgerEntry(raw as unknown as Puzzle, plan.day, new Date()));
    console.log(`[publish] ledger: ${publishLedgerPath()}  (+1 line)`);
    return;
  }

  const dest = path.join(root, plan.key);
  await mkdir(path.dirname(dest), { recursive: true });
  // The slice first, the puzzle second — the S3 ordering above, for its reason.
  const sliceDest = path.join(root, plan.slice);
  await writeFile(sliceDest, slice);
  console.log(`[publish] ${sliceDest}  (${slice.byteLength} bytes gzipped)`);
  await writeFile(dest, text);
  console.log(`[publish] ${dest}  (${lang}, ${plan.bonusId !== undefined ? plan.day : `day ${plan.day}`})`);
  if (plan.bonusId !== undefined) {
    console.log(`[publish] bonus ${plan.bonusId}: open ${bonusLink(lang, plan.bonusId, false)} on the dev server`);
  }
}

// Run as a CLI only when executed directly (`tsx src/publish.ts ...`), NOT when this
// module is imported (e.g. by publish.test.ts importing `planPublish`) — importing must
// not read argv or exit the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => die(err instanceof Error ? err.message : String(err)));
}
