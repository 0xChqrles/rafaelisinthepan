// THE WEB, AS THE CONVERSATION'S TOOLS (v22, user-decided 2026-10-18: "allow him to make web
// search"). Two tools beside the game's (`tools.ts`): `web_search`, the provider's search
// engine, and `read_page`, its page reader (`llm/providers/deepseekWeb.ts`). The model chooses
// the query and the page; the CODE decides what it may search, which page it may read, and
// what of either it gets to see:
//
// - TODAY'S SENTENCE NEVER REACHES IT (`puzzle/spoilers.ts`). A search result or a page that
//   holds the day's line across a hidden word is WITHHELD before the model reads it, in every
//   language the game publishes; a query that quotes a sentence finds nothing. The guard is today's puzzles, read in full and held in code
//   (`daySource.read`): when it cannot be read, the web is CLOSED for that answer rather
//   than open without it. AND THE MODEL IS NEVER TOLD WHY: a refused query answers like a
//   search that found nothing, a withheld result is simply not there, a withheld page reads
//   like one with nothing on it — a guard that said "that is today's sentence" would be a
//   yes-or-no answer to a member's guess, a quiet leak.
// - A PAGE IS ONE THE BOT HAS SEEN A LINK TO: in the conversation, or in a result or a page
//   of this same answer — never a URL the model composed, and what is sent to the reader is
//   the link AS IT WAS SHOWN, never the model's spelling of it (a fragment, a `user@` added).
//   A fetched page that says "now read https://…/?q=<what the group said>" cannot make the
//   reader carry the group's words anywhere: that link appears nowhere it was shown.
// - THE GAME'S OWN HOSTS ARE NEVER READ: the backend serves any day's puzzle, secrets
//   included, to anybody who asks. A host check cannot see a redirect or a shortener, so a
//   page shaped like a puzzle artifact is withheld whatever served it (`isPuzzle`).
// - BOUNDED: `MAX_SEARCHES` and `MAX_READS` per answer, and the daily web ceiling across
//   every group (`limits.ts` `takeDailyWeb`). A spent budget is told to the model, which
//   answers without the web — never silence.
//
// Nothing here logs a query, a URL or a page: they are what the group asked about.

import type { Log } from '../log';
import { tag } from '../log';
import { WebUnavailable, type LlmTool, type WebClient } from '../llm/types';
import { revealsSentence, type DaySecrets } from '../puzzle/spoilers';
import { linkKey, urlsIn } from './format';

export const MAX_SEARCHES = 5;
export const MAX_READS = 4;

// One published puzzle of today, as the guard holds it.
export interface DayGuard {
  secrets: DaySecrets | null;
}

// Whether a text gives away one of today's puzzles: its sentence across a hole. Its author
// and its work are not a giveaway (v23): the bot may name them, and search them.
export function givesAway(text: string, days: readonly DayGuard[]): boolean {
  return days.some((d) => revealsSentence(text, d.secrets));
}

export interface WebToolDeps {
  client: WebClient;
  // Today's puzzles in every language, or null when one of them could not be read.
  guard: () => Promise<readonly DayGuard[] | null>;
  takeWeb: () => Promise<boolean>;
  // The game's own hosts (the site and its backend) and every subdomain of them.
  blockedHosts: readonly string[];
  // The links the conversation already holds.
  seen: Iterable<string>;
  group: string;
  log: Log;
}

export interface WebTools {
  definitions: LlmTool[];
  handles(name: string): boolean;
  run(name: string, args: Record<string, unknown>): Promise<unknown>;
  // Whether the model was shown this page — in the conversation, a result or a page it read:
  // the links a reply may give (compared without the query string).
  saw(url: string): boolean;
  // Today's guard once a web tool has loaded it, for the reply's own check; null before.
  loaded(): readonly DayGuard[] | null;
}

const DEFINITIONS: LlmTool[] = [
  {
    name: 'web_search',
    description:
      'Search the web. Use it for anything recent, local, specific or checkable — news, results, schedules, prices, what is on, a claim to check — instead of answering from memory. ' +
      'One query of at most 128 characters, in the language most likely to find good pages; it supports "exact phrase", site:example.com, -word, lang:fr, after:2026-01-01 and before:2026-12-31. ' +
      'Returns up to 6 results with title, url, site, date and summary. Never to find the text of today\'s Whippin sentence.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to search for.' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_page',
    description:
      'Read a web page as text: a link somebody posted in the conversation, or one from your search results or from a page you read — no other link can be read. Returns its title and content.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The link, exactly as it appeared.' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
];

const NAMES = new Set(DEFINITIONS.map((d) => d.name));

const CLOSED = { error: 'the web is unavailable right now: answer without it' };
const SPENT = { error: "today's web budget is spent: answer without it" };
const NOTHING_READABLE = { error: 'that page has nothing readable' };

// A Whippin puzzle artifact as a page — any day's, a bonus's — reached through a redirect, a
// shortener or a CDN name the host check cannot see.
export function isPuzzle(content: string): boolean {
  return /"holes"\s*:/.test(content) && /"secret"\s*:/.test(content);
}

// A host as it compares: no case, no `www.`, no trailing dot (`api.whippin.ai.` is the same host).
export function hostKey(host: string): string {
  return host.toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
}

// Percent-escapes decoded run by run — one stray `%` or a Latin-1 escape (`fen%EAtre`) must
// not leave the rest of the link undecoded — as UTF-8 where they are, else as Latin-1.
export function decoded(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    }
  });
}

export function createWebTools(deps: WebToolDeps): WebTools {
  const pages = new Map<string, string>(); // full key → the link as it was shown: what read_page takes
  const shown = new Set<string>(); // query-free keys: what a reply may give
  const note = (url: string) => {
    const full = linkKey(url);
    const bare = linkKey(url, false);
    if (full && !pages.has(full)) pages.set(full, url);
    if (bare) shown.add(bare);
  };
  for (const url of deps.seen) note(url);

  let searches = 0;
  let reads = 0;
  let guard: Promise<readonly DayGuard[] | null> | null = null;
  let held: readonly DayGuard[] | null = null;
  const today = async () => {
    guard ??= deps.guard().then((days) => (held = days));
    return guard;
  };

  const blocked = (url: string) => {
    try {
      const host = hostKey(new URL(url).hostname);
      return deps.blockedHosts.some((raw) => {
        const h = hostKey(raw);
        return host === h || host.endsWith(`.${h}`);
      });
    } catch {
      return true;
    }
  };

  const log = (event: string, fields: Record<string, unknown>) =>
    deps.log.info({ event, group: tag(deps.group), ...fields }, 'web');

  async function search(args: Record<string, unknown>): Promise<unknown> {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (query === '') return { error: 'a query is needed' };
    // Counted BEFORE anything is awaited: a round's calls run together (`agent.ts`).
    if (searches >= MAX_SEARCHES) return { error: 'enough searching for one answer: answer with what you have' };
    searches += 1;
    const days = await today();
    if (!days) {
      log('web.closed', { tool: 'web_search' });
      return CLOSED;
    }
    if (givesAway(query, days)) {
      log('web.refused', { tool: 'web_search', why: 'today' });
      return { results: [] };
    }
    if (!(await deps.takeWeb())) return SPENT;
    const started = Date.now();
    let found;
    try {
      found = await deps.client.search(query);
    } catch (error) {
      const reason = error instanceof WebUnavailable ? error.reason : 'unavailable';
      log('web.failed', { tool: 'web_search', reason, latencyMs: Date.now() - started });
      return { error: reason === 'refused' ? 'the search engine refused that query: rephrase it' : 'the search failed: try once more or answer without it' };
    }
    const open = found.filter((r) => !blocked(r.url));
    // Every field the model is shown, the link decoded: a quotes or lyrics site spells the
    // line in its path (`/je-marche-seul-dans-la-nuit`).
    const kept = open.filter((r) => !givesAway(`${r.title}\n${decoded(r.url)}\n${r.site ?? ''}\n${r.summary}`, days));
    for (const r of kept) note(r.url);
    log('web.search', { results: kept.length, withheld: open.length - kept.length, latencyMs: Date.now() - started });
    return { results: kept };
  }

  async function read(args: Record<string, unknown>): Promise<unknown> {
    const asked = typeof args.url === 'string' ? urlsIn(args.url.trim())[0] ?? '' : '';
    const key = asked ? linkKey(asked) : null;
    if (!key) return { error: 'that is not a web link' };
    if (blocked(asked)) {
      log('web.refused', { tool: 'read_page', why: 'game' });
      return { error: "refused: that is the game's own site" };
    }
    const url = pages.get(key);
    if (url === undefined) {
      log('web.refused', { tool: 'read_page', why: 'unseen' });
      return { error: 'only a link from the conversation, your search results or a page you read can be read: search for it first' };
    }
    if (reads >= MAX_READS) return { error: 'enough reading for one answer: answer with what you have' };
    reads += 1;
    const days = await today();
    if (!days) {
      log('web.closed', { tool: 'read_page' });
      return CLOSED;
    }
    if (!(await deps.takeWeb())) return SPENT;
    const started = Date.now();
    let page;
    try {
      page = await deps.client.read(url);
    } catch (error) {
      const reason = error instanceof WebUnavailable ? error.reason : 'unavailable';
      log('web.failed', { tool: 'read_page', reason, latencyMs: Date.now() - started });
      return {
        error:
          reason === 'not_found'
            ? NOTHING_READABLE.error
            : reason === 'refused'
              ? 'that site does not let itself be read'
              : 'the page did not load: try once more or answer without it',
      };
    }
    if (isPuzzle(page.content) || givesAway(`${page.title}\n${decoded(page.content)}`, days)) {
      log('web.withheld', { tool: 'read_page', latencyMs: Date.now() - started });
      return NOTHING_READABLE;
    }
    for (const link of urlsIn(page.content)) note(link);
    log('web.read', { chars: page.content.length, truncated: page.truncated, latencyMs: Date.now() - started });
    return page;
  }

  return {
    definitions: DEFINITIONS,
    handles: (name) => NAMES.has(name),
    async run(name, args) {
      return name === 'web_search' ? search(args) : read(args);
    },
    saw(url) {
      const bare = linkKey(url, false);
      return bare !== null && shown.has(bare);
    },
    loaded: () => held,
  };
}
