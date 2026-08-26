import { describe, expect, it, vi } from 'vitest';
import {
  BatchGetItemCommand,
  UpdateItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { dynamoProfileStore } from './dynamoProfileStore';

const PUBLIC_ID = 'lfd5pqz5pa7zjm5u';

describe('dynamoProfileStore (#188)', () => {
  // CONTRACT (#204): the profile row and the ACCOUNT row are ONE read. A missing profile
  // means "never customized" and every board dresses it with the assigned pseudonym and
  // mark — which is still this player's face — so a DELETED account has to be a different
  // answer, and it is the account row's absence that says so.
  it('reads the profile row and the account row CONSISTENTLY, in one batch', async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(BatchGetItemCommand);
      return {
        Responses: {
          scores: [
            { sk: { S: 'profile' }, name: { S: 'Chqrles' }, avatar: { S: 'AAAAAAAAAAAAAAAAAAA' } },
            { sk: { S: 'account' }, createdAt: { S: '2026-08-19T14:00:00.000Z' } },
          ],
        },
      };
    });
    const store = dynamoProfileStore({ send } as unknown as DynamoDBClient, 'scores');

    await expect(store.get(PUBLIC_ID)).resolves.toEqual({
      live: true,
      profile: { publicId: PUBLIC_ID, name: 'Chqrles', avatar: 'AAAAAAAAAAAAAAAAAAA' },
    });
    // An eventually consistent read here would hand a player the profile they just
    // replaced (or a 404 right after their first save), which the client would then
    // take as its baseline — the score store's read-after-write requirement.
    expect((send.mock.calls[0][0] as BatchGetItemCommand).input).toMatchObject({
      RequestItems: {
        scores: {
          Keys: [
            { pk: { S: `player#${PUBLIC_ID}` }, sk: { S: 'profile' } },
            { pk: { S: `player#${PUBLIC_ID}` }, sk: { S: 'account' } },
          ],
          ConsistentRead: true,
        },
      },
    });
  });

  it('reports a never-customized identity as a LIVE account with no profile', async () => {
    const send = vi.fn(async (_command: unknown) => ({
      Responses: { scores: [{ sk: { S: 'account' }, createdAt: { S: 'x' } }] },
    }));
    const store = dynamoProfileStore({ send } as unknown as DynamoDBClient, 'scores');
    await expect(store.get(PUBLIC_ID)).resolves.toEqual({ live: true, profile: null });
  });

  it('reports a DELETED account as not live, whatever the profile row says (#204)', async () => {
    const send = vi.fn(async (_command: unknown) => ({ Responses: { scores: [] } }));
    const store = dynamoProfileStore({ send } as unknown as DynamoDBClient, 'scores');
    await expect(store.get(PUBLIC_ID)).resolves.toEqual({ live: false, profile: null });
  });

  it('upserts in one write, keeping createdAt from the FIRST save', async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    const store = dynamoProfileStore({ send } as unknown as DynamoDBClient, 'scores');
    await store.upsert({
      publicId: PUBLIC_ID,
      name: 'Chqrles',
      avatar: 'AAAAAAAAAAAAAAAAAAA',
      now: '2026-08-19T14:00:00.000Z',
    });

    const command = send.mock.calls[0][0] as UpdateItemCommand;
    expect(command).toBeInstanceOf(UpdateItemCommand);
    expect(command.input).toMatchObject({
      TableName: 'scores',
      Key: { pk: { S: `player#${PUBLIC_ID}` }, sk: { S: 'profile' } },
      ExpressionAttributeValues: {
        ':name': { S: 'Chqrles' },
        ':avatar': { S: 'AAAAAAAAAAAAAAAAAAA' },
        ':now': { S: '2026-08-19T14:00:00.000Z' },
      },
    });
    // The profile row is its own partition: a write here can never touch a score row.
    expect(command.input.UpdateExpression).toContain('if_not_exists(#createdAt, :now)');
  });

  it('creates the first profile with an atomic item-absence condition', async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    const store = dynamoProfileStore({ send } as unknown as DynamoDBClient, 'scores');
    await expect(
      store.create({
        publicId: PUBLIC_ID,
        name: 'LocalFace',
        avatar: 'AAAAAAAAAAAAAAAAAAA',
        now: '2026-08-26T09:00:00.000Z',
      }),
    ).resolves.toBe(true);

    const command = send.mock.calls[0][0] as UpdateItemCommand;
    expect(command.input.ConditionExpression).toBe('attribute_not_exists(#pk)');
    expect(command.input.ExpressionAttributeNames?.['#pk']).toBe('pk');
  });

  it('reports a lost create race without replacing the existing profile', async () => {
    const conflict = Object.assign(new Error('exists'), {
      name: 'ConditionalCheckFailedException',
    });
    const send = vi.fn(async (_command: unknown) => Promise.reject(conflict));
    const store = dynamoProfileStore({ send } as unknown as DynamoDBClient, 'scores');

    await expect(
      store.create({
        publicId: PUBLIC_ID,
        name: 'Background',
        avatar: 'AAAAAAAAAAAAAAAAAAA',
        now: '2026-08-26T09:00:00.000Z',
      }),
    ).resolves.toBe(false);
  });
});
