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
// `adopt` is ONE transaction in production. Here its writes reach the two owning maps
// through synchronous, memory-only methods (`LinkDeviceWrites` / `LinkProfileWrites`) and
// run in one serialized event-loop critical section. No request can observe the device,
// account, profile, merge job, and challenge halfway through that section.
export function memoryLinkStore(deps: {
  devices: LinkDeviceWrites;
  profiles: LinkProfileWrites;
}): LinkStore {
  const challenges = new Map<string, LinkChallenge>();
  const bindings = new Map<string, EmailBinding>();
  const sends = new Map<string, number>();
  // to -> the accounts whose friends still have to be merged into it.
  const merges = new Map<string, Set<string>>();
  // The production bind/adopt operations are DynamoDB transactions. Serialize their
  // process-local equivalents so two Promise turns cannot both validate the same challenge
  // or the same empty email slot before either applies its writes.
  let commits: Promise<void> = Promise.resolve();
  const commit = <T>(write: () => T): Promise<T> => {
    const result = commits.then(write, write);
    commits = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const challengeMatches = (hash: string, codeHash: string, now: string): boolean => {
    const challenge = challenges.get(hash);
    return (
      challenge !== undefined &&
      sameDigest(challenge.codeHash, codeHash) &&
      challenge.expiresAt * 1_000 > Date.parse(now) &&
      challenge.attempts < LINK_CODE_MAX_ATTEMPTS
    );
  };

  return {
    async spendSends(allowances, windowSeconds, now) {
      // Decide every counter before changing any of them, mirroring DynamoDB's transaction:
      // an IP refusal must not spend the address budget that was checked before it.
      const next = allowances.map(({ scope, hash, limit }) => {
        const key = sendKey(scope, hash, sendWindow(now, windowSeconds));
        return { key, count: (sends.get(key) ?? 0) + 1, limit };
      });
      if (next.some(({ count, limit }) => count > limit)) return false;
      for (const { key, count } of next) sends.set(key, count);
      return true;
    },

    async putChallenge(hash, challenge) {
      await commit(() => {
        challenges.set(hash, { ...challenge });
      });
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
      return commit(() => {
        if (!challengeMatches(input.emailHash, input.codeHash, input.now)) {
          return 'challenge_changed';
        }
        // CREATE-ONLY, like the production Put: a device that lost the race to this address
        // must not overwrite the binding that won it.
        if (bindings.has(input.emailHash)) return 'taken';
        if (!deps.devices.bindAccountEmail(input.accountId, input.email, input.now)) {
          return 'account_changed';
        }
        bindings.set(input.emailHash, { accountId: input.accountId, createdAt: input.now });
        challenges.delete(input.emailHash);
        return 'bound';
      });
    },

    async adopt(input: AccountAdoption) {
      return commit(() => {
        if (!challengeMatches(input.emailHash, input.codeHash, input.now)) {
          return 'challenge_changed';
        }
        const outcome = deps.devices.adoptDevice({
          tokenHash: input.tokenHash,
          deviceId: input.deviceId,
          from: input.from,
          to: input.to,
          erase: input.erase,
          now: input.now,
        });
        if (outcome !== 'adopted') return outcome;
        if (input.mergeFrom !== undefined) {
          const queued = merges.get(input.to) ?? new Set<string>();
          queued.add(input.mergeFrom);
          merges.set(input.to, queued);
        }
        if (input.erase) {
          deps.profiles.remove(input.from);
        }
        challenges.delete(input.emailHash);
        return 'adopted';
      });
    },

    async pendingMerges(accountId) {
      return [...(merges.get(accountId) ?? [])].sort();
    },

    async clearMerge(accountId, from) {
      merges.get(accountId)?.delete(from);
    },
  };
}
