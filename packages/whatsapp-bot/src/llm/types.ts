// ONE provider-neutral request/response contract (#236), covering exactly what the bot
// needs — ordinary generation, tool calls, bounded output — and
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
  // `reasoning`: what a thinking model reasoned before asking for its tools, handed back
  // with the tool calls it led to (DeepSeek refuses a thinking-mode tool round whose
  // reasoning it cannot find — `providers/deepseek.ts`). Absent on a remembered line.
  | { role: 'assistant'; content: string | null; toolCalls?: LlmToolCall[]; reasoning?: string }
  | { role: 'tool'; toolCallId: string; content: string };

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  maxTokens: number;
  temperature?: number;
  // How much the model may THINK before answering, for a reasoning model: `none` turns the
  // thinking off, `low` bounds it. Absent = the provider's default.
  effort?: 'none' | 'low' | 'high';
  timeoutMs?: number;
}

export interface LlmResponse {
  text: string | null;
  // A thinking model's reasoning, when the provider returns it (never shown to anybody).
  reasoning?: string | null;
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

// THE WEB (v22, 2026-10-18): the provider's search engine and page reader, as the
// conversation's tools use them (`chat/web.ts`). Provider-neutral like the rest of this
// file; DeepSeek's wire format stops at `providers/deepseekWeb.ts`.
export interface WebResult {
  title: string;
  url: string;
  site: string | null;
  date: string | null; // YYYY-MM-DD, when the engine knows it
  summary: string;
}

export interface WebPage {
  title: string;
  content: string; // the page as Markdown text, bounded
  truncated: boolean;
}

export interface WebClient {
  search(query: string): Promise<WebResult[]>;
  read(url: string): Promise<WebPage>;
}

// The search or the read did not happen: `refused` is the request (or the site) saying no,
// `not_found` a page with nothing readable, `unavailable` weather — network, timeout, 5xx,
// rate limit, an empty balance. The tool answers each as a fact; nothing throws past it.
export class WebUnavailable extends Error {
  constructor(readonly reason: 'refused' | 'not_found' | 'unavailable') {
    super(`web: ${reason}`);
    this.name = 'WebUnavailable';
  }
}
