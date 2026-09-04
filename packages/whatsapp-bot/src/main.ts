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
import { dynamoLimitStore, limitExpiry, limitKeys } from './chat/limits';
import { dynamoMemoryStore } from './chat/memory';
import { addressedTo } from './chat/trigger';
import { botRegion, loadEnv } from './config/env';
import { loadGroups, type GroupConfig } from './config/groupConfig';
import { dynamoDeclarationStore } from './domain/dynamoDeclarationStore';
import { createIngest } from './domain/ingest';
import { displayName } from './domain/names';
import { withoutShareLinks } from './domain/share';
import { dynamoLeaderStore } from './domain/leader';
import type { InboundMessage } from './domain/message';
import { createLlmProvider } from './llm';
import { generateShareComment, type ShareFacts } from './llm/shareComment';
import { createLog, tag } from './log';
import { commandIds, type OutboundQueue } from './outbound/commands';
import { dynamoSentStore } from './outbound/dedupStore';
import { createDispatcher, runConsumer } from './outbound/dispatcher';
import { memoryOutbound, sqsCommandSource, sqsOutboundQueue, type CommandSource } from './outbound/sqs';
import { hasPairedDevice, markAuthInvalidated, readAuthStatus, useDynamoAuthState } from './whatsapp/authStore';
import { connectWhatsApp } from './whatsapp/client';
import { acquireLease, keepLease, type LeaseKeeper } from './whatsapp/lease';
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

  const dynamo = new DynamoDBClient({ region: botRegion() });
  const ssm = () => new SSMClient({ region: botRegion() });
  // DECLARED BEFORE the gauge that reads it: `startConnectedMetric` publishes its first
  // point synchronously, so a `let` below this line puts that read in its temporal dead
  // zone — the throw lands in the publisher's own catch and the first tick is lost as a
  // "metric not published" warning, once per task start, looking like an IAM problem.
  let client: Awaited<ReturnType<typeof connectWhatsApp>> | null = null;
  let keeper: LeaseKeeper | null = null;
  const stopMetric = env.metricsNamespace
    ? startConnectedMetric(env.metricsNamespace, () => client?.isOpen() === true, log)
    : () => {};

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
  // RENEWED FROM HERE, not from after the socket is up: the auth read, the SSM fetch and
  // the WhatsApp handshake in between can outlast the lease's own grace window, and an
  // unrenewed lease is one another process may take while this one is still opening a
  // socket against the same device.
  keeper = keepLease(lease, {
    onLost(reason) {
      log.error({ event: 'lease.lost', reason }, 'the session lease is gone; stopping');
      void shutdown(1);
    },
    onError: (error, staleMs) =>
      log.warn({ event: 'lease.renew_failed', staleMs, error: error.message }, 'renew failed'),
  });

  const auth = await useDynamoAuthState(dynamo, env.table);
  if (!hasPairedDevice(auth.state.creds)) {
    log.error({ event: 'auth.unpaired' }, 'no paired device in the durable store; run `pnpm bot:pair`');
    // Stopped BEFORE the release, or the next renew would take back the lease this idle
    // process has just given up.
    keeper.stop();
    await lease.release();
    await idleUntilOperator(
      async () => hasPairedDevice((await useDynamoAuthState(dynamo, env.table)).state.creds),
      log,
    );
    return;
  }

  const declarations = dynamoDeclarationStore(dynamo, env.table);
  const outbound: OutboundQueue & Partial<CommandSource> = env.outboundQueueUrl
    ? sqsOutboundQueue(new SQSClient({ region: botRegion() }), env.outboundQueueUrl)
    : memoryOutbound();
  const source: CommandSource = env.outboundQueueUrl
    ? sqsCommandSource(new SQSClient({ region: botRegion() }), env.outboundQueueUrl)
    : (outbound as CommandSource);
  if (!env.outboundQueueUrl) log.warn({ event: 'outbound.local' }, 'no BOT_OUTBOUND_QUEUE_URL: in-process outbound queue');

  // ONE window per task, shared by the agent that reads it and `onMessage`, which fills
  // it with everything the group says that was not aimed at the bot.
  const context = new RecentContext();

  let provider = null;
  try {
    provider = await createLlmProvider(env.llm, ssm);
  } catch (error) {
    log.error({ event: 'llm.unconfigured', error: (error as Error).message }, 'no LLM provider; chat disabled');
  }
  const limits = dynamoLimitStore(dynamo, env.table);

  // The spoken acknowledgement (`acknowledge: "say"`), and it SPENDS THE SAME DAILY CALL
  // CEILING the conversation does. That ceiling exists to bound what the bot can cost in a
  // day, and a second model path outside it would leave it bounding half the spend. Out of
  // budget answers null, which is the emoji — the share is still acknowledged.
  const comment = provider
    ? (group: GroupConfig, facts: ShareFacts) =>
        generateShareComment(provider, group, facts, log, async () => {
          const at = new Date();
          const { scope, key } = limitKeys.calls(at);
          return limits.take(scope, key, env.llm.dailyCallCeiling, limitExpiry(at));
        })
    : undefined;

  const ingest = createIngest({
    groups,
    declarations,
    outbound,
    leaders: dynamoLeaderStore(dynamo, env.table),
    siteOrigin: env.siteOrigin,
    log,
    comment,
  });
  const answer = provider
    ? createAgent({
        provider,
        declarations,
        memory: dynamoMemoryStore(dynamo, env.table),
        limits,
        context,
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
    if (!address) {
      // NOT FOR THE BOT, BUT STILL THE CONVERSATION. Ordinary chatter is remembered so a
      // later question can be answered in the room it was asked in — "I'm thinking of 67"
      // has to be on the record before "@bot what number?" can mean anything. It reaches
      // the provider only if somebody DOES address the bot while it is still in the window.
      // The share link is stripped: a token is base64 noise that no conversation can use,
      // and a message that was only a link leaves nothing to remember.
      const text = withoutShareLinks(message.text, env.siteOrigin);
      if (text) {
        context.push(group.id, {
          role: 'user',
          name: displayName(group, message.sender, message.senderName),
          text,
          at: Date.now(),
        });
      }
      return;
    }
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
      replyTo: { id: message.id, participant: message.participant, text: message.text },
    });
  }

  async function shutdown(code: number): Promise<never> {
    abort.abort();
    stopMetric();
    keeper?.stop();
    try {
      await client?.close();
    } catch (error) {
      // The drain found the last credential snapshot unstored: the next start resumes an
      // older session than the one this socket held, and may end up re-pairing. Said
      // here, where it is the whole reason the exit is not clean.
      log.error({ event: 'auth.behind', error: (error as Error).message }, 'closing left the stored session behind the socket');
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
        // The mark is what keeps the NEXT task idle instead of reconnecting into another
        // logout; a write that fails is said, and the shutdown below still happens — the
        // replacement task will be logged out again and mark it then. What must not
        // happen is this rejection escaping: the task would die holding its lease.
        try {
          await markAuthInvalidated(dynamo, env.table, 'loggedOut');
          log.error({ event: 'auth.logged_out' }, 'device logged out: auth marked invalidated, re-pair with `pnpm bot:pair`');
        } catch (error) {
          log.error({ event: 'auth.invalidate_failed', error: (error as Error).message }, 'device logged out, and the auth could NOT be marked invalidated');
        }
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
  void runConsumer(source, dispatcher, log, abort.signal, () => client?.isOpen() === true);

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
