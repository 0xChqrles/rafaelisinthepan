// ONE active WhatsApp session is a CORRECTNESS rule (#236): Baileys' Signal state is
// mutable, and two processes acting as the same linked device produce both duplicate
// behaviour and competing key updates. The ECS service is sized to one task and deploys
// stop-before-start, but neither stops an operator's laptop (`pnpm bot:start`, or the
// pairing CLI) from opening a second socket against the same durable auth. This lease
// does: whoever holds `AUTH#bot / lease` may open the socket; everyone else refuses to
// start, and a holder that cannot renew stops rather than keep talking.

import {
  ConditionalCheckFailedException,
  PutItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'node:crypto';
import { AUTH_PARTITION, LEASE_SORT_KEY } from './authStore';

export const LEASE_TTL_MS = 90_000;
export const LEASE_RENEW_MS = 30_000;
// A holder holds the lease only until LEASE_TTL_MS after the last renew that ACTUALLY
// LANDED — and a renew that THREW, or that never answered at all, is not a renew. Keep
// failing for the whole window and the record expires, another process acquires it, and
// two sockets speak as one device: the one thing this file exists to prevent. So the
// holder gives up one renew period BEFORE the record can expire, which is the difference
// between the two constants.
export const LEASE_GRACE_MS = LEASE_TTL_MS - LEASE_RENEW_MS;
const LEASE_SK = LEASE_SORT_KEY;

export interface Lease {
  owner: string;
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

// Why the holder gave up: `refused` — somebody else holds it now; `stale` — our renewals
// stopped landing for longer than the grace window, so the record may have expired under
// us and somebody else may be about to.
export type LeaseLoss = 'refused' | 'stale';

export interface LeaseKeeper {
  // ONE renewal round. Exported so a test can drive the schedule instead of waiting on it.
  tick(): Promise<void>;
  stop(): void;
}

// Renews on a schedule and tells the holder to STOP when the lease is gone. Both callers
// use it, because both must obey the same rule and a second copy of it would be a second
// chance to get it wrong: a refusal is obvious, but a renew that keeps THROWING — or
// simply never answering — ends the same way: the record ages out and another process may
// open a second socket.
//
// A RENEW STILL IN FLIGHT IS NOT A RENEW EITHER, which is the case the throwing one hides.
// One that never settles reaches no catch block at all, so a keeper that measured staleness
// only on failure sat silent while the record expired under it and another process took the
// session — the two-socket state this file exists to prevent, reached through the one
// failure mode that raises no error. A tick that finds the previous renew still outstanding
// therefore checks the deadline itself, and gives up on it. It also declines to start a
// second one: overlapping writes can land out of order, and the older carries an EARLIER
// expiry, so the record would age out sooner than the holder believes it had renewed to.
export function keepLease(
  lease: Lease,
  handlers: {
    onLost(reason: LeaseLoss): void;
    onError?(error: Error, staleMs: number): void;
  },
  options: { now?: () => number; start?: boolean } = {},
): LeaseKeeper {
  const now = options.now ?? Date.now;
  let heldAt = now();
  let done = false;
  let renewing = false;

  const giveUp = (reason: LeaseLoss) => {
    done = true;
    handlers.onLost(reason);
  };

  const tick = async () => {
    if (done) return;
    if (renewing) {
      // Nothing else to do while one is outstanding — except notice that it has been
      // outstanding too long.
      if (now() - heldAt >= LEASE_GRACE_MS) giveUp('stale');
      return;
    }
    // The record's own expiry is stamped from the instant the write is BUILT, so that is
    // the instant the holder must measure its window from — not the instant the answer
    // came back. Measured from the answer, a renew that took longer than a renew period
    // would push the holder's give-up moment PAST the expiry it just wrote, and it would
    // still believe it held a lease somebody else could already have taken.
    const startedAt = now();
    renewing = true;
    let held: boolean;
    try {
      held = await lease.renew();
    } catch (error) {
      // A blip is not a lost lease; a blip that outlasts the grace window is.
      const staleMs = now() - heldAt;
      handlers.onError?.(error as Error, staleMs);
      if (!done && staleMs >= LEASE_GRACE_MS) giveUp('stale');
      return;
    } finally {
      renewing = false;
    }
    if (done) return;
    if (held) {
      heldAt = startedAt;
      return;
    }
    giveUp('refused');
  };

  const timer = options.start === false ? null : setInterval(() => void tick(), LEASE_RENEW_MS);
  timer?.unref();
  return {
    tick,
    stop() {
      done = true;
      if (timer) clearInterval(timer);
    },
  };
}

export async function acquireLease(
  client: DynamoDBClient,
  table: string,
  label: string,
  now: () => number = Date.now,
): Promise<Lease | null> {
  const owner = `${label}#${randomUUID()}`;
  const key = { pk: { S: AUTH_PARTITION }, sk: { S: LEASE_SK } };

  async function write(condition: string, values: Record<string, { S: string } | { N: string }>) {
    try {
      await client.send(
        new PutItemCommand({
          TableName: table,
          Item: {
            ...key,
            owner: { S: owner },
            label: { S: label },
            expiresAtMs: { N: String(now() + LEASE_TTL_MS) },
          },
          ConditionExpression: condition,
          ExpressionAttributeNames: { '#sk': 'sk', '#exp': 'expiresAtMs', '#owner': 'owner' },
          ExpressionAttributeValues: { ':now': { N: String(now()) }, ':owner': { S: owner }, ...values },
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }

  const acquired = await write('attribute_not_exists(#sk) OR #exp < :now OR #owner = :owner', {});
  if (!acquired) return null;
  return {
    owner,
    renew: () => write('#owner = :owner', {}),
    async release() {
      try {
        await client.send(
          new PutItemCommand({
            TableName: table,
            Item: { ...key, owner: { S: owner }, label: { S: label }, expiresAtMs: { N: '0' } },
            ConditionExpression: '#owner = :owner',
            ExpressionAttributeNames: { '#owner': 'owner' },
            ExpressionAttributeValues: { ':owner': { S: owner } },
          }),
        );
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
      }
    },
  };
}
