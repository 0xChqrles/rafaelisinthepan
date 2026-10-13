// CONTRACT (user-decided 2026-10-13: "they need to have an instant reload when there's a new
// sentence"): the page reloads onto a republished sentence — when a round's write is answered
// PUZZLE_CHANGED, and when its own revalidation of the puzzle reads another revision — and on
// nothing it cannot read, never twice in a row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_MS,
  RELOAD_GAP_MS,
  RETRY_MS,
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
    expect(readAnswer(200, `W/"${NEW}"`, SHOWN)).toBe('changed');
    expect(readAnswer(200, null, SHOWN)).toBe('unknown');
    expect(readAnswer(404, `"${NEW}"`, SHOWN)).toBe('unknown');
    expect(readAnswer(500, null, SHOWN)).toBe('unknown');
  });
});

describe('the watch', () => {
  it('reloads onto a new sentence, fetched whole first, and asks the CDN again after', async () => {
    const h = harness();
    const changed = answer(200, `"${NEW}"`);
    h.fetch.mockResolvedValueOnce(changed);
    watchSentence(URL, SHOWN);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch).toHaveBeenCalledWith(URL, expect.objectContaining({ cache: 'no-cache' }));
    expect(changed.arrayBuffer).toHaveBeenCalled();
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

  it('reloads at most once per gap, so an edge still on the old sentence cannot spin the page', async () => {
    const h = harness();
    h.fetch.mockResolvedValue(answer(200, `"${NEW}"`));
    watchSentence(URL, SHOWN);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reload).toHaveBeenCalledTimes(1);
    // The reload did not take (the test's page stays): the next ask inside the gap holds.
    await vi.advanceTimersByTimeAsync(RELOAD_GAP_MS - 1);
    expect(h.reload).toHaveBeenCalledTimes(1);
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
