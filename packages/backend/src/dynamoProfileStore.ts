import {
  GetItemCommand,
  UpdateItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { PROFILE_SORT_KEY, profileKey, type ProfileStore } from './profileStore';

// Production profile rows live in the score table (#188): one item per publicId in its
// own `player#<id>` partition. Upsert is a single UpdateItem — createdAt survives the
// first write via if_not_exists, updatedAt moves every time.
export function dynamoProfileStore(client: DynamoDBClient, tableName: string): ProfileStore {
  return {
    async get(publicId) {
      const response = await client.send(
        new GetItemCommand({
          TableName: tableName,
          Key: { pk: { S: profileKey(publicId) }, sk: { S: PROFILE_SORT_KEY } },
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

    async upsert(input) {
      await client.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: { pk: { S: profileKey(input.publicId) }, sk: { S: PROFILE_SORT_KEY } },
          UpdateExpression:
            'SET #name = :name, #avatar = :avatar, #updatedAt = :now, ' +
            '#createdAt = if_not_exists(#createdAt, :now)',
          ExpressionAttributeNames: {
            '#name': 'name',
            '#avatar': 'avatar',
            '#updatedAt': 'updatedAt',
            '#createdAt': 'createdAt',
          },
          ExpressionAttributeValues: {
            ':name': { S: input.name },
            ':avatar': { S: input.avatar },
            ':now': { S: input.now },
          },
        }),
      );
    },
  };
}
