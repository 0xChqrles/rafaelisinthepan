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
const LEASE_SK = LEASE_SORT_KEY;

export interface Lease {
  owner: string;
  renew(): Promise<boolean>;
  release(): Promise<void>;
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
