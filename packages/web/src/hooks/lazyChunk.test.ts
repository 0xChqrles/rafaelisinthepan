import { describe, expect, it, vi } from 'vitest';
import { lazyChunk } from './lazyChunk';

// CONTRACT: a chunk that failed to load is asked for AGAIN by the next caller — a failed
// idle preload must never poison the later, user-visible load (the reason this is not
// `React.lazy`, which caches a rejection) — and one that arrived is never fetched twice.
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

  it('shares one request between callers while it is in flight', async () => {
    const importer = vi.fn(() => new Promise<{ default: () => null }>(() => {}));
    const chunk = lazyChunk(importer);
    chunk.preload();
    chunk.preload();
    await settle();
    expect(importer).toHaveBeenCalledTimes(1);
  });
});
