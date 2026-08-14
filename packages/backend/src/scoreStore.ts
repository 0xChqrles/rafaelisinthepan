import type { ScoreMode } from './scoreBuckets';

export const SCORE_SUBMISSION_LIMIT = 5;
export const SCORE_DEDUP_TTL_SECONDS = 48 * 60 * 60;

export interface ScoreKey {
  date: string;
  lang: string;
  mode: ScoreMode;
}

export interface StoredHistogram {
  buckets: number[];
  total: number;
}

export interface ScoreIncrement extends ScoreKey {
  ipHash: string;
  bucket: number;
  bucketCount: number;
  expiresAt: number;
  requestToken: string;
}

export interface ScoreStore {
  get(key: ScoreKey, bucketCount: number): Promise<StoredHistogram>;
  // The dedup cap and aggregate increment are one atomic decision. false means the IP's
  // allowance is exhausted and no bucket changed.
  increment(input: ScoreIncrement): Promise<boolean>;
}

export function aggregateKey(key: ScoreKey): string {
  return `score#${key.date}#${key.lang}#${key.mode}`;
}

export function dedupKey(key: ScoreKey, ipHash: string): string {
  return `dedup#${key.date}#${key.lang}#${key.mode}#${ipHash}`;
}
