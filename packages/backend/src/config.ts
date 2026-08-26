// Runtime configuration, read from the Lambda's environment (set by the CDK stack, #3).
// Secret VALUES never enter CloudFormation: the environment carries only Parameter Store
// names, and the production entrypoint resolves both encrypted values together on first use.
import { GetParametersCommand, type SSMClient } from '@aws-sdk/client-ssm';

interface Config {
  bucket: string;
  scoreTable: string;
  turnstileSecretParameter: string;
  ipHmacSecretParameter: string;
  allowedOrigin: string;
  // Canonical site origin (the apex, e.g. https://whippin.ai) for the share card's absolute
  // URLs (og:image + the game redirect). Optional; when unset the handler falls back to the
  // request origin (fine for local dev). #8.
  siteOrigin?: string;
  // The verified SES sender the #204 link codes go out as. REQUIRED, like the table and the
  // secret names: a link flow whose mail cannot be sent is a flow that silently strands
  // every player who tries it, and a boot that names the failure is the cheaper one.
  mailFrom: string;
}

export interface ScoreSecrets {
  turnstileSecret: string;
  ipHmacSecret: string;
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
  const turnstileSecretParameter = env.TURNSTILE_SECRET_PARAMETER;
  if (!turnstileSecretParameter) {
    throw new Error('TURNSTILE_SECRET_PARAMETER env var is required.');
  }
  const ipHmacSecretParameter = env.IP_HMAC_SECRET_PARAMETER;
  if (!ipHmacSecretParameter) {
    throw new Error('IP_HMAC_SECRET_PARAMETER env var is required.');
  }
  const mailFrom = env.MAIL_FROM;
  if (!mailFrom) {
    throw new Error('MAIL_FROM env var is required.');
  }
  return {
    bucket,
    scoreTable,
    mailFrom,
    turnstileSecretParameter,
    ipHmacSecretParameter,
    // The web origin in prod; "*" is the permissive default for local/dev.
    allowedOrigin: env.ALLOWED_ORIGIN ?? '*',
    siteOrigin: env.SITE_ORIGIN,
  };
}

export async function loadScoreSecrets(
  client: SSMClient,
  config: Pick<Config, 'turnstileSecretParameter' | 'ipHmacSecretParameter'>,
): Promise<ScoreSecrets> {
  const names = [config.turnstileSecretParameter, config.ipHmacSecretParameter];
  const response = await client.send(
    new GetParametersCommand({ Names: names, WithDecryption: true }),
  );
  const values = new Map(
    (response.Parameters ?? []).flatMap((parameter) =>
      parameter.Name && parameter.Type === 'SecureString' && parameter.Value
        ? [[parameter.Name, parameter.Value] as const]
        : [],
    ),
  );
  const missing = names.filter((name) => !values.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Required SecureString score parameter(s) unavailable: ${missing.join(', ')}.`,
    );
  }

  const turnstileSecret = values.get(config.turnstileSecretParameter)!;
  const ipHmacSecret = values.get(config.ipHmacSecretParameter)!;
  if (Buffer.byteLength(ipHmacSecret) < 32) {
    throw new Error('The IP-HMAC secret must contain at least 32 bytes.');
  }
  return { turnstileSecret, ipHmacSecret };
}
