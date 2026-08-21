// CONTRACT (#201): the round sync engine. The server owns each round's ordered guess
// log; local play stays instant and the engine converges the server's copy behind it:
//   - the mount READ adopts whatever the local device is missing (cross-device history,
//     archive rounds included), merging server-first under the local log by canonical
//     identity (#104), and the adopted board carries its cached progress;
//   - counted guesses are COALESCED behind the ~1s pacing, measured from the previous
//     write's ANSWER (the server times its own receipt instants), and flushed as batches
//     clamped to what still fits under the cap;
//   - EVERY answer — a 200 and BOTH refusals — carries the full stored log and is adopted
//     as truth;
//   - a write whose outcome is UNKNOWN re-reads before writing again, so an append is
//     never stored twice; a 4xx VERDICT closes the conversation instead of spinning;
//   - the cap refusal (409) marks the round capped, and the persisted flag keeps a reload
//     from re-opening the conversation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RankMap, RuntimeHole } from '@whippin/shared';
import { postRoundBody } from '../api';
import { useGameStore, roundKeyForDay } from './gameStore';
import {
  backoffDelayMs,
  beginRoundSync,
  mergeLogs,
  notifyGuess,
  puzzleTag,
  replayHoles,
  resetRoundSync,
  writeDelayMs,
} from './roundSync';
import { ROUND_GUESS_CAP, ROUND_WRITE_MIN_MS } from '@whippin/shared';

// `roundUrl` is mocked with the rest (the house pattern — see useScoreHistogram.test.ts's
// `scoresUrl`, FriendInvite.test.ts's `friendsUrl`): the real builder throws without
// VITE_API_BASE_URL, which is a gitignored `.env.local` locally and absent in CI, so
// leaving it real makes this suite pass on a developer's machine and fail on the required
// check. What it builds is `api.test.ts`'s contract, not this one's. `parseRound` stays
// REAL — the engine's handling of a malformed body is part of what is under test here.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postRoundBody: vi.fn(),
  roundUrl: (lang: string, date: string, mode: string) =>
    `https://api.test/round?lang=${lang}&date=${date}&mode=${mode}`,
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

function ctx(key: string = KEY) {
  return {
    roundKey: key,
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

// A refusal is an ANSWER: 409 and 429 carry the UNCHANGED stored log exactly like a 200.
function refusal(status: number, guesses: string[]) {
  return {
    ok: false,
    status,
    json: async () => ({
      error: status === 409 ? 'round_full' : 'too_fast',
      message: 'refused',
      guesses,
      createdAt: '2026-08-21T09:00:00.000Z',
    }),
  } as unknown as Response;
}

function status(code: number) {
  return { ok: false, status: code, json: async () => ({}) } as unknown as Response;
}

function seedRound(tried: string[] = [], extra: Record<string, unknown> = {}, key: string = KEY) {
  useGameStore.setState(
    (s) => ({
      rounds: {
        ...s.rounds,
        [key]: {
          holes: freshHoles(),
          guessCount: tried.length,
          tried,
          progress: 0,
          ...extra,
        },
      },
      activeKey: key,
    }),
    false,
  );
}

function round(key: string = KEY) {
  return useGameStore.getState().rounds[key];
}

function bodyOf(call: number): { secret: string; puzzle: string; guesses?: string[] } {
  return post.mock.calls[call][1] as { secret: string; puzzle: string; guesses?: string[] };
}

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

// One local try more than the server will ever hold. Distinct strings, so `guessKey`
// (which falls back to the typed form for a guess no map ranks) keeps them apart.
function overCapLog(): string[] {
  return Array.from({ length: ROUND_GUESS_CAP + 1 }, (_, i) => `try-${i.toString(36)}`);
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

describe('puzzleTag', () => {
  it('names the puzzle by what holesMatchPuzzle itself compares', () => {
    const other = freshHoles();
    other[1] = { ...other[1], secret: 'antique' };
    expect(puzzleTag(freshHoles())).toBe(puzzleTag(freshHoles()));
    // A re-published sentence under the same (day, lang) key is a DIFFERENT puzzle, and
    // the tag is the only thing that tells the server so.
    expect(puzzleTag(other)).not.toBe(puzzleTag(freshHoles()));
  });

  it('fits the tag the route accepts', () => {
    expect(puzzleTag(freshHoles())).toMatch(/^[a-z0-9]{1,32}$/);
  });
});

describe('write pacing', () => {
  it('flushes the first write immediately', () => {
    expect(writeDelayMs(0, T0)).toBe(0);
  });

  it('measures the interval from the previous write\'s ANSWER, not its send', () => {
    // The server compares its OWN receipt instants with a strict `<`, so pacing from the
    // send instant leaves zero margin: any request faster than its predecessor is a 429.
    // Waiting from the answer puts the server's round trip inside the gap.
    expect(writeDelayMs(T0, T0 + 500)).toBe(ROUND_WRITE_MIN_MS - 500);
    expect(writeDelayMs(T0, T0 + ROUND_WRITE_MIN_MS)).toBe(0);
  });

  it('doubles the retry window per consecutive failure up to a 30s ceiling', () => {
    expect(backoffDelayMs(0, T0, T0)).toBe(0);
    expect(backoffDelayMs(1, T0, T0)).toBe(2 * ROUND_WRITE_MIN_MS);
    expect(backoffDelayMs(5, T0, T0)).toBe(30_000);
    expect(backoffDelayMs(20, T0, T0)).toBe(30_000);
  });
});

describe('engine', () => {
  it('adopts a richer server log on mount — history follows the player to a new device', async () => {
    seedRound();
    post.mockResolvedValueOnce(ok(['bois']));
    beginRoundSync(ctx());
    await settle();

    expect(post).toHaveBeenCalledOnce();
    // The read carries the player key and the puzzle tag, and asks for nothing else.
    expect(bodyOf(0).puzzle).toBe(puzzleTag(freshHoles()));
    expect(bodyOf(0).guesses).toBeUndefined();

    expect(round()?.tried).toEqual(['bois']);
    expect(round()?.guessCount).toBe(1);
    expect(round()?.holes[0]).toMatchObject({ word: 'bois', rank: 5 });
    // The cached progress travels with the board: nothing else refreshes it once this
    // round stops being the active one.
    expect(round()?.progress).toBeGreaterThan(0);
  });

  it('keeps local-only tries after a 404 read and appends them (creating the record)', async () => {
    seedRound(['bois']);
    post.mockResolvedValueOnce(status(404)).mockResolvedValueOnce(ok(['bois']));
    beginRoundSync(ctx());
    await settle();

    // A READ is not rate-limited server-side, so the first flush does not wait behind it.
    expect(post).toHaveBeenCalledTimes(2);
    expect(bodyOf(1).guesses).toEqual(['bois']);
    expect(round()?.tried).toEqual(['bois']);
  });

  it('does NOT rewrite the round when the server only echoes what we sent', async () => {
    seedRound(['bois']);
    post.mockResolvedValueOnce(status(404)).mockResolvedValueOnce(ok(['bois']));
    beginRoundSync(ctx());
    await settle();
    const settled = round();

    // Adopting an unchanged log would re-serialize the persist blob AND apply every
    // pending hole improvement on the spot, out from under Game.submit's deferral of
    // each swap to its floating hit's fade-out — which on a fast connection is every
    // single guess.
    await settle(5_000);
    expect(round()).toBe(settled);
  });

  it('splits guesses that land while a write is in flight into the next batch', async () => {
    seedRound();
    post
      .mockResolvedValueOnce(status(404)) // read
      .mockResolvedValueOnce(ok(['bois'])) // first append
      .mockResolvedValueOnce(ok(['bois', 'foret'])); // second append

    beginRoundSync(ctx());
    await settle();
    expect(post).toHaveBeenCalledOnce(); // the read alone: nothing pending yet

    const keyOf = (t: string) =>
      `${SECRET_MAP.foret[t]?.rank ?? -1}|${SECRET_MAP.ancienne[t]?.rank ?? -1}`;
    const store = useGameStore.getState();

    // The first guess flushes immediately — nothing has been written yet.
    store.recordGuess('bois', keyOf);
    notifyGuess(KEY);
    await settle();
    expect(bodyOf(1).guesses).toEqual(['bois']);

    // One typed while THAT write is settling waits out the interval and goes as its own
    // batch, coalesced rather than racing.
    store.recordGuess('foret', keyOf);
    notifyGuess(KEY);
    await settle();
    expect(post).toHaveBeenCalledTimes(2);

    await settle(ROUND_WRITE_MIN_MS);
    expect(post).toHaveBeenCalledTimes(3);
    expect(bodyOf(2).guesses).toEqual(['foret']);
    expect(round()?.tried).toEqual(['bois', 'foret']);
  });

  it('marks the round capped on 409 and never writes again', async () => {
    seedRound(['bois']);
    post.mockResolvedValueOnce(status(404)).mockResolvedValueOnce(refusal(409, ['bois']));
    beginRoundSync(ctx());
    await settle();

    expect(round()?.capped).toBe(true);
    const writes = post.mock.calls.length;

    useGameStore.getState().recordGuess('foret', (t) => t);
    notifyGuess(KEY);
    await settle(60_000);
    expect(post.mock.calls.length).toBe(writes); // conversation closed
  });

  it('does not re-open a capped round on a later mount', async () => {
    // `capped` is persisted; without reading it here every reload spends a read and a
    // guaranteed-409 append, and writes another cap line that is reload noise rather
    // than a player actually reaching the cap.
    seedRound(['bois'], { capped: true });
    beginRoundSync(ctx());
    await settle(60_000);
    expect(post).not.toHaveBeenCalled();
  });

  it('treats a 429 as pacing, not failure: adopts its log and retries one interval later', async () => {
    seedRound(['bois']);
    post
      .mockResolvedValueOnce(status(404))
      .mockResolvedValueOnce(refusal(429, []))
      .mockResolvedValueOnce(ok(['bois']));
    beginRoundSync(ctx());
    await settle();
    expect(post).toHaveBeenCalledTimes(2);

    // NOT the doubled backoff a transport failure earns — one plain interval, measured
    // from the refusal itself.
    await settle(ROUND_WRITE_MIN_MS - 1);
    expect(post).toHaveBeenCalledTimes(2);
    await settle(1);
    expect(post).toHaveBeenCalledTimes(3);
    expect(bodyOf(2).guesses).toEqual(['bois']);
  });

  it('RE-READS after a write whose outcome is unknown, instead of re-sending it', async () => {
    seedRound(['bois']);
    post
      .mockResolvedValueOnce(status(404))
      .mockResolvedValueOnce(status(500))
      .mockResolvedValueOnce(ok(['bois'])) // the re-read: the write HAD committed
      .mockResolvedValueOnce(ok(['bois']));

    beginRoundSync(ctx());
    await settle();
    expect(post).toHaveBeenCalledTimes(2); // read + the failed append

    await settle(2 * ROUND_WRITE_MIN_MS);
    // A 5xx (or a dropped connection) says nothing about whether the append landed.
    // Re-sending it would `list_append` the same guesses twice and burn the cap on a
    // duplicate the client's own dedup then hides, so the recovery is a READ.
    expect(bodyOf(2).guesses).toBeUndefined();
    expect(round()?.tried).toEqual(['bois']);

    // And with the log now known to be acked, nothing further is pending.
    await settle(30_000);
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('discards an in-flight answer once the daily is RE-PUBLISHED under it', async () => {
    seedRound();
    let landOldRead: (response: Response) => void = () => {};
    post.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        landOldRead = resolve;
      }),
    );
    post.mockResolvedValueOnce(status(404)); // the corrected puzzle's own read

    beginRoundSync(ctx());
    await settle();
    expect(post).toHaveBeenCalledOnce();

    // The daily is re-published while that read is still in the air. A flight is MUTATED
    // in place on re-registration, so without a check the old answer would be applied
    // using the CORRECTED puzzle's ranks and holes.
    const corrected: RuntimeHole[] = [
      { pos: 1, secret: 'foret', word: 'bois', rank: 87, startRank: 87 },
      { pos: 2, secret: 'antique', word: 'vieux', rank: 12, startRank: 12 },
    ];
    beginRoundSync({
      ...ctx(),
      freshHoles: corrected,
      ranks: { ...SECRET_MAP, antique: { antique: { word: 'antique', rank: 0 } } },
    });

    // The old request lands, carrying the RETIRED sentence's log.
    landOldRead(ok(['bois', 'chemin']));
    await settle();

    // None of it reached the round the player is now playing...
    expect(round()?.tried).toEqual([]);
    expect(round()?.holes).toEqual(freshHoles());
    // ...and the corrected puzzle asked the server about ITSELF.
    expect(post).toHaveBeenCalledTimes(2);
    expect(bodyOf(1).puzzle).toBe(puzzleTag(corrected));
  });

  it('closes on a 4xx VERDICT instead of spinning on it forever', async () => {
    seedRound(['bois']);
    post.mockResolvedValue(status(400));
    beginRoundSync(ctx());
    await settle(120_000);
    // A read this client will keep getting wrong stalls every append behind it, so the
    // guesses would reach the server on no visit ever while one request went out every
    // 30 seconds for the tab's life.
    expect(post).toHaveBeenCalledOnce();
  });

  it('clamps a batch to what still fits under the cap', async () => {
    const long = overCapLog();
    seedRound(long);
    post.mockResolvedValueOnce(status(404)).mockResolvedValueOnce(ok(long.slice(0, ROUND_GUESS_CAP)));
    beginRoundSync(ctx());
    await settle();

    // An unclamped batch takes a 400 — not the 409 this engine handles — and would be
    // re-sent every 30s forever while the round was never marked capped at all.
    expect(bodyOf(1).guesses).toHaveLength(ROUND_GUESS_CAP);
  });

  it('marks a round capped without spending a doomed request once the log is full', async () => {
    const long = overCapLog();
    seedRound(long);
    post
      .mockResolvedValueOnce(status(404))
      .mockResolvedValueOnce(ok(long.slice(0, ROUND_GUESS_CAP)));
    beginRoundSync(ctx());
    await settle(60_000);

    expect(post).toHaveBeenCalledTimes(2);
    expect(round()?.capped).toBe(true);
  });

  it('does NOT cap a round whose log ends exactly at the cap with nothing pending', async () => {
    // "Capped" means the server has (or would) refuse a guess — its own 409 semantics.
    // A player who solved on their 500th try is finished, not stopped counting, and
    // capping them here would silently suppress a legitimate leaderboard entry.
    const full = overCapLog().slice(0, ROUND_GUESS_CAP);
    seedRound(full);
    post.mockResolvedValueOnce(ok(full));
    beginRoundSync(ctx());
    await settle(60_000);

    expect(post).toHaveBeenCalledOnce();
    expect(round()?.capped).toBeUndefined();
  });

  it('bounds the conversation map — every flight pins its puzzle\'s rank map', async () => {
    post.mockResolvedValue(status(404));
    // Four rounds registered, no store rounds behind them: nothing is requested, but the
    // flights are created. Browsing the archive used to keep every one of them (and its
    // megabytes of ranks) alive for the tab's life.
    for (const day of [21, 22, 23, 24]) beginRoundSync(ctx(roundKeyForDay(day, 'fr')));
    await settle();
    expect(post).not.toHaveBeenCalled();

    // The oldest conversation is gone; dropping it is safe by construction, because
    // durability lives in the persisted log and the next mount reads.
    seedRound(['bois'], {}, roundKeyForDay(21, 'fr'));
    notifyGuess(roundKeyForDay(21, 'fr'));
    await settle();
    expect(post).not.toHaveBeenCalled();

    // The most recent one is still live.
    seedRound(['bois'], {}, roundKeyForDay(24, 'fr'));
    notifyGuess(roundKeyForDay(24, 'fr'));
    await settle();
    expect(post).toHaveBeenCalled();
  });
});
