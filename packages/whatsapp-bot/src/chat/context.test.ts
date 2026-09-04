import { describe, expect, it } from 'vitest';
import { withoutShareLinks } from '../domain/share';
import { RecentContext } from './context';

const GROUP = '120363000000000001@g.us';
const ORIGIN = 'https://whippin.ai';
const at = (minsAgo: number) => Date.now() - minsAgo * 60_000;

describe('the recent window (#236)', () => {
  it('carries ordinary chatter, so a later question can be answered from it', () => {
    // The case this exists for: the number is said to the GROUP, and asked about later.
    const context = new RecentContext();
    context.push(GROUP, { role: 'user', name: 'Gab', text: 'je pense au nombre 67', at: at(1) });
    context.push(GROUP, { role: 'user', name: 'Zou', text: 'ok', at: at(1) });
    expect(context.recent(GROUP).map((t) => t.text)).toEqual(['je pense au nombre 67', 'ok']);
  });

  it('holds 25 messages and forgets anything older than half an hour', () => {
    const context = new RecentContext();
    for (let i = 0; i < 30; i += 1) {
      context.push(GROUP, { role: 'user', name: 'Gab', text: `m${i}`, at: at(1) });
    }
    const kept = context.recent(GROUP);
    expect(kept).toHaveLength(25);
    expect(kept[0].text).toBe('m5'); // the oldest five fell off the end
    context.push(GROUP, { role: 'user', name: 'Zou', text: 'stale', at: at(31) });
    expect(context.recent(GROUP).map((t) => t.text)).not.toContain('stale');
  });

  it('keeps groups apart', () => {
    const context = new RecentContext();
    context.push(GROUP, { role: 'user', name: 'Gab', text: 'ici', at: at(1) });
    expect(context.recent('120363000000000002@g.us')).toEqual([]);
  });
});

describe('what a share message contributes (#236)', () => {
  it('strips the token whether the message was addressed to the bot or not', () => {
    // Both paths reach the provider: the ambient one when somebody later addresses the bot,
    // the addressed one immediately AND as the turn the agent records. A share carried by an
    // addressed message ("gg 7 essais <link> @bot qui mène ?") must not be the exception.
    const addressed = `gg 7 essais ${ORIGIN}/s/ZBXg-ISaks2-fA @WhippinBot qui mène ?`;
    const stripped = withoutShareLinks(addressed, ORIGIN);
    expect(stripped).toBe('gg 7 essais @WhippinBot qui mène ?');
    expect(stripped).not.toContain('ZBXg');
  });


  it('drops the token and keeps the words around it', () => {
    // A token is base64 noise no conversation can use; the sentence beside it is not.
    expect(withoutShareLinks(`gg 7 essais ${ORIGIN}/s/ZBXg-ISaks2-fA`, ORIGIN)).toBe('gg 7 essais');
    // A share-ONLY message leaves nothing, so it becomes no context at all — which is what
    // keeps "a score-only share never reaches the provider" true.
    expect(withoutShareLinks(`${ORIGIN}/s/ZBXg-ISaks2-fA`, ORIGIN)).toBe('');
    expect(withoutShareLinks(`a ${ORIGIN}/s/AAA et ${ORIGIN}/s/BBB b`, ORIGIN)).toBe('a et b');
    // Somebody else's link is somebody else's business, and stays as it was.
    expect(withoutShareLinks('https://example.com/s/AAA', ORIGIN)).toBe('https://example.com/s/AAA');
  });
});
