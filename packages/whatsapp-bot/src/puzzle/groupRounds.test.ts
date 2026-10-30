import { describe, expect, it } from 'vitest';
import type { BotMemberRound, BotRoundsRequest } from '@whippin/shared';
import { createLog } from '../log';
import { LIVE_ROUNDS_TTL_MS, createGroupRoundsReader, oddGuesses, parseRoundsAnswer } from './groupRounds';

const WG = 'abcdefghij234567';
const log = createLog('silent');

export function member(over: Partial<BotMemberRound> = {}): BotMemberRound {
  return {
    publicId: 'zzzzzzzzzz234567',
    name: 'Gab',
    started: true,
    tries: 7,
    progress: 100,
    solved: true,
    gaveUp: false,
    over: false,
    farGuesses: [{ try: 2, word: 'chaise', rank: 812 }],
    ...over,
  };
}

const answer = (members: unknown[] = [member()]) => ({ ok: true, group: { id: WG, name: 'Les potes' }, revision: 'r1', members });
const asked: BotRoundsRequest = { group: WG, lang: 'fr', date: '2026-10-30' };

describe('the Whippin group\'s rounds, read over IAM (2026-10-30)', () => {
  it('parses the contract\'s answer, and refuses ANY malformed part of it whole', () => {
    expect(parseRoundsAnswer(answer(), asked)).toEqual({ group: { id: WG, name: 'Les potes' }, revision: 'r1', members: [member()] });
    expect(parseRoundsAnswer({ ok: false, error: 'unknown_group' }, asked)).toBe('refused');
    // Another group than the one asked, a bad id, a bad count, a % past 100: no answer.
    expect(parseRoundsAnswer({ ...answer(), group: { id: 'bbbbbbbbbb234567', name: 'x' } }, asked)).toBeNull();
    expect(parseRoundsAnswer(answer([member({ publicId: 'NOPE' })]), asked)).toBeNull();
    expect(parseRoundsAnswer(answer([member({ tries: -1 })]), asked)).toBeNull();
    expect(parseRoundsAnswer(answer([member({ progress: 140 })]), asked)).toBeNull();
    expect(parseRoundsAnswer(answer([member(), { publicId: 'zzzzzzzzzz234567' }]), asked)).toBeNull();
    expect(parseRoundsAnswer('nope', asked)).toBeNull();
    // A miss (null rank) is a far guess; a rank of 0 is the SECRET, which the server never
    // sends — arriving anyway, it refuses the whole read rather than reach a prompt.
    expect(parseRoundsAnswer(answer([member({ farGuesses: [{ try: 1, word: 'xqz', rank: null }] })]), asked)).not.toBeNull();
    expect(parseRoundsAnswer(answer([member({ farGuesses: [{ try: 1, word: 'secret', rank: 0 }] })]), asked)).toBeNull();
    expect(parseRoundsAnswer(answer([member({ farGuesses: [{ try: 0, word: 'x', rank: 3 }] })]), asked)).toBeNull();
  });

  it('caches an answer for a minute per (group, language, date), with ONE flight for concurrent askers', async () => {
    let clock = 0;
    const calls: BotRoundsRequest[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const reader = createGroupRoundsReader({
      invoke: async (request) => {
        calls.push(request);
        await gate;
        return answer();
      },
      log,
      now: () => clock,
    });
    const both = Promise.all([reader.read(WG, 'fr', '2026-10-30'), reader.read(WG, 'fr', '2026-10-30')]);
    release();
    const [a, b] = await both;
    expect(calls).toEqual([asked]);
    expect(a).toBe(b);
    clock = LIVE_ROUNDS_TTL_MS - 1;
    await reader.read(WG, 'fr', '2026-10-30');
    expect(calls).toHaveLength(1);
    // Another language or day is another read; past the minute, the same one is asked again.
    await reader.read(WG, 'en', '2026-10-30');
    expect(calls).toHaveLength(2);
    clock = LIVE_ROUNDS_TTL_MS;
    await reader.read(WG, 'fr', '2026-10-30');
    expect(calls).toHaveLength(3);
    // A FRESH read asks inside the minute, and what it reads is held for the next asker.
    const fresh = await reader.read(WG, 'fr', '2026-10-30', { fresh: true });
    expect(calls).toHaveLength(4);
    expect(await reader.read(WG, 'fr', '2026-10-30')).toBe(fresh);
    expect(calls).toHaveLength(4);
  });

  it('degrades to null on a throw, a refusal or garbage — held for the minute too, so a down function is not asked at chat rate', async () => {
    let calls = 0;
    for (const outcome of [new Error('AccessDenied'), { ok: false, error: 'bad_request' }, { nonsense: true }]) {
      const reader = createGroupRoundsReader({
        invoke: async () => {
          calls += 1;
          if (outcome instanceof Error) throw outcome;
          return outcome;
        },
        log,
        now: () => 0,
      });
      expect(await reader.read(WG, 'fr', '2026-10-30')).toBeNull();
      expect(await reader.read(WG, 'fr', '2026-10-30')).toBeNull();
    }
    expect(calls).toBe(3);
    // Never sends the function a group id it must refuse.
    const reader = createGroupRoundsReader({ invoke: async () => answer(), log });
    expect(await reader.read('not-a-group', 'fr', '2026-10-30')).toBeNull();
  });

  it('picks the odd words: misses first, then the farthest, returned in play order', () => {
    const guesses = [
      { try: 1, word: 'a', rank: 300 },
      { try: 2, word: 'b', rank: null },
      { try: 3, word: 'c', rank: 900 },
      { try: 4, word: 'd', rank: 150 },
      { try: 5, word: 'e', rank: null },
    ];
    expect(oddGuesses(guesses, 3).map((g) => g.word)).toEqual(['b', 'c', 'e']);
    expect(oddGuesses(guesses, 10)).toHaveLength(5);
    expect(oddGuesses([], 3)).toEqual([]);
  });
});
