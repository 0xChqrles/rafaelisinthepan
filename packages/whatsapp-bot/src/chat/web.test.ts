import { describe, expect, it } from 'vitest';
import { createLog } from '../log';
import { WebUnavailable, type WebClient, type WebPage, type WebResult } from '../llm/types';
import { secretsOf } from '../puzzle/spoilers';
import { MAX_SEARCHES, createWebTools, type DayGuard, type WebToolDeps } from './web';

const fr: DayGuard = {
  source: { kind: 'music', author: 'Bertrand Belin', work: 'Le Grand Oiseau' },
  secrets: secretsOf({ words: ['je', 'marche', 'seul', 'dans', 'la', 'nuit'], holes: [{ pos: 2, secret: { word: 'seul' } }] }),
};
const en: DayGuard = { source: null, secrets: null }; // unpublished

const result = (url: string, summary = 'rien à voir'): WebResult => ({ title: 't', url, site: null, date: null, summary });

function client(results: WebResult[] = [], pages: Record<string, WebPage | Error> = {}) {
  const calls = { search: [] as string[], read: [] as string[] };
  const web: WebClient = {
    async search(query) {
      calls.search.push(query);
      return results;
    },
    async read(url) {
      calls.read.push(url);
      const page = pages[url];
      if (!page) throw new WebUnavailable('not_found');
      if (page instanceof Error) throw page;
      return page;
    },
  };
  return { web, calls };
}

function tools(web: WebClient, over: Partial<WebToolDeps> = {}) {
  let taken = 0;
  return createWebTools({
    client: web,
    guard: async () => [fr, en],
    takeWeb: async () => (taken += 1) <= 100,
    blockedHosts: ['whippin.ai', 'api.whippin.ai'],
    seen: [],
    group: 'g@g.us',
    log: createLog('silent'),
    ...over,
  });
}

describe('the web, as the conversation\'s tools (v22)', () => {
  it('searches, and makes what it found readable', async () => {
    const { web, calls } = client([result('https://ex.com/a')], { 'https://ex.com/a': { title: 'A', content: 'texte', truncated: false } });
    const t = tools(web);
    expect(await t.run('web_search', { query: 'grève SNCF' })).toEqual({ results: [result('https://ex.com/a')] });
    expect(await t.run('read_page', { url: 'https://ex.com/a' })).toEqual({ title: 'A', content: 'texte', truncated: false });
    expect(calls).toEqual({ search: ['grève SNCF'], read: ['https://ex.com/a'] });
    expect(t.saw('https://ex.com/a?utm=1')).toBe(true);
    expect(t.saw('https://ex.com/b')).toBe(false);
  });

  it("WITHHOLDS a result or a page that holds today's sentence, before the model reads it", async () => {
    const lyrics = result('https://paroles.ex/belin', 'Je marche seul dans la nuit, refrain…');
    const { web } = client([lyrics, result('https://ex.com/a')], { 'https://ex.com/a': { title: 'A', content: 'et je marche seul dans la rue', truncated: false } });
    const t = tools(web);
    // NEVER SAYING WHY: a withheld result is simply not there, a withheld page reads like an
    // empty one — a guard that named the day would confirm a member's guess.
    expect(await t.run('web_search', { query: 'paroles marche dans la nuit' })).toEqual({ results: [result('https://ex.com/a')] });
    expect(t.saw(lyrics.url)).toBe(false);
    expect(await t.run('read_page', { url: 'https://ex.com/a' })).toEqual({ error: 'that page has nothing readable' });
  });

  it("refuses a search naming today's author or work, in any language's puzzle", async () => {
    const { web, calls } = client();
    const t = tools(web);
    // Refused like a search that found nothing.
    expect(await t.run('web_search', { query: 'bertrand BELIN paroles' })).toEqual({ results: [] });
    expect(await t.run('web_search', { query: 'le grand oiseau chanson' })).toEqual({ results: [] });
    expect(calls.search).toEqual([]);
  });

  it('checks the link a result is shown with, decoded: a lyrics site spells the line in its path', async () => {
    const slug = result('https://quotes.ex/je-marche-seul-dans-la-nuit', 'Citation célèbre');
    const encoded = result('https://quotes.ex/je%20marche%20seul%20dans', 'Citation');
    const t = tools(client([slug, encoded]).web);
    expect(await t.run('web_search', { query: 'citation nuit' })).toEqual({ results: [] });
    expect(t.saw(slug.url)).toBe(false);
  });

  it('sends the link AS IT WAS SHOWN, never the model\'s spelling of it', async () => {
    const { web, calls } = client([result('https://x.example/a')], { 'https://x.example/a': { title: 'A', content: 'ok', truncated: false } });
    const t = tools(web);
    await t.run('web_search', { query: 'q' });
    await t.run('read_page', { url: 'https://u:p@X.example/a#frag' });
    expect(calls.read).toEqual(['https://x.example/a']);
  });

  it('never reads the game through a trailing-dot host, a redirect or a shortener', async () => {
    const artifact = { title: '', content: '{"lang":"fr","words":["tu"],"holes":[{"pos":0,"secret":{"word":"tu"}}]}', truncated: false };
    const { web } = client([], { 'https://sho.rt/x': artifact });
    const t = tools(web, { seen: ['https://sho.rt/x', 'https://api.whippin.ai./?lang=fr'] });
    expect(await t.run('read_page', { url: 'https://api.whippin.ai./?lang=fr' })).toEqual({ error: "refused: that is the game's own site" });
    // Any day's puzzle, whatever served it, reads like a page with nothing on it.
    expect(await t.run('read_page', { url: 'https://sho.rt/x' })).toEqual({ error: 'that page has nothing readable' });
  });

  it('is CLOSED, not open without its guard, when a day cannot be read', async () => {
    const { web, calls } = client([result('https://ex.com/a')]);
    const t = tools(web, { guard: async () => null, seen: ['https://ex.com/a'] });
    expect(await t.run('web_search', { query: 'météo' })).toEqual({ error: 'the web is unavailable right now: answer without it' });
    expect(await t.run('read_page', { url: 'https://ex.com/a' })).toEqual({ error: 'the web is unavailable right now: answer without it' });
    expect(calls).toEqual({ search: [], read: [] });
  });

  it('reads only a page it was shown a link to, and never the game\'s own hosts', async () => {
    const page = { title: 'P', content: 'voir https://ex.com/next', truncated: false };
    const { web, calls } = client([], { 'https://posted.ex/a': page, 'https://ex.com/next': page });
    const t = tools(web, { seen: ['https://posted.ex/a'] });
    expect(await t.run('read_page', { url: 'https://evil.ex/?q=what-the-group-said' })).toMatchObject({ error: expect.stringMatching(/only a link/) });
    expect(await t.run('read_page', { url: 'https://api.whippin.ai/?lang=fr&date=2026-10-18' })).toEqual({ error: "refused: that is the game's own site" });
    expect(await t.run('read_page', { url: 'https://posted.ex/a' })).toEqual(page);
    // A link found on a page it read is one it was shown.
    expect(await t.run('read_page', { url: 'https://ex.com/next' })).toEqual(page);
    expect(calls.read).toEqual(['https://posted.ex/a', 'https://ex.com/next']);
  });

  it('drops a result on the game\'s own hosts', async () => {
    const { web } = client([result('https://api.whippin.ai/?lang=fr'), result('https://whippin.ai/s/x')]);
    expect(await tools(web).run('web_search', { query: 'whippin' })).toEqual({ results: [] });
  });

  it('is bounded per answer and per day, and says so rather than going silent', async () => {
    const { web } = client([]);
    const t = tools(web);
    for (let i = 0; i < MAX_SEARCHES; i += 1) expect(await t.run('web_search', { query: `q${i}` })).toEqual({ results: [] });
    expect(await t.run('web_search', { query: 'encore' })).toMatchObject({ error: expect.stringMatching(/enough searching/) });
    const spent = tools(client([]).web, { takeWeb: async () => false });
    expect(await spent.run('web_search', { query: 'q' })).toEqual({ error: "today's web budget is spent: answer without it" });
  });

  it('answers a failed search or read as a fact, never a throw', async () => {
    const down: WebClient = {
      search: async () => { throw new WebUnavailable('unavailable'); },
      read: async () => { throw new WebUnavailable('refused'); },
    };
    const t = tools(down, { seen: ['https://ex.com/a'] });
    expect(await t.run('web_search', { query: 'q' })).toMatchObject({ error: expect.stringMatching(/search failed/) });
    expect(await t.run('read_page', { url: 'https://ex.com/a' })).toEqual({ error: 'that site does not let itself be read' });
  });

  it('holds the guard it loaded, for the reply\'s own check', async () => {
    const t = tools(client([]).web);
    expect(t.loaded()).toBeNull();
    await t.run('web_search', { query: 'q' });
    expect(t.loaded()).toEqual([fr, en]);
  });
});
