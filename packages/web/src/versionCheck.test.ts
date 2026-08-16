import { afterEach, describe, expect, it, vi } from 'vitest';
import { installVersionCheck } from './versionCheck';

// The observable is WHEN location.reload is spent: on a visibility flip, never while the
// tab is visibly in use — the module's whole contract.
function harness(visibility: 'visible' | 'hidden' = 'visible') {
  const listeners: Array<() => void> = [];
  const intervals: Array<() => void> = [];
  const reload = vi.fn();
  const doc = {
    visibilityState: visibility,
    addEventListener: (_type: string, fn: () => void) => listeners.push(fn),
  };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('location', { reload });
  vi.stubGlobal('window', {
    setInterval: (fn: () => void) => {
      intervals.push(fn);
      return 0;
    },
  });
  return {
    reload,
    flip(state: 'visible' | 'hidden') {
      doc.visibilityState = state;
      for (const fn of listeners) fn();
    },
    tick() {
      for (const fn of intervals) fn();
    },
    // The check settles over a few microtask hops (fetch, then json); a macrotask
    // covers them all with real timers.
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

function servedBuild(build: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ build }) })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('installVersionCheck', () => {
  it('reloads on tab-return when the deployed build differs', async () => {
    const h = harness('hidden');
    servedBuild('new');
    installVersionCheck('old');

    h.flip('visible');
    await h.settle();
    expect(h.reload).toHaveBeenCalled();
  });

  it('does not reload while the deployed build matches, nor on a build it cannot read', async () => {
    const h = harness('hidden');
    installVersionCheck('same');

    servedBuild('same');
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
    installVersionCheck('old');

    h.flip('visible');
    await h.settle();
    expect(h.reload).not.toHaveBeenCalled();

    servedBuild('new');
    h.flip('hidden');
    h.flip('visible');
    await h.settle();
    expect(h.reload).toHaveBeenCalled();
  });

  it('a mismatch the interval finds never yanks a visible tab — the next flip spends it', async () => {
    const h = harness('visible');
    servedBuild('new');
    installVersionCheck('old');

    h.tick();
    await h.settle();
    expect(h.reload).not.toHaveBeenCalled();

    h.flip('hidden');
    expect(h.reload).toHaveBeenCalled();
  });

  it('a hidden tab swaps as soon as the interval finds the mismatch', async () => {
    const h = harness('hidden');
    servedBuild('new');
    installVersionCheck('old');

    h.tick();
    await h.settle();
    expect(h.reload).toHaveBeenCalled();
  });
});
