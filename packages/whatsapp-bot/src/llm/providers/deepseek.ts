// DeepSeek, over its OpenAI-compatible chat completions API. Nothing DeepSeek-shaped
// leaves this file: the wire format is mapped onto `LlmRequest`/`LlmResponse` here.

import {
  LlmUnavailable,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from '../types';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_TIMEOUT_MS = 30_000;

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
}

function toWire(message: LlmMessage): WireMessage {
  switch (message.role) {
    case 'user':
      return { role: 'user', content: message.content };
    case 'tool':
      return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      };
  }
}

interface WireResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface DeepSeekOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export function deepSeekProvider(options: DeepSeekOptions): LlmProvider {
  const doFetch = options.fetch ?? fetch;
  const url = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
  return {
    name: 'deepseek',
    model: options.model,
    async generate(request: LlmRequest): Promise<LlmResponse> {
      const body = {
        model: options.model,
        messages: [{ role: 'system', content: request.system }, ...request.messages.map(toWire)],
        max_tokens: request.maxTokens,
        temperature: request.temperature ?? 1,
        ...(request.json ? { response_format: { type: 'json_object' } } : {}),
        ...(request.tools && request.tools.length > 0
          ? {
              tools: request.tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
            }
          : {}),
      };
      const started = Date.now();
      let response: Response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (error) {
        // The NAME alone ("TypeError", "AbortError") cannot tell a timeout from a DNS
        // failure from an aborted request, which is the whole question when the provider
        // starts misbehaving. The message names no secret: the key travels in a header.
        const cause = error as Error;
        throw new LlmUnavailable(`deepseek: ${cause.name}: ${cause.message}`);
      }
      if (response.status === 429 || response.status >= 500) {
        throw new LlmUnavailable(`deepseek: HTTP ${response.status}`);
      }
      if (!response.ok) {
        // A 4xx is our own request being wrong (key, model, schema) — a bug, not weather.
        throw new Error(`deepseek: HTTP ${response.status}`);
      }
      let wire: WireResponse;
      try {
        wire = (await response.json()) as WireResponse;
      } catch {
        throw new LlmUnavailable('deepseek: unparseable body');
      }
      const choice = wire.choices?.[0];
      const toolCalls = (choice?.message?.tool_calls ?? []).flatMap((c) =>
        c.id && c.function?.name
          ? [{ id: c.id, name: c.function.name, arguments: c.function.arguments ?? '{}' }]
          : [],
      );
      const reason = choice?.finish_reason;
      return {
        text: choice?.message?.content ?? null,
        toolCalls,
        finish:
          reason === 'stop' || reason === 'length' || reason === 'tool_calls' ? reason : 'other',
        usage: {
          inputTokens: wire.usage?.prompt_tokens ?? 0,
          outputTokens: wire.usage?.completion_tokens ?? 0,
        },
        latencyMs: Date.now() - started,
      };
    },
  };
}
