import {
  GetItemCommand,
  UpdateItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  PROFILE_SORT_KEY,
  profileKey,
  type ProfileStore,
  type ProfileUpsert,
} from './profileStore';

// Production profile rows live in the score table (#188): one item per publicId in its
// own `player#<id>` partition. Both create and upsert are one UpdateItem; create adds the
// item-absence condition, while createdAt survives later upserts via if_not_exists and
// updatedAt moves every time.
export function dynamoProfileStore(client: DynamoDBClient, tableName: string): ProfileStore {
  const write = (input: ProfileUpsert, createOnly: boolean) =>
    client.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: { S: profileKey(input.publicId) }, sk: { S: PROFILE_SORT_KEY } },
        UpdateExpression:
          'SET #name = :name, #avatar = :avatar, #updatedAt = :now, ' +
          '#createdAt = if_not_exists(#createdAt, :now)',
        // The background locally-decided identity is allowed to create the row, never
        // replace one the editor or another device won first. Put the test in THIS write:
        // a strongly consistent GET followed by an unconditional update still has a race.
        ...(createOnly ? { ConditionExpression: 'attribute_not_exists(#pk)' } : {}),
        ExpressionAttributeNames: {
          '#name': 'name',
          '#avatar': 'avatar',
          '#updatedAt': 'updatedAt',
          '#createdAt': 'createdAt',
          ...(createOnly ? { '#pk': 'pk' } : {}),
        },
        ExpressionAttributeValues: {
          ':name': { S: input.name },
          ':avatar': { S: input.avatar },
          ':now': { S: input.now },
        },
      }),
    );

  return {
    async get(publicId) {
      const response = await client.send(
        new GetItemCommand({
          TableName: tableName,
          Key: { pk: { S: profileKey(publicId) }, sk: { S: PROFILE_SORT_KEY } },
          // Strong consistency, for the score store's reason: this is a read-after-write
          // path. The editor re-reads its own profile on the next visit and ADOPTS what
          // comes back as both its contents and its save baseline, so an eventually
          // consistent read could hand a player the profile they just replaced — or, on
          // a first save, a 404 that presents their new profile as never customized.
          ConsistentRead: true,
        }),
      );
      const item = response.Item;
      if (!item) return null;
      return {
        publicId,
        name: item.name?.S ?? '',
        avatar: item.avatar?.S ?? '',
      };
    },

    async create(input) {
      try {
        await write(input, true);
        return true;
      } catch (error) {
        if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false;
        throw error;
      }
    },

    async upsert(input) {
      await write(input, false);
    },
  };
}
