import {
  GROUP_MEMBERS_MAX,
  GROUPS_MAX,
  byJoinedAt,
  type GroupMember,
  type GroupMembership,
  type GroupRecord,
  type GroupStore,
} from './groupStore';

// Process-local store for `pnpm backend:dev` and tests: the same GroupStore contract as
// DynamoDB — a membership written and deleted as one indivisible pair, the same two caps
// counted the same way — with no AWS account. Restarting the local server intentionally
// resets every group.
//
// `accountExists` is the DEVICE store's answer (#204), injected for the reason the
// profile store injects it: two in-memory copies of "does this account exist" would drift
// exactly where a deleted account must stop joining anything.
export function memoryGroupStore(
  accountExists: (publicId: string) => boolean | Promise<boolean> = () => true,
): GroupStore {
  const groups = new Map<string, GroupRecord>();
  // group id -> publicId -> joinedAt.
  const memberships = new Map<string, Map<string, string>>();
  const of = (id: string) => memberships.get(id) ?? new Map<string, string>();
  const countMine = (publicId: string) =>
    [...memberships.values()].filter((members) => members.has(publicId)).length;

  return {
    async get(id) {
      return groups.get(id) ?? null;
    },

    async members(id) {
      const rows: GroupMember[] = [...of(id)].map(([publicId, joinedAt]) => ({ publicId, joinedAt }));
      return byJoinedAt(rows, (row) => row.publicId);
    },

    async listMine(publicId) {
      const rows: GroupMembership[] = [];
      for (const [id, members] of memberships) {
        const joinedAt = members.get(publicId);
        const group = groups.get(id);
        if (joinedAt === undefined || !group) continue;
        rows.push({ id, name: group.name, createdBy: group.createdBy, joinedAt });
      }
      return byJoinedAt(rows, (row) => row.id);
    },

    async create({ id, name, createdBy, now }) {
      if (countMine(createdBy) >= GROUPS_MAX) return 'group_limit';
      if (!(await accountExists(createdBy))) return 'gone';
      // Create-only, like the production Put: a minted id never collides in practice, and
      // an id that did must not overwrite somebody else's group.
      if (groups.has(id)) throw new Error(`group ${id} already exists`);
      groups.set(id, { id, name, createdBy, createdAt: now });
      memberships.set(id, new Map([[createdBy, now]]));
      return 'created';
    },

    async join({ id, publicId, now }) {
      if (!groups.has(id)) return 'unknown_group';
      const members = of(id);
      if (members.has(publicId)) return 'already';
      if (members.size >= GROUP_MEMBERS_MAX) return 'group_full';
      if (countMine(publicId) >= GROUPS_MAX) return 'group_limit';
      if (!(await accountExists(publicId))) return 'gone';
      members.set(publicId, now);
      memberships.set(id, members);
      return 'joined';
    },

    async leave(id, publicId) {
      of(id).delete(publicId);
    },

    async leaveAll(publicId) {
      for (const members of memberships.values()) members.delete(publicId);
    },
  };
}
