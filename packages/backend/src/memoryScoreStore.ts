import {
  SCORE_SUBMISSION_LIMIT,
  aggregateKey,
  dedupKey,
  type ScoreStore,
  type StoredHistogram,
} from './scoreStore';

interface DedupCount {
  count: number;
  expiresAt: number;
}

// Process-local store for `pnpm backend:dev`: same ScoreStore contract and cap as DynamoDB,
// with no AWS account. Restarting the local server intentionally resets this lab data.
export function memoryScoreStore(now: () => Date = () => new Date()): ScoreStore {
  const histograms = new Map<string, StoredHistogram>();
  const dedup = new Map<string, DedupCount>();
  const requests = new Set<string>();

  return {
    async get(key, bucketCount) {
      const stored = histograms.get(aggregateKey(key));
      return {
        buckets: Array.from({ length: bucketCount }, (_unused, index) => stored?.buckets[index] ?? 0),
        total: stored?.total ?? 0,
      };
    },

    async increment(input) {
      // Mirror DynamoDB's ClientRequestToken: an internal/replayed identical request must
      // never consume two allowances or increment twice.
      if (requests.has(input.requestToken)) return true;

      const dKey = dedupKey(input, input.ipHash);
      const existing = dedup.get(dKey);
      const nowSeconds = Math.floor(now().getTime() / 1000);
      const active = existing && existing.expiresAt > nowSeconds ? existing : undefined;
      if (active && active.count >= SCORE_SUBMISSION_LIMIT) return false;

      dedup.set(dKey, { count: (active?.count ?? 0) + 1, expiresAt: input.expiresAt });
      const aKey = aggregateKey(input);
      const current = histograms.get(aKey) ?? {
        buckets: Array.from({ length: input.bucketCount }, () => 0),
        total: 0,
      };
      const buckets = [...current.buckets];
      buckets[input.bucket] = (buckets[input.bucket] ?? 0) + 1;
      histograms.set(aKey, { buckets, total: current.total + 1 });
      requests.add(input.requestToken);
      return true;
    },
  };
}
