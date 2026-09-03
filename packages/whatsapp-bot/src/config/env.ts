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
  groupsDir: string; // BOT_GROUPS_DIR — where the committed group files were copied to
  siteOrigin: string; // BOT_SITE_ORIGIN — the share links to recognise (https://whippin.ai)
  metricsNamespace?: string; // BOT_METRICS_NAMESPACE — unset = no CloudWatch metrics
  llm: LlmEnv;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} env var is required.`);
  return value;
}

// Where the committed group files are when nobody says otherwise: the SOURCE tree, which
// is what `pnpm bot:start` and `pnpm bot:pair` run from. Both DEPLOYED forms set
// BOT_GROUPS_DIR outright — the image copies the files to /app/…, the Lambda bundle keeps
// them beside its handler — because resolved from a bundle this path lands beside the
// bundle instead, where there is nothing.
function sourceGroupsDir(): string {
  return fileURLToPath(new URL('../../groups', import.meta.url));
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): BotEnv {
  const ceiling = Number(env.BOT_LLM_DAILY_CALL_CEILING ?? 500);
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
