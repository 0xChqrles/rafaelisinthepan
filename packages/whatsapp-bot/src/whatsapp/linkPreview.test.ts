import type { WAUrlInfo } from 'baileys';
import { describe, expect, it } from 'vitest';
import type { Log } from '../log';
import { buildLinkPreview, type LinkPreviewDeps } from './linkPreview';

const URL = 'https://whippin.ai/g/abcdefghij234567?v=20711';
const INFO: WAUrlInfo = { 'canonical-url': URL, 'matched-text': URL, title: 'Whippin AI — le_groupe' };

function deps(build: NonNullable<LinkPreviewDeps['build']>, budgetMs?: number) {
  const lines: Record<string, unknown>[] = [];
  const write = (entry: Record<string, unknown>) => void lines.push(entry);
  const upload = (async () => ({ mediaUrl: '', directPath: '' })) as unknown as LinkPreviewDeps['upload'];
  return { lines, upload, deps: { upload, build, budgetMs, log: { info: write, warn: write } as unknown as Log } };
}

describe('the preview card, waited for (user-decided 2026-09-14)', () => {
  it('builds the card for the named link, as a full-size upload, with room for a slow render', async () => {
    const asked: unknown[] = [];
    const { upload, deps: d } = deps(async (...args) => (asked.push(args), INFO));
    expect(await buildLinkPreview(URL, d)).toBe(INFO);
    const [url, opts] = asked[0] as [string, { uploadImage: unknown; fetchOpts: { timeout: number } }];
    expect(url).toBe(URL);
    expect(opts.uploadImage).toBe(upload);
    expect(opts.fetchOpts.timeout).toBeGreaterThan(3_000); // Baileys' default; a cold card render takes 2.3s
  });

  it('costs the card and never the message: a page with no title, a failure, a build that hangs', async () => {
    expect(await buildLinkPreview(URL, deps(async () => undefined).deps)).toBeNull();
    const failing = deps(async () => {
      throw new Error(`Failed to fetch stream from ${URL}`);
    });
    expect(await buildLinkPreview(URL, failing.deps)).toBeNull();
    // An invite link is a way into a group: the error is logged without it.
    expect(JSON.stringify(failing.lines)).not.toContain('abcdefghij234567');
    const hanging = deps(() => new Promise<never>(() => {}), 20);
    expect(await buildLinkPreview(URL, hanging.deps)).toBeNull();
    expect(hanging.lines[0]).toMatchObject({ event: 'outbound.preview_timeout' });
  });
});
