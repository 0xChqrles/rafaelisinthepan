// CONTRACT (#211): the PRIVATE player history — the archive calendar's month, the
// chooser's status strip and the streak's solved-day list, all read off what the server
// already derives from the guess log (#203).
//
// What is pinned here is the protocol, not the plumbing: it is a POST because the device
// token is the auth and travels in the BODY (so nobody can read another player's history), it
// is addressed by a MONTH rather than a day (the sort-key prefix #203 reordered the round
// key for), it answers only the SUMMARY facts and never the raw guess logs, and a solve
// credits the streak's day exactly where `recordSolve` used to.

import { describe, expect, it, vi } from 'vitest';
import { generatePublicId, type PlayerHistory } from '@whippin/shared';
import { createHandler } from './handler';
import { memoryDeviceStore } from './memoryDeviceStore';
import { memoryHistoryStore } from './memoryHistoryStore';
import { memoryRoundStore } from './memoryRoundStore';
import { memoryScoreStore } from './memoryScoreStore';
import type { PlayerHistoryStore } from './historyStore';
import type { RoundStore } from './roundStore';
import type { FnUrlEvent } from './respond';
import type { PuzzleStore } from './store';
import { seedDevice, type TestDevice } from './testDevice';

const emptyStore: PuzzleStore = {
  getPuzzle: async () => null,
  getWordPuzzle: async () => null,
  getSlice: async () => null,
};

async function makeHandler(
  roundStore: RoundStore = memoryRoundStore(),
  history: PlayerHistoryStore = memoryHistoryStore(),
) {
  const devices = memoryDeviceStore();
  const handler = createHandler({
    store: emptyStore,
    deviceStore: devices,
    devices: {
      turnstile: { async verify() { return true; } },
      allowSourceIp: true,
    },
    rounds: {
      roundStore,
      scoreStore: memoryScoreStore(),
      ipHmacSecret: 'x'.repeat(64),
      turnstile: { async verify() { return true; } },
      history,
      allowSourceIp: true,
    },
  });
  return { handler, roundStore, history, me: await seedDevice(devices) };
}

function postBody(query: Record<string, string>, body: unknown): FnUrlEvent {
  return {
    rawPath: '/history',
    queryStringParameters: query,
    requestContext: { http: { method: 'POST' } },
    body: JSON.stringify(body),
  };
}

const post = (query: Record<string, string>, me: TestDevice) =>
  postBody(query, { token: me.token });

const MONTH = { lang: 'fr', mode: 'sentence', month: '2026-08' };

// Seed a stored round the way an accepted append leaves it — the summary attributes
// beside the log, which is exactly what #203 writes.
async function playDay(
  rounds: RoundStore,
  publicId: string,
  date: string,
  progress: number,
  solved: boolean,
  lang = 'fr',
) {
  await rounds.append({
    date,
    lang,
    mode: 'sentence',
    publicId,
    puzzle: 'rev1',
    guesses: ['bois'],
    progress,
    solved,
    now: new Date(`${date}T12:00:00Z`),
  });
}

describe('history route (#211)', () => {
  it('answers the asked-for MONTH with the summary the server derived — never the log', async () => {
    const { handler, roundStore, me } = await makeHandler();
    await playDay(roundStore, me.accountId, '2026-08-03', 42, false);
    await playDay(roundStore, me.accountId, '2026-08-04', 100, true);

    const result = await handler(post(MONTH, me));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as PlayerHistory;
    expect(body.days).toEqual([
      { date: '2026-08-03', progress: 42, solved: false },
      { date: '2026-08-04', progress: 100, solved: true },
    ]);
    // The raw guesses are the one thing a summary surface may never be handed.
    expect(result.body).not.toContain('bois');
  });

  it('is scoped to the asked-for month, language and mode', async () => {
    const { handler, roundStore, me } = await makeHandler();
    await playDay(roundStore, me.accountId, '2026-08-03', 40, false);
    await playDay(roundStore, me.accountId, '2026-09-03', 50, false); // another month
    await playDay(roundStore, me.accountId, '2026-08-05', 60, false, 'en'); // another language

    const days = (JSON.parse((await handler(post(MONTH, me))).body) as PlayerHistory).days;
    expect(days.map((day) => day.date)).toEqual(['2026-08-03']);
  });

  it('is PRIVATE — one player never sees another\'s days', async () => {
    const { handler, roundStore, me } = await makeHandler();
    await playDay(roundStore, generatePublicId(), '2026-08-03', 42, false);

    const body = JSON.parse((await handler(post(MONTH, me))).body) as PlayerHistory;
    expect(body.days).toEqual([]);
  });

  it('a month with nothing played is EMPTY, which is an answer', async () => {
    const { handler, me } = await makeHandler();
    const body = JSON.parse((await handler(post(MONTH, me))).body) as PlayerHistory;
    expect(body).toEqual({ days: [], solvedDays: [] });
  });

  it('omitting the month asks for the solved-day collection alone (no calendar cost)', async () => {
    const { handler, roundStore, history, me } = await makeHandler();
    await playDay(roundStore, me.accountId, '2026-08-03', 42, false);
    await history.recordSolvedDay({ publicId: me.accountId, lang: 'fr', day: 20_669 });

    const body = JSON.parse(
      (await handler(post({ lang: 'fr', mode: 'sentence' }, me))).body,
    ) as PlayerHistory;
    expect(body).toEqual({ days: [], solvedDays: [20_669] });
  });

  it('collection: false skips the solved-day read — the chooser\'s month-only shape', async () => {
    const { handler, roundStore, history, me } = await makeHandler();
    await playDay(roundStore, me.accountId, '2026-08-03', 42, false);
    await history.recordSolvedDay({ publicId: me.accountId, lang: 'fr', day: 20_669 });
    // The store is never even asked: the chooser draws a month strip and no streak, so
    // paying the collection's consistent read for it is capacity spent on nothing.
    const spy = vi.spyOn(history, 'solvedDays');
    const body = JSON.parse(
      (await handler(postBody(MONTH, { token: me.token, collection: false }))).body,
    ) as PlayerHistory;
    expect(spy).not.toHaveBeenCalled();
    expect(body.days.map((day) => day.date)).toEqual(['2026-08-03']);
    expect(body.solvedDays).toEqual([]);
  });

  it('answers the language\'s solved days, ascending', async () => {
    const { handler, history, me } = await makeHandler();
    for (const day of [20_670, 20_668, 20_669]) {
      await history.recordSolvedDay({ publicId: me.accountId, lang: 'fr', day });
    }
    await history.recordSolvedDay({ publicId: me.accountId, lang: 'en', day: 20_600 });

    const body = JSON.parse((await handler(post(MONTH, me))).body) as PlayerHistory;
    expect(body.solvedDays).toEqual([20_668, 20_669, 20_670]);
  });

  it('is POST-only: the token authenticates in the body, so a GET is a named 405', async () => {
    const { handler } = await makeHandler();
    const result = await handler({
      rawPath: '/history',
      queryStringParameters: MONTH,
      requestContext: { http: { method: 'GET' } },
    });
    expect(result.statusCode).toBe(405);
    expect(JSON.parse(result.body).error).toBe('method_not_allowed');
  });

  it('refuses a malformed token, an unsupported language, a missing mode and a bad month', async () => {
    const { handler, me } = await makeHandler();
    const bad = [
      postBody(MONTH, { token: 'nope' }),
      post({ ...MONTH, lang: 'zz' }, me),
      post({ lang: 'fr', month: '2026-08' }, me),
      post({ ...MONTH, month: '2026-13' }, me),
      post({ ...MONTH, month: '2026-08-03' }, me),
    ];
    for (const event of bad) {
      expect((await handler(event)).statusCode).toBe(400);
    }
  });

  it('refuses a device nobody holds with unknown_device (#216)', async () => {
    const { handler } = await makeHandler();
    const result = await handler(postBody(MONTH, { token: 'f'.repeat(64) }));
    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body).error).toBe('unknown_device');
  });

  it('never caches: a private read must not sit at the edge', async () => {
    const { handler, me } = await makeHandler();
    const result = await handler(post(MONTH, me));
    expect(result.headers['Cache-Control']).toBe('no-store');
  });
});

describe('the streak day a CONFIRMED solve credits (#211)', () => {
  it('is idempotent, so a re-solve of a corrected revision cannot claim it twice', async () => {
    const history = memoryHistoryStore();
    const me = generatePublicId();
    await history.recordSolvedDay({ publicId: me, lang: 'fr', day: 20_669 });
    await history.recordSolvedDay({ publicId: me, lang: 'fr', day: 20_669 });
    await expect(history.solvedDays(me, 'fr')).resolves.toEqual([20_669]);
  });

  it('is bounded to MAX_SOLVED_DAYS, dropping the oldest', async () => {
    const history = memoryHistoryStore();
    const me = generatePublicId();
    for (let day = 1; day <= 801; day += 1) {
      await history.recordSolvedDay({ publicId: me, lang: 'fr', day });
    }
    const days = await history.solvedDays(me, 'fr');
    expect(days.length).toBe(800);
    expect(days[0]).toBe(2);
    expect(days[days.length - 1]).toBe(801);
  });
});
