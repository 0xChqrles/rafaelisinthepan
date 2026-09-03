// The podium job (#236): BOUNDED work, so it is a Lambda — never a second WhatsApp
// session. EventBridge Scheduler fires it per group at that group's own local time
// (`podium.time` in `podium.timezone`, a social convention), with `{ group }` as input.
//
//   read the group's rows for the Whippin day → dense podium → (optional) model comments
//   → render → ONE outbound command on the queue the connected task consumes.
//
// The Whippin day is the shared day contract's active day at the fire instant — never a
// calendar string derived from the group's time zone. A manual replay may name a date:
// invoke with `{ "group": "<jid>", "date": "YYYY-MM-DD" }`. The command id is
// `podium:<group>:<day>`, so a retried invocation cannot post the podium twice.

import { SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { activeDate, dayNumber } from '@whippin/shared';
import { loadEnv } from './config/env';
import { loadGroups, type GroupRegistry } from './config/groupConfig';
import type { DeclarationStore } from './domain/declarations';
import { dynamoDeclarationStore } from './domain/dynamoDeclarationStore';
import { nameResolver } from './domain/names';
import { buildPodium } from './domain/podium';
import { renderPodium, type Comments } from './domain/podiumText';
import { createLlmProvider, type LlmProvider } from './llm';
import { generatePodiumComments } from './llm/podiumComments';
import { createLog, tag, type Log } from './log';
import { commandIds, type OutboundQueue } from './outbound/commands';
import { sqsOutboundQueue } from './outbound/sqs';

export interface PodiumJobEvent {
  group: string;
  date?: string; // YYYY-MM-DD, for a manual replay
}

export interface PodiumJobResult {
  outcome: 'posted' | 'empty' | 'skipped';
  group: string;
  dayNumber: number;
  lines: number;
  comments: number;
}

export interface PodiumJobDeps {
  groups: GroupRegistry;
  declarations: DeclarationStore;
  outbound: OutboundQueue;
  provider: LlmProvider | null;
  log: Log;
  now?: () => Date;
}

export async function runPodiumJob(event: PodiumJobEvent, deps: PodiumJobDeps): Promise<PodiumJobResult> {
  const now = deps.now ?? (() => new Date());
  const group = deps.groups.get(event.group);
  const day =
    event.date && /^\d{4}-\d{2}-\d{2}$/.test(event.date)
      ? dayNumber(event.date)
      : dayNumber(activeDate(now()));
  if (!group || !group.podium.enabled) {
    deps.log.warn({ event: 'podium.skipped', group: tag(event.group) }, 'group not configured for a podium');
    return { outcome: 'skipped', group: event.group, dayNumber: day, lines: 0, comments: 0 };
  }
  const rows = await deps.declarations.day(group.id, day);
  const podium = buildPodium(day, rows, nameResolver(group));
  if (podium.lines.length === 0 && podium.capped.length === 0) {
    deps.log.info({ event: 'podium.empty', group: tag(group.id), day }, 'no shares today; nothing posted');
    return { outcome: 'empty', group: group.id, dayNumber: day, lines: 0, comments: 0 };
  }
  let comments: Comments = new Map();
  if (deps.provider) {
    comments = await generatePodiumComments(deps.provider, group, podium, deps.log);
  }
  const text = renderPodium(podium, group.language, comments);
  await deps.outbound.enqueue({
    id: commandIds.podium(group.id, day),
    kind: 'message',
    group: group.id,
    text,
  });
  deps.log.info(
    { event: 'podium.queued', group: tag(group.id), day, lines: podium.lines.length, comments: comments.size },
    'podium queued',
  );
  return { outcome: 'posted', group: group.id, dayNumber: day, lines: podium.lines.length, comments: comments.size };
}

// Lambda entry. Everything with a side effect is built here, once per container.
let deps: Promise<PodiumJobDeps> | undefined;

async function buildDeps(): Promise<PodiumJobDeps> {
  const log = createLog();
  const env = loadEnv();
  if (!env.outboundQueueUrl) throw new Error('BOT_OUTBOUND_QUEUE_URL env var is required.');
  const dynamo = new DynamoDBClient({});
  let provider: LlmProvider | null = null;
  try {
    provider = await createLlmProvider(env.llm, () => new SSMClient({}));
  } catch (error) {
    log.error({ event: 'llm.unconfigured', error: (error as Error).message }, 'podium without comments');
  }
  return {
    groups: loadGroups(env.groupsDir),
    declarations: dynamoDeclarationStore(dynamo, env.table),
    outbound: sqsOutboundQueue(new SQSClient({}), env.outboundQueueUrl),
    provider,
    log,
  };
}

export async function handler(event: PodiumJobEvent): Promise<PodiumJobResult> {
  deps ??= buildDeps();
  return runPodiumJob(event, await deps);
}
