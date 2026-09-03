import { describe, expect, it, vi } from 'vitest';
import { GetItemCommand, PutItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { dynamoLeaderStore, memoryLeaderStore } from './leader';

const GROUP = '120363000000000001@g.us';
const DAY = 20700;
const GAB = '33612345678@s.whatsapp.net';
const ZOU = '33600000000@s.whatsapp.net';

// The Get answers with the row that stands; the conditional Put answers with what it
// DISPLACED (`ReturnValues: ALL_OLD`), which is what the outcome is read from.
function answering(item: Record<string, unknown> | undefined) {
  return vi.fn(async (command: unknown) =>
    command instanceof GetItemCommand ? { Item: item } : { Attributes: item },
  );
}

const puts = (send: ReturnType<typeof answering>) =>
  send.mock.calls.map(([command]) => command).filter((c) => c instanceof PutItemCommand);

describe('the new-leader event (#236)', () => {
  it('announces a change of HOLDER — never the first share, never a tie', async () => {
    const store = memoryLeaderStore();
    expect(await store.claim({ group: GROUP, lang: 'fr', dayNumber: DAY, sender: GAB, score: 10 })).toBe('first');
    expect(await store.claim({ group: GROUP, lang: 'fr', dayNumber: DAY, sender: ZOU, score: 4 })).toBe('took_lead');
    expect(await store.claim({ group: GROUP, lang: 'fr', dayNumber: DAY, sender: GAB, score: 4 })).toBe('unchanged');
    expect(await store.claim({ group: GROUP, lang: 'fr', dayNumber: DAY, sender: GAB, score: 9 })).toBe('unchanged');
  });

  it('moves the row on a self-improvement, so the next player is judged against it', async () => {
    const store = memoryLeaderStore();
    await store.claim({ group: GROUP, lang: 'fr', dayNumber: DAY, sender: GAB, score: 10 });
    // Gab improving their own lead is not news…
    expect(await store.claim({ group: GROUP, lang: 'fr', dayNumber: DAY, sender: GAB, score: 5 })).toBe('unchanged');
    // …but it IS the day's best: 7 is two behind it and takes no lead.
    expect(await store.claim({ group: GROUP, lang: 'fr', dayNumber: DAY, sender: ZOU, score: 7 })).toBe('unchanged');
    expect(await store.claim({ group: GROUP, lang: 'fr', dayNumber: DAY, sender: ZOU, score: 3 })).toBe('took_lead');
  });

  it('keeps days, groups and LANGUAGES apart', async () => {
    const store = memoryLeaderStore();
    await store.claim({ group: GROUP, lang: 'fr', dayNumber: DAY, sender: GAB, score: 5 });
    expect(await store.claim({ group: GROUP, lang: 'fr', dayNumber: DAY + 1, sender: ZOU, score: 9 })).toBe('first');
    expect(
      await store.claim({ group: '120363000000000002@g.us', lang: 'fr', dayNumber: DAY, sender: ZOU, score: 9 }),
    ).toBe('first');
    // A group that changed language starts a fresh row: an `en` best must not gate an
    // `fr` announcement, since the two numbers count tries at different puzzles.
    expect(
      await store.claim({ group: GROUP, lang: 'en', dayNumber: DAY, sender: ZOU, score: 9 }),
    ).toBe('first');
  });

  it('the DynamoDB store WRITES the self-improvement it declines to announce', async () => {
    const send = answering({ sender: { S: GAB }, score: { N: '10' } });
    const store = dynamoLeaderStore({ send } as unknown as DynamoDBClient, 'bot');
    expect(await store.claim({ group: GROUP, lang: 'fr', dayNumber: DAY, sender: GAB, score: 5 })).toBe('unchanged');
    const [put] = puts(send) as PutItemCommand[];
    expect(put.input.Item?.score).toEqual({ N: '5' });
    expect(put.input.Item?.sender).toEqual({ S: GAB });
    expect(put.input.ConditionExpression).toBe('attribute_not_exists(#sk) OR #score > :score');
  });

  it('the DynamoDB store writes nothing for a score no better than what stands', async () => {
    const send = answering({ sender: { S: GAB }, score: { N: '3' } });
    const store = dynamoLeaderStore({ send } as unknown as DynamoDBClient, 'bot');
    expect(await store.claim({ group: GROUP, lang: 'fr', dayNumber: DAY, sender: ZOU, score: 8 })).toBe('unchanged');
    expect(puts(send)).toHaveLength(0);
  });

  it('reports a lead taken from a row that appeared AFTER its read — the day-start race', async () => {
    // Two first shares of a day land together: both read an empty day, both write, and
    // this one lands second. Read from its own pre-read it would report `first` and
    // announce nothing, though it has just overtaken the other.
    const send = vi.fn(async (command: unknown) =>
      command instanceof GetItemCommand
        ? { Item: undefined }
        : { Attributes: { sender: { S: GAB }, score: { N: '9' } } },
    );
    const store = dynamoLeaderStore({ send } as unknown as DynamoDBClient, 'bot');
    expect(await store.claim({ group: GROUP, lang: 'fr', dayNumber: DAY, sender: ZOU, score: 4 })).toBe('took_lead');
  });

  it('the DynamoDB store reports a real change of holder', async () => {
    const send = answering({ sender: { S: GAB }, score: { N: '9' } });
    const store = dynamoLeaderStore({ send } as unknown as DynamoDBClient, 'bot');
    expect(await store.claim({ group: GROUP, lang: 'fr', dayNumber: DAY, sender: ZOU, score: 4 })).toBe('took_lead');
    expect(puts(send)).toHaveLength(1);
  });
});
