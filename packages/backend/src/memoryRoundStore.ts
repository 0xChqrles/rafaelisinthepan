import { ROUND_GUESS_CAP, ROUND_WRITE_MIN_MS } from '@whippin/shared';
import {
  roundPartition,
  roundSortKey,
  type RoundAppendInput,
  type RoundKey,
  type RoundState,
  type RoundStore,
} from './roundStore';

interface RoundItem {
  guesses: string[];
  puzzle: string;
  createdAt: string;
  lastWriteAt: number;
}

// Process-local store for `pnpm backend:dev`: the same RoundStore contract as DynamoDB —
// one append-or-refuse decision per write under both bounds, plus the puzzle-identity
// restart — with no AWS account. Restarting the local server intentionally resets this lab
// data. The bound constants are imported from @whippin/shared rather than parameterized, so
// this implementation cannot drift from the production condition it mirrors.
export function memoryRoundStore(): RoundStore {
  const rounds = new Map<string, RoundItem>();
  const itemKey = (key: RoundKey, publicId: string) =>
    `${roundPartition(publicId)}/${roundSortKey(key)}`;

  const stateOf = (item: RoundItem): RoundState => ({
    guesses: [...item.guesses],
    createdAt: item.createdAt,
  });

  return {
    async get(key, publicId, puzzle) {
      const item = rounds.get(itemKey(key, publicId));
      // A record naming a DIFFERENT puzzle is an honest "nothing stored for this one"
      // (roundStore.ts): the daily was re-published under the same key.
      if (!item || item.puzzle !== puzzle) return null;
      return stateOf(item);
    },

    async append(input: RoundAppendInput) {
      const id = itemKey(input, input.publicId);
      const existing = rounds.get(id);
      const nowMs = input.now.getTime();
      const paced = !existing || existing.lastWriteAt < nowMs - ROUND_WRITE_MIN_MS;

      // The route never sends an over-cap batch, but the store owns the invariant:
      // refuse rather than create (or restart) a record born past the cap.
      if (input.guesses.length > ROUND_GUESS_CAP) {
        return { outcome: 'round_full' as const, state: existing ? stateOf(existing) : empty() };
      }

      // A RETIRED puzzle's log: the round restarted under the same key, so the batch
      // REPLACES it rather than growing it. The interval still applies — otherwise
      // varying the tag would be a way around the rate bound.
      if (!existing || existing.puzzle !== input.puzzle) {
        if (existing && !paced) return { outcome: 'too_fast' as const, state: stateOf(existing) };
        const item: RoundItem = {
          guesses: [...input.guesses],
          puzzle: input.puzzle,
          createdAt: input.now.toISOString(),
          lastWriteAt: nowMs,
        };
        rounds.set(id, item);
        return { outcome: 'appended' as const, state: stateOf(item) };
      }

      // Cap first, then interval — the same order the Dynamo classification reads them
      // in, so a doubly-refused append answers round_full on both backends.
      if (existing.guesses.length + input.guesses.length > ROUND_GUESS_CAP) {
        return { outcome: 'round_full' as const, state: stateOf(existing) };
      }
      if (!paced) return { outcome: 'too_fast' as const, state: stateOf(existing) };
      existing.guesses.push(...input.guesses);
      existing.lastWriteAt = nowMs;
      return { outcome: 'appended' as const, state: stateOf(existing) };
    },
  };
}

function empty(): RoundState {
  return { guesses: [], createdAt: '' };
}
