// Provider selection is RUNTIME configuration (BOT_LLM_PROVIDER / BOT_LLM_MODEL); the API
// key is read from Parameter Store at start, never from anything committed.

import { GetParameterCommand, type SSMClient } from '@aws-sdk/client-ssm';
import type { LlmEnv } from '../config/env';
import { deepSeekProvider } from './providers/deepseek';
import { deepSeekWeb } from './providers/deepseekWeb';
import type { LlmProvider, WebClient } from './types';

async function resolveLlmApiKey(env: LlmEnv, ssm: () => SSMClient): Promise<string | null> {
  if (env.apiKey) return env.apiKey;
  if (!env.apiKeyParameter) return null;
  const response = await ssm().send(
    new GetParameterCommand({ Name: env.apiKeyParameter, WithDecryption: true }),
  );
  const value = response.Parameter?.Value;
  return value && value !== '' ? value : null;
}

// Null when no key is configured: every caller treats that as "no comedian" and degrades.
export async function createLlmProvider(
  env: LlmEnv,
  ssm: () => SSMClient,
): Promise<LlmProvider | null> {
  const apiKey = await resolveLlmApiKey(env, ssm);
  if (!apiKey) return null;
  switch (env.provider) {
    case 'deepseek':
      return deepSeekProvider({ apiKey, model: env.model });
    default:
      throw new Error(`Unknown BOT_LLM_PROVIDER "${env.provider}".`);
  }
}

// The conversation's web (v22): the same provider's search and page reader, on the same key.
// Null with no key, and for a provider that has none — the conversation then simply has no
// web tools.
export async function createWebClient(env: LlmEnv, ssm: () => SSMClient): Promise<WebClient | null> {
  if (env.provider !== 'deepseek') return null;
  const apiKey = await resolveLlmApiKey(env, ssm);
  return apiKey ? deepSeekWeb({ apiKey }) : null;
}

export * from './types';
