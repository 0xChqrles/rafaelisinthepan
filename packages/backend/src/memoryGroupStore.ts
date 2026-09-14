import {
  GROUP_MEMBERS_MAX,
  GROUPS_MAX,
  byJoinedAt,
  successionFor,
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
        rows.push({ id, name: group.name, joinedAt });
      }
      return byJoinedAt(rows, (row) => row.id);
    },

    async create({ id, name, createdBy, now }) {
      if (countMine(createdBy) >= GROUPS_MAX) return 'group_limit';
      if (!(await accountExists(createdBy))) return 'gone';
      // Create-only, like the production Put: a minted id never collides in practice, and
      // an id that did must not overwrite somebody else's group.
      if (groups.has(id)) throw new Error(`group ${id} already exists`);
      groups.set(id, { id, name, createdBy, createdAt: now, membershipVersion: 0 });
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
      // Recheck after the asynchronous account lookup, before the indivisible write.
      const group = groups.get(id);
      if (!group) return 'unknown_group';
      if (of(id).has(publicId)) return 'already';
      groups.set(id, { ...group, membershipVersion: group.membershipVersion + 1 });
      members.set(publicId, now);
      memberships.set(id, members);
      return 'joined';
    },

    async leave(id, publicId, options) {
      const group = groups.get(id);
      if (!options && group) {
        options = successionFor(group, await this.members(id), publicId).options;
        return this.leave(id, publicId, options);
      }
      if (options && (!group || group.membershipVersion !== options.expectedVersion)) return false;
      of(id).delete(publicId);
      if (!group) return true;
      if (options?.deleteGroup) {
        groups.delete(id);
        memberships.delete(id);
      } else {
        groups.set(id, {
          ...group,
          createdBy: options?.successor ?? group.createdBy,
          membershipVersion: group.membershipVersion + 1,
        });
      }
      return true;
    },

    async leaveAll(publicId) {
      for (let pass = 0; pass < 4; pass += 1) {
        const mine = await this.listMine(publicId);
        if (mine.length === 0) return;
        for (const held of mine) {
          const group = await this.get(held.id);
          const members = await this.members(held.id);
          await this.leave(held.id, publicId, group ? successionFor(group, members, publicId).options : undefined);
        }
      }
      throw new Error(`Group departure of ${publicId} did not converge.`);
    },
  };
}
