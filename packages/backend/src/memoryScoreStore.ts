import {
  SCORE_SUBMISSION_LIMIT,
  dayKey,
  dedupKey,
  type ScoreRow,
  type ScoreStore,
  type ScoreSubmitOutcome,
} from './scoreStore';

interface DedupCount {
  count: number;
  expiresAt: number;
}

// Process-local store for `pnpm backend:dev`: same ScoreStore contract as DynamoDB —
// per-player first-write-wins rows, atomic IP allowance — with no AWS account.
// Restarting the local server intentionally resets this lab data.
//
// `submissionLimit` defaults to the SHARED production rule, so this store's contract test
// pins one number and nothing here can drift from Dynamo's behaviour. It is a parameter
// only because the local SERVER turns the allowance off, loudly and for a stated reason —
// see serve.ts.
export function memoryScoreStore(
  now: () => Date = () => new Date(),
  submissionLimit: number = SCORE_SUBMISSION_LIMIT,
): ScoreStore {
  // Per player: the score AND the published version it was earned on (#203).
  const days = new Map<string, Map<string, { score: number; revision: string }>>();
  const dedup = new Map<string, DedupCount>();
  // Mirror DynamoDB's ClientRequestToken: an internal/replayed identical request must
  // return the same outcome without consuming a second allowance or writing twice.
  const requests = new Map<string, ScoreSubmitOutcome>();

  return {
    async list(key) {
      const rows: ScoreRow[] = [];
      for (const [publicId, row] of days.get(dayKey(key)) ?? []) {
        rows.push({ publicId, score: row.score });
      }
      return rows;
    },

    async getMany(key, publicIds) {
      const day = days.get(dayKey(key));
      const rows: ScoreRow[] = [];
      for (const publicId of new Set(publicIds)) {
        const row = day?.get(publicId);
        if (row !== undefined) rows.push({ publicId, score: row.score });
      }
      return rows;
    },

    async submit(input) {
      const replayed = requests.get(input.requestToken);
      if (replayed) return replayed;

      const settle = (outcome: ScoreSubmitOutcome): ScoreSubmitOutcome => {
        requests.set(input.requestToken, outcome);
        return outcome;
      };

      // Both conditions are one atomic decision, and an existing row is the truer
      // refusal: it is idempotent and consumes no allowance (dynamoScoreStore's order).
      const day = days.get(dayKey(input)) ?? new Map<string, { score: number; revision: string }>();
      // First write wins PER VERSION (dynamoScoreStore.ts states why): a row earned on a
      // REPUBLISHED puzzle belongs to a round that has already started over.
      const held = day.get(input.publicId);
      if (held && held.revision === input.revision) return settle('already_recorded');

      const dKey = dedupKey(input, input.ipHash);
      const existing = dedup.get(dKey);
      const nowSeconds = Math.floor(now().getTime() / 1000);
      const active = existing && existing.expiresAt > nowSeconds ? existing : undefined;
      if (active && active.count >= submissionLimit) return settle('capped');

      dedup.set(dKey, { count: (active?.count ?? 0) + 1, expiresAt: input.expiresAt });
      day.set(input.publicId, { score: input.score, revision: input.revision });
      days.set(dayKey(input), day);
      return settle('recorded');
    },
  };
}
