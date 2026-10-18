import { describe, expect, it, vi } from 'vitest';
import { WebUnavailable } from '../types';
import { PAGE_MAX_CHARS, SUMMARY_MAX_CHARS, cleanPage, deepSeekWeb, resultDate } from './deepseekWeb';

function fetchReturning(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}
const sentBody = (f: typeof fetch) => {
  const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) };
};

describe("DeepSeek's Search and Fetch APIs (v22)", () => {
  it('searches on the key, bounded, and maps the results', async () => {
    const f = fetchReturning(200, {
      results: [
        { title: ' T ', url: 'https://ex.com/a', site_name: 'Ex', date: '2026-10-16T16:00:00+00:00', summary: 'x'.repeat(4000), snippet: 's' },
        { title: 'no link', url: 'javascript:alert(1)' },
        { title: 'snippet only', url: 'https://ex.com/b', snippet: 'court', date: null },
      ],
    });
    const found = await deepSeekWeb({ apiKey: 'k', fetch: f }).search(`  ${'é'.repeat(200)}  `);
    const { url, init, body } = sentBody(f);
    expect(url).toBe('https://api.deepseek.com/v1/tools/search');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(Array.from(body.query as string)).toHaveLength(128);
    expect(body).toMatchObject({ count: 6, need_content: false });
    expect(body.ori_question).toBeUndefined(); // the member's own words never go
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ title: 'T', url: 'https://ex.com/a', site: 'Ex', date: '2026-10-17' });
    expect(found[0].summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(found[1]).toEqual({ title: 'snippet only', url: 'https://ex.com/b', site: null, date: null, summary: 'court' });
  });

  it('reads a page as clean, bounded text', async () => {
    const f = fetchReturning(200, { title: 'Titre', content: `Le 17\\. octobre \\- grève ![img](https://x/i.png)\n\n\n\nfin${'x'.repeat(PAGE_MAX_CHARS)}` });
    const page = await deepSeekWeb({ apiKey: 'k', fetch: f }).read('https://ex.com/a');
    expect(sentBody(f)).toMatchObject({ url: 'https://api.deepseek.com/v1/tools/fetch', body: { url: 'https://ex.com/a' } });
    expect(page.title).toBe('Titre');
    expect(page.content.startsWith('Le 17. octobre - grève\n\nfin')).toBe(true);
    expect(page.content.length).toBeLessThanOrEqual(PAGE_MAX_CHARS);
    expect(page.truncated).toBe(true);
  });

  it('answers every failure as WebUnavailable with its reason, and never names the query or URL', async () => {
    const reason = async (status: number, call: 'search' | 'read') => {
      const web = deepSeekWeb({ apiKey: 'k', fetch: fetchReturning(status, { error: {} }) });
      const failure = await (call === 'search' ? web.search('secret query') : web.read('https://secret.url')).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(WebUnavailable);
      expect((failure as Error).message).not.toMatch(/secret/);
      return (failure as WebUnavailable).reason;
    };
    expect(await reason(403, 'read')).toBe('refused');
    expect(await reason(404, 'read')).toBe('not_found');
    expect(await reason(402, 'search')).toBe('unavailable');
    expect(await reason(429, 'search')).toBe('unavailable');
    expect(await reason(504, 'read')).toBe('unavailable');
    const hung = deepSeekWeb({ apiKey: 'k', fetch: vi.fn(async () => { throw new DOMException('t', 'TimeoutError'); }) as unknown as typeof fetch });
    expect(await hung.search('q').catch((e: unknown) => (e as WebUnavailable).reason)).toBe('unavailable');
    const empty = deepSeekWeb({ apiKey: 'k', fetch: fetchReturning(200, { title: 'x', content: '' }) });
    expect(await empty.read('https://ex.com').catch((e: unknown) => (e as WebUnavailable).reason)).toBe('not_found');
    expect(await deepSeekWeb({ apiKey: 'k', fetch: fetchReturning(200, {}) }).search('   ').catch((e: unknown) => (e as WebUnavailable).reason)).toBe('refused');
  });

  it("reads the engine's day-level stamps as the Beijing day they mean", () => {
    expect(resultDate('2026-10-16T16:00:00+00:00')).toBe('2026-10-17');
    expect(resultDate(null)).toBeNull();
    expect(resultDate('soon')).toBeNull();
    expect(cleanPage('a\\_b \\#1 \\(x\\)')).toBe('a_b #1 (x)');
  });
});
