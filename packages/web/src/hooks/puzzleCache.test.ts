// CONTRACT (2026-09-11): parsed puzzles are kept across mounts under two bounds — the last
// PUZZLE_CACHE_MAX days, and no longer than the CDN's own 300s — a missing day is never
// kept, and one in-flight request serves every concurrent asker.

import { describe, expect, it, vi } from 'vitest';
import { createPuzzleCache, PUZZLE_CACHE_MAX, PUZZLE_CACHE_TTL_MS } from './puzzleCache';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('puzzleCache', () => {
  it('answers a second load from memory without fetching again', async () => {
    const c = clock();
    const cache = createPuzzleCache<{ id: string }>(c.now);
    const fetcher = vi.fn(async () => ({ id: 'a' }));
    expect(await cache.load('fr:2026-09-11', fetcher)).toEqual({ id: 'a' });
    expect(await cache.load('fr:2026-09-11', fetcher)).toEqual({ id: 'a' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.get('fr:2026-09-11')).toEqual({ id: 'a' });
  });

  it('keeps only the last PUZZLE_CACHE_MAX days, the oldest out first', async () => {
    const c = clock();
    const cache = createPuzzleCache<number>(c.now);
    for (let i = 0; i <= PUZZLE_CACHE_MAX; i += 1) {
      await cache.load(`day${i}`, async () => i);
    }
    expect(cache.get('day0')).toBeNull();
    expect(cache.get(`day${PUZZLE_CACHE_MAX}`)).toBe(PUZZLE_CACHE_MAX);
  });

  it('a hit counts as most recently used', async () => {
    const c = clock();
    const cache = createPuzzleCache<number>(c.now);
    for (let i = 0; i < PUZZLE_CACHE_MAX; i += 1) await cache.load(`day${i}`, async () => i);
    expect(cache.get('day0')).toBe(0); // touched: no longer the oldest
    await cache.load('extra', async () => 99);
    expect(cache.get('day0')).toBe(0);
    expect(cache.get('day1')).toBeNull();
  });

  it("expires an entry after the CDN's own TTL — no staler than the route already is", async () => {
    const c = clock();
    const cache = createPuzzleCache<number>(c.now);
    const fetcher = vi.fn(async () => 1);
    await cache.load('k', fetcher);
    c.advance(PUZZLE_CACHE_TTL_MS);
    expect(cache.get('k')).toBe(1);
    c.advance(1);
    expect(cache.get('k')).toBeNull();
    await cache.load('k', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('never keeps a MISSING day, so one published later shows up', async () => {
    const cache = createPuzzleCache<number>(clock().now);
    const fetcher = vi.fn(async () => null);
    expect(await cache.load('k', fetcher)).toBeNull();
    expect(await cache.load('k', fetcher)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('shares ONE in-flight request between concurrent askers', async () => {
    const cache = createPuzzleCache<number>(clock().now);
    let resolve!: (n: number) => void;
    const fetcher = vi.fn(() => new Promise<number>((r) => { resolve = r; }));
    const a = cache.load('k', fetcher);
    const b = cache.load('k', fetcher);
    resolve(7);
    expect(await Promise.all([a, b])).toEqual([7, 7]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('a failed fetch keeps nothing and lets the next load try again', async () => {
    const cache = createPuzzleCache<number>(clock().now);
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('HTTP 500')).mockResolvedValueOnce(3);
    await expect(cache.load('k', fetcher)).rejects.toThrow('HTTP 500');
    expect(await cache.load('k', fetcher)).toBe(3);
  });
});
