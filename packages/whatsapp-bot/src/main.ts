// The long-lived WhatsApp task (#236): ONE Baileys session on ONE Fargate task.
//
//   load durable auth → open WhatsApp socket → load configured groups → subscribe
//
// and a replacement task repeats exactly that without touching the phone. It also owns
// every outbound send (the queue consumer) — a podium job never connects to WhatsApp.
//
// Fail-closed states, both of which keep the task ALIVE but idle and the "connected"
// metric at 0, so the alarm says what is wrong instead of a restart loop hiding it:
//   * durable auth marked INVALIDATED (WhatsApp logged the device out) — re-pairing is an
//     operator act; nothing here erases or re-mints a session;
//   * durable auth not paired yet.
// A lease held by another process (a laptop running `bot:start`, or the pairing CLI) is a
// refusal to start at all.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SSMClient } from '@aws-sdk/client-ssm';
import { activeDate, dayNumber } from '@whippin/shared';
import { createAgent } from './chat/agent';
import { RecentContext } from './chat/context';
import { dynamoLimitStore } from './chat/limits';
import { dynamoMemoryStore } from './chat/memory';
import { addressedTo } from './chat/trigger';
import { loadEnv } from './config/env';
import { loadGroups } from './config/groupConfig';
import { dynamoDeclarationStore } from './domain/dynamoDeclarationStore';
import { createIngest } from './domain/ingest';
import { dynamoLeaderStore } from './domain/leader';
import type { InboundMessage } from './domain/message';
import { createLlmProvider } from './llm';
import { createLog, tag } from './log';
import { commandIds, type OutboundQueue } from './outbound/commands';
import { dynamoSentStore } from './outbound/dedupStore';
import { createDispatcher, runConsumer } from './outbound/dispatcher';
import { memoryOutbound, sqsCommandSource, sqsOutboundQueue, type CommandSource } from './outbound/sqs';
import { markAuthInvalidated, readAuthStatus, useDynamoAuthState } from './whatsapp/authStore';
import { connectWhatsApp } from './whatsapp/client';
import { acquireLease, LEASE_RENEW_MS } from './whatsapp/lease';
import { startConnectedMetric } from './whatsapp/metrics';

const IDLE_RECHECK_MS = 60_000;

async function idleUntilOperator(check: () => Promise<boolean>, log: ReturnType<typeof createLog>) {
  // Stay up (the alarm is on the metric), re-check the durable state once a minute, and
  // restart the process the moment an operator has fixed it.
  for (;;) {
    await new Promise((r) => setTimeout(r, IDLE_RECHECK_MS));
    if (await check()) {
      log.info({ event: 'auth.ready' }, 'durable auth is usable again; restarting');
      process.exit(0);
    }
  }
}

async function main(): Promise<void> {
  const log = createLog();
  const env = loadEnv();
  const groups = loadGroups(env.groupsDir);
  log.info({ event: 'boot', groups: groups.all().map((g) => tag(g.id)) }, 'starting');

  const dynamo = new DynamoDBClient({});
  const ssm = () => new SSMClient({});
  const stopMetric = env.metricsNamespace
    ? startConnectedMetric(env.metricsNamespace, () => client?.isOpen() === true, log)
    : () => {};
  let client: Awaited<ReturnType<typeof connectWhatsApp>> | null = null;

  const status = await readAuthStatus(dynamo, env.table);
  if (status.invalidated) {
    log.error({ event: 'auth.invalidated', at: status.at, reason: status.reason }, 'WhatsApp logged this device out; run `pnpm bot:pair`');
    await idleUntilOperator(async () => !(await readAuthStatus(dynamo, env.table)).invalidated, log);
    return;
  }

  const lease = await acquireLease(dynamo, env.table, 'task');
  if (!lease) {
    log.error({ event: 'lease.held' }, 'another process holds the WhatsApp session; refusing to start');
    process.exit(1);
  }

  const auth = await useDynamoAuthState(dynamo, env.table);
  if (!auth.state.creds.registered) {
    log.error({ event: 'auth.unpaired' }, 'no paired device in the durable store; run `pnpm bot:pair`');
    await lease.release();
    await idleUntilOperator(
      async () => (await useDynamoAuthState(dynamo, env.table)).state.creds.registered,
      log,
    );
    return;
  }

  const declarations = dynamoDeclarationStore(dynamo, env.table);
  const outbound: OutboundQueue & Partial<CommandSource> = env.outboundQueueUrl
    ? sqsOutboundQueue(new SQSClient({}), env.outboundQueueUrl)
    : memoryOutbound();
  const source: CommandSource = env.outboundQueueUrl
    ? sqsCommandSource(new SQSClient({}), env.outboundQueueUrl)
    : (outbound as CommandSource);
  if (!env.outboundQueueUrl) log.warn({ event: 'outbound.local' }, 'no BOT_OUTBOUND_QUEUE_URL: in-process outbound queue');

  const ingest = createIngest({
    groups,
    declarations,
    outbound,
    leaders: dynamoLeaderStore(dynamo, env.table),
    siteOrigin: env.siteOrigin,
    log,
  });

  let provider = null;
  try {
    provider = await createLlmProvider(env.llm, ssm);
  } catch (error) {
    log.error({ event: 'llm.unconfigured', error: (error as Error).message }, 'no LLM provider; chat disabled');
  }
  const answer = provider
    ? createAgent({
        provider,
        declarations,
        memory: dynamoMemoryStore(dynamo, env.table),
        limits: dynamoLimitStore(dynamo, env.table),
        context: new RecentContext(),
        dailyCallCeiling: env.llm.dailyCallCeiling,
        log,
      })
    : null;

  const abort = new AbortController();

  async function onMessage(message: InboundMessage): Promise<void> {
    await ingest(message);
    const group = groups.get(message.group);
    if (!group || !group.chat.enabled || !message.live || message.fromMe || !answer || !client) return;
    const identity = { jids: client.selfJids(), name: group.chat.name };
    const address = addressedTo(message, identity);
    if (!address) return;
    log.info({ event: 'chat.addressed', how: address, group: tag(group.id), sender: tag(message.sender) }, 'addressed');
    const today = dayNumber(activeDate(new Date()));
    const outcome = await answer(message, group, identity, today);
    if (outcome.kind === 'silent') {
      log.info({ event: 'chat.silent', reason: outcome.reason, group: tag(group.id) }, 'no reply');
      return;
    }
    await outbound.enqueue({
      id: commandIds.reply(group.id, message.id),
      kind: 'message',
      group: group.id,
      text: outcome.text,
      replyTo: { id: message.id, participant: message.sender },
    });
  }

  async function shutdown(code: number): Promise<never> {
    abort.abort();
    stopMetric();
    try {
      await client?.close();
    } finally {
      await lease!.release().catch(() => {});
    }
    process.exit(code);
  }

  client = await connectWhatsApp({
    auth,
    log,
    onMessage,
    async onStop(reason) {
      if (reason === 'logged_out') {
        await markAuthInvalidated(dynamo, env.table, 'loggedOut');
        log.error({ event: 'auth.logged_out' }, 'device logged out: auth marked invalidated, re-pair with `pnpm bot:pair`');
      } else {
        log.error({ event: 'wa.replaced' }, 'another session replaced this device; stopping');
      }
      await shutdown(1);
    },
  });

  const dispatcher = createDispatcher({
    sender: client,
    sent: dynamoSentStore(dynamo, env.table),
    groups,
    log,
  });
  void runConsumer(source, dispatcher, log, abort.signal);

  const renew = setInterval(() => {
    lease.renew().then(
      (ok) => {
        if (!ok) {
          log.error({ event: 'lease.lost' }, 'lost the session lease; stopping');
          void shutdown(1);
        }
      },
      (error) => log.warn({ event: 'lease.renew_failed', error: (error as Error).message }),
    );
  }, LEASE_RENEW_MS);
  renew.unref();

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      log.info({ event: 'signal', signal }, 'shutting down');
      void shutdown(0);
    });
  }
}

main().catch((error) => {
  createLog().fatal({ event: 'fatal', error: (error as Error).message }, 'bot crashed');
  process.exit(1);
});
