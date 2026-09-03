// The proactive "X takes the lead" line is a SEPARATE policy from reactions, with its own
// anti-spam state (#236): it fires from a deterministic event — a share that strictly
// beats the day's standing leader — never because anything decided the group was quiet.
// The first share of a day is not a lead change, so it is not announced; each change is
// announced at most once (the command id carries day, sender and score).

import {
  ConditionalCheckFailedException,
  GetItemCommand,
  PutItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';

export type LeadOutcome = 'first' | 'took_lead' | 'unchanged';

export interface LeaderStore {
  claim(group: string, dayNumber: number, sender: string, score: number): Promise<LeadOutcome>;
}

export function leaderKey(group: string, dayNumber: number) {
  return { pk: { S: `GROUP#${group}` }, sk: { S: `LEAD#${String(dayNumber).padStart(6, '0')}` } };
}

export function dynamoLeaderStore(client: DynamoDBClient, tableName: string): LeaderStore {
  return {
    async claim(group, dayNumber, sender, score) {
      const key = leaderKey(group, dayNumber);
      const current = (await client.send(new GetItemCommand({ TableName: tableName, Key: key })))
        .Item;
      const previousScore = current ? Number(current.score?.N) : undefined;
      const previousSender = current?.sender?.S;
      if (previousScore !== undefined && (previousScore <= score || previousSender === sender)) {
        return 'unchanged';
      }
      try {
        await client.send(
          new PutItemCommand({
            TableName: tableName,
            Item: { ...key, sender: { S: sender }, score: { N: String(score) } },
            // Strictly better than what stands (or nothing stands) at write time.
            ConditionExpression: 'attribute_not_exists(#sk) OR #score > :score',
            ExpressionAttributeNames: { '#sk': 'sk', '#score': 'score' },
            ExpressionAttributeValues: { ':score': { N: String(score) } },
          }),
        );
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return 'unchanged';
        throw error;
      }
      return current ? 'took_lead' : 'first';
    },
  };
}

export function memoryLeaderStore(): LeaderStore {
  const rows = new Map<string, { sender: string; score: number }>();
  return {
    async claim(group, dayNumber, sender, score) {
      const key = `${group}#${dayNumber}`;
      const current = rows.get(key);
      if (current && (current.score <= score || current.sender === sender)) return 'unchanged';
      rows.set(key, { sender, score });
      return current ? 'took_lead' : 'first';
    },
  };
}
