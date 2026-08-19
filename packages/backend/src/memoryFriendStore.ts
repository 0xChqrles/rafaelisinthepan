import { FRIENDS_MAX, type FriendStore } from './friendStore';

// Process-local store for `pnpm backend:dev` and tests: the same FriendStore contract as
// DynamoDB — mutual edges written and deleted as one indivisible pair, the same cap on both
// sides — with no AWS account. Restarting the local server intentionally resets the graph.
export function memoryFriendStore(): FriendStore {
  // publicId -> friendId -> createdAt.
  const edges = new Map<string, Map<string, string>>();
  const own = (publicId: string) => edges.get(publicId) ?? new Map<string, string>();
  // Sorted, mirroring DynamoDB's sort-key order, so the two implementations answer the same
  // call the same way.
  const sorted = (of: Map<string, string>) => [...of.keys()].sort();

  return {
    async list(publicId) {
      return sorted(own(publicId));
    },

    async link({ publicId, friendId, createdAt }) {
      const mine = own(publicId);
      const theirs = own(friendId);
      // The cap gates a pair the caller does not already hold, and both rows are written
      // either way — dynamoFriendStore's semantics exactly, including the re-link that
      // repairs whichever direction is missing.
      const held = mine.has(friendId);
      if (!held) {
        if (mine.size >= FRIENDS_MAX) return { outcome: 'capped', friends: sorted(mine) };
        if (theirs.size >= FRIENDS_MAX) return { outcome: 'capped', friends: sorted(mine) };
      }

      // Both directions in one step — nothing here can observe a half-edge.
      mine.set(friendId, mine.get(friendId) ?? createdAt);
      theirs.set(publicId, theirs.get(publicId) ?? createdAt);
      edges.set(publicId, mine);
      edges.set(friendId, theirs);
      return { outcome: held ? 'already_linked' : 'linked', friends: sorted(mine) };
    },

    async unlink(publicId, friendId) {
      own(publicId).delete(friendId);
      own(friendId).delete(publicId);
    },
  };
}
