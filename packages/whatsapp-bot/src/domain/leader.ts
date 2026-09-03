// The proactive "X takes the lead" line is a SEPARATE policy from reactions, with its own
// anti-spam state (#236): it fires from a deterministic event — a share that strictly
// beats the day's standing leader — never because anything decided the group was quiet.
// The first share of a day is not a lead change, so it is not announced; each change is
// announced at most once (the command id carries day, sender and score).
//
// THE ROW MOVES ON EVERY IMPROVEMENT; THE ANNOUNCEMENT ONLY WHEN THE HOLDER CHANGES. The
// leader improving their OWN best is not news, but it is still the day's best — and a row
// left at the superseded number announces a lead that never happened: the leader goes 10
// → 5 silently, the row still says 10, and the next player's 7 is read as taking a lead
// they are two behind. So a better score is always written, and only the outcome is
// suppressed. The reverse case — someone REPLACING their own declaration with a worse one
// (precedence is by message time, not by score) — leaves the row holding a number nobody
// still has, which suppresses a later announcement rather than inventing one. That is the
// safe direction for anti-spam state, and the declarations remain the authority either way.

import {
  ConditionalCheckFailedException,
  GetItemCommand,
  PutItemCommand,
  type AttributeValue,
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
      // Nothing better than what stands: the row already says the truth, and this read is
      // only here to skip a pointless write. THE OUTCOME IS NOT DECIDED FROM IT — see below.
      if (previousScore !== undefined && previousScore <= score) return 'unchanged';
      let displaced: Record<string, AttributeValue> | undefined;
      try {
        // ALL_OLD: what this write actually DISPLACED, which is the only race-free answer
        // to "did the lead change hands?". Deciding it from the read above loses the first
        // shares of a day when two land together — both read nothing, both write, and the
        // second reports `first` while it has in fact just overtaken the other.
        const response = await client.send(
          new PutItemCommand({
            TableName: tableName,
            Item: { ...key, sender: { S: sender }, score: { N: String(score) } },
            // Strictly better than what stands (or nothing stands) at write time.
            ConditionExpression: 'attribute_not_exists(#sk) OR #score > :score',
            ExpressionAttributeNames: { '#sk': 'sk', '#score': 'score' },
            ExpressionAttributeValues: { ':score': { N: String(score) } },
            ReturnValues: 'ALL_OLD',
          }),
        );
        displaced = response.Attributes;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return 'unchanged';
        throw error;
      }
      if (!displaced) return 'first';
      // Written either way; announced only when the day's best changed HANDS.
      return displaced.sender?.S === sender ? 'unchanged' : 'took_lead';
    },
  };
}

export function memoryLeaderStore(): LeaderStore {
  const rows = new Map<string, { sender: string; score: number }>();
  return {
    async claim(group, dayNumber, sender, score) {
      const key = `${group}#${dayNumber}`;
      const current = rows.get(key);
      if (current && current.score <= score) return 'unchanged';
      rows.set(key, { sender, score });
      if (!current) return 'first';
      return current.sender === sender ? 'unchanged' : 'took_lead';
    },
  };
}
