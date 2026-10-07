// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { lazyChunk } from './lazyChunk';

// CONTRACT: a chunk that failed to load is asked for AGAIN by the next caller — a failed
// idle preload must never poison the later, user-visible load (the reason this is not
// `React.lazy`, which caches a rejection) — and one that arrived is never fetched twice. A
// user-visible load that is lost says so (`failed`), and its RETRY asks again.
describe('lazyChunk', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('retries after a failed preload, and fetches a loaded chunk only once', async () => {
    const Component = () => null;
    const importer = vi
      .fn<() => Promise<{ default: typeof Component }>>()
      .mockRejectedValueOnce(new Error('Chunk download failed'))
      .mockResolvedValue({ default: Component });
    const chunk = lazyChunk(importer);

    chunk.preload();
    await settle();
    expect(importer).toHaveBeenCalledTimes(1);

    chunk.preload();
    await settle();
    expect(importer).toHaveBeenCalledTimes(2);

    chunk.preload();
    await settle();
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it('says a lost user-visible load as FAILED (never a frame of nothing), and one that lands as the component', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const Component = () => null;
    const importer = vi
      .fn<() => Promise<{ default: typeof Component }>>()
      .mockRejectedValueOnce(new Error('Chunk download failed'))
      .mockResolvedValue({ default: Component });
    const chunk = lazyChunk(importer);
    let seen: ReturnType<typeof chunk.useLoaded> | null = null;
    function Probe() {
      seen = chunk.useLoaded();
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Probe)));
    await vi.waitFor(() => expect(seen?.failed).toBe(true));
    expect(seen!.Loaded).toBeNull();
    await act(async () => root.unmount());
    // The next caller asks again (the browser may answer from its module map: RETRY reloads).
    const again = createRoot(document.createElement('div'));
    await act(async () => again.render(createElement(Probe)));
    await vi.waitFor(() => expect(seen?.Loaded).toBe(Component));
    expect(seen!.failed).toBe(false);
    expect(importer).toHaveBeenCalledTimes(2);
    await act(async () => again.unmount());
  });

  it('shares one request between callers while it is in flight', async () => {
    const importer = vi.fn(() => new Promise<{ default: () => null }>(() => {}));
    const chunk = lazyChunk(importer);
    chunk.preload();
    chunk.preload();
    await settle();
    expect(importer).toHaveBeenCalledTimes(1);
  });
});
