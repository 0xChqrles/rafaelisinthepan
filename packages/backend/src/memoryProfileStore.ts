import type { LinkProfileWrites } from './linkStore';
import type { ProfileRecord, ProfileStore } from './profileStore';

// Process-local store for `pnpm backend:dev` and tests: the same ProfileStore contract
// as DynamoDB with no AWS account. Restarting the local server intentionally resets it.
//
// It also carries #204's `remove`, which is NOT on the ProfileStore contract: in production
// that delete rides inside `dynamoLinkStore`'s one indivisible transaction, so the profile
// store never issues it. See `LinkProfileWrites`.
//
// `live` is answered by an injected predicate rather than a second map: the ACCOUNT rows
// belong to the device store, and two in-memory copies of "does this account exist" would
// drift exactly where #204 needs them not to. `backend:dev` and the route tests pass the
// device store's own reader; a consumer with no account model at all (a unit test dressing
// rows) leaves it out and every player reads as live, which is what the pre-#204 behaviour
// was.
export function memoryProfileStore(
  accountExists: (publicId: string) => boolean | Promise<boolean> = () => true,
): ProfileStore & LinkProfileWrites {
  const profiles = new Map<string, ProfileRecord>();

  return {
    async get(publicId) {
      return { live: await accountExists(publicId), profile: profiles.get(publicId) ?? null };
    },

    async create(input) {
      if (profiles.has(input.publicId)) return false;
      profiles.set(input.publicId, {
        publicId: input.publicId,
        name: input.name,
        avatar: input.avatar,
      });
      return true;
    },

    async upsert(input) {
      profiles.set(input.publicId, {
        publicId: input.publicId,
        name: input.name,
        avatar: input.avatar,
      });
    },

    async remove(publicId) {
      profiles.delete(publicId);
    },
  };
}
