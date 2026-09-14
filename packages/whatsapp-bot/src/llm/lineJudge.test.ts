import { describe, expect, it } from 'vitest';
import { createLog } from '../log';
import { LlmUnavailable, type LlmProvider } from './types';
import { chooseLine, parseVerdict } from './lineJudge';

const brief = { system: 'judge', occasion: '{}' };
const log = createLog('silent');
const judge = (answer: () => Promise<string>): LlmProvider => ({
  name: 'fake',
  model: 'fake',
  async generate() {
    return { text: await answer(), toolCalls: [], finish: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 };
  },
});

describe('the judge answers a digit, then its reason (2026-09-07)', () => {
  it('reads the digit first and keeps the words after it as the reason', () => {
    expect(parseVerdict('1: the placing is right')).toEqual({ verdict: 'keep', reason: 'the placing is right' });
    expect(parseVerdict('0 — Zou is ahead in the facts,\n  not behind')).toEqual({ verdict: 'drop', reason: 'Zou is ahead in the facts, not behind' });
    expect(parseVerdict('  0')).toEqual({ verdict: 'drop' });
    expect(parseVerdict('Verdict: 1.')).toEqual({ verdict: 'keep' });
    expect(parseVerdict('no idea')).toBeNull();
  });

  it('with no verdict at all, posts the first candidate or nothing, as the caller asked (2026-09-14)', async () => {
    const down = judge(async () => { throw new LlmUnavailable('503'); });
    expect(await chooseLine(down, brief, ['a', 'b'], log)).toEqual({ line: 'a', dropped: 0, reasons: [] });
    expect(await chooseLine(down, brief, ['a', 'b'], log, undefined, 'post-none')).toEqual({ line: null, dropped: 0, reasons: [] });
    // A refused ceiling is no verdict either.
    expect(await chooseLine(judge(async () => '1'), brief, ['a'], log, async () => false, 'post-none')).toEqual({ line: null, dropped: 0, reasons: [] });
    // A real drop is a drop under either setting.
    expect(await chooseLine(judge(async () => '0: wrong'), brief, ['a'], log, undefined, 'post-none')).toEqual({ line: null, dropped: 1, reasons: ['wrong'] });
  });
});
