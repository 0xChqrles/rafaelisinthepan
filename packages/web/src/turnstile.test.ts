import { afterEach, describe, expect, it, vi } from 'vitest';

interface FakeScript {
  src: string;
  async: boolean;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  remove: ReturnType<typeof vi.fn>;
}

// One list of every script tag the module has appended: the count IS the observable for
// "did this call start a fresh load, or subscribe to the cached one?".
function fakeDocument(): FakeScript[] {
  const scripts: FakeScript[] = [];
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  vi.stubGlobal('document', {
    createElement: vi.fn(() => {
      const script: FakeScript = {
        src: '',
        async: false,
        onload: null,
        onerror: null,
        remove: vi.fn(),
      };
      scripts.push(script);
      return script;
    }),
    head: { appendChild: vi.fn() },
  });
  return scripts;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('turnstileToken — lazy script load', () => {
  it('times out a stalled script and clears the cached promise so a later call retries', async () => {
    vi.useFakeTimers();
    const scripts = fakeDocument();

    const { turnstileToken } = await import('./turnstile');
    const first = turnstileToken('site-key');
    const firstError = first.catch((error: unknown) => error);

    expect(scripts).toHaveLength(1);
    await vi.runOnlyPendingTimersAsync();
    await expect(firstError).resolves.toMatchObject({ message: 'Turnstile script timed out.' });
    expect(scripts[0].remove).toHaveBeenCalledOnce();

    const retry = turnstileToken('site-key');
    const retryError = retry.catch((error: unknown) => error);
    expect(scripts).toHaveLength(2);
    scripts[1].onerror?.();
    await expect(retryError).resolves.toMatchObject({
      message: 'Turnstile script failed to load.',
    });
  });

  it('settles an attempt once, so a late error cannot clobber the retry that replaced it', async () => {
    // An aborted request can still report its error after the timeout gave up on it, by
    // which point the cached promise belongs to a NEWER attempt. Clearing it there would
    // strand that attempt: the calls already waiting on it keep their reference, but the
    // next caller would start a redundant load instead of joining the one in flight.
    vi.useFakeTimers();
    const scripts = fakeDocument();

    const { turnstileToken } = await import('./turnstile');
    const first = turnstileToken('site-key').catch((error: unknown) => error);
    await vi.runOnlyPendingTimersAsync();
    await expect(first).resolves.toMatchObject({ message: 'Turnstile script timed out.' });

    const retry = turnstileToken('site-key').catch((error: unknown) => error);
    expect(scripts).toHaveLength(2);

    // The first attempt's request reports, far too late to mean anything.
    scripts[0].onerror?.();

    // The cached promise still belongs to the second attempt, so this joins it.
    const joined = turnstileToken('site-key').catch((error: unknown) => error);
    expect(scripts).toHaveLength(2);

    scripts[1].onerror?.();
    for (const settled of [retry, joined]) {
      await expect(settled).resolves.toMatchObject({
        message: 'Turnstile script failed to load.',
      });
    }
  });
});
