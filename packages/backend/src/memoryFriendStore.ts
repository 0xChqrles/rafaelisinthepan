import { FRIENDS_MAX, type FriendStore } from './friendStore';

// Process-local store for `pnpm backend:dev` and tests: the same FriendStore contract as
// DynamoDB — mutual edges written and deleted as one indivisible pair, the same cap on both
// sides — with no AWS account. Restarting the local server intentionally resets the graph.
export function memoryFriendStore(): FriendStore {
  // publicId -> friendId -> createdAt.
  const edges = new Map<string, Map<string, string>>();
  const own = (publicId: string) => edges.get(publicId) ?? new Map<string, string>();

  return {
    async list(publicId) {
      // Sorted, mirroring DynamoDB's sort-key order, so the two implementations answer the
      // same call the same way.
      return [...own(publicId).keys()].sort();
    },

    async link({ publicId, friendId, createdAt }) {
      const mine = own(publicId);
      if (mine.has(friendId)) return 'already_linked';
      if (mine.size >= FRIENDS_MAX) return 'capped';
      const theirs = own(friendId);
      if (theirs.size >= FRIENDS_MAX) return 'capped';

      // Both directions in one step — nothing here can observe a half-edge.
      mine.set(friendId, createdAt);
      theirs.set(publicId, theirs.get(publicId) ?? createdAt);
      edges.set(publicId, mine);
      edges.set(friendId, theirs);
      return 'linked';
    },

    async unlink(publicId, friendId) {
      own(publicId).delete(friendId);
      own(friendId).delete(publicId);
    },
  };
}
