import { describe, expect, it, vi } from 'vitest';
import {
  BatchGetItemCommand,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { batchGetAll } from './dynamoBatchGet';

// CONTRACT: the read of a KNOWN key set never drops a key. It is sent 100 keys a call
// (DynamoDB's own limit), a key the service left unprocessed is asked again — behind a
// wait, never before the first attempt of a batch — and one that never comes back fails
// the read loudly. The schedule's numbers are pinned in `dynamoRetry.test.ts`.

const keyOf = (n: number): Record<string, AttributeValue> => ({ pk: { S: 'day' }, sk: { S: `p${n}` } });
const keys = (count: number) => Array.from({ length: count }, (_, n) => keyOf(n));

// A table that answers every key it is asked for, except the ones `drop` withholds on a
// given call (returned as unprocessed, the way a throttled partition answers).
function table(drop: (call: number, asked: Record<string, AttributeValue>[]) => Record<string, AttributeValue>[] = () => []) {
  const asked: Record<string, AttributeValue>[][] = [];
  const send = vi.fn(async (command: BatchGetItemCommand) => {
    const request = command.input.RequestItems!.scores;
    const batch = request.Keys!;
    asked.push(batch);
    const dropped = drop(asked.length, batch);
    return {
      Responses: { scores: batch.filter((key) => !dropped.includes(key)) },
      ...(dropped.length > 0 ? { UnprocessedKeys: { scores: { Keys: dropped } } } : {}),
    };
  });
  const waits: number[] = [];
  const read = (wanted: Record<string, AttributeValue>[]) =>
    batchGetAll(
      { send } as unknown as DynamoDBClient,
      'scores',
      wanted,
      { ConsistentRead: true },
      async (ms) => {
        waits.push(ms);
      },
      'Score',
    );
  return { send, asked, waits, read };
}

describe('batchGetAll — the known-key read', () => {
  it('sends the keys 100 a call, with the caller\'s own request options, and answers every item', async () => {
    const { send, asked, waits, read } = table();
    const wanted = keys(250);
    await expect(read(wanted)).resolves.toEqual(wanted);
    expect(asked.map((batch) => batch.length)).toEqual([100, 100, 50]);
    for (const [command] of send.mock.calls) {
      expect(command).toBeInstanceOf(BatchGetItemCommand);
      expect(command.input.RequestItems!.scores.ConsistentRead).toBe(true);
    }
    // Nothing came back unprocessed, so nothing waited: a batch's FIRST read is never delayed.
    expect(waits).toEqual([]);
  });

  it('sends nothing for an empty key set — DynamoDB refuses a batch of no keys', async () => {
    const { send, read } = table();
    await expect(read([])).resolves.toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('asks again for exactly what came back unprocessed, after a wait', async () => {
    // The first call withholds two keys; the retry withholds one of them again.
    const { asked, waits, read } = table((call, batch) =>
      call === 1 ? [batch[1], batch[2]] : call === 2 ? [batch[1]] : [],
    );
    const wanted = keys(3);
    const items = await read(wanted);
    expect(asked).toEqual([wanted, [wanted[1], wanted[2]], [wanted[2]]]);
    expect(items).toEqual([wanted[0], wanted[1], wanted[2]]);
    // One wait before each RETRY, inside the schedule's first two windows.
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeLessThanOrEqual(50);
    expect(waits[1]).toBeLessThanOrEqual(100);
  });

  it('gives each batch its own attempts: a retry in one never delays the next one\'s first read', async () => {
    const { asked, waits, read } = table((call, batch) => (call === 1 ? [batch[0]] : []));
    await read(keys(150));
    expect(asked.map((batch) => batch.length)).toEqual([100, 1, 50]);
    expect(waits).toHaveLength(1);
  });

  it('fails LOUDLY, naming the store, when a key never comes back — it is never dropped', async () => {
    const { send, waits, read } = table((_call, batch) => batch);
    await expect(read(keys(1))).rejects.toThrow('Score batch read left unprocessed keys.');
    // Five attempts, a wait between each pair and none before the first.
    expect(send).toHaveBeenCalledTimes(5);
    expect(waits).toHaveLength(4);
  });
});
