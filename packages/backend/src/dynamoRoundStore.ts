import {
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { ROUND_GUESS_CAP, ROUND_WRITE_MIN_MS } from '@whippin/shared';
import {
  roundMonthPrefix,
  roundPartition,
  roundSortKeyDate,
  roundSortKey,
  type RoundDaySummary,
  type RoundKey,
  type RoundRunner,
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

  // Strongly consistent BY DEFAULT, for the score store's reason: the read lands right
  // after this player's own appends — the sync's catch-up on load, and the classification
  // of the write that just failed — which must not be invisible to it. #203's pre-write
  // derivation read opts out (see `RoundStore.get`), which halves what that read costs.
  const readItem = async (key: RoundKey, publicId: string, consistent = true) => {
    const response = await client.send(
      new GetItemCommand({
        TableName: tableName,
        Key: itemKey(key, publicId),
        ConsistentRead: consistent,
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
    startedBy: '#by',
    submittedAt: '#sub',
    progress: '#prog',
    solved: '#solved',
  } as const;

  // The alias map for exactly the attributes one command touches.
  const aliases = (...attributes: (keyof typeof NAMES)[]): Record<string, string> =>
    Object.fromEntries(attributes.map((attribute) => [NAMES[attribute], attribute]));

  return {
    // The private calendar read (#211): ONE Query over the player's own partition behind a
    // month prefix, PROJECTED down to the summary attributes. The projection does not lower
    // what DynamoDB READS (capacity is measured on the whole item), but it is what keeps a
    // month's raw guess logs — megabytes of slugs — from crossing the wire for a calendar.
    //
    // It pages, even though ~31 rows of a few KB sit far inside the 1 MB response limit:
    // silently rendering a PARTIAL month is the one failure a calendar cannot show.
    async listMonth(key, publicId) {
      const rows: RoundDaySummary[] = [];
      const prefix = roundMonthPrefix(key);
      let cursor: Record<string, AttributeValue> | undefined;
      do {
        const response = await client.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
            // `sk` is aliased for the reason every name here is: the reserved-word list is
            // long and a collision is a ValidationException, never a wrong answer.
            ExpressionAttributeNames: {
              '#pk': 'pk',
              '#sk': 'sk',
              ...aliases('progress', 'solved'),
            },
            ExpressionAttributeValues: {
              ':pk': { S: roundPartition(publicId) },
              ':prefix': { S: prefix },
            },
            ProjectionExpression: `#sk, ${NAMES.progress}, ${NAMES.solved}`,
            // Strongly consistent, the score Query's rule: a player opens the archive right
            // after finishing a day, and a calendar that has not caught up with their own
            // last guess reads as the game losing it.
            ConsistentRead: true,
            ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          }),
        );
        // The DATE is the tail of the sort key the prefix matched — the key is built from
        // it, so reading it back needs no second attribute on the item. The slice is the
        // formatters' own inverse (`roundSortKeyDate`), never local offset arithmetic.
        for (const item of response.Items ?? []) {
          rows.push({
            date: roundSortKeyDate(item.sk?.S ?? '', key),
            progress: numberOf(item.progress) ?? 0,
            solved: item.solved?.BOOL === true,
          });
        }
        cursor = response.LastEvaluatedKey;
      } while (cursor);
      return rows;
    },

    async get(key, publicId, puzzle, opts) {
      const item = await readItem(key, publicId, opts?.consistent !== false);
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
        ':progress': { N: String(input.progress) },
        // Declared only where it is NAMED: an unused ExpressionAttributeValue is the same
        // ValidationException an unused alias is.
        ...(input.solved ? { ':solved': { BOOL: true } } : {}),
        ...extra,
      });
      // `solved` is only ever written TRUE (roundStore.ts), so an unsolved append names it
      // in the CONDITION and nowhere else.
      const markSolved = input.solved ? ', #solved = :solved' : '';

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
              '#p = :puzzle, #last = :now, #created = if_not_exists(#created, :created), ' +
              `#prog = :progress${markSolved}`,
            // Every clause is path-only CONDITION syntax. DynamoDB's condition grammar
            // has NO arithmetic, its function list is attribute_exists /
            // attribute_not_exists / attribute_type / begins_with / contains /
            // size(<path>), and `if_not_exists` is specific to an update expression's SET
            // action — naming either here makes the service reject the whole request with
            // a ValidationException before a single guess is stored. So the cap is
            // expressed as ROOM (`:room` = the cap minus this batch) against the log's own
            // size, which bounds the RESULTING log exactly as `size + batch <= cap` would:
            // the result may REACH the cap, never pass it.
            //
            // The last clause is #203's FREEZE: once `solved` is set, further appends are
            // refused — evaluated as part of the same write, so it costs no extra read
            // (Word mode's submit already works this way, `attribute_not_exists(#sub)`).
            // It is not an anti-cheat measure: sentence score is unique tries and lower is
            // better, so padding a log after the solve only ever makes the score worse.
            // What it prevents is a RECORDED SCORE SILENTLY CHANGING after it is on the
            // leaderboard, which reads as a bug whoever caused it.
            ConditionExpression:
              '(attribute_not_exists(#last) OR #last < :cutoff) ' +
              'AND (attribute_not_exists(#g) OR (size(#g) <= :room AND #p = :puzzle)) ' +
              'AND attribute_not_exists(#solved)',
            ExpressionAttributeNames: aliases(
              'guesses',
              'puzzle',
              'lastWriteAt',
              'createdAt',
              'progress',
              'solved',
            ),
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

      // The condition named four bounds; classify against the stored item.
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
              // A restart takes the RETIRED puzzle's derived summary with it: its `solved`
              // would otherwise freeze the fresh round on a sentence nobody is playing any
              // more (the word start's `REMOVE #g, #sub` rule).
              UpdateExpression:
                'SET #g = :batch, #p = :puzzle, #last = :now, #created = :created, ' +
                (input.solved
                  ? '#prog = :progress, #solved = :solved'
                  : '#prog = :progress REMOVE #solved'),
              // Only a record still naming the retired puzzle may be replaced, so two
              // tabs racing the same restart cannot wipe each other's fresh log.
              ConditionExpression:
                '#p <> :puzzle AND (attribute_not_exists(#last) OR #last < :cutoff)',
              ExpressionAttributeNames: aliases(
                'guesses',
                'puzzle',
                'lastWriteAt',
                'createdAt',
                'progress',
                'solved',
              ),
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
      // A SOLVED round is settled — the truest answer of the three, since neither retrying
      // nor a smaller batch can ever be accepted again (#203).
      if (stored.solved) return { outcome: 'round_solved', state: stored };
      // A log already at (or within one batch of) the cap is the cap refusal — the truer
      // answer, since retrying can never succeed — and anything else is the interval.
      if (stored.guesses.length + input.guesses.length > ROUND_GUESS_CAP) {
        return { outcome: 'round_full', state: stored };
      }
      return { outcome: 'too_fast', state: stored };
    },

    // The corrective write (#203; roundStore.ts states why it exists). ONE conditional
    // UpdateItem under two clauses.
    //
    // The puzzle's identity: a record naming a DIFFERENT one has already restarted and has
    // nothing here to correct.
    //
    // And MONOTONICITY, the same shape `solved` gets by being write-only-true. Two settles
    // can be in flight at once (this one is behind a retry backoff, and a second device's
    // append can land and settle inside it), and the later ARRIVAL may carry the older log:
    // last-writer-wins would then park a lower percentage on the row for good, since a
    // solved round takes no further append to repair it. Progress only ever RISES within one
    // puzzle's life — a round's log only grows, and a longer log can only reach equal-or-
    // better ranks — so refusing a write that would lower it costs nothing correct. `<=`
    // rather than `<` so a SOLVE still lands when the percentage is already what it will be:
    // a solved derivation is exactly 100, which is also why this clause can never refuse one
    // (100 is the maximum a stored value can hold).
    async settle(input) {
      try {
        await client.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: itemKey(input, input.publicId),
            UpdateExpression: input.solved
              ? 'SET #prog = :progress, #solved = :solved'
              : 'SET #prog = :progress',
            // Path-only condition syntax, the append's rule: a comparator against a value is
            // the grammar's own (`#last < :cutoff` already relies on it), where arithmetic
            // and `if_not_exists` are not.
            ConditionExpression:
              '#p = :puzzle AND (attribute_not_exists(#prog) OR #prog <= :progress)',
            ExpressionAttributeNames: input.solved
              ? aliases('progress', 'solved', 'puzzle')
              : aliases('progress', 'puzzle'),
            ExpressionAttributeValues: {
              ':progress': { N: String(input.progress) },
              ':puzzle': { S: input.puzzle },
              ...(input.solved ? { ':solved': { BOOL: true } } : {}),
            },
          }),
        );
        return true;
      } catch (error) {
        // Either the round was re-published under us — there is no summary of THIS puzzle
        // to correct, and the fresh round derives its own on its next append — or a better
        // correction already landed. Both are the right outcome, and neither is a retry —
        // but neither is a SUCCESS either: the caller has to know the state it asked for is
        // not the stored one, or it claims a solve this record never took.
        if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
        return false;
      }
    },

    // WORD mode's first write (#202): stamp the round's start from THIS server's clock —
    // and, since #217, the DEVICE it belongs to.
    //
    // ONE conditional UpdateItem, and the condition is the whole ownership model:
    // `attribute_not_exists(#sub) OR #p <> :puzzle` passes for a record that does not exist
    // (the first clause — a missing attribute makes the comparison in the second FALSE,
    // never true), for an unsubmitted run whoever started it, and for one naming a RETIRED
    // word. It fails for exactly the state that ends a daily: this puzzle's log is already
    // RECORDED, which the classification read below answers with. Everything it passes for
    // is REPLACED, atomically, so nothing can observe a clock without its owner.
    async start(input) {
      const stampedAt = input.now.toISOString();
      try {
        const response = await client.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: itemKey(input, input.publicId),
            // A RESTART takes the run it replaces with it — its LOG, and the mark saying
            // that log was recorded (a retired word's), or the fresh round would read as
            // already submitted and never write.
            UpdateExpression:
              'SET #started = :now, #by = :runner, #p = :puzzle, #created = :now REMOVE #g, #sub',
            ConditionExpression: 'attribute_not_exists(#sub) OR #p <> :puzzle',
            ExpressionAttributeNames: aliases(
              'startedAt',
              'startedBy',
              'puzzle',
              'createdAt',
              'guesses',
              'submittedAt',
            ),
            ExpressionAttributeValues: {
              ':puzzle': { S: input.puzzle },
              ':now': { S: stampedAt },
              ':runner': runnerValue(input.runner),
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return { outcome: 'started', state: itemToState(response.Attributes)! };
      } catch (error) {
        if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
      }
      // A submission won the race: the recorded run is what stands, and the answer carries
      // it so the caller adopts the final run instead of wiping it. `stateForTag` is belt
      // and braces — the condition only fails for this puzzle's own record.
      return {
        outcome: 'already_submitted',
        state: stateForTag(await readItem(input, input.publicId), input.puzzle),
      };
    },

    // WORD mode's second and last write (#202): the whole log, once, from the device that
    // played it (#217).
    //
    // It reads BEFORE writing, unlike the streaming append, because the two refusals it owes
    // the caller are not expressible as conditions: the wait check compares instants
    // arithmetically (DynamoDB's condition grammar has none) and the caller has to be told
    // WHICH bound refused it. Neither is racy — the write itself carries the ownership and
    // the first-write-wins clauses, so both verdicts are decided by the store rather than by
    // the read that preceded it.
    async submit(input) {
      const stored = stateForTag(await readItem(input, input.publicId), input.puzzle);
      if (!stored.startedAt) return { outcome: 'not_started', state: empty() };
      // `submittedAt`, never the log's length: a run that claimed nothing records an EMPTY
      // log, and reading that back as "nothing recorded" is what let a second submission
      // overwrite it (roundStore.ts).
      if (stored.submittedAt) return { outcome: 'already_submitted', state: stored };
      // The stamp names another device: this run was restarted while its player was away,
      // so the log offered here belongs to a clock that no longer exists (#217).
      if (stored.startedBy?.deviceId !== input.deviceId) {
        return { outcome: 'started_elsewhere', state: stored };
      }
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
            // puzzle's, still stamped for THIS device, and still unsubmitted. The device
            // clause is what makes ownership a store decision rather than a read's opinion —
            // a restart can land between the read above and this write.
            ConditionExpression:
              '#p = :puzzle AND #by.#dev = :device AND attribute_not_exists(#sub)',
            ExpressionAttributeNames: {
              ...aliases('guesses', 'submittedAt', 'puzzle', 'startedBy'),
              '#dev': 'deviceId',
            },
            ExpressionAttributeValues: {
              ':puzzle': { S: input.puzzle },
              ':device': { S: input.deviceId },
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
      // submission landing first, another device's RESTART taking the clock, or the daily
      // being re-published under us — where this log describes a retired word and the round
      // has restarted without it.
      const now = stateForTag(await readItem(input, input.publicId), input.puzzle);
      if (now.submittedAt) return { outcome: 'already_submitted', state: now };
      return now.startedBy === undefined
        ? { outcome: 'not_started', state: now }
        : { outcome: 'started_elsewhere', state: now };
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

// The run's OWNER as one attribute (#217): the device id the submission's condition
// compares, plus the parsed user-agent fields the screen names that device with. ONE map
// rather than four top-level attributes, so the stamp is written, replaced and read as the
// single fact it is.
function runnerValue(runner: RoundRunner): AttributeValue {
  return {
    M: {
      deviceId: { S: runner.deviceId },
      device: { S: runner.device },
      os: { S: runner.os },
      browser: { S: runner.browser },
    },
  };
}

// …and back. A stamp with no device id is not a stamp — the two are written together, and
// half of one says nothing about who is running the round.
function runnerOf(item: Item): RoundRunner | undefined {
  const map = item?.startedBy?.M;
  const deviceId = map?.deviceId?.S;
  if (!deviceId) return undefined;
  return {
    deviceId,
    device: map?.device?.S ?? '',
    os: map?.os?.S ?? '',
    browser: map?.browser?.S ?? '',
  };
}

function itemToState(item: Item): RoundState | null {
  if (!item) return null;
  const startedAt = item.startedAt?.S;
  const startedBy = runnerOf(item);
  const submittedAt = item.submittedAt?.S;
  const progress = numberOf(item.progress);
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
    // submission's own marker and follows the same rule, and so does the run's OWNER
    // (#217), which the same write stamps.
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(startedBy === undefined ? {} : { startedBy }),
    ...(submittedAt === undefined ? {} : { submittedAt }),
    // The derived summary (#203). ABSENT rather than 0/false on a round that has none —
    // a word round, or a sentence round written before its first append — for the
    // `startedAt` reason: the freeze and the corrective write both test presence.
    ...(progress === undefined ? {} : { progress }),
    ...(item.solved?.BOOL === true ? { solved: true } : {}),
  };
}

function puzzleOf(item: Item): string | undefined {
  return item?.puzzle?.S;
}

function numberOf(value: AttributeValue | undefined): number | undefined {
  return value?.N === undefined ? undefined : Number(value.N);
}
