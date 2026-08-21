import { describe, expect, it, vi } from 'vitest';
import {
  ConditionalCheckFailedException,
  GetItemCommand,
  UpdateItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { ROUND_GUESS_CAP, ROUND_WRITE_MIN_MS } from '@whippin/shared';
import { dynamoRoundStore } from './dynamoRoundStore';

const PUBLIC_ID = 'lfd5pqz5pa7zjm5u';
const NOW = new Date('2026-08-21T14:00:00.000Z');
const KEY = { date: '2026-08-21', lang: 'fr', mode: 'sentence' } as const;

function storedItem(guesses: string[], lastWriteAt: number) {
  return {
    guesses: { L: guesses.map((g) => ({ S: g })) },
    createdAt: { S: '2026-08-21T09:00:00.000Z' },
    lastWriteAt: { N: String(lastWriteAt) },
  };
}

describe('dynamoRoundStore (#201)', () => {
  it('reads the round record CONSISTENTLY — the sync adopts what comes back', async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetItemCommand);
      return { Item: storedItem(['bois', 'foret'], 1) };
    });
    const store = dynamoRoundStore({ send } as unknown as DynamoDBClient, 'scores');

    await expect(store.get(KEY, PUBLIC_ID)).resolves.toEqual({
      guesses: ['bois', 'foret'],
      createdAt: '2026-08-21T09:00:00.000Z',
    });
    // Read-after-write: the catch-up read lands right after this player's own appends.
    expect((send.mock.calls[0][0] as GetItemCommand).input).toMatchObject({
      TableName: 'scores',
      Key: { pk: { S: `round#2026-08-21#fr#sentence` }, sk: { S: PUBLIC_ID } },
      ConsistentRead: true,
    });
  });

  it('reports a round the server holds nothing for as null', async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    const store = dynamoRoundStore({ send } as unknown as DynamoDBClient, 'scores');
    await expect(store.get(KEY, PUBLIC_ID)).resolves.toBeNull();
  });

  it('appends in ONE conditional write carrying both bounds, answering the updated item', async () => {
    const send = vi.fn(async (_command: unknown) => ({
      Attributes: storedItem(['bois', 'foret'], NOW.getTime()),
    }));
    const store = dynamoRoundStore({ send } as unknown as DynamoDBClient, 'scores');

    const result = await store.append({
      ...KEY,
      publicId: PUBLIC_ID,
      guesses: ['foret'],
      now: NOW,
    });
    expect(result.outcome).toBe('appended');
    expect(result.state).toMatchObject({ guesses: ['bois', 'foret'] });

    const command = send.mock.calls[0][0] as UpdateItemCommand;
    expect(command.input).toMatchObject({
      TableName: 'scores',
      Key: { pk: { S: 'round#2026-08-21#fr#sentence' }, sk: { S: PUBLIC_ID } },
      ReturnValues: 'ALL_NEW',
      ExpressionAttributeValues: {
        ':batch': { L: [{ S: 'foret' }] },
        ':n': { N: '1' },
        ':cap': { N: String(ROUND_GUESS_CAP) },
        ':now': { N: String(NOW.getTime()) },
        ':cutoff': { N: String(NOW.getTime() - ROUND_WRITE_MIN_MS) },
      },
    });
    // The cap bounds the RESULTING log (`size + batch`), not just the pre-append size —
    // one oversized batch must not be able to overshoot past it.
    expect(command.input.ConditionExpression).toContain(
      'size(if_not_exists(#g, :empty)) + :n <= :cap',
    );
    // The interval is the other clause of the SAME condition — one atomic decision.
    expect(command.input.ConditionExpression).toContain(
      '(attribute_not_exists(#last) OR #last < :cutoff)',
    );
    // createdAt survives the first write only.
    expect(command.input.UpdateExpression).toContain('if_not_exists(#created, :now)');
  });

  it('classifies a refused append by reading the stored log once', async () => {
    const existing = storedItem(Array.from({ length: ROUND_GUESS_CAP }, () => 'a'), 1);
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof UpdateItemCommand) {
        throw new ConditionalCheckFailedException({
          $metadata: {},
          message: 'The conditional request failed',
        });
      }
      return { Item: existing };
    });
    const store = dynamoRoundStore({ send } as unknown as DynamoDBClient, 'scores');

    const refused = await store.append({
      ...KEY,
      publicId: PUBLIC_ID,
      guesses: ['one-more'],
      now: NOW,
    });
    // The log is at the cap and any batch would overflow it: the cap refusal, not the
    // interval — retrying can never succeed, and the client must stop rather than wait.
    expect(refused.outcome).toBe('round_full');
    expect(refused.state.guesses).toHaveLength(ROUND_GUESS_CAP);
  });

  it('answers too_fast when the stored log has room but the interval has not', async () => {
    const recent = storedItem(['bois'], NOW.getTime() - 100);
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof UpdateItemCommand) {
        throw new ConditionalCheckFailedException({
          $metadata: {},
          message: 'The conditional request failed',
        });
      }
      return { Item: recent };
    });
    const store = dynamoRoundStore({ send } as unknown as DynamoDBClient, 'scores');

    const refused = await store.append({
      ...KEY,
      publicId: PUBLIC_ID,
      guesses: ['foret'],
      now: NOW,
    });
    expect(refused.outcome).toBe('too_fast');
    expect(refused.state).toMatchObject({ guesses: ['bois'] });
  });

  it('surfaces operational failures instead of misreading them as refusals', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof UpdateItemCommand) {
        throw new Error('ProvisionedThroughputExceeded');
      }
      return {};
    });
    const store = dynamoRoundStore({ send } as unknown as DynamoDBClient, 'scores');
    await expect(
      store.append({ ...KEY, publicId: PUBLIC_ID, guesses: ['a'], now: NOW }),
    ).rejects.toThrow('ProvisionedThroughputExceeded');
  });
});
