// CONTRACT (#201): the production round store. One item per (date, lang, mode, publicId)
// in the PLAYER's own partition; the append is ONE conditional UpdateItem carrying the
// cap, the write interval and the puzzle identity, classified by a single consistent read
// when it is refused.

import { describe, expect, it, vi } from 'vitest';
import {
  ConditionalCheckFailedException,
  GetItemCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { ROUND_GUESS_CAP, ROUND_WRITE_MIN_MS } from '@whippin/shared';
import { dynamoRoundStore } from './dynamoRoundStore';

const PUBLIC_ID = 'lfd5pqz5pa7zjm5u';
const NOW = new Date('2026-08-21T14:00:00.000Z');
const KEY = { date: '2026-08-21', lang: 'fr', mode: 'sentence' } as const;
const PUZZLE = 'a1b2c3d4';

function storedItem(
  guesses: string[],
  lastWriteAt: number,
  puzzle: string = PUZZLE,
): Record<string, AttributeValue> {
  return {
    guesses: { L: guesses.map((g) => ({ S: g })) },
    puzzle: { S: puzzle },
    createdAt: { S: '2026-08-21T09:00:00.000Z' },
    lastWriteAt: { N: String(lastWriteAt) },
  };
}

// DynamoDB's CONDITION grammar has NO arithmetic, and its whole function list is these
// six — `size` over a document PATH. `if_not_exists` and `+` belong to an UPDATE
// expression's SET action; naming either in a condition makes the service reject the
// request with a ValidationException at parse, before anything is stored. A mocked
// client cannot produce that error and the memory store never sees the expression, so
// the shape of the expression is what this suite has to hold.
const CONDITION_FUNCTIONS = [
  'attribute_exists',
  'attribute_not_exists',
  'attribute_type',
  'begins_with',
  'contains',
  'size',
];

// DynamoDB rejects an ExpressionAttributeNames entry that no expression references ("Value
// provided in ExpressionAttributeNames unused in expressions: keys: {#x}") and an alias no
// entry declares, and does the same for VALUES. A mocked client validates neither, so a
// command carrying a union map of every attribute the store knows about looks perfectly
// fine here and fails EVERY write in production. `checkedClient` below runs this on every
// command any test in this file issues, so a new write path is covered by existing.
function expectAliasesMatch(command: UpdateItemCommand): void {
  const { UpdateExpression = '', ConditionExpression = '' } = command.input;
  const source = `${UpdateExpression} ${ConditionExpression}`;
  const check = (pattern: RegExp, declared: object | undefined, what: string) => {
    const used = new Set(source.match(pattern) ?? []);
    const keys = new Set(Object.keys(declared ?? {}));
    expect([...keys].filter((k) => !used.has(k)), `${what} declared but unused`).toEqual([]);
    expect([...used].filter((k) => !keys.has(k)), `${what} used but undeclared`).toEqual([]);
  };
  check(/#[A-Za-z0-9_]+/g, command.input.ExpressionAttributeNames, 'name');
  check(/:[A-Za-z0-9_]+/g, command.input.ExpressionAttributeValues, 'value');
}

// Every store in this suite is built over this, so no write escapes the checks above.
function checkedClient(send: (command: unknown) => Promise<unknown>) {
  return vi.fn(async (command: unknown) => {
    if (command instanceof UpdateItemCommand) expectAliasesMatch(command);
    return send(command);
  });
}

function makeStore(send: (command: unknown) => Promise<unknown>) {
  const checked = checkedClient(send);
  return {
    store: dynamoRoundStore({ send: checked } as unknown as DynamoDBClient, 'scores'),
    send: checked,
  };
}

function expectConditionSyntax(expression: string | undefined): void {
  expect(expression).toBeTruthy();
  const source = expression!;
  for (const match of source.matchAll(/([A-Za-z_]+)\s*\(/g)) {
    // `AND (`/`OR (`/`NOT (` are the grammar's own logical operators, not calls.
    if (['AND', 'OR', 'NOT'].includes(match[1].toUpperCase())) continue;
    expect(CONDITION_FUNCTIONS).toContain(match[1]);
  }
  // No arithmetic anywhere, and every `size()` reads a plain attribute PATH rather than
  // wrapping another call.
  expect(source).not.toMatch(/[+*/]/);
  expect(source).not.toMatch(/\s-\s/);
  for (const match of source.matchAll(/size\(\s*([^)]*)\)/g)) {
    expect(match[1].trim()).toMatch(/^#[A-Za-z]+$/);
  }
}

// What the item LOOKS like after the SET actions this command declares — so a test can
// read back exactly what the write wrote instead of hand-building a shape the write path
// could never produce (which is how `createdAt` came to be written as a Number and read
// as a String, silently emptying it for the item's whole life).
function firstWriteResult(command: UpdateItemCommand): Record<string, AttributeValue> {
  const values = command.input.ExpressionAttributeValues!;
  return {
    guesses: values[':batch'],
    puzzle: values[':puzzle'],
    createdAt: values[':created'],
    lastWriteAt: values[':now'],
    progress: values[':progress'],
    // `solved` is only ever WRITTEN true (#203), so an unsolved append declares no value
    // for it at all and the item simply has none.
    ...(values[':solved'] ? { solved: values[':solved'] } : {}),
  };
}

function refuseOnce(item: Record<string, AttributeValue> | undefined) {
  let refused = false;
  return vi.fn(async (command: unknown) => {
    if (command instanceof UpdateItemCommand && !refused) {
      refused = true;
      throw new ConditionalCheckFailedException({
        $metadata: {},
        message: 'The conditional request failed',
      });
    }
    if (command instanceof UpdateItemCommand) {
      return { Attributes: firstWriteResult(command) };
    }
    return item ? { Item: item } : {};
  });
}

describe('dynamoRoundStore (#201)', () => {
  it('reads the round record CONSISTENTLY from the player-keyed item', async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetItemCommand);
      return { Item: storedItem(['bois', 'foret'], 1) };
    });
    const { store } = makeStore(send);

    await expect(store.get(KEY, PUBLIC_ID, PUZZLE)).resolves.toEqual({
      guesses: ['bois', 'foret'],
      createdAt: '2026-08-21T09:00:00.000Z',
    });
    // Per-PLAYER partition, the daily in the sort key: a day partition would put every
    // player's writes for one daily on one key, which adaptive capacity cannot split.
    // Read-after-write: the catch-up read lands right after this player's own appends.
    expect((send.mock.calls[0][0] as GetItemCommand).input).toMatchObject({
      TableName: 'scores',
      Key: { pk: { S: `round#${PUBLIC_ID}` }, sk: { S: 'fr#sentence#2026-08-21' } },
      ConsistentRead: true,
    });
  });

  it('reports a round the server holds nothing for as null', async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    const { store } = makeStore(send);
    await expect(store.get(KEY, PUBLIC_ID, PUZZLE)).resolves.toBeNull();
  });

  it('reports a RETIRED puzzle\'s record as null — the daily was re-published', async () => {
    const send = vi.fn(async (_command: unknown) => ({
      Item: storedItem(['bois'], 1, 'deadbeef'),
    }));
    const { store } = makeStore(send);
    // The old sentence's log must never come back as this puzzle's history: the client
    // reset its local round on exactly this change, and a merge would undo that for good.
    await expect(store.get(KEY, PUBLIC_ID, PUZZLE)).resolves.toBeNull();
  });

  it('appends in ONE conditional write carrying every bound, answering the updated item', async () => {
    const send = vi.fn(async (command: unknown) => ({
      Attributes: firstWriteResult(command as UpdateItemCommand),
    }));
    const { store } = makeStore(send);

    const result = await store.append({
      ...KEY,
      publicId: PUBLIC_ID,
      guesses: ['foret'],
      puzzle: PUZZLE,
      progress: 0,
      solved: false,
      now: NOW,
    });
    expect(result.outcome).toBe('appended');
    expect(result.state.guesses).toEqual(['foret']);
    // createdAt survives the round trip: written as a String and read as one. A Number
    // here reads back as '' on every response, for the item's whole life.
    expect(result.state.createdAt).toBe(NOW.toISOString());

    const command = send.mock.calls[0][0] as UpdateItemCommand;
    expect(command.input).toMatchObject({
      TableName: 'scores',
      Key: { pk: { S: `round#${PUBLIC_ID}` }, sk: { S: 'fr#sentence#2026-08-21' } },
      ReturnValues: 'ALL_NEW',
      ExpressionAttributeValues: {
        ':batch': { L: [{ S: 'foret' }] },
        ':puzzle': { S: PUZZLE },
        ':now': { N: String(NOW.getTime()) },
        ':created': { S: NOW.toISOString() },
        ':cutoff': { N: String(NOW.getTime() - ROUND_WRITE_MIN_MS) },
      },
    });
    // The expression must be legal CONDITION syntax — the one thing a mocked client
    // cannot tell us.
    expectConditionSyntax(command.input.ConditionExpression);
    // The cap bounds the RESULTING log: ROOM is the cap minus this batch, so the log may
    // REACH the cap and never pass it, whatever the batch size.
    expect(command.input.ExpressionAttributeValues![':room']).toEqual({ N: String(ROUND_GUESS_CAP - 1) });
    expect(command.input.ConditionExpression).toContain('size(#g) <= :room');
    // The interval and the puzzle identity are clauses of the SAME condition — one
    // atomic decision, so no bound can be raced.
    expect(command.input.ConditionExpression).toContain(
      '(attribute_not_exists(#last) OR #last < :cutoff)',
    );
    expect(command.input.ConditionExpression).toContain('#p = :puzzle');
    // createdAt survives the first write only.
    expect(command.input.UpdateExpression).toContain('if_not_exists(#created, :created)');
  });

  it('leaves room for a whole batch, not just one guess', async () => {
    const send = vi.fn(async (command: unknown) => ({
      Attributes: firstWriteResult(command as UpdateItemCommand),
    }));
    const { store } = makeStore(send);
    await store.append({
      ...KEY,
      publicId: PUBLIC_ID,
      guesses: ['a', 'b', 'c'],
      puzzle: PUZZLE,
      progress: 0,
      solved: false,
      now: NOW,
    });
    const command = send.mock.calls[0][0] as UpdateItemCommand;
    expect(command.input.ExpressionAttributeValues![':room']).toEqual({
      N: String(ROUND_GUESS_CAP - 3),
    });
  });

  it('refuses a batch too large for an EMPTY log without writing', async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    const { store } = makeStore(send);
    const refused = await store.append({
      ...KEY,
      publicId: PUBLIC_ID,
      guesses: Array.from({ length: ROUND_GUESS_CAP + 1 }, () => 'a'),
      puzzle: PUZZLE,
      progress: 0,
      solved: false,
      now: NOW,
    });
    // A missing attribute has no size, so this half of the cap cannot be a condition —
    // the store owns it instead of creating a record born past the cap.
    expect(refused.outcome).toBe('round_full');
    expect(send.mock.calls.every(([command]) => !(command instanceof UpdateItemCommand))).toBe(true);
  });

  it('classifies a refused append by reading the stored log once', async () => {
    const existing = storedItem(Array.from({ length: ROUND_GUESS_CAP }, () => 'a'), 1);
    const send = refuseOnce(existing);
    const { store } = makeStore(send);

    const refused = await store.append({
      ...KEY,
      publicId: PUBLIC_ID,
      guesses: ['one-more'],
      puzzle: PUZZLE,
      progress: 0,
      solved: false,
      now: NOW,
    });
    // The log is at the cap and any batch would overflow it: the cap refusal, not the
    // interval — retrying can never succeed, and the client must stop rather than wait.
    expect(refused.outcome).toBe('round_full');
    expect(refused.state.guesses).toHaveLength(ROUND_GUESS_CAP);
  });

  it('answers too_fast when the stored log has room but the interval has not', async () => {
    const send = refuseOnce(storedItem(['bois'], NOW.getTime() - 100));
    const { store } = makeStore(send);

    const refused = await store.append({
      ...KEY,
      publicId: PUBLIC_ID,
      guesses: ['foret'],
      puzzle: PUZZLE,
      progress: 0,
      solved: false,
      now: NOW,
    });
    expect(refused.outcome).toBe('too_fast');
    expect(refused.state).toMatchObject({ guesses: ['bois'] });
  });

  it('REPLACES a retired puzzle\'s log instead of growing it', async () => {
    const send = refuseOnce(storedItem(['ancien'], 1, 'deadbeef'));
    const { store } = makeStore(send);

    const result = await store.append({
      ...KEY,
      publicId: PUBLIC_ID,
      guesses: ['bois'],
      puzzle: PUZZLE,
      progress: 0,
      solved: false,
      now: NOW,
    });
    expect(result.outcome).toBe('appended');
    // The retired sentence's tries are GONE, not merged under the new one's.
    expect(result.state.guesses).toEqual(['bois']);

    const replace = send.mock.calls.at(-1)![0] as UpdateItemCommand;
    expect(replace.input.UpdateExpression).toContain('SET #g = :batch');
    // Only a record still naming the retired puzzle may be replaced, and the interval
    // still binds — varying the tag must not be a way around the rate bound.
    expectConditionSyntax(replace.input.ConditionExpression);
    expect(replace.input.ConditionExpression).toContain('#p <> :puzzle');
    expect(replace.input.ConditionExpression).toContain('#last < :cutoff');
  });

  it('refuses a retired-puzzle restart inside the interval WITHOUT handing its log back', async () => {
    const send = refuseOnce(storedItem(['ancien'], NOW.getTime() - 100, 'deadbeef'));
    const { store } = makeStore(send);

    const refused = await store.append({
      ...KEY,
      publicId: PUBLIC_ID,
      guesses: ['bois'],
      puzzle: PUZZLE,
      progress: 0,
      solved: false,
      now: NOW,
    });
    expect(refused.outcome).toBe('too_fast');
    // The client adopts EVERY answer as this round's truth, refusals included. Answering
    // with the retired sentence's log would walk those guesses straight back into the
    // corrected puzzle — the one door left open in the tag's whole purpose.
    expect(refused.state.guesses).toEqual([]);
    // Nothing was rewritten.
    expect(send.mock.calls.filter(([c]) => c instanceof UpdateItemCommand)).toHaveLength(1);
  });

  it('re-reads after LOSING a restart race, and answers with this puzzle\'s log', async () => {
    // Another tab restarted the round first: the replace's `#p <> :puzzle` no longer
    // holds, and what is stored now is already THIS puzzle's fresh log.
    const retired = storedItem(['ancien'], 1, 'deadbeef');
    const restarted = storedItem(['neuf'], NOW.getTime(), PUZZLE);
    let updates = 0;
    let reads = 0;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof UpdateItemCommand) {
        updates += 1;
        throw new ConditionalCheckFailedException({
          $metadata: {},
          message: 'The conditional request failed',
        });
      }
      reads += 1;
      return { Item: reads === 1 ? retired : restarted };
    });
    const { store } = makeStore(send);

    const refused = await store.append({
      ...KEY,
      publicId: PUBLIC_ID,
      guesses: ['bois'],
      puzzle: PUZZLE,
      progress: 0,
      solved: false,
      now: NOW,
    });
    expect(updates).toBe(2); // the append, then the refused replace
    expect(refused.outcome).toBe('too_fast');
    expect(refused.state.guesses).toEqual(['neuf']);
  });

  it('surfaces operational failures instead of misreading them as refusals', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof UpdateItemCommand) {
        throw new Error('ProvisionedThroughputExceeded');
      }
      return {};
    });
    const { store } = makeStore(send);
    await expect(
      store.append({
        ...KEY,
        publicId: PUBLIC_ID,
        guesses: ['a'],
        puzzle: PUZZLE,
        progress: 0,
        solved: false,
        now: NOW,
      }),
    ).rejects.toThrow('ProvisionedThroughputExceeded');
  });
});

// CONTRACT (#202): Word mode's two writes land on the SAME item. START is one conditional
// UpdateItem stamping `startedAt` — idempotent for this word, restarting for a retired one.
// SUBMIT reads once (the wait check is arithmetic, which a condition cannot express, and
// the caller has to be told WHICH bound refused it) and then writes first-write-wins.
describe('dynamoRoundStore — word mode (#202)', () => {
  const WORD_KEY = { date: '2026-08-21', lang: 'fr', mode: 'word' } as const;
  const START_INPUT = { ...WORD_KEY, publicId: PUBLIC_ID, puzzle: PUZZLE, now: NOW };

  // A submitted round carries BOTH its log and `submittedAt`: the marker is the attribute,
  // never the log's length, or a recorded 0-claim run reads as unsubmitted.
  function startedItem(
    startedAt: string,
    guesses?: string[],
    puzzle: string = PUZZLE,
  ): Record<string, AttributeValue> {
    return {
      ...(guesses ? { guesses: { L: guesses.map((g) => ({ S: g })) }, submittedAt: { S: startedAt } } : {}),
      puzzle: { S: puzzle },
      createdAt: { S: startedAt },
      startedAt: { S: startedAt },
    };
  }

  it('stamps the clock in ONE conditional write, from the SERVER\'s own instant', async () => {
    const send = vi.fn(async (_command: unknown) => ({
      Attributes: startedItem(NOW.toISOString()),
    }));
    const { store } = makeStore(send);

    const result = await store.start(START_INPUT);
    expect(result.outcome).toBe('started');
    // A STRING, like createdAt: the Number spelling is reserved for the one attribute a
    // condition compares arithmetically.
    expect(result.state.startedAt).toBe(NOW.toISOString());

    const command = send.mock.calls[0][0] as UpdateItemCommand;
    expect(command.input).toMatchObject({
      Key: { pk: { S: `round#${PUBLIC_ID}` }, sk: { S: 'fr#word#2026-08-21' } },
      ReturnValues: 'ALL_NEW',
    });
    expectConditionSyntax(command.input.ConditionExpression);
    // Fresh record OR a retired word's — and never this word's own running clock.
    expect(command.input.ConditionExpression).toContain('attribute_not_exists(#started)');
    expect(command.input.ConditionExpression).toContain('#p <> :puzzle');
    // A restart takes the retired word's log with it.
    expect(command.input.UpdateExpression).toContain('REMOVE #g');
  });

  it('resumes the ORIGINAL clock when this word is already running', async () => {
    const stamped = '2026-08-21T13:59:00.000Z';
    const send = refuseOnce(startedItem(stamped));
    const { store } = makeStore(send);

    const result = await store.start(START_INPUT);
    // The daily is one-shot: a double tap, a retry and a second device all get the one
    // start, never a fresh minute.
    expect(result.outcome).toBe('running');
    expect(result.state.startedAt).toBe(stamped);
  });

  it('records the whole log once the run could be over, first write wins', async () => {
    const stamped = '2026-08-21T13:00:00.000Z';
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof UpdateItemCommand) {
        return { Attributes: startedItem(stamped, ['mer', 'loin']) };
      }
      return { Item: startedItem(stamped) };
    });
    const { store } = makeStore(send);

    const result = await store.submit({
      ...WORD_KEY,
      publicId: PUBLIC_ID,
      puzzle: PUZZLE,
      guesses: ['mer', 'loin'],
      minElapsedMs: 64_000,
      now: NOW,
    });
    expect(result.outcome).toBe('submitted');
    expect(result.state.guesses).toEqual(['mer', 'loin']);

    const write = send.mock.calls.find(([c]) => c instanceof UpdateItemCommand)![0] as UpdateItemCommand;
    expectConditionSyntax(write.input.ConditionExpression);
    // Still this word's, still started, still unsubmitted — first-write-wins is decided by
    // the STORE, not by the read that preceded it.
    expect(write.input.ConditionExpression).toContain('attribute_not_exists(#sub)');
    expect(write.input.ConditionExpression).toContain('attribute_exists(#started)');
    expect(write.input.ConditionExpression).toContain('#p = :puzzle');
  });

  it('refuses a submission that arrives before the run can be over — and writes nothing', async () => {
    const stamped = new Date(NOW.getTime() - 10_000).toISOString();
    const send = vi.fn(async (_command: unknown) => ({ Item: startedItem(stamped) }));
    const { store } = makeStore(send);

    const refused = await store.submit({
      ...WORD_KEY,
      publicId: PUBLIC_ID,
      puzzle: PUZZLE,
      guesses: ['mer'],
      minElapsedMs: 64_000,
      now: NOW,
    });
    expect(refused.outcome).toBe('too_early');
    expect(refused.state.startedAt).toBe(stamped);
    expect(send.mock.calls.every(([c]) => !(c instanceof UpdateItemCommand))).toBe(true);
  });

  it('refuses a submission for a run nobody started here', async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    const { store } = makeStore(send);
    await expect(
      store.submit({
        ...WORD_KEY,
        publicId: PUBLIC_ID,
        puzzle: PUZZLE,
        guesses: [],
        minElapsedMs: 60_000,
        now: NOW,
      }),
    ).resolves.toMatchObject({ outcome: 'not_started' });
  });

  it('answers a SECOND submission with the run that was recorded', async () => {
    const stamped = '2026-08-21T13:00:00.000Z';
    const send = vi.fn(async (_command: unknown) => ({
      Item: startedItem(stamped, ['mer']),
    }));
    const { store } = makeStore(send);

    const again = await store.submit({
      ...WORD_KEY,
      publicId: PUBLIC_ID,
      puzzle: PUZZLE,
      guesses: ['mer', 'ocean'],
      minElapsedMs: 64_000,
      now: NOW,
    });
    expect(again.outcome).toBe('already_submitted');
    expect(again.state.guesses).toEqual(['mer']);
  });

  it('never hands back a RETIRED word\'s state', async () => {
    const send = vi.fn(async (_command: unknown) => ({
      Item: startedItem('2026-08-21T13:00:00.000Z', ['ancien'], 'deadbeef'),
    }));
    const { store } = makeStore(send);
    const refused = await store.submit({
      ...WORD_KEY,
      publicId: PUBLIC_ID,
      puzzle: PUZZLE,
      guesses: ['mer'],
      minElapsedMs: 64_000,
      now: NOW,
    });
    // The record names a word this submission knows nothing about: there is no run of THIS
    // one to end, and the retired one's log must not travel back to the client.
    expect(refused.outcome).toBe('not_started');
    expect(refused.state.guesses).toEqual([]);
    expect(refused.state.startedAt).toBeUndefined();
  });
});

// CONTRACT (#202): the submission's marker is `submittedAt`, never the LOG'S LENGTH. A run
// that claimed nothing records an EMPTY log, which by length alone is indistinguishable
// from an unsubmitted round — so a second submission overwrote it, a retry of it
// classified as `not_started` (a VERDICT the client closes on), and a mount read could not
// tell the day was already recorded.
describe('a recorded 0-claim run (#202)', () => {
  const WORD_KEY = { date: '2026-08-21', lang: 'fr', mode: 'word' } as const;
  const STAMP = '2026-08-21T13:00:00.000Z';
  const submitInput = (guesses: string[]) => ({
    ...WORD_KEY,
    publicId: PUBLIC_ID,
    puzzle: PUZZLE,
    guesses,
    minElapsedMs: 60_000,
    now: NOW,
  });

  function item(extra: Record<string, AttributeValue> = {}): Record<string, AttributeValue> {
    return {
      puzzle: { S: PUZZLE },
      createdAt: { S: STAMP },
      startedAt: { S: STAMP },
      ...extra,
    };
  }

  it('is marked by an attribute, so the write records one', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof UpdateItemCommand) {
        return { Attributes: item({ guesses: { L: [] }, submittedAt: { S: NOW.toISOString() } }) };
      }
      return { Item: item() };
    });
    const { store } = makeStore(send);
    const first = await store.submit(submitInput([]));
    expect(first.outcome).toBe('submitted');
    expect(first.state.guesses).toEqual([]);
    expect(first.state.submittedAt).toBe(NOW.toISOString());
  });

  it('cannot be overwritten by a later submission, and is not mistaken for "never started"', async () => {
    // What stands is an EMPTY recorded run.
    const send = vi.fn(async (_command: unknown) => ({
      Item: item({ guesses: { L: [] }, submittedAt: { S: STAMP } }),
    }));
    const { store, send: checked } = makeStore(send);

    const again = await store.submit(submitInput(['mer']));
    // Answered with what was recorded — not overwritten, and NOT `not_started`, which the
    // client treats as a verdict and closes the conversation on.
    expect(again.outcome).toBe('already_submitted');
    expect(again.state.guesses).toEqual([]);
    // Refused before the store was touched at all.
    expect(checked.mock.calls.every(([c]) => !(c instanceof UpdateItemCommand))).toBe(true);
  });
});

// CONTRACT (#203): the derived summary rides the append's own mutation, a SOLVED round is
// frozen by one more clause on the condition it already sends, and the corrective write is
// the one small extra mutation — issued only when the returned log disagrees.
describe('dynamoRoundStore — the derived summary (#203)', () => {
  const derived = (progress: number, solved: boolean) => ({
    ...KEY,
    publicId: PUBLIC_ID,
    guesses: ['mer'],
    puzzle: PUZZLE,
    progress,
    solved,
    now: NOW,
  });

  it('writes progress with the guesses, in ONE mutation, and reads it back', async () => {
    const send = vi.fn(async (command: unknown) => ({
      Attributes: firstWriteResult(command as UpdateItemCommand),
    }));
    const { store } = makeStore(send);

    const result = await store.append(derived(42.5, false));
    expect(result.outcome).toBe('appended');
    expect(result.state.progress).toBe(42.5);
    // Only ever written TRUE: an unsolved append leaves the attribute absent, so nothing
    // can un-finish a day another device just finished.
    expect(result.state.solved).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);

    const command = send.mock.calls[0][0] as UpdateItemCommand;
    expect(command.input.UpdateExpression).toContain('#prog = :progress');
    expect(command.input.UpdateExpression).not.toContain('#solved =');
    expect(command.input.ExpressionAttributeValues).not.toHaveProperty(':solved');
  });

  it('FREEZES the round with a path-only clause on the condition it already sends', async () => {
    const send = vi.fn(async (command: unknown) => ({
      Attributes: firstWriteResult(command as UpdateItemCommand),
    }));
    const { store } = makeStore(send);
    await store.append(derived(100, true));

    const command = send.mock.calls[0][0] as UpdateItemCommand;
    // No extra READ buys the freeze — DynamoDB evaluates it as part of the same write.
    expect(send).toHaveBeenCalledTimes(1);
    expect(command.input.ConditionExpression).toContain('attribute_not_exists(#solved)');
    expectConditionSyntax(command.input.ConditionExpression);
    expect(command.input.UpdateExpression).toContain('#solved = :solved');
  });

  it('classifies a refusal on a SOLVED record as round_solved, above the cap and the interval', async () => {
    // The stored item is at the cap AND inside the interval AND solved: the truest answer
    // is the one that can never be retried into success.
    const solved = {
      ...storedItem(Array.from({ length: ROUND_GUESS_CAP }, (_, i) => `g${i}`), NOW.getTime()),
      solved: { BOOL: true },
      progress: { N: '100' },
    };
    const { store } = makeStore(refuseOnce(solved));

    const refused = await store.append(derived(100, false));
    expect(refused.outcome).toBe('round_solved');
    expect(refused.state.solved).toBe(true);
    expect(refused.state.progress).toBe(100);
  });

  it('a RESTART clears the retired puzzle\'s solve, or the fresh round is born frozen', async () => {
    const retired = { ...storedItem(['ancien'], 1, 'deadbeef'), solved: { BOOL: true } };
    const { store, send } = makeStore(refuseOnce(retired));

    const result = await store.append(derived(10, false));
    expect(result.outcome).toBe('appended');
    const replace = send.mock.calls.at(-1)![0] as UpdateItemCommand;
    expect(replace.input.UpdateExpression).toContain('REMOVE #solved');
  });

  it('the corrective write is ONE conditional update, gated on the puzzle identity', async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    const { store } = makeStore(send);
    await store.settle({ ...KEY, publicId: PUBLIC_ID, puzzle: PUZZLE, progress: 100, solved: true });

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as UpdateItemCommand;
    expect(command.input.UpdateExpression).toBe('SET #prog = :progress, #solved = :solved');
    // A record naming a DIFFERENT puzzle has already restarted and has nothing here to
    // correct. (The monotonicity clause beside it has its own suite below.)
    expect(command.input.ConditionExpression).toContain('#p = :puzzle');
    expectConditionSyntax(command.input.ConditionExpression);
  });

  it('corrects progress alone without ever writing solved false', async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    const { store } = makeStore(send);
    await store.settle({ ...KEY, publicId: PUBLIC_ID, puzzle: PUZZLE, progress: 66, solved: false });
    const command = send.mock.calls[0][0] as UpdateItemCommand;
    expect(command.input.UpdateExpression).toBe('SET #prog = :progress');
    expect(command.input.ExpressionAttributeValues).not.toHaveProperty(':solved');
  });

  it('leaves a re-published round alone rather than correcting a summary of the wrong puzzle', async () => {
    const send = vi.fn(async () => {
      throw new ConditionalCheckFailedException({
        $metadata: {},
        message: 'The conditional request failed',
      });
    });
    const { store } = makeStore(send);
    await expect(
      store.settle({ ...KEY, publicId: PUBLIC_ID, puzzle: PUZZLE, progress: 100, solved: true }),
    ).resolves.toBeUndefined();
  });

  it('surfaces an operational failure of the corrective write, so the caller can retry it', async () => {
    // It is the LAST chance to record a solve: once the puzzle is solved the player stops
    // guessing, so nothing later comes along to notice the omission.
    const send = vi.fn(async () => {
      throw new Error('ProvisionedThroughputExceeded');
    });
    const { store } = makeStore(send);
    await expect(
      store.settle({ ...KEY, publicId: PUBLIC_ID, puzzle: PUZZLE, progress: 100, solved: true }),
    ).rejects.toThrow('ProvisionedThroughputExceeded');
  });

  it('reads the pre-write derivation EVENTUALLY consistently, and everything else strongly', async () => {
    const send = vi.fn(async (_command: unknown) => ({ Item: storedItem(['bois'], 1) }));
    const { store } = makeStore(send);
    await store.get(KEY, PUBLIC_ID, PUZZLE, { consistent: false });
    expect((send.mock.calls[0][0] as GetItemCommand).input.ConsistentRead).toBe(false);
    await store.get(KEY, PUBLIC_ID, PUZZLE);
    expect((send.mock.calls[1][0] as GetItemCommand).input.ConsistentRead).toBe(true);
  });
});

// CONTRACT (#203, tightened on review): `progress` is written UPWARD only. Two settles can
// be in flight at once — the corrective write sits behind a retry backoff, and another
// device's append can land and settle inside it — so the later ARRIVAL may carry the older
// log. Last-writer-wins would park a lower percentage on the row for good, since a solved
// round takes no further append to repair it.
describe('dynamoRoundStore — the corrective write is MONOTONIC (#203)', () => {
  const settle = (progress: number, solved: boolean) => ({
    ...KEY,
    publicId: PUBLIC_ID,
    puzzle: PUZZLE,
    progress,
    solved,
  });

  it('guards the write with a comparison the CONDITION grammar actually has', async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    const { store } = makeStore(send);
    await store.settle(settle(60, false));

    const command = send.mock.calls[0][0] as UpdateItemCommand;
    expect(command.input.ConditionExpression).toBe(
      '#p = :puzzle AND (attribute_not_exists(#prog) OR #prog <= :progress)',
    );
    // A comparator against a value is the grammar's own (`#last < :cutoff` relies on it);
    // arithmetic and `if_not_exists` are what it does not have.
    expectConditionSyntax(command.input.ConditionExpression);
  });

  it('lets the FIRST correction through on a row that has no progress yet', async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    const { store } = makeStore(send);
    await store.settle(settle(60, false));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('is `<=` so a SOLVE still lands when the percentage is already what it will be', async () => {
    // A solved derivation is exactly 100, which is also the maximum a stored value can
    // hold — so this clause can never refuse a solve, only a lowering correction.
    const send = vi.fn(async (_command: unknown) => ({}));
    const { store } = makeStore(send);
    await store.settle(settle(100, true));
    const command = send.mock.calls[0][0] as UpdateItemCommand;
    expect(command.input.ExpressionAttributeValues![':progress']).toEqual({ N: '100' });
    expect(command.input.UpdateExpression).toContain('#solved = :solved');
  });

  it('swallows the refusal: a better correction landing first is the right outcome', async () => {
    const send = vi.fn(async (_command: unknown) => {
      throw new ConditionalCheckFailedException({
        $metadata: {},
        message: 'The conditional request failed',
      });
    });
    const { store } = makeStore(send);
    // Indistinguishable from a republish, and neither is a retry — the row already holds
    // something at least as true as what this write carried.
    await expect(store.settle(settle(60, false))).resolves.toBeUndefined();
  });
});
