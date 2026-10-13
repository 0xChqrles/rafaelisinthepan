// CONTRACT (user-decided 2026-10-13: "they need to have an instant reload when there's a new
// sentence"): the page reloads onto a republished sentence — when a round's write is answered
// PUZZLE_CHANGED, and when its own revalidation of the puzzle reads another revision — and on
// nothing it cannot read, never twice in a row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_MS,
  RELOAD_GAP_MS,
  RETRY_MS,
  noteRoundOver,
  notePuzzleChanged,
  readAnswer,
  resetSentenceWatch,
  takeFreshPuzzle,
  watchSentence,
} from './sentenceWatch';

const URL = 'https://api.test/?lang=fr&date=2026-10-13';
const SHOWN = 'a1b2c3d4e5f60718';
const NEW = 'b2c3d4e5f6071829';

function answer(status: number, etag: string | null) {
  return {
    status,
    headers: new Headers(etag ? { ETag: etag } : {}),
    arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
    body: { cancel: vi.fn(async () => {}) },
  } as unknown as Response;
}

function harness(visibility: 'visible' | 'hidden' = 'visible') {
  const listeners: Array<() => void> = [];
  const reload = vi.fn();
  const stored = new Map<string, string>();
  const doc = {
    visibilityState: visibility,
    addEventListener: (_type: string, fn: () => void) => listeners.push(fn),
  };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', {
    location: { reload },
    addEventListener: () => {},
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    },
  });
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  return {
    reload,
    fetch,
    flip(state: 'visible' | 'hidden') {
      doc.visibilityState = state;
      for (const fn of listeners) fn();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetSentenceWatch();
});

afterEach(() => {
  resetSentenceWatch();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('what an answer says of the sentence on screen', () => {
  it('reads the revision off the ETag, and nothing off an answer it cannot read', () => {
    expect(readAnswer(200, `"${SHOWN}"`, SHOWN)).toBe('same');
    // The revision this tab reloaded away from is a lagging edge, never a newer sentence.
    expect(readAnswer(200, `"${SHOWN}"`, NEW, SHOWN)).toBe('unknown');
    expect(readAnswer(200, `W/"${NEW}"`, SHOWN)).toBe('changed');
    expect(readAnswer(200, null, SHOWN)).toBe('unknown');
    expect(readAnswer(404, `"${NEW}"`, SHOWN)).toBe('unknown');
    expect(readAnswer(500, null, SHOWN)).toBe('unknown');
  });
});

describe('the watch', () => {
  it('reloads onto a new sentence, fetched whole first into the cache the reload reads', async () => {
    const h = harness();
    const changed = answer(200, `"${NEW}"`);
    h.fetch.mockResolvedValueOnce(changed);
    watchSentence(URL, SHOWN);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch).toHaveBeenCalledWith(URL, expect.objectContaining({ cache: 'no-cache' }));
    expect(changed.arrayBuffer).toHaveBeenCalled();
    expect(h.reload).toHaveBeenCalledTimes(1);
    // Stored whole: the reloaded page reads it from the cache, no second ask.
    expect(takeFreshPuzzle(URL)).toBe(false);
  });

  it('still reloads when the new sentence cannot be read in time, and the reload asks again', async () => {
    const h = harness();
    const changed = answer(200, `"${NEW}"`);
    vi.mocked(changed.arrayBuffer).mockRejectedValueOnce(new Error('aborted'));
    h.fetch.mockResolvedValueOnce(changed);
    watchSentence(URL, SHOWN);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reload).toHaveBeenCalledTimes(1);
    // The reloaded page's first fetch of that URL revalidates, once.
    expect(takeFreshPuzzle(URL)).toBe(true);
    expect(takeFreshPuzzle(URL)).toBe(false);
  });

  it('keeps an unchanged sentence, asking again every minute', async () => {
    const h = harness();
    h.fetch.mockResolvedValue(answer(200, `"${SHOWN}"`));
    watchSentence(URL, SHOWN);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('never reloads on an answer it cannot read', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(answer(200, null));
    h.fetch.mockRejectedValueOnce(new Error('offline'));
    watchSentence(URL, SHOWN);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('asks at once on PUZZLE_CHANGED, and again shortly while the CDN still serves the old one', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(answer(200, `"${SHOWN}"`)); // the watch's own first ask
    watchSentence(URL, SHOWN);
    await vi.advanceTimersByTimeAsync(0);

    h.fetch.mockResolvedValueOnce(answer(200, `"${SHOWN}"`)); // the edge not caught up yet
    h.fetch.mockResolvedValueOnce(answer(200, `"${NEW}"`));
    notePuzzleChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('asks nothing out of view, and at once on coming back', async () => {
    const h = harness('hidden');
    h.fetch.mockResolvedValue(answer(200, `"${NEW}"`));
    watchSentence(URL, SHOWN);
    await vi.advanceTimersByTimeAsync(CHECK_MS * 3);
    expect(h.fetch).not.toHaveBeenCalled();
    h.flip('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('reloads at most once per gap, across the reload itself', async () => {
    const h = harness();
    const OTHER = 'c3d4e5f607182930';
    h.fetch.mockResolvedValue(answer(200, `"${NEW}"`));
    watchSentence(URL, SHOWN);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reload).toHaveBeenCalledTimes(1);

    // The RELOADED page (module state gone, the tab's storage kept) still finds another
    // revision — the edge moved on again: inside the gap it holds…
    resetSentenceWatch();
    h.fetch.mockResolvedValue(answer(200, `"${OTHER}"`));
    watchSentence(URL, NEW);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reload).toHaveBeenCalledTimes(1);
    // …and past it, the next minute's ask reloads.
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(h.reload).toHaveBeenCalledTimes(2);
  });

  it('never reloads back onto the sentence it just left, which a lagging edge may still serve', async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(answer(200, `"${NEW}"`));
    watchSentence(URL, SHOWN);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reload).toHaveBeenCalledTimes(1);

    resetSentenceWatch();
    h.fetch.mockResolvedValue(answer(200, `"${SHOWN}"`));
    watchSentence(URL, NEW);
    await vi.advanceTimersByTimeAsync(RELOAD_GAP_MS + CHECK_MS * 2);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('asks about the sentence now on screen when it changed during an ask', async () => {
    const h = harness();
    const B = 'https://api.test/?lang=fr&date=2026-10-12';
    let land: (r: Response) => void = () => {};
    h.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => (land = resolve)));
    const stop = watchSentence(URL, SHOWN);
    await vi.advanceTimersByTimeAsync(0);
    // A's ask is in flight; the player moves to day B.
    stop();
    h.fetch.mockResolvedValue(answer(200, `"${NEW}"`));
    watchSentence(B, SHOWN);
    await vi.advanceTimersByTimeAsync(0);
    land(answer(200, `"${SHOWN}"`));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch).toHaveBeenLastCalledWith(B, expect.anything());
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  // User-decided 2026-10-13: a round already over keeps its result on screen; the reload
  // waits until the player looks away (or comes back).
  it('holds the reload of a round already over until the tab is hidden', async () => {
    const h = harness();
    h.fetch.mockResolvedValue(answer(200, `"${NEW}"`));
    watchSentence(URL, SHOWN);
    noteRoundOver(true);
    await vi.advanceTimersByTimeAsync(CHECK_MS * 3);
    expect(h.reload).not.toHaveBeenCalled();
    // Found once, then nothing more to ask.
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.flip('hidden');
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('spends a held reload on the tab\'s return too', async () => {
    const h = harness();
    h.fetch.mockResolvedValue(answer(200, `"${NEW}"`));
    watchSentence(URL, SHOWN);
    noteRoundOver(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reload).not.toHaveBeenCalled();
    // A return without a hide first (a bfcache restore, a focus the page missed).
    h.flip('visible');
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('reloads a round still being played at once', async () => {
    const h = harness();
    h.fetch.mockResolvedValue(answer(200, `"${NEW}"`));
    watchSentence(URL, SHOWN);
    noteRoundOver(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('drops a held reload when the sentence leaves the screen', async () => {
    const h = harness();
    h.fetch.mockResolvedValue(answer(200, `"${NEW}"`));
    const stop = watchSentence(URL, SHOWN);
    noteRoundOver(true);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    h.flip('hidden');
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('stops when the sentence leaves the screen', async () => {
    const h = harness();
    h.fetch.mockResolvedValue(answer(200, `"${SHOWN}"`));
    const stop = watchSentence(URL, SHOWN);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    notePuzzleChanged();
    await vi.advanceTimersByTimeAsync(CHECK_MS * 2);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});
