// CONTRACT (#211): the production solved-day collection. It is a DynamoDB NUMBER SET, and
// that type is the design: `ADD` is an idempotent set insert, so crediting a day needs no
// read, no value condition and no way for two confirmations of one solve to record it twice.
// The condition that bounds it is CONDITION grammar — `size(<path>)` and `contains`, never
// arithmetic — and a mocked client validates none of that, so the expression's shape is what
// this suite holds.

import { describe, expect, it, vi } from 'vitest';
import {
  ConditionalCheckFailedException,
  GetItemCommand,
  UpdateItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { MAX_SOLVED_DAYS } from '@whippin/shared';
import { dynamoHistoryStore } from './dynamoHistoryStore';

const PUBLIC_ID = 'lfd5pqz5pa7zjm5u';

function makeStore(send: (command: unknown) => Promise<unknown>) {
  const spy = vi.fn(send);
  return { store: dynamoHistoryStore({ send: spy } as unknown as DynamoDBClient, 'scores'), send: spy };
}

describe('dynamoHistoryStore — the streak\'s solved-day collection (#211)', () => {
  it('lives on the PRIVATE player row, per language', async () => {
    const { store, send } = makeStore(async () => ({}));
    await store.solvedDays(PUBLIC_ID, 'fr');
    const key = (send.mock.calls[0][0] as GetItemCommand).input.Key!;
    // The same partition the #188 profile row sits in — reachable only through the
    // authenticated history read, never through the public `GET /profile?id=`.
    expect(key.pk).toEqual({ S: `player#${PUBLIC_ID}` });
    expect(key.sk).toEqual({ S: 'history#fr' });
  });

  it('reads the collection CONSISTENTLY, ascending and bounded', async () => {
    const { store, send } = makeStore(async () => ({
      Item: { days: { NS: ['20670', '20668', '20669'] } },
    }));
    await expect(store.solvedDays(PUBLIC_ID, 'fr')).resolves.toEqual([20_668, 20_669, 20_670]);
    // The solve that credits a day is recorded by the append that finishes the round, and
    // the streak is read moments later on the same device.
    expect((send.mock.calls[0][0] as GetItemCommand).input.ConsistentRead).toBe(true);
  });

  it('a player with no row has solved no days — an ANSWER, not a missing record', async () => {
    const { store } = makeStore(async () => ({}));
    await expect(store.solvedDays(PUBLIC_ID, 'fr')).resolves.toEqual([]);
  });

  it('credits a day with ONE unconditional-value ADD — idempotent by construction', async () => {
    const { store, send } = makeStore(async () => ({}));
    await store.recordSolvedDay({ publicId: PUBLIC_ID, lang: 'fr', day: 20_669 });
    expect(send).toHaveBeenCalledTimes(1);
    const input = (send.mock.calls[0][0] as UpdateItemCommand).input;
    expect(input.UpdateExpression).toBe('ADD #days :day');
    expect(input.ExpressionAttributeValues![':day']).toEqual({ NS: ['20669'] });
  });

  it('bounds the collection with CONDITION grammar only — no arithmetic', async () => {
    const { store, send } = makeStore(async () => ({}));
    await store.recordSolvedDay({ publicId: PUBLIC_ID, lang: 'fr', day: 20_669 });
    const condition = (send.mock.calls[0][0] as UpdateItemCommand).input.ConditionExpression!;
    expect(condition).toBe(
      'attribute_not_exists(#days) OR size(#days) < :max OR contains(#days, :one)',
    );
    // `if_not_exists` and `+` belong to an UPDATE expression; naming either here is a
    // ValidationException before a single day is credited, which no mocked client can show.
    expect(condition).not.toMatch(/[+*/]/);
    expect(condition).not.toContain('if_not_exists');
  });

  it('a day the collection ALREADY holds is a silent no-op, not an overflow trim', async () => {
    // The third clause exists for exactly this: a re-solve of a corrected revision must
    // not fall into the trim path just because the collection is full.
    const { store, send } = makeStore(async () => ({}));
    await store.recordSolvedDay({ publicId: PUBLIC_ID, lang: 'fr', day: 20_669 });
    const values = (send.mock.calls[0][0] as UpdateItemCommand).input.ExpressionAttributeValues!;
    expect(values[':one']).toEqual({ N: '20669' });
    expect(values[':max']).toEqual({ N: String(MAX_SOLVED_DAYS) });
  });

  // A FULL collection trims with SET OPERATIONS — an unconditional ADD that returns the
  // merged membership, then a DELETE of what now sits beyond the cap. Never a read plus
  // `SET #days = <the whole set>`: that is a lost update, and the thing it loses is a
  // player's solved day.
  it('a FULL collection ADDs the day and DELETEs only the overflow', async () => {
    const stored = Array.from({ length: MAX_SOLVED_DAYS }, (_, i) => String(i + 1));
    let refused = false;
    const { store, send } = makeStore(async (command) => {
      if (command instanceof UpdateItemCommand && !refused) {
        refused = true;
        throw new ConditionalCheckFailedException({ $metadata: {}, message: 'full' });
      }
      // The unconditional ADD answers the MERGED set, DynamoDB's own post-write membership.
      return { Attributes: { days: { NS: [...stored, String(MAX_SOLVED_DAYS + 1)] } } };
    });

    await store.recordSolvedDay({ publicId: PUBLIC_ID, lang: 'fr', day: MAX_SOLVED_DAYS + 1 });
    // The refused conditional ADD, the unconditional one, the trim. No read at all: the
    // ADD's own ALL_NEW is what the trim is computed from.
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.some(([c]) => c instanceof GetItemCommand)).toBe(false);

    const add = (send.mock.calls[1][0] as UpdateItemCommand).input;
    expect(add.UpdateExpression).toBe('ADD #days :day');
    expect(add.ConditionExpression).toBeUndefined();
    expect(add.ReturnValues).toBe('ALL_NEW');

    const trim = (send.mock.calls[2][0] as UpdateItemCommand).input;
    expect(trim.UpdateExpression).toBe('DELETE #days :drop');
    // ONLY the overflow, named element by element — so it commutes with a concurrent
    // credit of a different day instead of overwriting it.
    expect(trim.ExpressionAttributeValues![':drop'].NS).toEqual(['1']);
  });

  it('a concurrent credit that landed in the SAME set is never trimmed away', async () => {
    // Another device credited day MAX+1 between this call's refusal and its ADD, so the
    // merged set holds BOTH new days. The trim must drop the two oldest and leave both.
    const stored = Array.from({ length: MAX_SOLVED_DAYS }, (_, i) => String(i + 1));
    let refused = false;
    const { store, send } = makeStore(async (command) => {
      if (command instanceof UpdateItemCommand && !refused) {
        refused = true;
        throw new ConditionalCheckFailedException({ $metadata: {}, message: 'full' });
      }
      return {
        Attributes: {
          days: { NS: [...stored, String(MAX_SOLVED_DAYS + 1), String(MAX_SOLVED_DAYS + 2)] },
        },
      };
    });

    await store.recordSolvedDay({ publicId: PUBLIC_ID, lang: 'fr', day: MAX_SOLVED_DAYS + 2 });
    const trim = (send.mock.calls[2][0] as UpdateItemCommand).input;
    expect(trim.ExpressionAttributeValues![':drop'].NS).toEqual(['1', '2']);
  });

  it('trims NOTHING when the merged set is already inside the cap', async () => {
    // Two credits raced and each dropped the same oldest element, so the collection is one
    // over; the next one lands under the cap again and issues no DELETE. A bound overshot
    // by simultaneous writes converges — a lost solved day would not.
    const stored = Array.from({ length: MAX_SOLVED_DAYS }, (_, i) => String(i + 1));
    let refused = false;
    const { store, send } = makeStore(async (command) => {
      if (command instanceof UpdateItemCommand && !refused) {
        refused = true;
        throw new ConditionalCheckFailedException({ $metadata: {}, message: 'full' });
      }
      return { Attributes: { days: { NS: stored } } };
    });

    await store.recordSolvedDay({ publicId: PUBLIC_ID, lang: 'fr', day: 1 });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
