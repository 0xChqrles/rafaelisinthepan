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
// first-write-wins per published revision, with an atomic allowance on row creation only —
// and no AWS account.
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

      const day = days.get(dayKey(input)) ?? new Map<string, { score: number; revision: string }>();
      // First write wins PER VERSION (dynamoScoreStore.ts states why): a row earned on a
      // REPUBLISHED puzzle belongs to a round that has already started over. Replacing it
      // consumes no allowance because it does not add a player to the population.
      const held = day.get(input.publicId);
      if (held && held.revision === input.revision) return settle('already_recorded');
      if (held) {
        day.set(input.publicId, { score: input.score, revision: input.revision });
        return settle('recorded');
      }

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

    // #204's active-day transfer: the recorded row follows the round it was derived from.
    // It spends no allowance — the population gains no player, it renames the one it has —
    // and it is refused when the destination already holds a row of its own.
    async transfer(key, from, to) {
      const day = days.get(dayKey(key));
      const row = day?.get(from);
      if (!day || !row) return false;
      if (day.has(to)) return false;
      day.set(to, row);
      day.delete(from);
      return true;
    },
  };
}
