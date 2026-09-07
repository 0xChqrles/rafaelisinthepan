import { describe, expect, it } from 'vitest';
import { parseVerdict } from './lineJudge';

describe('the judge answers a digit, then its reason (2026-09-07)', () => {
  it('reads the digit first and keeps the words after it as the reason', () => {
    expect(parseVerdict('1: the placing is right')).toEqual({ verdict: 'keep', reason: 'the placing is right' });
    expect(parseVerdict('0 — Zou is ahead in the facts,\n  not behind')).toEqual({ verdict: 'drop', reason: 'Zou is ahead in the facts, not behind' });
    expect(parseVerdict('  0')).toEqual({ verdict: 'drop' });
    expect(parseVerdict('Verdict: 1.')).toEqual({ verdict: 'keep' });
    expect(parseVerdict('no idea')).toBeNull();
  });
});
