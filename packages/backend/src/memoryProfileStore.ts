import type { ProfileRecord, ProfileStore } from './profileStore';

// Process-local store for `pnpm backend:dev` and tests: the same ProfileStore contract
// as DynamoDB with no AWS account. Restarting the local server intentionally resets it.
export function memoryProfileStore(): ProfileStore {
  const profiles = new Map<string, ProfileRecord>();

  return {
    async get(publicId) {
      return profiles.get(publicId) ?? null;
    },

    async upsert(input) {
      profiles.set(input.publicId, {
        publicId: input.publicId,
        name: input.name,
        avatar: input.avatar,
      });
    },
  };
}
