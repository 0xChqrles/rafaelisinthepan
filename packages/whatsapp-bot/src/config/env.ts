// Runtime configuration for the two processes this package ships — the long-lived
// WhatsApp task and the bounded podium job. Values come from the environment the CDK
// stack sets; SECRETS never do (the environment carries a Parameter Store NAME, and the
// key is read at runtime — the backend's own rule).

import { fileURLToPath } from 'node:url';

export interface LlmEnv {
  provider: string; // BOT_LLM_PROVIDER, e.g. "deepseek"
  model: string; // BOT_LLM_MODEL, e.g. "deepseek-v4-flash"
  apiKeyParameter?: string; // SSM SecureString holding the provider key
  apiKey?: string; // local runs only (BOT_LLM_API_KEY); production uses the parameter
  // Daily ceiling on model CALLS across every group — the last line against one bored
  // participant turning the group into an API loop, after the per-user and per-group ones.
  dailyCallCeiling: number;
}

export interface BotEnv {
  table: string; // BOT_TABLE — the bot-owned DynamoDB table (every keyspace)
  outboundQueueUrl?: string; // BOT_OUTBOUND_QUEUE_URL — absent on a purely local dry run
  groupsDir: string; // BOT_GROUPS_DIR — where the pulled snapshot files were copied to
  siteOrigin: string; // BOT_SITE_ORIGIN — the share links to recognise (https://whippin.ai)
  metricsNamespace?: string; // BOT_METRICS_NAMESPACE — unset = no CloudWatch metrics
  llm: LlmEnv;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} env var is required.`);
  return value;
}

// Where the pulled snapshot files are when nobody says otherwise: the SOURCE tree, which
// is what `pnpm bot:start` and `pnpm bot:pair` run from (`groups/local/`, written by
// `pnpm bot:groups pull` from SSM — never `groups/` itself, which holds only the
// committed template). Both DEPLOYED forms set BOT_GROUPS_DIR outright — the image copies
// the files to /app/…, the Lambda bundle keeps them beside its handler — because resolved
// from a bundle this path lands beside the bundle instead, where there is nothing.
function sourceGroupsDir(): string {
  return fileURLToPath(new URL('../../groups/local', import.meta.url));
}

// EVERY AWS CLIENT IN THIS PACKAGE IS BUILT AGAINST THIS REGION, and it is PINNED rather
// than inherited from the shell. The stacks are all pinned to us-east-1 (`infra/bin/app.ts`),
// so that is where the table, the queue and the parameters are — not a fact a laptop's
// default region should be able to get wrong. Inside ECS and Lambda the runtime's own
// AWS_REGION is this same value, so pinning changes nothing there; what it fixes is the
// OPERATOR path, where `pnpm bot:pair` against a default of eu-west-1 answered
// `ResourceNotFoundException: Requested resource not found` — true, unhelpful, and naming
// nothing that would lead anyone to the region. `BOT_AWS_REGION` overrides it.
export const BOT_REGION = process.env.BOT_AWS_REGION || 'us-east-1';

export const DEFAULT_DAILY_CALL_CEILING = 500;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): BotEnv {
  // An EMPTY value is unset, as it is for every other knob here — `Number('')` is 0, which
  // passes the check below and silences every model reply while the per-user and
  // per-group quotas keep being spent, and an empty variable is the easiest thing to
  // leave behind in a task definition.
  const rawCeiling = env.BOT_LLM_DAILY_CALL_CEILING?.trim();
  const ceiling = rawCeiling ? Number(rawCeiling) : DEFAULT_DAILY_CALL_CEILING;
  if (!Number.isFinite(ceiling) || ceiling < 0) {
    throw new Error('BOT_LLM_DAILY_CALL_CEILING must be a non-negative number.');
  }
  return {
    table: required(env, 'BOT_TABLE'),
    outboundQueueUrl: env.BOT_OUTBOUND_QUEUE_URL || undefined,
    groupsDir: env.BOT_GROUPS_DIR || sourceGroupsDir(),
    siteOrigin: (env.BOT_SITE_ORIGIN || 'https://whippin.ai').replace(/\/+$/, ''),
    metricsNamespace: env.BOT_METRICS_NAMESPACE || undefined,
    llm: {
      provider: env.BOT_LLM_PROVIDER || 'deepseek',
      model: env.BOT_LLM_MODEL || 'deepseek-v4-flash',
      apiKeyParameter: env.BOT_LLM_API_KEY_PARAMETER || undefined,
      apiKey: env.BOT_LLM_API_KEY || undefined,
      dailyCallCeiling: ceiling,
    },
  };
}
