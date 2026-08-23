import { boundSolvedDays, MAX_SOLVED_DAYS } from '@whippin/shared';
import type { PlayerHistoryStore } from './historyStore';

// Process-local store for `pnpm backend:dev` and tests: the same PlayerHistoryStore
// contract as DynamoDB with no AWS account. Restarting the local server intentionally
// resets it — the collection is a rebuildable cache of the round rows, which reset with it.
//
// NOTHING HERE REPLACES THE COLLECTION (the #211 rule the Dynamo store spells out): a
// credit is an ELEMENT insert and the overflow trim DELETES named elements, mirroring the
// Dynamo store's ADD + DELETE. This process is single-threaded and could get away with a
// whole-set rewrite, but this file is the contract's reference implementation for
// `backend:dev` and the route tests — the next store copied from it must not inherit a
// read-modify-write the real one forbids as a lost update.
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
      days.set(id, set);
      // A day already held is a silent no-op — the Dynamo condition's `contains` clause.
      if (set.has(input.day)) return;
      set.add(input.day);
      // The trim names exactly the elements now beyond the cap, oldest first — the Dynamo
      // store's DELETE, never a rewrite of the whole set.
      const all = [...set].sort((a, b) => a - b);
      for (const drop of all.slice(0, Math.max(0, all.length - MAX_SOLVED_DAYS))) {
        set.delete(drop);
      }
    },
  };
}
