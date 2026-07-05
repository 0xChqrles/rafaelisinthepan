// Publish a generated puzzle into the store the backend serves (issue #17 / #4).
//
//   pnpm puzzle:publish <puzzle.json> [--day YYYY-MM-DD] [--s3] [--store DIR]
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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { activeDate, type Puzzle } from '@whippin/shared';
import { defaultLocalStoreRoot, isValidDate, storeKey } from './layout';

// The infra identifiers publish reads from the deployed stack — mirror packages/infra:
// the stack id in `bin/app.ts` and the CfnOutput ids in `lib/backend-stack.ts`. The stack
// is pinned to us-east-1 (see bin/app.ts), so its outputs and its bucket live there.
const STACK_NAME = 'WhippinBackendStack';
const BUCKET_OUTPUT_KEY = 'PuzzleBucketName';
const DISTRIBUTION_OUTPUT_KEY = 'DistributionId';
const STACK_REGION = 'us-east-1';

interface Args {
  file?: string;
  day?: string;
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

// Resolve the puzzle bucket + API distribution from the deployed stack's outputs — the
// infra code is the single source of truth for both. Needs AWS creds (already required to
// upload) + `cloudformation:DescribeStacks`. The SDK is imported lazily so the local path
// stays AWS-free. Dies with a clear, actionable error if the stack/output is missing.
async function stackOutputs(): Promise<{ bucket: string; distributionId: string }> {
  const { CloudFormationClient, DescribeStacksCommand } = await import(
    '@aws-sdk/client-cloudformation'
  );
  const cf = new CloudFormationClient({ region: STACK_REGION });
  const res = await cf.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
  const outputs = res.Stacks?.[0]?.Outputs;
  const get = (key: string): string => {
    const value = outputs?.find((o) => o.OutputKey === key)?.OutputValue;
    if (!value) {
      die(
        `stack "${STACK_NAME}" (${STACK_REGION}) has no "${key}" output — ` +
          `deploy the infra package first (pnpm infra:deploy).`,
      );
    }
    return value;
  };
  return { bucket: get(BUCKET_OUTPUT_KEY), distributionId: get(DISTRIBUTION_OUTPUT_KEY) };
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
// LOCAL unless `--s3` opts in, in which case `bucket` (the name resolved from the deployed
// stack output) is REQUIRED — never a silent local fallback. The (impure, AWS) lookup is
// kept in main so this stays pure. Throws on an invalid day or `--s3` with no bucket; the
// CLI turns that into a clean `die`.
export function planPublish(
  args: Pick<Args, 's3' | 'day'>,
  lang: string,
  now: Date,
  bucket?: string,
): PublishPlan {
  const day = args.day ?? activeDate(now);
  if (!isValidDate(day)) throw new Error(`invalid --day "${day}" (expected YYYY-MM-DD).`);
  const key = storeKey(day, lang);
  if (args.s3) {
    if (!bucket) throw new Error('--s3 requires the deployed bucket (no stack output resolved).');
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
    die('usage: puzzle:publish <puzzle.json> [--day YYYY-MM-DD] [--s3] [--store DIR]');
  }

  const file = resolveInput(args.file);
  const text = await readFile(file, 'utf8').catch(() => die(`cannot read ${file}`));
  const puzzle = asPuzzle(JSON.parse(text), file);

  // For S3, the destination is always the deployed bucket, discovered from the stack output.
  const deployed = args.s3 ? await stackOutputs() : undefined;

  let plan: PublishPlan;
  try {
    plan = planPublish(args, puzzle.lang, new Date(), deployed?.bucket);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  if (plan.target.kind === 's3') {
    const { bucket } = plan.target;
    // Import the SDK only on the S3 path so the local path stays AWS-free. The bucket lives
    // in STACK_REGION (the stack is pinned there), so address it explicitly.
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({ region: STACK_REGION });
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: plan.key,
        Body: text,
        ContentType: 'application/json; charset=utf-8',
      }),
    );
    console.log(`[publish] s3://${bucket}/${plan.key}  (${puzzle.lang}, day ${plan.day})`);

    // The puzzle URL is date-addressed and the CDN holds it via a year-long s-maxage, so a
    // REPUBLISH must invalidate the cached entry or the correction would never reach the
    // edge. `/*` is one invalidation path (well within the free tier) and also covers the
    // 404 negative cache when publishing a late puzzle. Needs cloudfront:CreateInvalidation.
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
