import { describe, expect, it, vi } from 'vitest';
import { parseGroupConfig } from '../config/groupConfig';
import { createLog } from '../log';
import {
  generatePodiumComments,
  parseCommentAnswer,
  podiumCommentLines,
  sanitizeComment,
} from './podiumComments';
import { LlmUnavailable, type LlmProvider, type LlmResponse } from './types';

const podium = {
  dayNumber: 20700,
  lines: [
    { position: 1, score: 3, players: [{ jid: 'a', name: 'Gab' }] },
    {
      position: 2,
      score: 4,
      players: [
        { jid: 'b', name: 'Delphine' },
        { jid: 'c', name: 'Zou' },
      ],
    },
  ],
  capped: [],
};
const group = parseGroupConfig('g.json', {
  id: '120363000000000001@g.us',
  name: 'g',
  language: 'fr',
  enabled: true,
  podium: { enabled: true, time: '22:00', timezone: 'Europe/Paris' },
  chat: { enabled: true, prePrompt: 'On se chambre.' },
});
const log = createLog('silent');

function answering(texts: (string | Error)[]): LlmProvider & { calls: number } {
  const provider = {
    name: 'fake',
    model: 'fake',
    calls: 0,
    async generate(): Promise<LlmResponse> {
      const next = texts[provider.calls];
      provider.calls += 1;
      if (next instanceof Error) throw next;
      return {
        text: next,
        toolCalls: [],
        finish: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
        latencyMs: 1,
      };
    },
  };
  return provider;
}

describe('podium comments are prose keyed to immutable lines (#236)', () => {
  it('hands the model ids, positions, scores and names — and reads back exactly those ids', () => {
    expect(podiumCommentLines(podium)).toEqual([
      { id: '3', position: 1, score: 3, names: ['Gab'] },
      { id: '4', position: 2, score: 4, names: ['Delphine', 'Zou'] },
    ]);
    const ok = parseCommentAnswer(
      JSON.stringify({ lines: [{ id: '3', comment: 'Brigade antidopage.' }, { id: 4, comment: 'Duo.' }] }),
      ['3', '4'],
    );
    expect([...ok!.entries()]).toEqual([
      ['3', 'Brigade antidopage.'],
      ['4', 'Duo.'],
    ]);
  });

  it.each([
    ['a missing line', { lines: [{ id: '3', comment: 'x' }] }],
    ['a duplicate line', { lines: [{ id: '3', comment: 'x' }, { id: '3', comment: 'y' }] }],
    ['an unknown id', { lines: [{ id: '3', comment: 'x' }, { id: '9', comment: 'y' }] }],
    ['an empty comment', { lines: [{ id: '3', comment: '' }, { id: '4', comment: 'y' }] }],
    ['an over-long comment', { lines: [{ id: '3', comment: 'x'.repeat(200) }, { id: '4', comment: 'y' }] }],
  ])('rejects the whole answer on %s', (_, answer) => {
    expect(parseCommentAnswer(JSON.stringify(answer), ['3', '4'])).toBeNull();
  });

  it('keeps comments plain text', () => {
    expect(sanitizeComment(' *La* _brigade_\nantidopage. ')).toBe('La brigade antidopage.');
    expect(sanitizeComment('"Quoted."')).toBe('Quoted.');
    expect(sanitizeComment(42)).toBeNull();
  });

  it('retries a malformed answer once, then ships the podium without comments', async () => {
    const provider = answering(['not json', 'still not json']);
    expect((await generatePodiumComments(provider, group, podium, log)).size).toBe(0);
    expect(provider.calls).toBe(2);
    const recovered = answering([
      'nope',
      JSON.stringify({ lines: [{ id: '3', comment: 'a' }, { id: '4', comment: 'b' }] }),
    ]);
    expect((await generatePodiumComments(recovered, group, podium, log)).get('4')).toBe('b');
  });

  it('an unavailable provider degrades to no comments; a bug stops after one call', async () => {
    const down = answering([new LlmUnavailable('503'), new LlmUnavailable('503')]);
    expect((await generatePodiumComments(down, group, podium, log)).size).toBe(0);
    expect(down.calls).toBe(2);
    const bug = answering([new Error('HTTP 401')]);
    expect((await generatePodiumComments(bug, group, podium, log)).size).toBe(0);
    expect(bug.calls).toBe(1);
    const empty = answering([]);
    const spy = vi.spyOn(empty, 'generate');
    await generatePodiumComments(empty, group, { ...podium, lines: [] }, log);
    expect(spy).not.toHaveBeenCalled();
  });
});
