import { ROUND_GUESS_CAP, ROUND_WRITE_MIN_MS } from '@whippin/shared';
import {
  roundPartition,
  type RoundAppendInput,
  type RoundState,
  type RoundStore,
} from './roundStore';

interface RoundItem {
  guesses: string[];
  createdAt: string;
  lastWriteAt: number;
}

// Process-local store for `pnpm backend:dev`: the same RoundStore contract as DynamoDB —
// one append-or-refuse decision per write under both bounds — with no AWS account.
// Restarting the local server intentionally resets this lab data. The bound constants are
// imported from @whippin/shared rather than parameterized, so this implementation cannot
// drift from the production condition it mirrors.
export function memoryRoundStore(): RoundStore {
  const rounds = new Map<string, Map<string, RoundItem>>();

  const stateOf = (item: RoundItem): RoundState => ({
    guesses: [...item.guesses],
    createdAt: item.createdAt,
  });

  return {
    async get(key, publicId) {
      const item = rounds.get(roundPartition(key))?.get(publicId);
      return item ? stateOf(item) : null;
    },

    async append(input) {
      const partition = rounds.get(roundPartition(input)) ?? new Map<string, RoundItem>();
      rounds.set(roundPartition(input), partition);
      const existing = partition.get(input.publicId);
      const nowMs = input.now.getTime();

      if (!existing) {
        // The route never sends an over-cap batch, but the store owns the invariant:
        // refuse rather than create a record born past the cap.
        if (input.guesses.length > ROUND_GUESS_CAP) {
          return { outcome: 'round_full', state: { guesses: [], createdAt: '' } };
        }
        const item: RoundItem = {
          guesses: [...input.guesses],
          createdAt: input.now.toISOString(),
          lastWriteAt: nowMs,
        };
        partition.set(input.publicId, item);
        return { outcome: 'appended', state: stateOf(item) };
      }

      // Cap first, then interval — the same order the Dynamo classification reads them
      // in, so a doubly-refused append answers round_full on both backends.
      if (existing.guesses.length + input.guesses.length > ROUND_GUESS_CAP) {
        return { outcome: 'round_full', state: stateOf(existing) };
      }
      if (existing.lastWriteAt >= nowMs - ROUND_WRITE_MIN_MS) {
        return { outcome: 'too_fast', state: stateOf(existing) };
      }
      existing.guesses.push(...input.guesses);
      existing.lastWriteAt = nowMs;
      return { outcome: 'appended', state: stateOf(existing) };
    },
  };
}
