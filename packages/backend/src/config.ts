// Runtime configuration, read from the Lambda's environment (set by the CDK stack, #3).
interface Config {
  bucket: string;
  scoreTable: string;
  turnstileSecret: string;
  ipHmacSecret: string;
  allowedOrigin: string;
  // Canonical site origin (the apex, e.g. https://whippin.ai) for the share card's absolute
  // URLs (og:image + the game redirect). Optional; when unset the handler falls back to the
  // request origin (fine for local dev). #8.
  siteOrigin?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const bucket = env.PUZZLE_BUCKET;
  if (!bucket) {
    throw new Error('PUZZLE_BUCKET env var is required.');
  }
  const scoreTable = env.SCORE_TABLE;
  if (!scoreTable) {
    throw new Error('SCORE_TABLE env var is required.');
  }
  const turnstileSecret = env.TURNSTILE_SECRET;
  if (!turnstileSecret) {
    throw new Error('TURNSTILE_SECRET env var is required.');
  }
  const ipHmacSecret = env.IP_HMAC_SECRET;
  if (!ipHmacSecret || Buffer.byteLength(ipHmacSecret) < 32) {
    throw new Error('IP_HMAC_SECRET env var is required and must contain at least 32 bytes.');
  }
  return {
    bucket,
    scoreTable,
    turnstileSecret,
    ipHmacSecret,
    // The web origin in prod; "*" is the permissive default for local/dev.
    allowedOrigin: env.ALLOWED_ORIGIN ?? '*',
    siteOrigin: env.SITE_ORIGIN,
  };
}
