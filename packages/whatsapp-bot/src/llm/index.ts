// Provider selection is RUNTIME configuration (BOT_LLM_PROVIDER / BOT_LLM_MODEL); the API
// key is read from Parameter Store at start, never from anything committed.

import { GetParameterCommand, type SSMClient } from '@aws-sdk/client-ssm';
import type { LlmEnv } from '../config/env';
import { deepSeekProvider } from './providers/deepseek';
import type { LlmProvider } from './types';

export async function resolveLlmApiKey(env: LlmEnv, ssm: () => SSMClient): Promise<string | null> {
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

export * from './types';
