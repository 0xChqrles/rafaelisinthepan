// A day's puzzle, kept once it has been fetched and parsed (user-decided 2026-09-11: going
// back and forth between today's result and tomorrow's round "makes the navigation slow
// and interrupted many times by the loading state").
//
// A sentence puzzle is megabytes of rank maps. The browser's HTTP cache usually spares the
// NETWORK on a revisit (the route is served `max-age=300`), but the app still decompressed
// and parsed that JSON on every mount, which is the LOADING beat a phone shows on every
// arrival. This keeps the PARSED object instead, under two bounds that are the whole safety
// argument:
//
//   COUNT — the last `PUZZLE_CACHE_MAX` days, oldest out. Every entry pins megabytes of
//           heap; three covers today ↔ tomorrow ↔ one archive day, and it is the bound the
//           round engine already applies to its conversations for the same reason.
//   AGE   — an entry expires after `PUZZLE_CACHE_TTL_MS`, the SAME 300 seconds the CDN
//           caches the route for. So this makes nothing staler than it already is: a
//           republish shows up on the schedule it always did, and the round engine handles
//           the revision change when it does.
//
// A MISSING day (404) is never cached — a day published a minute later must show up — and
// an in-flight request is SHARED, so a fast back-and-forth cannot fire two fetches for one
// day. Nothing is persisted: a reload pays one fetch, which is fine.

export const PUZZLE_CACHE_MAX = 3;
export const PUZZLE_CACHE_TTL_MS = 300_000;

interface Entry<T> {
  value: T;
  at: number;
}

export interface PuzzleCache<T> {
  // The cached value, or null when there is none (or it has expired). A hit is also the
  // most recently used entry from then on.
  get(key: string): T | null;
  // Fetch through the cache: a hit answers at once, an in-flight request for the same key
  // is joined, and a `null` answer (a missing day) is handed back but never kept.
  load(key: string, fetcher: () => Promise<T | null>): Promise<T | null>;
  clear(): void;
}

export function createPuzzleCache<T>(
  now: () => number = () => Date.now(),
  max = PUZZLE_CACHE_MAX,
  ttlMs = PUZZLE_CACHE_TTL_MS,
): PuzzleCache<T> {
  // Map iterates in insertion order, so re-inserting on a hit is what makes it an LRU.
  const entries = new Map<string, Entry<T>>();
  const inflight = new Map<string, Promise<T | null>>();

  const get = (key: string): T | null => {
    const entry = entries.get(key);
    if (!entry) return null;
    if (now() - entry.at > ttlMs) {
      entries.delete(key);
      return null;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  };

  const set = (key: string, value: T): void => {
    entries.delete(key);
    entries.set(key, { value, at: now() });
    for (const oldest of entries.keys()) {
      if (entries.size <= max) break;
      entries.delete(oldest);
    }
  };

  return {
    get,
    load(key, fetcher) {
      const hit = get(key);
      if (hit !== null) return Promise.resolve(hit);
      const pending = inflight.get(key);
      if (pending) return pending;
      const request = fetcher().then(
        (value) => {
          inflight.delete(key);
          if (value !== null) set(key, value);
          return value;
        },
        (error: unknown) => {
          inflight.delete(key);
          throw error;
        },
      );
      inflight.set(key, request);
      return request;
    },
    clear() {
      entries.clear();
      inflight.clear();
    },
  };
}
