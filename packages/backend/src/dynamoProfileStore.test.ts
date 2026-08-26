import { describe, expect, it, vi } from 'vitest';
import {
  GetItemCommand,
  UpdateItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { dynamoProfileStore } from './dynamoProfileStore';

const PUBLIC_ID = 'lfd5pqz5pa7zjm5u';

describe('dynamoProfileStore (#188)', () => {
  it('reads the player item CONSISTENTLY — the editor adopts what comes back', async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetItemCommand);
      return { Item: { name: { S: 'Chqrles' }, avatar: { S: 'AAAAAAAAAAAAAAAAAAA' } } };
    });
    const store = dynamoProfileStore({ send } as unknown as DynamoDBClient, 'scores');

    await expect(store.get(PUBLIC_ID)).resolves.toEqual({
      publicId: PUBLIC_ID,
      name: 'Chqrles',
      avatar: 'AAAAAAAAAAAAAAAAAAA',
    });
    // An eventually consistent read here would hand a player the profile they just
    // replaced (or a 404 right after their first save), which the client would then
    // take as its baseline — the score store's read-after-write requirement.
    expect((send.mock.calls[0][0] as GetItemCommand).input).toMatchObject({
      TableName: 'scores',
      Key: { pk: { S: `player#${PUBLIC_ID}` }, sk: { S: 'profile' } },
      ConsistentRead: true,
    });
  });

  it('reports a never-customized identity as null, not an empty profile', async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    const store = dynamoProfileStore({ send } as unknown as DynamoDBClient, 'scores');
    await expect(store.get(PUBLIC_ID)).resolves.toBeNull();
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
