// Mint the DAY PREVIEW LINKS of one game day (user-decided 2026-10-08).
//
//   pnpm puzzle:preview <YYYY-MM-DD> [--s3]
//
// Prints one link per supported language: the day's page carrying that (lang, date)'s
// preview code (previewCode.ts). Opened, it plays the day ahead of its date on its REAL
// round, and a solve there is on time. Only the operator can mint one — the code is signed
// with the server's IP-HMAC secret — and each link grants exactly its own (lang, date).
//
// Destination defaults to LOCAL, like `puzzle:publish`: without `--s3` the code is signed
// with `backend:dev`'s fixed local secret and the link is a bare path for the dev server.
// `--s3` signs with the PRODUCTION secret, read from Parameter Store with the operator's own
// credentials, and prefixes the site origin. Nothing is looked up in the store and a past
// date is not refused: a code for a day already out is simply useless.
import { pathToFileURL } from 'node:url';
import { isCalendarDate, previewPath, SUPPORTED_LANGS } from '@whippin/shared';
import { LOCAL_IP_HMAC_SECRET } from './config';
import { previewCode } from './previewCode';
import { STACK_REGION } from './stack';

// The SecureString the backend signs with. It must equal infra's default for
// `ipHmacSecretParameter` (infra/lib/backend-stack.ts) — the one name spelled twice.
const IP_HMAC_SECRET_PARAMETER = '/whippin/ip-hmac-secret';

interface Args {
  date: string;
  s3: boolean;
}

export function parseArgs(argv: string[]): Args {
  let date: string | undefined;
  let s3 = false;
  for (const a of argv) {
    if (a === '--s3') s3 = true;
    else if (a.startsWith('--')) die(`unknown flag: ${a}`);
    else if (date !== undefined) die(`unexpected extra argument: ${a}`);
    else date = a;
  }
  if (date === undefined) die('usage: puzzle:preview <YYYY-MM-DD> [--s3]');
  if (!isCalendarDate(date)) die(`not a calendar date: ${date} (expected YYYY-MM-DD)`);
  return { date, s3 };
}

function die(msg: string): never {
  console.error(`[preview] ${msg}`);
  process.exit(1);
}

// One printed line per supported language: the language, then its link.
export function previewLinks(secret: string, date: string, origin: string): string[] {
  return SUPPORTED_LANGS.map(
    (lang) => `${lang}  ${origin}${previewPath(lang, date, previewCode(secret, lang, date))}`,
  );
}

// The production secret, exactly as the backend loads it (config.ts `loadScoreSecrets`).
// The region is explicit: the parameter lives in STACK_REGION, and a read anywhere else
// answers "not found" rather than the wrong value.
async function productionSecret(): Promise<string> {
  const { GetParameterCommand, SSMClient } = await import('@aws-sdk/client-ssm');
  const client = new SSMClient({ region: STACK_REGION });
  const { Parameter } = await client.send(
    new GetParameterCommand({ Name: IP_HMAC_SECRET_PARAMETER, WithDecryption: true }),
  );
  if (Parameter?.Type !== 'SecureString' || !Parameter.Value) {
    die(`${IP_HMAC_SECRET_PARAMETER} (${STACK_REGION}) is not a non-empty SecureString.`);
  }
  return Parameter.Value;
}

async function main() {
  const { date, s3 } = parseArgs(process.argv.slice(2));
  const secret = s3 ? await productionSecret() : LOCAL_IP_HMAC_SECRET;
  // The site's own origin for a production link (as `puzzle:publish`'s bonus link); the bare
  // path locally — open it on the dev server.
  const origin = s3 ? (process.env.SITE_ORIGIN ?? 'https://whippin.ai') : '';
  for (const line of previewLinks(secret, date, origin)) console.log(line);
}

// Run as a CLI only when executed directly, NOT when imported (preview.test.ts) — importing
// must not read argv or exit the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => die(err instanceof Error ? err.message : String(err)));
}
