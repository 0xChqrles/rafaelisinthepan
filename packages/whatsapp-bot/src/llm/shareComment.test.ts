import { describe, expect, it } from 'vitest';
import { parseGroupConfig } from '../config/groupConfig';
import { createLog } from '../log';
import { memoryDeclarationStore, type Declaration } from '../domain/declarations';
import { LlmUnavailable, type LlmProvider, type LlmResponse } from './types';
import { COMMENTARY_MAX_CHARS, generateShareComment } from './shareComment';
import { FACT_JUDGE_SYSTEM } from './lineJudge';

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
const DAY = 20700;
const facts = { mode: 'sentence' as const, player: 'Gab', score: 7, capped: false };
const log = createLog('silent');

function row(day: number, sender: string, score: number, capped = false): Declaration {
  return {
    group: GROUP, dayNumber: day, sender, score, capped, token: `t-${day}-${sender}`, messageId: `m-${day}-${sender}`,
    messageTs: 1, name: sender, receivedAt: '2026-09-07T10:00:00.000Z', lang: 'fr',
  };
}
// Gab's 7 today behind Zou's 5; yesterday Gab did 12 and Zou 9.
async function store(rows: Declaration[] = [row(DAY, 'Zou', 5), row(DAY, 'Gab', 7), row(DAY - 1, 'Gab', 12), row(DAY - 1, 'Zou', 9)]) {
  const s = memoryDeclarationStore();
  for (const r of rows) await s.record(r);
  return s;
}
const depsFor = (declarations: Awaited<ReturnType<typeof store>>, sender = 'Gab') => ({ declarations, dayNumber: DAY, sender });

// Writer calls consume `steps` in call order (a step past the end is a usable line); a
// JUDGE call — told apart by its own system prompt — is answered by `judge`, default keep.
function provider(
  steps: (Partial<LlmResponse> | Error)[],
  judge: (line: string) => Partial<LlmResponse> | Error = () => ({ text: '1' }),
) {
  const calls: { system: string; messages: { content: string }[]; effort?: string }[] = [];
  const judged: string[] = [];
  let writes = 0;
  const p: LlmProvider = {
    name: 'fake',
    model: 'fake',
    async generate(request) {
      calls.push(request as (typeof calls)[number]);
      let step: Partial<LlmResponse> | Error;
      if (request.system === FACT_JUDGE_SYSTEM) {
        judged.push(/\nLine: (.*)\n/.exec(request.messages[0].content as string)?.[1] ?? '');
        step = judge(judged[judged.length - 1]);
      } else {
        step = steps[writes] ?? { text: 'Cinq pour Zou, sept pour toi.' };
        writes += 1;
      }
      if (step instanceof Error) throw step;
      return { text: null, toolCalls: [], finish: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, ...step };
    },
  };
  return { provider: p, calls, judged, written: () => calls.filter((c) => c.system !== FACT_JUDGE_SYSTEM) };
}

describe('the spoken acknowledgement of a share is commentary from the numbers (user-decided 2026-09-07)', () => {
  it('hands the model the FACTS of the day and the habit, reasons, and returns the line cleaned', async () => {
    const p = provider([{ text: '  **Sept**,\n derrière Zou.  ' }]);
    expect(await generateShareComment(p.provider, group, facts, depsFor(await store()), log)).toBe('Sept, derrière Zou.');
    // The user turn is the facts as JSON — the exact score, the board with this share
    // placed, who is ahead, the habit — and no band word anywhere.
    const sent = JSON.parse(p.written()[0].messages[0].content);
    expect(sent.score).toBe(7);
    expect(sent.today).toMatchObject({ postedSoFar: 2, firstOfDay: false, position: 2, ahead: ['Zou'], behind: [] });
    expect(sent.habit).toMatchObject({ daysPlayed: 1, averageScore: 12, averagePosition: 2 });
    expect(sent.others[0]).toMatchObject({ name: 'Zou', averageScore: 9 });
    expect(JSON.stringify(sent)).not.toMatch(/strong|brilliant|verdict/);
    // The writer phrases the facts with its thinking off; the judge reasons over them.
    expect(p.written()[0].effort).toBe('none');
    expect(p.written()[0].system).toContain('On se chambre.');
    const judgeCall = p.calls.find((c) => c.system === FACT_JUDGE_SYSTEM)!;
    expect(judgeCall.messages[0].content).toContain('"score":7');
  });

  it('the emoji stands in when the facts cannot be read, or the share is not on the board', async () => {
    const broken = await store();
    broken.day = async () => { throw new Error('dynamo down'); };
    const p = provider([]);
    expect(await generateShareComment(p.provider, group, facts, depsFor(broken), log)).toBeNull();
    expect(p.calls).toHaveLength(0); // no facts, no words
    const stranger = provider([]);
    expect(await generateShareComment(stranger.provider, group, facts, depsFor(await store(), 'Nobody'), log)).toBeNull();
    expect(stranger.calls).toHaveLength(0);
  });

  it('writes every candidate at once; a failed or unfinished one is dropped and the others stand', async () => {
    const flaky = provider([new LlmUnavailable('503'), { text: 'Sept, derrière Zou.' }]);
    expect(await generateShareComment(flaky.provider, group, facts, depsFor(await store()), log)).toBe('Sept, derrière Zou.');
    const dead = provider([new LlmUnavailable('503'), new LlmUnavailable('503'), new LlmUnavailable('503')]);
    expect(await generateShareComment(dead.provider, group, facts, depsFor(await store()), log)).toBeNull();
    expect(dead.calls).toHaveLength(3); // and nothing reached the judge
    // A truncated or interrupted answer is a fragment, refused on the reason.
    const cut = provider([{ text: 'Sept, derr', finish: 'length' }, { text: 'Sept, derr', finish: 'other' }, { text: 'Sept, derrière Zou.' }]);
    expect(await generateShareComment(cut.provider, group, facts, depsFor(await store()), log)).toBe('Sept, derrière Zou.');
    // Too long is a paragraph, not a bubble.
    const long = provider([{ text: 'x'.repeat(COMMENTARY_MAX_CHARS + 1) }, { text: 'x'.repeat(COMMENTARY_MAX_CHARS + 1) }, { text: 'x'.repeat(COMMENTARY_MAX_CHARS + 1) }]);
    expect(await generateShareComment(long.provider, group, facts, depsFor(await store()), log)).toBeNull();
  });

  it('THE JUDGE reads each line against the facts: the first kept is posted, none kept is the emoji, no verdict posts the first', async () => {
    const picky = provider([{ text: 'Zou est derrière toi.' }, { text: 'Sept, derrière Zou.' }], (line) => ({ text: line === 'Sept, derrière Zou.' ? '1' : '0' }));
    expect(await generateShareComment(picky.provider, group, facts, depsFor(await store()), log)).toBe('Sept, derrière Zou.');
    expect(picky.judged).toHaveLength(3);
    const strict = provider([{ text: 'Zou est derrière toi.' }], () => ({ text: '0' }));
    expect(await generateShareComment(strict.provider, group, facts, depsFor(await store()), log)).toBeNull();
    const down = provider([{ text: 'Sept, derrière Zou.' }], () => new LlmUnavailable('503'));
    expect(await generateShareComment(down.provider, group, facts, depsFor(await store()), log)).toBe('Sept, derrière Zou.');
  });

  it('spends the daily ceiling per call — candidates and verdicts — and none at all is the emoji', async () => {
    let units = 0;
    const metered = provider([{ text: 'Sept, derrière Zou.' }]);
    expect(await generateShareComment(metered.provider, group, facts, depsFor(await store()), log, async () => (units += 1) <= 1)).toBe('Sept, derrière Zou.');
    expect(metered.written()).toHaveLength(1);
    const closed = provider([{ text: 'Sept, derrière Zou.' }]);
    expect(await generateShareComment(closed.provider, group, facts, depsFor(await store()), log, async () => false)).toBeNull();
    expect(closed.calls).toHaveLength(0);
  });

  it('tells the model a WORD result by its own rules, from the claims alone — nothing is recorded to read', async () => {
    const p = provider([{ text: 'Vingt-six, joli.' }]);
    const s = await store();
    s.day = async () => { throw new Error('must not be read'); };
    expect(await generateShareComment(p.provider, group, { mode: 'word', player: 'Gab', claims: 26 }, depsFor(s), log)).toBe('Vingt-six, joli.');
    expect(JSON.parse(p.written()[0].messages[0].content)).toEqual({ player: 'Gab', found: 26 });
    expect(p.written()[0].system).toContain('WORD MODE');
    expect(p.written()[0].system).toContain('MORE is better');
  });
});
