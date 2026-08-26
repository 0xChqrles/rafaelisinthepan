import type {
  BootstrapInput,
  DeviceRecord,
  DeviceStore,
  ResolvedDevice,
  AccountRecord,
} from './deviceStore';
import type { LinkDeviceWrites } from './linkStore';

// Process-local store for `pnpm backend:dev` and tests: the same DeviceStore contract as
// DynamoDB with no AWS account. Restarting the local server intentionally resets it — which
// means every local device is signed out, exactly as a wiped table would sign one out.
//
// `initial` seeds identities that should already exist. It is what lets a route test name
// its caller at module level (`memoryScoreStore`'s injected clock and limit are the same
// kind of knob) instead of threading an await through every construction.
// It also carries #204's three link-time writes, which are NOT on the DeviceStore contract:
// in production they ride inside `dynamoLinkStore`'s one indivisible transaction, so the
// device store never issues them. See `LinkDeviceWrites`.
export function memoryDeviceStore(
  initial: readonly BootstrapInput[] = [],
): DeviceStore & LinkDeviceWrites {
  // The base table: token hash -> the ONE device item.
  const devices = new Map<string, DeviceRecord>();
  const accounts = new Map<string, AccountRecord>();

  for (const seed of initial) {
    accounts.set(seed.accountId, { accountId: seed.accountId, createdAt: seed.now });
    devices.set(seed.tokenHash, {
      revokeKey: seed.tokenHash,
      deviceId: seed.deviceId,
      accountId: seed.accountId,
      agent: seed.agent,
      createdAt: seed.now,
      lastSeenAt: seed.now,
    });
  }

  const resolved = (tokenHash: string): ResolvedDevice | null => {
    const device = devices.get(tokenHash);
    if (!device) return null;
    // The account-existence check is part of authentication, not decoration: a device item
    // an account deletion missed must not keep authenticating.
    const account = accounts.get(device.accountId);
    if (!account) return null;
    return { device, account };
  };

  return {
    async resolve(tokenHash) {
      return resolved(tokenHash);
    },

    async accountExists(accountId) {
      return accounts.has(accountId);
    },

    async bootstrap(input) {
      // Idempotent by token hash: a lost answer after a committed write returns what was
      // already created rather than minting a second identity. A device item whose account
      // is GONE resolves null and falls through — bootstrap re-parents the orphaned token
      // onto the fresh identity, the Dynamo store's documented behaviour.
      const existing = resolved(input.tokenHash);
      if (existing) return existing;
      const account: AccountRecord = { accountId: input.accountId, createdAt: input.now };
      const device: DeviceRecord = {
        revokeKey: input.tokenHash,
        deviceId: input.deviceId,
        accountId: input.accountId,
        agent: input.agent,
        createdAt: input.now,
        lastSeenAt: input.now,
      };
      accounts.set(account.accountId, account);
      devices.set(input.tokenHash, device);
      return { device, account };
    },

    async list(accountId) {
      return [...devices.values()]
        .filter((device) => device.accountId === accountId)
        .sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));
    },

    async revoke(accountId, deviceId, revokeKey) {
      const device = devices.get(revokeKey);
      if (!device) return 'absent';
      if (device.accountId !== accountId || device.deviceId !== deviceId) return 'mismatch';
      devices.delete(revokeKey);
      return 'removed';
    },

    async touch(tokenHash, now) {
      const device = devices.get(tokenHash);
      if (device) devices.set(tokenHash, { ...device, lastSeenAt: now });
    },

    // #204's link-time writes. The base key is the token's hash and never moves; only the
    // account the item names does.
    async reparentDevice({ tokenHash, deviceId, from, to, now }) {
      const device = devices.get(tokenHash);
      if (!device || device.deviceId !== deviceId || device.accountId !== from) return;
      devices.set(tokenHash, { ...device, accountId: to, lastSeenAt: now });
    },

    async bindAccountEmail(accountId, email) {
      const account = accounts.get(accountId);
      if (account) accounts.set(accountId, { ...account, email });
    },

    async deleteAccount(accountId) {
      // The device ROWS are left where they are, exactly as production leaves them: a device
      // still naming a deleted account stops authenticating on the account-existence check
      // above, and the housekeeping sweep (#207) collects the rows.
      accounts.delete(accountId);
    },
  };
}
