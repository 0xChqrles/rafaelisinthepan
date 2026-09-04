import { describe, expect, it, vi } from 'vitest';
import { dayNumber } from '@whippin/shared';
import { parseGroupConfig } from '../config/groupConfig';
import { createLog } from '../log';
import { LlmUnavailable, type LlmProvider, type LlmResponse } from './types';
import { generateShareComment } from './shareComment';

const GROUP = '120363000000000001@g.us';
const DAY = dayNumber('2026-09-04');
const group = parseGroupConfig('g.json', {
  id: GROUP,
  name: 'g',
  language: 'fr',
  enabled: true,
  podium: { enabled: true, time: '22:00', timezone: 'Europe/Paris' },
  chat: { enabled: true, prePrompt: 'On se chambre.' },
  acknowledge: 'say',
});
const facts = { player: 'Gab', score: 7, capped: false, dayNumber: DAY };

function provider(steps: (Partial<LlmResponse> | Error)[]): { provider: LlmProvider; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    provider: {
      name: 'fake',
      model: 'fake',
      async generate(request) {
        calls.push(request);
        const step = steps[calls.length - 1] ?? { text: 'fin' };
        if (step instanceof Error) throw step;
        return { text: null, toolCalls: [], finish: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, ...step };
      },
    },
  };
}

const log = createLog('silent');

describe('the spoken acknowledgement of a share (#236)', () => {
  it('hands the model the FACTS and returns its line, cleaned', async () => {
    const p = provider([{ text: '  **Sept** coups,\n honnête.  ' }]);
    expect(await generateShareComment(p.provider, group, facts, log)).toBe('Sept coups, honnête.');
    // The numbers are given, never asked for: the model comments, it does not decide.
    const sent = JSON.parse((p.calls[0] as { messages: { content: string }[] }).messages[0].content);
    expect(sent).toEqual({ player: 'Gab', score: 7, capped: false, date: '2026-09-04' });
    // The group's own voice reaches it.
    expect((p.calls[0] as { system: string }).system).toContain('On se chambre.');
  });

  it('sends no score for a capped run — there is none to comment on', async () => {
    const p = provider([{ text: 'Aïe.' }]);
    await generateShareComment(p.provider, group, { ...facts, capped: true }, log);
    const sent = JSON.parse((p.calls[0] as { messages: { content: string }[] }).messages[0].content);
    expect(sent).toMatchObject({ capped: true, score: null });
  });

  it('retries an UNAVAILABLE model once, then gives the caller the emoji', async () => {
    const flaky = provider([new LlmUnavailable('503'), { text: 'Deuxième essai.' }]);
    expect(await generateShareComment(flaky.provider, group, facts, log)).toBe('Deuxième essai.');
    const dead = provider([new LlmUnavailable('503'), new LlmUnavailable('503')]);
    expect(await generateShareComment(dead.provider, group, facts, log)).toBeNull();
    expect(dead.calls).toHaveLength(2);
  });

  it('does not retry a non-availability failure — it would only recur', async () => {
    const p = provider([new Error('bad request')]);
    expect(await generateShareComment(p.provider, group, facts, log)).toBeNull();
    expect(p.calls).toHaveLength(1);
  });

  it('refuses a TRUNCATED answer, however short the fragment reads', async () => {
    // The budget is shared with the reasoning tokens, so running out returns a fragment —
    // and a short fragment passes every length check. "Gab, 7 ess" was a real one.
    const p = provider([
      { text: 'Gab, 7 ess', finish: 'length' },
      { text: 'Sept coups pour Gab, correct.', finish: 'stop' },
    ]);
    expect(await generateShareComment(p.provider, group, facts, log)).toBe('Sept coups pour Gab, correct.');
    const both = provider([
      { text: 'Gab, 7 ess', finish: 'length' },
      { text: 'Gab, 7 es', finish: 'length' },
    ]);
    expect(await generateShareComment(both.provider, group, facts, log)).toBeNull();
  });

  it('rejects an unusable line rather than posting it', async () => {
    for (const text of [null, '', '   ', 'x'.repeat(141)]) {
      const p = provider([{ text }, { text }]);
      expect(await generateShareComment(p.provider, group, facts, log)).toBeNull();
    }
  });
});
