import {
  GetItemCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { ROUND_GUESS_CAP, ROUND_WRITE_MIN_MS } from '@whippin/shared';
import {
  roundPartition,
  roundSortKey,
  type RoundKey,
  type RoundState,
  type RoundStore,
} from './roundStore';

// Production round records live in the score table (#201): one item per
// (date, lang, mode, publicId), in the PLAYER's own `round#<publicId>` partition under a
// `<date>#<lang>#<mode>` sort key (see roundStore.ts for why the day is not the partition).
//
// The append is ONE conditional UpdateItem — the cap, the per-player write interval and
// the puzzle identity are three clauses of the same ConditionExpression as the
// `list_append` itself, so a refused append cannot be raced past any of them. Success
// returns the updated item (ReturnValues) so the happy path is one call; a failed
// condition reads the item once, consistently, to classify the refusal — the condition
// cannot say which clause rejected it, and the caller owes the client the distinction (a
// cap stops the round; a rate refusal only delays it; a retired puzzle restarts it).
//
// WORD mode's two writes (#202) land on the SAME item: `start` stamps `startedAt` (one
// conditional UpdateItem, the append's shape) and `submit` records the whole log once.
export function dynamoRoundStore(client: DynamoDBClient, tableName: string): RoundStore {
  const itemKey = (key: RoundKey, publicId: string) => ({
    pk: { S: roundPartition(publicId) },
    sk: { S: roundSortKey(key) },
  });

  // Strong consistency, for the score store's reason: the read lands right after this
  // player's own appends — the sync's catch-up on load, and the classification of the
  // write that just failed — which must not be invisible to it.
  const readItem = async (key: RoundKey, publicId: string) => {
    const response = await client.send(
      new GetItemCommand({
        TableName: tableName,
        Key: itemKey(key, publicId),
        ConsistentRead: true,
      }),
    );
    return response.Item;
  };

  // EVERY alias a command declares must appear in that command's own expressions, and
  // every alias its expressions name must be declared: DynamoDB rejects either mismatch
  // with a ValidationException ("Value provided in ExpressionAttributeNames unused in
  // expressions") before a byte is written. So the maps are PER COMMAND, never one shared
  // map covering the union — a shared one is only correct until a write stops using one of
  // its entries, which is silent everywhere a mocked client is the only reader.
  // `dynamoRoundStore.test.ts` asserts the correspondence on every command this store
  // issues, in both directions and for values too.
  const NAMES = {
    guesses: '#g',
    puzzle: '#p',
    lastWriteAt: '#last',
    createdAt: '#created',
    startedAt: '#started',
    submittedAt: '#sub',
  } as const;

  // The alias map for exactly the attributes one command touches.
  const aliases = (...attributes: (keyof typeof NAMES)[]): Record<string, string> =>
    Object.fromEntries(attributes.map((attribute) => [NAMES[attribute], attribute]));

  return {
    async get(key, publicId, puzzle) {
      const item = await readItem(key, publicId);
      // A record naming a DIFFERENT puzzle is an honest "nothing stored for this one":
      // the daily was re-published under the same key and this log is the retired
      // sentence's (roundStore.ts).
      if (!item || puzzleOf(item) !== puzzle) return null;
      return itemToState(item);
    },

    async append(input) {
      const nowMs = input.now.getTime();
      const cutoff = nowMs - ROUND_WRITE_MIN_MS;
      const values = (extra: Record<string, AttributeValue>) => ({
        ':batch': { L: input.guesses.map((guess) => ({ S: guess })) },
        ':puzzle': { S: input.puzzle },
        ':now': { N: String(nowMs) },
        ':created': { S: input.now.toISOString() },
        ':cutoff': { N: String(cutoff) },
        ...extra,
      });

      // The store owns the cap invariant, and this half of it cannot be a condition: a
      // batch too large for an EMPTY log has nothing to compare against (a missing
      // attribute has no size), so refuse it here. The route validates the same bound
      // before this is reached — this is what keeps the two backends answering alike.
      if (input.guesses.length > ROUND_GUESS_CAP) {
        return {
          outcome: 'round_full',
          state: stateForTag(await readItem(input, input.publicId), input.puzzle),
        };
      }

      try {
        const response = await client.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: itemKey(input, input.publicId),
            UpdateExpression:
              'SET #g = list_append(if_not_exists(#g, :empty), :batch), ' +
              '#p = :puzzle, #last = :now, #created = if_not_exists(#created, :created)',
            // Every clause is path-only CONDITION syntax. DynamoDB's condition grammar
            // has NO arithmetic, its function list is attribute_exists /
            // attribute_not_exists / attribute_type / begins_with / contains /
            // size(<path>), and `if_not_exists` is specific to an update expression's SET
            // action — naming either here makes the service reject the whole request with
            // a ValidationException before a single guess is stored. So the cap is
            // expressed as ROOM (`:room` = the cap minus this batch) against the log's own
            // size, which bounds the RESULTING log exactly as `size + batch <= cap` would:
            // the result may REACH the cap, never pass it.
            ConditionExpression:
              '(attribute_not_exists(#last) OR #last < :cutoff) ' +
              'AND (attribute_not_exists(#g) OR (size(#g) <= :room AND #p = :puzzle))',
            ExpressionAttributeNames: aliases('guesses', 'puzzle', 'lastWriteAt', 'createdAt'),
            ExpressionAttributeValues: values({
              ':empty': { L: [] },
              ':room': { N: String(ROUND_GUESS_CAP - input.guesses.length) },
            }),
            ReturnValues: 'ALL_NEW',
          }),
        );
        return { outcome: 'appended', state: itemToState(response.Attributes)! };
      } catch (error) {
        if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
      }

      // The condition named three bounds; classify against the stored item.
      const item = await readItem(input, input.publicId);
      const last = numberOf(item?.lastWriteAt);
      const paced = last === undefined || last < cutoff;

      if (puzzleOf(item) !== input.puzzle) {
        // A RETIRED puzzle's log (or no record at all): the round restarted under the
        // same key, so the batch REPLACES it rather than growing it. The interval still
        // applies — otherwise varying the tag would be a way around the rate bound.
        if (!paced) return { outcome: 'too_fast', state: empty() };
        try {
          const response = await client.send(
            new UpdateItemCommand({
              TableName: tableName,
              Key: itemKey(input, input.publicId),
              UpdateExpression: 'SET #g = :batch, #p = :puzzle, #last = :now, #created = :created',
              // Only a record still naming the retired puzzle may be replaced, so two
              // tabs racing the same restart cannot wipe each other's fresh log.
              ConditionExpression:
                '#p <> :puzzle AND (attribute_not_exists(#last) OR #last < :cutoff)',
              ExpressionAttributeNames: aliases('guesses', 'puzzle', 'lastWriteAt', 'createdAt'),
              ExpressionAttributeValues: values({}),
              ReturnValues: 'ALL_NEW',
            }),
          );
          return { outcome: 'appended', state: itemToState(response.Attributes)! };
        } catch (error) {
          if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
          // Lost the restart race — another tab replaced it first, or a write landed
          // inside the interval. Re-read: whatever is there now may already BE this
          // puzzle's fresh log, which is the truth to answer with.
          return {
            outcome: 'too_fast',
            state: stateForTag(await readItem(input, input.publicId), input.puzzle),
          };
        }
      }

      const stored = itemToState(item);
      if (!stored) return { outcome: 'too_fast', state: empty() };
      // A log already at (or within one batch of) the cap is the cap refusal — the truer
      // answer, since retrying can never succeed — and anything else is the interval.
      if (stored.guesses.length + input.guesses.length > ROUND_GUESS_CAP) {
        return { outcome: 'round_full', state: stored };
      }
      return { outcome: 'too_fast', state: stored };
    },

    // WORD mode's first write (#202): stamp the round's start from THIS server's clock.
    //
    // One conditional UpdateItem does both branches the operation has. `attribute_not_exists
    // (#started) OR #p <> :puzzle` passes for a record that does not exist (the first
    // clause — a missing attribute makes the comparison in the second FALSE, never true),
    // and for one naming a RETIRED word (the round restarts, so its log is REMOVEd with the
    // old start). It fails for exactly the case that must not move: this puzzle's clock is
    // already stamped, which the classification read below answers with.
    async start(input) {
      const stampedAt = input.now.toISOString();
      try {
        const response = await client.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: itemKey(input, input.publicId),
            // A RESTART takes the retired word's whole run with it — its log AND the mark
            // saying that log was recorded, or the fresh round would read as already
            // submitted and never write.
            UpdateExpression:
              'SET #started = :now, #p = :puzzle, #created = :now REMOVE #g, #sub',
            ConditionExpression: 'attribute_not_exists(#started) OR #p <> :puzzle',
            ExpressionAttributeNames: aliases(
              'startedAt',
              'puzzle',
              'createdAt',
              'guesses',
              'submittedAt',
            ),
            ExpressionAttributeValues: {
              ':puzzle': { S: input.puzzle },
              ':now': { S: stampedAt },
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return { outcome: 'started', state: itemToState(response.Attributes)! };
      } catch (error) {
        if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
      }
      // Already running: the ORIGINAL start stands, and the answer carries it so a second
      // tap, a retry or a second device all resume the one clock. `stateForTag` is belt and
      // braces — the condition only fails for this puzzle's own record.
      return {
        outcome: 'running',
        state: stateForTag(await readItem(input, input.publicId), input.puzzle),
      };
    },

    // WORD mode's second and last write (#202): the whole log, once.
    //
    // It reads BEFORE writing, unlike the streaming append, because the two refusals it owes
    // the caller are not expressible as conditions: the wait check compares instants
    // arithmetically (DynamoDB's condition grammar has none) and the caller has to be told
    // WHICH bound refused it. Neither is racy — `startedAt` is stamped once and never moves,
    // and the write itself still carries `attribute_not_exists(#g)`, so first-write-wins is
    // decided by the store rather than by the read that preceded it.
    async submit(input) {
      const stored = stateForTag(await readItem(input, input.publicId), input.puzzle);
      if (!stored.startedAt) return { outcome: 'not_started', state: empty() };
      // `submittedAt`, never the log's length: a run that claimed nothing records an EMPTY
      // log, and reading that back as "nothing recorded" is what let a second submission
      // overwrite it (roundStore.ts).
      if (stored.submittedAt) return { outcome: 'already_submitted', state: stored };
      if (input.now.getTime() - Date.parse(stored.startedAt) < input.minElapsedMs) {
        return { outcome: 'too_early', state: stored };
      }

      try {
        const response = await client.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: itemKey(input, input.publicId),
            UpdateExpression: 'SET #g = :log, #sub = :now',
            // Path-only condition syntax, the append's rule: the record must still be this
            // puzzle's, still started, and still unsubmitted.
            ConditionExpression:
              '#p = :puzzle AND attribute_exists(#started) AND attribute_not_exists(#sub)',
            ExpressionAttributeNames: aliases('guesses', 'submittedAt', 'puzzle', 'startedAt'),
            ExpressionAttributeValues: {
              ':puzzle': { S: input.puzzle },
              ':log': { L: input.guesses.map((guess) => ({ S: guess })) },
              ':now': { S: input.now.toISOString() },
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return { outcome: 'submitted', state: itemToState(response.Attributes)! };
      } catch (error) {
        if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
      }
      // Lost the race. Re-read and let what STANDS say which race it was: another device's
      // submission landing first, or the daily being re-published under us — where this log
      // describes a retired word and the round has restarted without it.
      const now = stateForTag(await readItem(input, input.publicId), input.puzzle);
      return now.submittedAt
        ? { outcome: 'already_submitted', state: now }
        : { outcome: 'not_started', state: now };
    },
  };
}

function empty(): RoundState {
  return { guesses: [], createdAt: '' };
}

// The state a caller may be TOLD about, which is only ever the state of the puzzle it
// asked about. A record naming a different one holds the RETIRED sentence's log, and
// every answer — the refusals included — is adopted by the client as this round's truth:
// handing that log back on a rate-refused restart would reintroduce exactly the guesses
// the tag exists to exclude, through the one door left open.
function stateForTag(item: Item, puzzle: string): RoundState {
  return puzzleOf(item) === puzzle ? itemToState(item) ?? empty() : empty();
}

type Item = Record<string, AttributeValue> | undefined;

function itemToState(item: Item): RoundState | null {
  if (!item) return null;
  const startedAt = item.startedAt?.S;
  const submittedAt = item.submittedAt?.S;
  return {
    guesses: item.guesses?.L?.map((v) => v.S ?? '') ?? [],
    // Written as a STRING (`:created`), read as one: `lastWriteAt` is the only round
    // attribute that is a Number, because only IT is compared arithmetically in the
    // append's condition. Writing this one as a Number and reading it as a String is
    // silent — the `?? ''` fallback makes every response carry an empty createdAt for
    // the item's whole life — so the two spellings are kept next to each other.
    createdAt: item.createdAt?.S ?? '',
    // ABSENT rather than empty when unstamped (a sentence round, an unstarted word one):
    // the word submit's "is there a run to end?" test reads exactly this, and `''` would
    // pass a truthiness check into `Date.parse` and answer NaN. `submittedAt` is the
    // submission's own marker and follows the same rule.
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(submittedAt === undefined ? {} : { submittedAt }),
  };
}

function puzzleOf(item: Item): string | undefined {
  return item?.puzzle?.S;
}

function numberOf(value: AttributeValue | undefined): number | undefined {
  return value?.N === undefined ? undefined : Number(value.N);
}
