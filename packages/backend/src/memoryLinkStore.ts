import { LINK_CODE_MAX_ATTEMPTS } from '@whippin/shared';
import { sameDigest, sendKey, sendWindow } from './linkStore';
import type { LinkDeviceWrites, LinkProfileWrites } from './linkStore';
import type {
  AccountAdoption,
  EmailBinding,
  LinkChallenge,
  LinkStore,
  LinkVerifyResult,
} from './linkStore';

// Process-local store for `pnpm backend:dev` and tests: the same LinkStore contract as
// DynamoDB with no AWS account and no SES. Restarting the local server drops every pending
// code and every binding, which is exactly what a wiped table does.
//
// `adopt` is ONE transaction in production. Here it is a SEQUENCE of writes through the two
// memory stores it has to reach (`LinkDeviceWrites` / `LinkProfileWrites`) — there is no
// shared item space to write atomically — so the local server and the tests can observe a
// partial application only if a write in the middle throws, which none of these do. The
// ORDER still mirrors the transaction's intent: everything that gives the device its new
// account happens before anything that destroys the old one.
export function memoryLinkStore(deps: {
  devices: LinkDeviceWrites;
  profiles: LinkProfileWrites;
}): LinkStore {
  const challenges = new Map<string, LinkChallenge>();
  const bindings = new Map<string, EmailBinding>();
  const sends = new Map<string, number>();
  // to -> the accounts whose friends still have to be merged into it.
  const merges = new Map<string, Set<string>>();

  return {
    async spendSend(scope, hash, limit, windowSeconds, now) {
      // The WINDOW is part of the key, exactly as it is in production: a fresh item per
      // window starts at zero, so nothing here has to reset a counter.
      const key = sendKey(scope, hash, sendWindow(now, windowSeconds));
      const count = (sends.get(key) ?? 0) + 1;
      if (count > limit) return false;
      sends.set(key, count);
      return true;
    },

    async putChallenge(hash, challenge) {
      challenges.set(hash, { ...challenge });
    },

    async verify(hash, codeHash, now): Promise<LinkVerifyResult> {
      const held = challenges.get(hash);
      if (!held) return { outcome: 'none', attemptsLeft: 0 };
      if (held.expiresAt * 1000 <= now.getTime()) {
        challenges.delete(hash);
        return { outcome: 'expired', attemptsLeft: 0 };
      }
      if (held.attempts >= LINK_CODE_MAX_ATTEMPTS) {
        return { outcome: 'spent', attemptsLeft: 0 };
      }
      if (sameDigest(held.codeHash, codeHash)) {
        return { outcome: 'ok', attemptsLeft: LINK_CODE_MAX_ATTEMPTS - held.attempts };
      }
      // The attempt is counted BEFORE the answer, the same way the conditional update does:
      // the count is the only thing between a six-digit code and a guessing loop.
      held.attempts += 1;
      return {
        outcome: held.attempts >= LINK_CODE_MAX_ATTEMPTS ? 'spent' : 'wrong',
        attemptsLeft: Math.max(0, LINK_CODE_MAX_ATTEMPTS - held.attempts),
      };
    },

    async binding(hash) {
      return bindings.get(hash) ?? null;
    },

    async bind(input) {
      // CREATE-ONLY, like the production Put: a device that lost the race to this address
      // must not overwrite the binding that won it.
      if (bindings.has(input.emailHash)) return 'taken';
      bindings.set(input.emailHash, { accountId: input.accountId, createdAt: input.now });
      await deps.devices.bindAccountEmail(input.accountId, input.email, input.now);
      challenges.delete(input.emailHash);
      return 'bound';
    },

    async adopt(input: AccountAdoption) {
      await deps.devices.reparentDevice({
        tokenHash: input.tokenHash,
        deviceId: input.deviceId,
        from: input.from,
        to: input.to,
        now: input.now,
      });
      if (input.mergeFrom !== undefined) {
        const queued = merges.get(input.to) ?? new Set<string>();
        queued.add(input.mergeFrom);
        merges.set(input.to, queued);
      }
      if (input.erase) {
        await deps.profiles.remove(input.from);
        await deps.devices.deleteAccount(input.from);
      }
      challenges.delete(input.emailHash);
    },

    async pendingMerges(accountId) {
      return [...(merges.get(accountId) ?? [])].sort();
    },

    async clearMerge(accountId, from) {
      merges.get(accountId)?.delete(from);
    },
  };
}
