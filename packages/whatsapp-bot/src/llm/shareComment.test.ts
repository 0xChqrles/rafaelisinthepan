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
    // The VERDICT is the bot's, from the same thresholds the emoji uses; the model dresses
    // it. And no field name is a word the answer may borrow (an early draft called this
    // `band` and produced "le band a gagné").
    expect(sent).toEqual({ player: 'Gab', tries: 7, solved: true, verdict: 'strong' });
    // The group's own voice reaches it.
    expect((p.calls[0] as { system: string }).system).toContain('On se chambre.');
  });

  it('sends no score for a capped run — there is none to comment on', async () => {
    const p = provider([{ text: 'Aïe.' }]);
    await generateShareComment(p.provider, group, { ...facts, capped: true }, log);
    const sent = JSON.parse((p.calls[0] as { messages: { content: string }[] }).messages[0].content);
    expect(sent).toMatchObject({ tries: null, solved: false, verdict: 'failed' });
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

  it('publishes ONLY a completion that finished — any other reason is a line the model did not mean', async () => {
    // `length` is not the only early stop: DeepSeek answers `insufficient_system_resource`
    // for an interrupted generation and `content_filter` for an omitted one, which the
    // provider folds into `other`. A short partial passes every text check, so the gate is
    // the reason itself: this call has no tools, and `stop` is the one reason that means
    // "said what it meant".
    for (const finish of ['other', 'tool_calls'] as const) {
      const p = provider([{ text: 'Sept coups, honnête.', finish }, { text: 'Sept coups, honnête.', finish }]);
      expect(await generateShareComment(p.provider, group, facts, log)).toBeNull();
      expect(p.calls).toHaveLength(2);
    }
    const recovered = provider([{ text: 'Sept coups, hon', finish: 'other' }, { text: 'Sept coups, honnête.', finish: 'stop' }]);
    expect(await generateShareComment(recovered.provider, group, facts, log)).toBe('Sept coups, honnête.');
  });

  it('carries the verdict for every band, so the model never has to calibrate', async () => {
    // Told only a number the model cannot know whether 7 is good, and answers the same flat
    // line to a 3, a 7 and a 42 — measured against the real provider.
    // Three is the FLOOR — a sentence hides three words — so it is the only perfect score,
    // and "under ten is really good" spans brilliant and strong.
    for (const [score, capped, verdict] of [
      [3, false, 'perfect'], [4, false, 'brilliant'], [6, false, 'brilliant'],
      [7, false, 'strong'], [9, false, 'strong'], [10, false, 'ordinary'],
      [19, false, 'ordinary'], [20, false, 'laboured'], [0, true, 'failed'],
    ] as const) {
      const p = provider([{ text: 'ok.' }]);
      await generateShareComment(p.provider, group, { ...facts, score, capped }, log);
      const sent = JSON.parse((p.calls[0] as { messages: { content: string }[] }).messages[0].content);
      expect(sent.verdict).toBe(verdict);
    }
  });

  it('rejects an unusable line rather than posting it', async () => {
    // Long is the failure this register exists to avoid: a line that runs on is one that
    // started explaining itself.
    for (const text of [null, '', '   ', 'x'.repeat(91)]) {
      const p = provider([{ text }, { text }]);
      expect(await generateShareComment(p.provider, group, facts, log)).toBeNull();
    }
  });
});
