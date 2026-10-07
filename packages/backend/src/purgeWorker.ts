// The PURGE worker (#207): a second Lambda, run every hour by an EventBridge schedule
// (`infra/lib/backend-stack.ts`), that erases what every deleted account left behind —
// `runPurges` over the queued jobs (`purge.ts` holds the steps and why each is safe to run
// again). It builds the same DynamoDB stores the API does (`index.ts`), over the one table
// its environment names, and nothing else: no puzzle store, no Turnstile, no address secret.
//
// The run stops STARTING jobs well inside the Lambda's own limit, so the job in hand can
// finish; whatever is left waits for the next hour. The log line carries COUNTS only. A run
// in which any job FAILED throws at the end — after every other job was tried — so the
// Lambda's `Errors` metric, and the alarm on it, see it; a run cut off by its deadline does
// not, since a queue longer than one run is not a failure.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { loadPurgeConfig } from './config';
import { dynamoDeviceStore } from './dynamoDeviceStore';
import { dynamoGroupStore } from './dynamoGroupStore';
import { dynamoLinkStore } from './dynamoLinkStore';
import { dynamoRoundStore } from './dynamoRoundStore';
import { dynamoScoreStore } from './dynamoScoreStore';
import { runPurges, type PurgeRun } from './purge';

// How long before the Lambda's own timeout the run stops starting jobs: room for the one
// purge in hand — a few hundred unconditional deletes — to finish.
export const PURGE_DEADLINE_MARGIN_MS = 30_000;

// The one field of the Lambda context this reads — typed locally, the forwarder's rule
// (`mailForward.ts`): a dependency added for one method is a dependency kept in step forever.
interface LambdaContext {
  getRemainingTimeInMillis(): number;
}

const { scoreTable } = loadPurgeConfig();
const dynamo = new DynamoDBClient({});
const deps = {
  links: dynamoLinkStore(dynamo, scoreTable),
  groups: dynamoGroupStore(dynamo, scoreTable),
  devices: dynamoDeviceStore(dynamo, scoreTable),
  rounds: dynamoRoundStore(dynamo, scoreTable),
  scores: dynamoScoreStore(dynamo, scoreTable),
};

export async function handler(_event: unknown, context: LambdaContext): Promise<PurgeRun> {
  const deadlineMs = Date.now() + context.getRemainingTimeInMillis() - PURGE_DEADLINE_MARGIN_MS;
  const run = await runPurges(deps, { deadlineMs });
  console.log(
    `[purge] ${run.jobs} job(s): ${run.done} done, ${run.left} left, ${run.failed} failed`,
  );
  if (run.failed > 0) throw new Error(`${run.failed} account purge(s) did not finish.`);
  return run;
}
