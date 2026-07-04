// Runtime configuration, read from the Lambda's environment (set by the CDK stack, #3).
export interface Config {
  bucket: string;
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
  return {
    bucket,
    // The web origin in prod; "*" is the permissive default for local/dev.
    allowedOrigin: env.ALLOWED_ORIGIN ?? '*',
    siteOrigin: env.SITE_ORIGIN,
  };
}
