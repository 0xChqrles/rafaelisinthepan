// ONE provider-neutral request/response contract (#236), covering exactly what the bot
// needs — ordinary generation, structured (JSON) output, tool calls, bounded output — and
// not every feature every vendor exposes. Podium and chat code see only this; a provider's
// own types stop at `providers/<name>.ts`.

export interface LlmTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema (object)
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string; // raw JSON text, parsed (and validated) by the tool runner
}

export type LlmMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  maxTokens: number;
  json?: boolean; // ask for a JSON object answer
  temperature?: number;
  // How much the model may THINK before answering, for a reasoning model: `none` turns the
  // thinking off, `low` bounds it. Absent = the provider's default.
  effort?: 'none' | 'low' | 'high';
  timeoutMs?: number;
}

export interface LlmResponse {
  text: string | null;
  toolCalls: LlmToolCall[];
  finish: 'stop' | 'length' | 'tool_calls' | 'other';
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generate(request: LlmRequest): Promise<LlmResponse>;
}

// The provider could not answer (network, timeout, 5xx, rate limit). Callers DEGRADE on
// this — a podium without comments, a question without an answer — never fail.
export class LlmUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmUnavailable';
  }
}
