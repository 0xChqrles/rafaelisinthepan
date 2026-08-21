// CONTRACT (#201): the round sync engine. The server owns each round's ordered guess
// log; local play stays instant and the engine converges the server's copy behind it:
//   - the mount READ adopts whatever the local device is missing (cross-device history,
//     archive rounds included), merging server-first under the local log by canonical
//     identity (#104);
//   - counted guesses are COALESCED behind the ~1s pacing and flushed as batches;
//   - EVERY answer carries the full stored log and is adopted as truth;
//   - failed writes queue and retry with capped backoff — durability lives in the
//     persisted `tried`, never in the queue;
//   - the cap refusal (409) marks the round capped and closes the conversation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RankMap, RuntimeHole } from '@whippin/shared';
import { postRoundBody } from '../api';
import { useGameStore, roundKeyForDay } from './gameStore';
import {
  beginRoundSync,
  flushDelayMs,
  mergeLogs,
  notifyGuess,
  replayHoles,
  resetRoundSync,
} from './roundSync';
import { ROUND_WRITE_MIN_MS } from '@whippin/shared';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postRoundBody: vi.fn(),
}));

const post = vi.mocked(postRoundBody);

const T0 = 1_700_000_000_000;
const KEY = roundKeyForDay(21, 'fr');
const SECRET_MAP: RankMap = {
  foret: {
    foret: { word: 'forêt', rank: 0 },
    foretz: { word: 'forêt', rank: 0 },
    bois: { word: 'bois', rank: 5 },
    chemin: { word: 'chemin', rank: 87 },
  },
  ancienne: {
    ancienne: { word: 'ancienne', rank: 0 },
    vieille: { word: 'vieille', rank: 40 },
  },
};

function freshHoles(): RuntimeHole[] {
  return [
    { pos: 1, secret: 'foret', word: 'bois', rank: 87, startRank: 87 },
    { pos: 2, secret: 'ancienne', word: 'vieille', rank: 40, startRank: 40 },
  ];
}

function ctx() {
  return {
    roundKey: KEY,
    lang: 'fr',
    mode: 'sentence',
    date: '2026-08-21',
    ranks: SECRET_MAP,
    freshHoles: freshHoles(),
  } as const;
}

function ok(guesses: string[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ guesses, createdAt: '2026-08-21T09:00:00.000Z' }),
  } as unknown as Response;
}

function status(code: number) {
  return { ok: false, status: code } as unknown as Response;
}

function seedRound(tried: string[] = []) {
  useGameStore.setState(
    (s) => ({
      rounds: {
        ...s.rounds,
        [KEY]: {
          holes: freshHoles(),
          guessCount: tried.length,
          tried,
          progress: 0,
        },
      },
      activeKey: KEY,
    }),
    false,
  );
}

function round() {
  return useGameStore.getState().rounds[KEY];
}

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetRoundSync();
  post.mockReset();
  useGameStore.setState(
    {
      rounds: {},
      wordRounds: {},
      activeKey: null,
      activeWordKey: null,
    },
    false,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('mergeLogs', () => {
  it('unions server-first, deduping by canonical identity (#104)', () => {
    // 'foretz' aliases to the same whole outcome as 'foret' in every map — ONE try.
    const { guesses, acked } = mergeLogs(
      ['foret'],
      ['foretz', 'bois'],
      (t) => (SECRET_MAP.foret[t]?.rank ?? -1) + '|' + (SECRET_MAP.ancienne[t]?.rank ?? -1),
    );
    expect(guesses).toEqual(['foret', 'bois']);
    expect(acked).toBe(1); // only the server entry is acked
  });

  it('keeps local-only tries behind the acked prefix', () => {
    const { guesses, acked } = mergeLogs(['a', 'b'], ['b', 'c'], (t) => t);
    expect(guesses).toEqual(['a', 'b', 'c']);
    expect(acked).toBe(2);
  });
});

describe('replayHoles', () => {
  it('walks the log under the game-loop rule: closer word + lower rank, solved locked', () => {
    const holes = replayHoles(freshHoles(), SECRET_MAP, ['bois', 'ancienne']);
    expect(holes[0]).toMatchObject({ word: 'bois', rank: 5 }); // improved
    expect(holes[1]).toMatchObject({ word: 'ancienne', rank: 0 }); // solved
    // The fresh template is never mutated.
    expect(freshHoles()[0]).toMatchObject({ word: 'bois', rank: 87 });
  });
});

describe('flushDelayMs', () => {
  it('fires the first attempt immediately, then paces one interval', () => {
    expect(flushDelayMs(0, 0, T0)).toBe(0);
    expect(flushDelayMs(T0, 0, T0 + 500)).toBe(ROUND_WRITE_MIN_MS - 500);
    expect(flushDelayMs(T0, 0, T0 + ROUND_WRITE_MIN_MS)).toBe(0);
  });

  it('doubles per consecutive failure up to a 30s ceiling', () => {
    const last = T0;
    expect(flushDelayMs(last, 1, last)).toBe(2 * ROUND_WRITE_MIN_MS);
    expect(flushDelayMs(last, 5, last)).toBe(30_000);
    expect(flushDelayMs(last, 20, last)).toBe(30_000);
  });
});

describe('engine', () => {
  it('adopts a richer server log on mount — history follows the player to a new device', async () => {
    seedRound();
    post.mockResolvedValueOnce(ok(['bois']));
    beginRoundSync(ctx());
    await settle();

    expect(post).toHaveBeenCalledOnce();
    expect(round()?.tried).toEqual(['bois']);
    expect(round()?.guessCount).toBe(1);
    expect(round()?.holes[0]).toMatchObject({ word: 'bois', rank: 5 });
  });

  it('keeps local-only tries after a 404 read and appends them (creating the record)', async () => {
    seedRound(['bois']);
    post.mockResolvedValueOnce(status(404)).mockResolvedValueOnce(ok(['bois']));
    beginRoundSync(ctx());
    await settle(); // read lands; the append paces one interval behind it
    expect(post).toHaveBeenCalledOnce();

    await settle(ROUND_WRITE_MIN_MS + 1);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1]).toMatchObject({ guesses: ['bois'] });
    expect(round()?.tried).toEqual(['bois']);
  });

  it('splits guesses that land while a write is in flight into the next batch', async () => {
    seedRound();
    post
      .mockResolvedValueOnce(status(404)) // read
      .mockResolvedValueOnce(ok(['bois'])) // first append
      .mockResolvedValueOnce(ok(['bois', 'foret'])); // second append

    beginRoundSync(ctx());
    await settle();

    const keyOf = (t: string) =>
      `${SECRET_MAP.foret[t]?.rank ?? -1}|${SECRET_MAP.ancienne[t]?.rank ?? -1}`;
    const store = useGameStore.getState();

    // Past the pacing window the first guess flushes immediately...
    await settle(ROUND_WRITE_MIN_MS + 1);
    store.recordGuess('bois', keyOf);
    notifyGuess(KEY);
    await settle();
    expect(post.mock.calls.at(-1)?.[1]).toMatchObject({ guesses: ['bois'] });

    // ...and one typed while THAT write is in flight waits for the next batch.
    store.recordGuess('foret', keyOf);
    notifyGuess(KEY);
    await settle();
    expect(post).toHaveBeenCalledTimes(2);

    await settle(ROUND_WRITE_MIN_MS + 1);
    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls[2][1]).toMatchObject({ guesses: ['foret'] });
    expect(round()?.tried).toEqual(['bois', 'foret']);
  });

  it('marks the round capped on 409 and never writes again', async () => {
    seedRound(['bois']);
    post.mockResolvedValueOnce(status(404)).mockResolvedValueOnce(status(409));
    beginRoundSync(ctx());
    await settle(ROUND_WRITE_MIN_MS + 1);

    expect(round()?.capped).toBe(true);
    const writes = post.mock.calls.length;

    useGameStore.getState().recordGuess('foret', (t) => t);
    notifyGuess(KEY);
    await settle(60_000);
    expect(post.mock.calls.length).toBe(writes); // conversation closed
  });

  it('retries failed writes with backoff and resets on success', async () => {
    seedRound(['bois']);
    post
      .mockResolvedValueOnce(status(404))
      .mockResolvedValueOnce(status(500))
      .mockResolvedValueOnce(ok(['bois']));

    beginRoundSync(ctx());
    await settle(ROUND_WRITE_MIN_MS + 1);
    expect(post).toHaveBeenCalledTimes(2); // read + first (failed) append

    await settle(ROUND_WRITE_MIN_MS); // only half the doubled window
    expect(post).toHaveBeenCalledTimes(2);

    await settle(ROUND_WRITE_MIN_MS + 1); // past 2× interval
    expect(post).toHaveBeenCalledTimes(3);
    expect(round()?.tried).toEqual(['bois']);
  });
});
