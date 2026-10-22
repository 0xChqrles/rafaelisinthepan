// DeepSeek's Search and Fetch APIs (released 2026-10-17, https://api-docs.deepseek.com/guides/search),
// as the conversation's web tools call them. Two plain JSON endpoints on the same key as the
// model — the model never calls them itself: Chat Completions takes only function tools, and
// DeepSeek's one hosted search (the Responses API's `web_search`) runs on `deepseek-v4-pro`
// alone and would leave the code no place to check what was searched or read (`chat/web.ts`).
//
// THE PAGE IS READ BY DEEPSEEK, NOT BY THIS TASK: the Fetch API downloads it on DeepSeek's
// side, so a link a member posts never makes the bot's own task open a connection — the
// task's network (and the ECS credentials endpoint inside it) is never what a URL reaches.
//
// Neither a query nor a URL is ever logged or put in an error message: they are what the
// group said.

import { WebUnavailable, type WebClient, type WebPage, type WebResult } from '../types';

const SEARCH_ENDPOINT = 'https://api.deepseek.com/v1/tools/search';
const FETCH_ENDPOINT = 'https://api.deepseek.com/v1/tools/fetch';
// The API takes 1–128 characters.
export const QUERY_MAX_CHARS = 128;
export const SEARCH_COUNT = 6;
// Summaries are written for a model and measured LONGER than documented (1,100–3,700 chars
// against 600–800, 2026-10-18), and every tool result is re-sent on every later round of the
// answer — so each is cut here.
export const SUMMARY_MAX_CHARS = 900;
export const PAGE_MAX_CHARS = 12_000;
// What is CLEANED at most: the escapes roughly double a page, so twice the kept length still
// fills it — and nothing past it is run through a regex in the task's one process.
const RAW_MAX_CHARS = 2 * PAGE_MAX_CHARS;
const SEARCH_TIMEOUT_MS = 12_000; // measured 0.6s
const FETCH_TIMEOUT_MS = 30_000; // measured 16s for one news article

interface WireResult {
  title?: unknown;
  url?: unknown;
  site_name?: unknown;
  date?: unknown;
  summary?: unknown;
  snippet?: unknown;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function cut(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

// The engine's dates are day-level and stamped at 16:00 UTC — midnight in Beijing, where the
// engine runs — so the Beijing calendar day is the date it means.
const BEIJING_MS = 8 * 60 * 60 * 1000;
export function resultDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at + BEIJING_MS).toISOString().slice(0, 10) : null;
}

// The Fetch API's Markdown escapes nearly every punctuation mark (`\,` `\.` `\-` `\/`),
// which doubles what the model reads for nothing; images are nothing it can read.
export function cleanPage(markdown: string): string {
  return markdown
    .replace(/!\[[^\]\n]{0,300}\]\([^)\s]{0,2000}\)/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!|~<>,/:;=?&%$@"'])/g, '$1')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function failure(status: number): WebUnavailable {
  if (status === 400 || status === 403 || status === 413) return new WebUnavailable('refused');
  if (status === 404) return new WebUnavailable('not_found');
  return new WebUnavailable('unavailable'); // 401/402/408/429/5xx/504: weather or the account
}

export interface DeepSeekWebOptions {
  apiKey: string;
  fetch?: typeof fetch;
}

export function deepSeekWeb(options: DeepSeekWebOptions): WebClient {
  const doFetch = options.fetch ?? fetch;

  async function post(endpoint: string, body: unknown, timeoutMs: number): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new WebUnavailable('unavailable');
    }
    if (!response.ok) throw failure(response.status);
    try {
      return await response.json();
    } catch {
      throw new WebUnavailable('unavailable');
    }
  }

  return {
    async search(query) {
      const q = Array.from(query.trim()).slice(0, QUERY_MAX_CHARS).join('').trim();
      if (q === '') throw new WebUnavailable('refused');
      const wire = (await post(SEARCH_ENDPOINT, { query: q, count: SEARCH_COUNT, need_content: false }, SEARCH_TIMEOUT_MS)) as {
        results?: WireResult[];
      } | null;
      const results: WebResult[] = [];
      for (const r of Array.isArray(wire?.results) ? wire.results : []) {
        const url = text(r?.url);
        if (!/^https?:\/\//i.test(url)) continue;
        results.push({
          title: text(r.title),
          url,
          site: text(r.site_name) || null,
          date: resultDate(r.date),
          summary: cut(text(r.summary) || text(r.snippet), SUMMARY_MAX_CHARS),
        });
      }
      return results;
    },
    async read(url) {
      const wire = (await post(FETCH_ENDPOINT, { url }, FETCH_TIMEOUT_MS)) as { title?: unknown; content?: unknown } | null;
      const raw = text(wire?.content);
      const content = cleanPage(raw.slice(0, RAW_MAX_CHARS));
      if (content === '') throw new WebUnavailable('not_found');
      const page: WebPage = {
        title: text(wire?.title),
        content: cut(content, PAGE_MAX_CHARS),
        truncated: raw.length > RAW_MAX_CHARS || content.length > PAGE_MAX_CHARS,
      };
      return page;
    },
  };
}
