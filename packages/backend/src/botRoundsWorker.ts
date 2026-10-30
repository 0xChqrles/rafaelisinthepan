// The BOT ROUNDS function (`BotRoundsFn`, named `BOT_ROUNDS_FUNCTION_NAME` in shared): a
// third Lambda beside the API and the purge worker, INVOKED by the WhatsApp bot's task over
// IAM (`lambda:InvokeFunction`) with a `BotRoundsRequest` payload — no URL, no CloudFront.
// `botRounds.ts` holds the read and its spoiler rule; this builds the stores it reads, the
// API's own (`index.ts`) over the bucket and table its environment names, and nothing else.
//
// A malformed payload ANSWERS `bad_request` (`readBotRounds` never throws for bad input); a
// store failure THROWS, so the invoke fails and the bot treats the read as unavailable. The
// log line names the outcome and COUNTS only — never a guess, a word or a name.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import type { BotRoundsResponse } from '@whippin/shared';
import { readBotRounds } from './botRounds';
import { loadBotRoundsConfig } from './config';
import { dynamoGroupStore } from './dynamoGroupStore';
import { dynamoProfileStore } from './dynamoProfileStore';
import { dynamoRoundStore } from './dynamoRoundStore';
import { s3Store } from './s3Store';

const { bucket, scoreTable } = loadBotRoundsConfig();
const dynamo = new DynamoDBClient({});
// ONE store instance per container: the revision-keyed artifact memory (`puzzleReads.ts`)
// lives on it, so a warm function reuses the parsed day across the bot's reads.
const deps = {
  groups: dynamoGroupStore(dynamo, scoreTable),
  profiles: dynamoProfileStore(dynamo, scoreTable),
  rounds: dynamoRoundStore(dynamo, scoreTable),
  puzzles: s3Store(new S3Client({}), bucket),
};

export async function handler(event: unknown): Promise<BotRoundsResponse> {
  const answer = await readBotRounds(deps, event);
  if (!answer.ok) {
    console.log(`[bot-rounds] ${answer.error}`);
  } else {
    const started = answer.members.filter((member) => member.started).length;
    console.log(
      `[bot-rounds] ok: ${answer.members.length} member(s), ${started} started, ` +
        `${answer.revision === null ? 'no puzzle' : 'published'}`,
    );
  }
  return answer;
}
