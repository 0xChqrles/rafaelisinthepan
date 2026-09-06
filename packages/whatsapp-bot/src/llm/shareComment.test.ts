import { describe, expect, it, vi } from 'vitest';
import { parseGroupConfig } from '../config/groupConfig';
import { createLog } from '../log';
import { LlmUnavailable, type LlmProvider, type LlmResponse } from './types';
import { generateShareComment } from './shareComment';
import { LINE_RULES } from './podiumComments';

// The user turn is the FACTS as JSON, then the rules a line is checked against.
function sentIn(call: unknown) {
  const [facts, rules] = (call as { messages: { content: string }[] }).messages[0].content.split('\n');
  expect(rules).toMatch(/ Move [123]\.$/);
  expect(rules.startsWith(LINE_RULES)).toBe(true);
  return JSON.parse(facts);
}

const GROUP = '120363000000000001@g.us';
const group = parseGroupConfig('g.json', {
  id: GROUP,
  name: 'g',
  language: 'fr',
  enabled: true,
  timezone: 'Europe/Paris', podium: { enabled: true, time: '22:00' },
  chat: { enabled: true, prePrompt: 'On se chambre.' },
  acknowledge: 'say',
});
const facts = { mode: 'sentence' as const, player: 'Gab', score: 7, capped: false };

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
    const p = provider([{ text: '  **Propre**,\n honnête.  ' }]);
    expect(await generateShareComment(p.provider, group, facts, log)).toBe('Propre, honnête.');
    // The VERDICT is the bot's, from the same thresholds the emoji uses; the model dresses
    // it. THE SCORE ITSELF IS NOT SENT (v8): a number the model never saw is one it cannot
    // read back, and the verdict is the whole of what the line reacts to. And no field name
    // is a word the answer may borrow (an early draft called this `band` and produced "le
    // band a gagné").
    expect(sentIn(p.calls[0])).toEqual({ player: 'Gab', solved: true, verdict: 'strong' });
    // No thinking: a deliberated line ran past the timeout under the v8 voice, and an
    // undeliberated one takes about a second.
    expect((p.calls[0] as { effort: string }).effort).toBe('none');
    // The group's own voice reaches it.
    expect((p.calls[0] as { system: string }).system).toContain('On se chambre.');
  });

  it('sends no score for a capped run — there is none to comment on', async () => {
    const p = provider([{ text: 'Aïe.' }]);
    await generateShareComment(p.provider, group, { ...facts, capped: true }, log);
    expect(sentIn(p.calls[0])).toEqual({ player: 'Gab', solved: false, verdict: 'failed' });
  });

  it('retries an UNAVAILABLE model once, then gives the caller the emoji', async () => {
    const flaky = provider([new LlmUnavailable('503'), { text: 'Deuxième essai.' }]);
    expect(await generateShareComment(flaky.provider, group, facts, log)).toBe('Deuxième essai.');
    const dead = provider([new LlmUnavailable('503'), new LlmUnavailable('503'), new LlmUnavailable('503')]);
    expect(await generateShareComment(dead.provider, group, facts, log)).toBeNull();
    expect(dead.calls).toHaveLength(3);
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
      { text: 'Correct, et je le pense.', finish: 'stop' },
    ]);
    expect(await generateShareComment(p.provider, group, facts, log)).toBe('Correct, et je le pense.');
    const all = provider([
      { text: 'Gab, 7 ess', finish: 'length' },
      { text: 'Gab, 7 es', finish: 'length' },
      { text: 'Gab, 7 e', finish: 'length' },
    ]);
    expect(await generateShareComment(all.provider, group, facts, log)).toBeNull();
  });

  it('publishes ONLY a completion that finished — any other reason is a line the model did not mean', async () => {
    // `length` is not the only early stop: DeepSeek answers `insufficient_system_resource`
    // for an interrupted generation and `content_filter` for an omitted one, which the
    // provider folds into `other`. A short partial passes every text check, so the gate is
    // the reason itself: this call has no tools, and `stop` is the one reason that means
    // "said what it meant".
    for (const finish of ['other', 'tool_calls'] as const) {
      const p = provider([{ text: 'Propre, honnête.', finish }, { text: 'Propre, honnête.', finish }, { text: 'Propre, honnête.', finish }]);
      expect(await generateShareComment(p.provider, group, facts, log)).toBeNull();
      expect(p.calls).toHaveLength(3);
    }
    const recovered = provider([{ text: 'Propre, hon', finish: 'other' }, { text: 'Propre, honnête.', finish: 'stop' }]);
    expect(await generateShareComment(recovered.provider, group, facts, log)).toBe('Propre, honnête.');
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
      expect(sentIn(p.calls[0]).verdict).toBe(verdict);
    }
  });

  it('rejects an unusable line rather than posting it', async () => {
    // Long is the failure this register exists to avoid: a line that runs on is one that
    // started explaining itself.
    for (const text of [null, '', '   ', 'x'.repeat(91)]) {
      const p = provider([{ text }, { text }, { text }]);
      expect(await generateShareComment(p.provider, group, facts, log)).toBeNull();
    }
  });

  it('refuses a line that reads the score back, names them, or leans on a simile, and tries again (v8)', async () => {
    // The share the player posted already shows the score and the name; a line repeating
    // them is padding, and asked not to, a model with its thinking off complied about half
    // the time. A simile is the lyrical move the voice was asked to drop.
    for (const text of ['Sept coups, honnête.', 'Un 7 bien rangé.', 'Gab, je vais encadrer ça.', 'Tu es un tigre, Gab.', 'Rapide comme un tigre.']) {
      const p = provider([{ text }, { text: 'Je vais encadrer ça.' }]);
      expect(await generateShareComment(p.provider, group, facts, log)).toBe('Je vais encadrer ça.');
      expect(p.calls).toHaveLength(2);
    }
  });

  it('tells the model a WORD result by its own rules: found words, more is better, never the word', async () => {
    const p = provider([{ text: 'Le dictionnaire te doit des royalties.' }]);
    expect(await generateShareComment(p.provider, group, { mode: 'word', player: 'Gab', claims: 26 }, log)).toBe('Le dictionnaire te doit des royalties.');
    expect(sentIn(p.calls[0])).toEqual({ player: 'Gab', verdict: 'brilliant' });
    const system = (p.calls[0] as { system: string }).system;
    expect(system).toContain('WORD MODE');
    expect(system).toContain('MORE is better');
    expect(system).not.toContain('Three is the lowest');
  });
});
