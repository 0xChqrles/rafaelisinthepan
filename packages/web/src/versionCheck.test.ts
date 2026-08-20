import { afterEach, describe, expect, it, vi } from 'vitest';
import { installVersionCheck } from './versionCheck';

// The observable is WHEN location.reload is spent: at the page's own STARTUP (the only
// trigger that can catch a tab which LOADED stale), on a return to a page that was left
// — a visibility flip or a bfcache restore — and never while the tab is visibly in use.
function harness(visibility: 'visible' | 'hidden' = 'visible', storage: 'ok' | 'denied' = 'ok') {
  const listeners: Array<() => void> = [];
  const restores: Array<(event: { persisted: boolean }) => void> = [];
  const intervals: Array<() => void> = [];
  const reload = vi.fn();
  const stored = new Map<string, string>();
  const doc = {
    visibilityState: visibility,
    addEventListener: (_type: string, fn: () => void) => listeners.push(fn),
  };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('location', { reload });
  const win: Record<string, unknown> = {
    setInterval: (fn: () => void) => {
      intervals.push(fn);
      return 0;
    },
    // Lazy wrappers so vi.useFakeTimers() (installed per test, after the harness)
    // still intercepts the module's abort timer.
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: Parameters<typeof clearTimeout>[0]) => clearTimeout(id),
    addEventListener: (type: string, fn: (event: { persisted: boolean }) => void) => {
      if (type === 'pageshow') restores.push(fn);
    },
  };
  // The startup reload is budgeted per build in session storage; a fresh map per test
  // keeps that budget from leaking between them. 'denied' is the disabled-storage case,
  // where the PROPERTY itself throws.
  if (storage === 'ok') {
    win.sessionStorage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    };
  } else {
    Object.defineProperty(win, 'sessionStorage', {
      get() {
        throw new Error('storage disabled');
      },
    });
  }
  vi.stubGlobal('window', win);

  // The check settles over a few microtask hops (fetch, then json); a macrotask
  // covers them all with real timers.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    reload,
    settle,
    flip(state: 'visible' | 'hidden') {
      doc.visibilityState = state;
      for (const fn of listeners) fn();
    },
    // A bfcache restore hands back the live page; `persisted: false` is an ordinary load.
    show(persisted: boolean) {
      for (const fn of restores) fn({ persisted });
    },
    tick() {
      for (const fn of intervals) fn();
    },
    // Past the startup beat (which has its own tests below), so a test about returns
    // reads only the reloads its returns spent.
    async started(current: string) {
      installVersionCheck(current);
      await settle();
      reload.mockClear();
    },
  };
}

function servedBuild(build: unknown) {
  const mock = vi.fn(async () => ({ ok: true, json: async () => ({ build }) }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('installVersionCheck', () => {
  it('reloads a tab that LOADED stale, visible or not', async () => {
    const h = harness('visible');
    const fetchMock = servedBuild('new');
    installVersionCheck('old');

    await h.settle();
    expect(h.reload).toHaveBeenCalled();
    // The abortable fetch is what keeps a stalled request from pinning the in-flight
    // promise and disabling every later check for the session.
    expect(fetchMock).toHaveBeenCalledWith(
      '/version.json',
      expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }),
    );
  });

  it('spends the startup reload ONCE per build, so a version.json ahead of its index cannot spin', async () => {
    const h = harness('visible');
    servedBuild('new');

    installVersionCheck('old');
    await h.settle();
    expect(h.reload).toHaveBeenCalledTimes(1);

    // The reloaded page comes back on the same build — the mismatch is the deploy's own
    // upload window, not something a second reload can fix.
    installVersionCheck('old');
    await h.settle();
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('leaves the startup reload unspent when storage cannot bound it, and returns still carry it', async () => {
    const h = harness('hidden', 'denied');
    servedBuild('new');

    installVersionCheck('old');
    await h.settle();
    expect(h.reload).not.toHaveBeenCalled();

    h.flip('visible');
    expect(h.reload).toHaveBeenCalled();
  });

  it('reloads on tab-return when the deployed build differs', async () => {
    const h = harness('hidden');
    servedBuild('same');
    await h.started('same');

    servedBuild('new'); // a deploy while the tab sat in the background
    h.flip('visible');
    await h.settle();
    expect(h.reload).toHaveBeenCalled();
  });

  it('reloads on a bfcache restore, which reports no visibility flip of its own', async () => {
    const h = harness('visible');
    servedBuild('same');
    await h.started('same');

    servedBuild('new'); // a deploy while the page sat in the back/forward cache
    h.show(true);
    await h.settle();
    expect(h.reload).toHaveBeenCalled();
  });

  it('ignores a pageshow that is an ordinary load — startup already answered for it', async () => {
    const h = harness('visible');
    servedBuild('same');
    await h.started('same');

    servedBuild('new');
    h.show(false);
    await h.settle();
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('checks at backgrounding and swaps while the tab is hidden', async () => {
    const h = harness('visible');
    servedBuild('same');
    await h.started('same');

    servedBuild('new');
    h.flip('hidden');
    await h.settle();
    expect(h.reload).toHaveBeenCalled();
  });

  it('does not reload while the deployed build matches, nor on a build it cannot read', async () => {
    const h = harness('hidden');
    servedBuild('same');
    await h.started('same');

    h.flip('visible');
    await h.settle();

    servedBuild(undefined);
    h.flip('hidden');
    h.flip('visible');
    await h.settle();
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('a failed check is silent, and the next trigger retries', async () => {
    const h = harness('hidden');
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    await h.started('old');

    h.flip('visible');
    await h.settle();
    expect(h.reload).not.toHaveBeenCalled();

    servedBuild('new');
    h.flip('hidden');
    h.flip('visible');
    await h.settle();
    expect(h.reload).toHaveBeenCalled();
  });

  it('aborts a stalled request so the next trigger can retry', async () => {
    const h = harness('hidden');
    // A fetch that never settles on its own — only the abort signal can end it.
    const fetchMock = vi.fn(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    // The startup check is the request that hangs; triggers while it does join it
    // instead of spawning another.
    installVersionCheck('old');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    h.flip('visible');
    h.flip('hidden');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The abort timer fires, the hung promise rejects, and the checker is free again.
    await vi.advanceTimersByTimeAsync(10_000);
    h.flip('hidden');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('a mismatch the interval finds never yanks a visible tab — the next return spends it', async () => {
    const h = harness('visible');
    servedBuild('same');
    await h.started('same');

    servedBuild('new');
    h.tick();
    await h.settle();
    expect(h.reload).not.toHaveBeenCalled();

    h.flip('hidden');
    expect(h.reload).toHaveBeenCalled();
  });

  it('a hidden tab swaps as soon as the interval finds the mismatch', async () => {
    const h = harness('hidden');
    servedBuild('same');
    await h.started('same');

    servedBuild('new');
    h.tick();
    await h.settle();
    expect(h.reload).toHaveBeenCalled();
  });
});
