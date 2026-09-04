import { describe, expect, it, vi } from 'vitest';
import { parseGroupConfig } from '../config/groupConfig';
import { createLog } from '../log';
import {
  generatePodiumComments,
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

type Answer = string | Error | { text: string | null; finish: 'stop' | 'length' };

// Answers BY LINE, never by call order: the lines are generated in parallel, so which
// request arrives second is the scheduler's business and not a thing to assert against.
function answering(byPlace: Record<number, Answer[]>): LlmProvider & {
  calls: number;
  requests: { messages: { content: string }[] }[];
} {
  const used: Record<number, number> = {};
  const provider = {
    name: 'fake',
    model: 'fake',
    calls: 0,
    requests: [] as { messages: { content: string }[] }[],
    async generate(request: { messages: { content: string }[] }): Promise<LlmResponse> {
      provider.calls += 1;
      provider.requests.push(request);
      const place = JSON.parse(request.messages[0].content).place as number;
      const n = (used[place] ??= 0);
      used[place] += 1;
      const next = (byPlace[place] ?? [])[n];
      if (next instanceof Error) throw next;
      const shaped = typeof next === 'object' && next !== null ? next : { text: next ?? '', finish: 'stop' as const };
      return {
        text: shaped.text,
        toolCalls: [],
        finish: shaped.finish,
        usage: { inputTokens: 0, outputTokens: 0 },
        latencyMs: 1,
      };
    },
  };
  return provider as unknown as LlmProvider & { calls: number; requests: { messages: { content: string }[] }[] };
}

describe('podium comments are prose keyed to immutable lines (#236)', () => {
  it('hands the model one line at a time, and never the id it keys the answer by', async () => {
    expect(podiumCommentLines(podium)).toEqual([
      { id: '3', position: 1, score: 3, names: ['Gab'] },
      { id: '4', position: 2, score: 4, names: ['Delphine', 'Zou'] },
    ]);
    const provider = answering({ 1: ['Brigade antidopage.'], 2: ['Duo.'] });
    const comments = await generatePodiumComments(provider, group, podium, log);
    // One call per line, and the comments come back keyed to their own lines.
    expect(provider.calls).toBe(2);
    expect(comments.get('3')).toBe('Brigade antidopage.');
    expect(comments.get('4')).toBe('Duo.');
    // Each call carries only ITS line, plus how many there were — never the whole podium,
    // and never an `id` the model could echo back as prose.
    const sent = JSON.parse(provider.requests[0].messages[0].content as string);
    expect(sent).toEqual({ place: 1, tries: 3, who: ['Gab'], outOf: 2 });
  });

  it('keeps comments plain text', () => {
    expect(sanitizeComment(' *La* _brigade_\n antidopage. ')).toBe('La brigade antidopage.');
    expect(sanitizeComment('"Quoted."')).toBe('Quoted.');
    expect(sanitizeComment(42)).toBeNull();
  });

  it('A LINE THAT FAILS NO LONGER TAKES THE OTHERS WITH IT', async () => {
    // The whole reason for one call per line: the renderer prints a podium line with no
    // comment, so a partial set is a partial podium rather than a bare one.
    const provider = answering({ 1: ['', ''], 2: ['La deuxième tient.'] });
    const comments = await generatePodiumComments(provider, group, podium, log);
    expect(comments.has('3')).toBe(false); // both attempts unusable, given up on
    expect(comments.get('4')).toBe('La deuxième tient.');
  });

  it('refuses a TRUNCATED answer however short the fragment reads', async () => {
    // The budget is shared with this model's reasoning, so running out returns a fragment.
    const provider = answering({
      1: [{ text: 'Brigade anti', finish: 'length' }, { text: 'Brigade antidopage.', finish: 'stop' }],
      2: [{ text: 'Duo.', finish: 'stop' }],
    });
    const comments = await generatePodiumComments(provider, group, podium, log);
    expect(comments.get('3')).toBe('Brigade antidopage.');
  });

  it('retries an unusable answer once per line, then leaves that line bare', async () => {
    const provider = answering({ 1: ['', ''], 2: ['', ''] });
    expect((await generatePodiumComments(provider, group, podium, log)).size).toBe(0);
    expect(provider.calls).toBe(4); // two lines, two attempts each
  });

  it('an unavailable provider degrades to no comments; a bug stops after one call per line', async () => {
    const err = () => new LlmUnavailable('503');
    const down = answering({ 1: [err(), err()], 2: [err(), err()] });
    expect((await generatePodiumComments(down, group, podium, log)).size).toBe(0);
    expect(down.calls).toBe(4);
    const bug = answering({ 1: [new Error('HTTP 401')], 2: [new Error('HTTP 401')] });
    expect((await generatePodiumComments(bug, group, podium, log)).size).toBe(0);
    expect(bug.calls).toBe(2); // one per line, not retried
    const empty = answering({});
    const spy = vi.spyOn(empty, 'generate');
    await generatePodiumComments(empty, group, { ...podium, lines: [] }, log);
    expect(spy).not.toHaveBeenCalled();
  });
});
