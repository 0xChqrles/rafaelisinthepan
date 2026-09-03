import { describe, expect, it } from 'vitest';
import { DEFAULT_DAILY_CALL_CEILING, loadEnv } from './env';

const base = { BOT_TABLE: 'bot' };

describe('runtime env (#236)', () => {
  it('reads the daily call ceiling, and treats an EMPTY value as unset', () => {
    expect(loadEnv({ ...base, BOT_LLM_DAILY_CALL_CEILING: '42' }).llm.dailyCallCeiling).toBe(42);
    expect(loadEnv(base).llm.dailyCallCeiling).toBe(DEFAULT_DAILY_CALL_CEILING);
    // `Number('')` is 0 — a ceiling that silences every reply while the other quotas
    // keep being spent — and an empty variable is an easy thing to leave in a task definition.
    expect(loadEnv({ ...base, BOT_LLM_DAILY_CALL_CEILING: '' }).llm.dailyCallCeiling).toBe(
      DEFAULT_DAILY_CALL_CEILING,
    );
    expect(loadEnv({ ...base, BOT_LLM_DAILY_CALL_CEILING: '  ' }).llm.dailyCallCeiling).toBe(
      DEFAULT_DAILY_CALL_CEILING,
    );
    // Zero on purpose is still zero.
    expect(loadEnv({ ...base, BOT_LLM_DAILY_CALL_CEILING: '0' }).llm.dailyCallCeiling).toBe(0);
  });

  it('refuses a ceiling that is not a non-negative number', () => {
    expect(() => loadEnv({ ...base, BOT_LLM_DAILY_CALL_CEILING: 'lots' })).toThrow(/non-negative/);
    expect(() => loadEnv({ ...base, BOT_LLM_DAILY_CALL_CEILING: '-1' })).toThrow(/non-negative/);
  });
});
