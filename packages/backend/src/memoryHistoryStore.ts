import { boundSolvedDays } from '@whippin/shared';
import type { PlayerHistoryStore } from './historyStore';

// Process-local store for `pnpm backend:dev` and tests: the same PlayerHistoryStore
// contract as DynamoDB with no AWS account. Restarting the local server intentionally
// resets it — the collection is a rebuildable cache of the round rows, which reset with it.
export function memoryHistoryStore(): PlayerHistoryStore {
  const days = new Map<string, Set<number>>();
  const key = (publicId: string, lang: string) => `${publicId}#${lang}`;

  return {
    async solvedDays(publicId, lang) {
      // Bounded on the way OUT as well as in, the Dynamo store's rule: a row that somehow
      // grew past the cap still answers inside it.
      return boundSolvedDays([...(days.get(key(publicId, lang)) ?? [])]);
    },

    async recordSolvedDay(input) {
      const id = key(input.publicId, input.lang);
      const set = days.get(id) ?? new Set<number>();
      set.add(input.day);
      // The bound applies to what is KEPT, not only to what is read — mirroring the
      // Dynamo store's overflow rewrite, so both backends hold the same collection.
      days.set(id, new Set(boundSolvedDays([...set])));
    },
  };
}
