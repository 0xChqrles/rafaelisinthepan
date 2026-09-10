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
import { createDaySourceReader } from './puzzle/daySource';
import { DayLog, dayOfInstant, dynamoDayLogStore, quoteLead } from './chat/dayLog';
import { dynamoDiaryStore } from './chat/diary';
import { dynamoLimitStore, limitExpiry, limitKeys } from './chat/limits';
import { serialByKey } from './chat/serial';
import { labelPlayers } from './chat/tools';
import {
  NEW_EXCHANGE,
  addressedTo,
  afterAnswer,
  isWordless,
  jidUser,
  mayVolunteer,
  namesWithBot,
  quotesBot,
  withMentionNames,
  type Approach,
  type BotIdentity,
  type Exchange,
} from './chat/trigger';
import { botRegion, loadEnv } from './config/env';
import { loadGroups, type GroupConfig } from './config/groupConfig';
import { dynamoDeclarationStore } from './domain/dynamoDeclarationStore';
import { createIngest } from './domain/ingest';
import { displayName } from './domain/names';
import { withoutShares } from './domain/share';
import { dynamoLeaderStore } from './domain/leader';
import type { InboundMessage, Mention } from './domain/message';
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

  // THE DAY LOG (#277): ONE per task, shared by the agent that reads it and `onMessage`,
  // which fills it with everything the group says. Durable, and RELOADED HERE, so the
  // minute a deploy costs no longer costs the bot the day it was in.
  const dayLog = new DayLog(dynamoDayLogStore(dynamo, env.table));
  const bootDay = dayNumber(activeDate(new Date()));
  for (const group of groups.all()) {
    if (!group.chat.enabled) continue;
    try {
      const turns = await dayLog.load(group.id, bootDay);
      log.info({ event: 'daylog.loaded', group: tag(group.id), turns }, "today's log reloaded");
    } catch (error) {
      log.warn({ event: 'daylog.load_failed', group: tag(group.id), error: (error as Error).message }, 'starting the day from here');
    }
  }
  const diary = dynamoDiaryStore(dynamo, env.table);

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
    ? (group: GroupConfig, facts: ShareFacts, key: { dayNumber: number; sender: string }) =>
        generateShareComment(provider, group, facts, { declarations, ...key }, log, async () => {
          const at = new Date();
          const { scope, key } = limitKeys.calls(at);
          return limits.take(scope, key, env.llm.dailyCallCeiling, limitExpiry(at));
        })
    : undefined;

  // The bot's own words into the day log, said in the log when the store refuses: a turn
  // the bot cannot store is one it forgets at the next restart, nothing worse.
  async function keep(turn: Parameters<DayLog['append']>[0], unlessSaid = false): Promise<void> {
    try {
      await (unlessSaid ? dayLog.appendUnlessSaid(turn) : dayLog.append(turn));
    } catch (error) {
      log.warn({ event: 'daylog.write_failed', group: tag(turn.group), error: (error as Error).message }, 'the turn was not stored');
    }
  }

  const ingest = createIngest({
    groups,
    declarations,
    outbound,
    leaders: dynamoLeaderStore(dynamo, env.table),
    siteOrigin: env.siteOrigin,
    log,
    comment,
    // A spoken acknowledgement is something the bot SAID in the group, so it belongs in the
    // day log like any other turn — otherwise "pourquoi tu dis ça ?" a minute later is a
    // question about a message the bot cannot see. Remembered once it is QUEUED, not once
    // it is composed: a line the queue refused for good was never said. The emoji is not a
    // turn — there is nothing to remember about it.
    spoken: (group, line, message) => {
      const at = Date.now();
      void keep({ group: group.id, day: dayOfInstant(at), at, id: `${message.id}#ack`, kind: 'bot', name: '', text: line });
    },
  });
  const answer = provider
    ? createAgent({
        provider,
        declarations,
        diary,
        limits,
        dayLog,
        dailyCallCeiling: env.llm.dailyCallCeiling,
        // Read once per (language, day) and held for the process's life: the task is
        // long-lived, so the group pays one 4-6 MB read a day and not one per question.
        daySource: createDaySourceReader({ apiBaseUrl: env.apiBaseUrl, log }),
        log,
      })
    : null;

  const abort = new AbortController();

  // The group's name for whoever a remembered message's mentions point at — off the same
  // window the tools resolve names in (`labelPlayers`), so the log and a later question
  // agree on who "Zou" is. Keyed by the digits the text's @token spells, labelled by the
  // PLAYER the mention resolves to (a LID-addressed group's tokens spell LIDs the
  // declarations know nobody by). A read that fails costs the names, never the message:
  // the operator's override or the `…last4` handle stands in, which is the one thing the
  // token may become — never stay as.
  async function mentionNames(group: GroupConfig, mentions: Mention[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (mentions.length === 0) return names;
    let labels = new Map<string, string>();
    try {
      const today = dayNumber(activeDate(new Date()));
      labels = await labelPlayers({ group, today, declarations }, mentions.map((m) => m.player));
    } catch (error) {
      log.warn({ event: 'chat.labels_failed', group: tag(group.id), error: (error as Error).message }, 'could not name the mentioned players');
    }
    for (const m of mentions) names.set(jidUser(m.jid), labels.get(m.player) ?? displayName(group, m.player, ''));
    return names;
  }

  // THE EXCHANGE, per group (`trigger.ts`): how many times in a row the bot has answered
  // without being addressed, which is the one thing it may not do without end.
  const exchanges = new Map<string, Exchange>();
  // ONE CONVERSATION AT A TIME PER GROUP (`chat/serial.ts`, PR-278 review): WhatsApp starts
  // a handler per message without awaiting the last, so the read of the exchange, the model
  // call and the write back have to be ONE section or a burst walks straight past the
  // budget. Ingestion stays outside it — a share's emoji must not wait behind somebody
  // else's model call — and only the conversation below is serialized.
  const inTurn = serialByKey();

  // What the day log keeps of a message — what a conversation can use and nothing that
  // identifies anyone: the share stripped, the link AND the generated block around it, so
  // a score-only message leaves nothing to remember; every mention as the name the group
  // uses, since the token spells a phone number; and a quote spelled out at the head of
  // the turn (`quoteLead`), so "oui" under "on joue ce soir ?" reads as the answer it was.
  // Answers the text as remembered, or null when the message had nothing to keep.
  async function remember(group: GroupConfig, message: InboundMessage, identity: BotIdentity): Promise<string | null> {
    const text = withoutShares(message.text, env.siteOrigin);
    const quoted = message.quoted;
    const quotedText = quoted ? withoutShares(quoted.text, env.siteOrigin) : '';
    if (!text && !quoted) return null;
    const refs = quoted ? [...message.mentions, { jid: quoted.participant, player: quoted.player }] : message.mentions;
    const names = await mentionNames(group, refs);
    const lead = quoted
      ? quoteLead(
          quotesBot(message, identity) ? 'you' : (names.get(jidUser(quoted.participant)) ?? displayName(group, quoted.player, '')),
          withMentionNames(quotedText, namesWithBot(names, identity)),
        )
      : '';
    const kept = `${lead}${withMentionNames(text, names)}`.trim();
    if (!kept) return null;
    const at = message.timestamp * 1000;
    await keep({
      group: group.id,
      day: dayOfInstant(at),
      at,
      id: message.id,
      kind: 'said',
      name: displayName(group, message.sender, message.senderName),
      text: kept,
    });
    return kept;
  }

  async function onMessage(message: InboundMessage): Promise<void> {
    const group = groups.get(message.group);
    if (!group) {
      await ingest(message); // answers `ignored`; the allow-list is its to hold too
      return;
    }
    const at = message.timestamp * 1000;
    const chatting = group.chat.enabled && message.live;
    // THE BOT'S OWN LINES ENTER THE LOG AS WHATSAPP ECHOES THEM BACK (`fromMe`,
    // 2026-09-07): the podium and the reminder are sent from the queue and composed
    // nowhere near here, so a "merci" under the podium was a reply to a line the model
    // could not see. A line already remembered when it was composed — an answer, a spoken
    // acknowledgement — is not remembered twice (`appendUnlessSaid`); the echo of a share
    // block, should the bot ever forward one, leaves nothing; so does a reaction's echo.
    if (chatting && message.fromMe) {
      const said = withoutShares(message.text, env.siteOrigin);
      if (said) await keep({ group: group.id, day: dayOfInstant(at), at, id: message.id, kind: 'bot', name: '', text: said }, true);
    }
    const identity: BotIdentity | null = chatting && client ? { jids: client.selfJids(), name: group.chat.name } : null;
    // EVERY message of the group is the conversation, and is REMEMBERED BEFORE `ingest`
    // RUNS: a share is acknowledged inside it, and a spoken acknowledgement is a turn too
    // (`spoken`, above) — recorded the other way round, every such exchange read as the
    // bot answering before the player had spoken.
    const kept = identity && !message.fromMe ? await remember(group, message, identity) : null;
    const ingested = await ingest(message);
    if (!identity || message.fromMe || !answer) return;
    const bot = identity;
    const ask = answer;

    return inTurn(group.id, async () => {
      // ADDRESSED, or AMBIENT (#277). Addressed is always answered. Ambient is offered to
      // the model — unless the message was a share the bot has just acknowledged (that WAS
      // the answer), or it holds nothing to answer, or the bot has volunteered its budget
      // of unasked answers in this exchange (`mayVolunteer`). READ INSIDE THE SECTION: the
      // whole point of it is that this value is the one the last answer wrote.
      const address = addressedTo(message, bot);
      const approach: Approach = address ?? 'ambient';
      const exchange = exchanges.get(group.id) ?? NEW_EXCHANGE;
      if (!address) {
        const acknowledged = group.acknowledge !== 'none' && (ingested === 'recorded' || ingested === 'acknowledged');
        const wordless = !kept || (isWordless(kept) && !(message.quoted && !isWordless(message.quoted.text)));
        const reason = acknowledged ? 'acknowledged' : wordless ? 'wordless' : !mayVolunteer(exchange, at) ? 'exchange_budget' : null;
        if (reason) {
          if (reason === 'exchange_budget') log.info({ event: 'chat.silent', reason, group: tag(group.id) }, 'not offered');
          return;
        }
      }
      log.info({ event: 'chat.offered', how: approach, group: tag(group.id), sender: tag(message.sender) }, 'offered');
      // THE MESSAGE'S OWN DAY, never the clock's (PR-278 review). A message sent at 21:59
      // Eastern and delivered at 22:06 is still live (`OFFLINE_LIVE_S`) and is a turn of
      // the day it was SENT in — which is the day its own log entry went to. Read against
      // the day that has since begun, the prompt would be missing the very message it is
      // answering, and every other turn of that exchange with it.
      const today = dayOfInstant(at);
      // STRIPPED HERE TOO, not only on the way into the log. An addressed message can carry
      // a share ("gg 7 essais <link> @bot qui mène ?"), and the agent reads the message's
      // own text for the emptiness test — so leaving the share on it would let a bare link
      // count as a question.
      const asked = {
        ...message,
        text: withoutShares(message.text, env.siteOrigin),
        ...(message.quoted ? { quoted: { ...message.quoted, text: withoutShares(message.quoted.text, env.siteOrigin) } } : {}),
      };
      const outcome = await ask(asked, group, bot, today, {
        approach,
        exchange,
        // What was filed for this message, so the prompt can point at it wherever the day
        // has put it (`AnswerOptions.said`): queued behind another answer, it is not the
        // last turn of the day by the time it is answered.
        said: { id: message.id, name: displayName(group, message.sender, message.senderName), text: kept ?? '' },
      });
      if (outcome.kind === 'silent') {
        log.info({ event: 'chat.silent', reason: outcome.reason, how: approach, group: tag(group.id) }, 'no reply');
        return;
      }
      // SAID ONLY ONCE THE QUEUE HAS IT (PR-278 review), the rule ingest's `spoken` hook
      // already followed: what the queue refused is not a turn the bot believes it said,
      // and it spends no exchange budget either. The instant is this process's clock, never
      // before the message it answers — a phone's stamp and this one need not agree.
      const spokeAt = Math.max(Date.now(), at + 1);
      try {
        if (outcome.kind === 'react') {
          await outbound.enqueue({
            id: commandIds.reply(group.id, message.id),
            kind: 'reaction',
            group: group.id,
            target: { id: message.id, participant: message.participant },
            emoji: outcome.emoji,
          });
          // A reaction closes: it moves no exchange and adds no bubble.
          await keep({ group: group.id, day: today, at: spokeAt, id: `${message.id}#react`, kind: 'reacted', name: '', text: outcome.emoji });
          return;
        }
        await outbound.enqueue({
          id: commandIds.reply(group.id, message.id),
          kind: 'message',
          group: group.id,
          text: outcome.text,
          replyTo: { id: message.id, participant: message.participant, text: message.text },
        });
      } catch (error) {
        log.error({ event: 'outbound.enqueue_failed', group: tag(group.id), error: (error as Error).message }, 'the answer was not queued; nothing recorded');
        return;
      }
      exchanges.set(group.id, afterAnswer(exchange, approach, at));
      await keep({ group: group.id, day: today, at: spokeAt, id: `${message.id}#reply`, kind: 'bot', name: '', text: outcome.text });
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
