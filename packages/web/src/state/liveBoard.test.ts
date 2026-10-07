import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveBoard } from '@whippin/shared';

// CONTRACT: the live read is asked at guess cadence against a bounded pool of Lambdas
// (reserved concurrency 200), so this module is the ONE place its cost is bounded — at most one read per
// LIVE_REFRESH_MS, one flight at a time, a request inside the window served ONCE at its end
// (never dropped), no request without an identity, an answer fenced by the identity epoch,
// and a failure that keeps the last answer. It says whether an answer is still to come
// (`busy`), so a consumer waiting for a newer one never waits on nothing. ONE request skips
// the window — the one asked when the round ends (`now`), so the result's boards are built
// from an answer that has seen the end without waiting out the window — and only that one.

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  verdict: vi.fn(),
  identity: { accountId: 'A', token: 'token', deviceId: 'device' } as { accountId: string; token: string; deviceId: string } | null,
}));
vi.mock('../api', () => ({
  boardUrl: (lang: string, date: string) => `/board?lang=${lang}&date=${date}`,
  parseLiveBoard: (data: unknown) => data,
  postBoardBody: mocks.post,
}));
vi.mock('../identity', () => ({
  deviceIdentity: () => mocks.identity,
  identityEpochOf: (identity: { accountId: string }) => identity.accountId,
  currentRequestIdentity: (epoch: string) =>
    mocks.identity?.accountId === epoch ? { identity: mocks.identity, epoch } : null,
}));
vi.mock('./signedOutVerdict', () => ({ adoptSignedOutVerdict: mocks.verdict }));
import { LIVE_REFRESH_MS, requestLiveBoard, resetLiveBoard, useLiveBoardStore } from './liveBoard';

const answer = (tag: string): LiveBoard => ({
  groups: [{ id: 'gggggggggggggggg', name: tag, members: ['A'] }],
  rows: [],
  playing: [],
});
const ok = (board: LiveBoard) => ({ ok: true, status: 200, json: async () => board });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
// Let a resolved flight run its continuation (the answer, then the trailing schedule).
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  resetLiveBoard();
  mocks.post.mockReset();
  mocks.verdict.mockReset();
  mocks.identity = { accountId: 'A', token: 'token', deviceId: 'device' };
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the live read', () => {
  it('makes no private request without an identity', () => {
    mocks.identity = null;
    requestLiveBoard('fr', '2026-10-02');
    vi.advanceTimersByTime(LIVE_REFRESH_MS * 3);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('reads at once, then at most ONCE per window: requests inside it collapse into one trailing read', async () => {
    mocks.post.mockResolvedValue(ok(answer('first')));
    requestLiveBoard('fr', '2026-10-02');
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls[0][1]).toEqual({ token: 'token', live: true });
    await settle();
    expect(useLiveBoardStore.getState().board).toEqual(answer('first'));

    // Three acknowledged appends in the next seconds: nothing goes out yet…
    vi.advanceTimersByTime(2_000);
    requestLiveBoard('fr', '2026-10-02');
    vi.advanceTimersByTime(3_000);
    requestLiveBoard('fr', '2026-10-02');
    requestLiveBoard('fr', '2026-10-02');
    expect(mocks.post).toHaveBeenCalledTimes(1);
    // …and ONE read goes at the window's end — never dropped, never one per request.
    mocks.post.mockResolvedValue(ok(answer('second')));
    vi.advanceTimersByTime(LIVE_REFRESH_MS - 5_000 - 1);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    await settle();
    expect(useLiveBoardStore.getState().board).toEqual(answer('second'));
    vi.advanceTimersByTime(LIVE_REFRESH_MS * 3);
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it('reads at once again once a whole window has passed', async () => {
    mocks.post.mockResolvedValue(ok(answer('x')));
    requestLiveBoard('fr', '2026-10-02');
    await settle();
    vi.advanceTimersByTime(LIVE_REFRESH_MS);
    requestLiveBoard('fr', '2026-10-02');
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it('holds ONE flight at a time: a slow read delays the next past its window', async () => {
    const slow = deferred<ReturnType<typeof ok>>();
    mocks.post.mockReturnValueOnce(slow.promise);
    requestLiveBoard('fr', '2026-10-02');
    requestLiveBoard('fr', '2026-10-02');
    vi.advanceTimersByTime(LIVE_REFRESH_MS * 2);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    mocks.post.mockResolvedValue(ok(answer('next')));
    slow.resolve(ok(answer('slow')));
    await settle();
    // The window had passed while it was out: the waiting request goes the moment it lands.
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it('keeps the last answer through a failure, silently', async () => {
    mocks.post.mockResolvedValueOnce(ok(answer('good')));
    requestLiveBoard('fr', '2026-10-02');
    await settle();
    mocks.post.mockRejectedValueOnce(new Error('offline'));
    vi.advanceTimersByTime(LIVE_REFRESH_MS);
    requestLiveBoard('fr', '2026-10-02');
    await settle();
    mocks.post.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    vi.advanceTimersByTime(LIVE_REFRESH_MS);
    requestLiveBoard('fr', '2026-10-02');
    await settle();
    expect(mocks.post).toHaveBeenCalledTimes(3);
    expect(useLiveBoardStore.getState().board).toEqual(answer('good'));
    // A refused read is offered to the sign-out verdict, which alone decides what it means.
    expect(mocks.verdict).toHaveBeenCalledTimes(1);
  });

  it('is BUSY about a day from the request until no read for it is waiting or out', async () => {
    const first = deferred<ReturnType<typeof ok>>();
    mocks.post.mockReturnValueOnce(first.promise);
    expect(useLiveBoardStore.getState().busy).toBeNull();
    requestLiveBoard('fr', '2026-10-02');
    // Out on the wire.
    expect(useLiveBoardStore.getState().busy).toBe('fr:2026-10-02');
    first.resolve(ok(answer('first')));
    await settle();
    expect(useLiveBoardStore.getState()).toMatchObject({ board: answer('first'), busy: null });

    // A request inside the window waits for its trailing call: still owed, so still busy —
    // through the wait and the flight, whatever the flight answers.
    vi.advanceTimersByTime(2_000);
    requestLiveBoard('fr', '2026-10-02');
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(useLiveBoardStore.getState().busy).toBe('fr:2026-10-02');
    const trailing = deferred<ReturnType<typeof ok>>();
    mocks.post.mockReturnValueOnce(trailing.promise);
    vi.advanceTimersByTime(LIVE_REFRESH_MS - 2_000);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(useLiveBoardStore.getState().busy).toBe('fr:2026-10-02');
    trailing.reject(new Error('offline'));
    await settle();
    // Failed: nothing more is on its way, and the last answer stands.
    expect(useLiveBoardStore.getState()).toMatchObject({ board: answer('first'), busy: null });
  });

  it('stays busy across a flight when a request came in behind it', async () => {
    const slow = deferred<ReturnType<typeof ok>>();
    mocks.post.mockReturnValueOnce(slow.promise);
    requestLiveBoard('fr', '2026-10-02');
    requestLiveBoard('fr', '2026-10-02');
    mocks.post.mockResolvedValueOnce(ok(answer('after')));
    slow.resolve(ok(answer('before')));
    await settle();
    // The answer that landed predates the second request, whose read is still owed.
    expect(useLiveBoardStore.getState()).toMatchObject({ board: answer('before'), busy: 'fr:2026-10-02' });
    vi.advanceTimersByTime(LIVE_REFRESH_MS);
    await settle();
    expect(useLiveBoardStore.getState()).toMatchObject({ board: answer('after'), busy: null });
  });

  it("drops an answer that outlived its identity, and serves the next account's own", async () => {
    const old = deferred<ReturnType<typeof ok>>();
    mocks.post.mockReturnValueOnce(old.promise);
    requestLiveBoard('fr', '2026-10-02');
    // The account changes while the read is out (identityScope resets this module).
    resetLiveBoard();
    mocks.identity = { accountId: 'B', token: 'token-b', deviceId: 'device-b' };
    mocks.post.mockResolvedValueOnce(ok(answer('B')));
    requestLiveBoard('fr', '2026-10-02');
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[1][1]).toEqual({ token: 'token-b', live: true });
    await settle();
    old.resolve(ok(answer('A')));
    await settle();
    expect(useLiveBoardStore.getState().board).toEqual(answer('B'));
  });

  it('serves the request asked when the round ends AT ONCE, inside the window, and only that one', async () => {
    mocks.post.mockResolvedValue(ok(answer('during')));
    requestLiveBoard('fr', '2026-10-02');
    await settle();
    // A guess acknowledged 2s later waits for the window's end…
    vi.advanceTimersByTime(2_000);
    requestLiveBoard('fr', '2026-10-02');
    expect(mocks.post).toHaveBeenCalledTimes(1);
    // …and the end confirmed a second later goes at once, standing for that wait too.
    vi.advanceTimersByTime(1_000);
    mocks.post.mockResolvedValue(ok(answer('ended')));
    requestLiveBoard('fr', '2026-10-02', true);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    await settle();
    expect(useLiveBoardStore.getState()).toMatchObject({ board: answer('ended'), busy: null });
    // Nothing trails behind it: the wait it replaced was served.
    vi.advanceTimersByTime(LIVE_REFRESH_MS * 2);
    expect(mocks.post).toHaveBeenCalledTimes(2);

    // Every other request is throttled again, from the read it made.
    requestLiveBoard('fr', '2026-10-02');
    expect(mocks.post).toHaveBeenCalledTimes(3);
    await settle();
    requestLiveBoard('fr', '2026-10-02');
    vi.advanceTimersByTime(LIVE_REFRESH_MS - 1);
    expect(mocks.post).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1);
    expect(mocks.post).toHaveBeenCalledTimes(4);
  });

  it('keeps ONE flight at a time for the end too: it goes the moment the flight out lands', async () => {
    const out = deferred<ReturnType<typeof ok>>();
    mocks.post.mockReturnValueOnce(out.promise);
    requestLiveBoard('fr', '2026-10-02');
    requestLiveBoard('fr', '2026-10-02', true);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    mocks.post.mockResolvedValueOnce(ok(answer('ended')));
    out.resolve(ok(answer('during')));
    await settle();
    // Not at the window's end: at once.
    expect(mocks.post).toHaveBeenCalledTimes(2);
    await settle();
    expect(useLiveBoardStore.getState()).toMatchObject({ board: answer('ended'), busy: null });
  });

  it('says which day an answer is about', async () => {
    mocks.post.mockResolvedValue(ok(answer('today')));
    requestLiveBoard('fr', '2026-10-02');
    await settle();
    expect(useLiveBoardStore.getState().key).toBe('fr:2026-10-02');
    expect(mocks.post.mock.calls[0][0]).toBe('/board?lang=fr&date=2026-10-02');
  });
});
