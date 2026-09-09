// The scheduled job (#236): BOUNDED work, so it is a Lambda — never a second WhatsApp
// session. EventBridge Scheduler fires it per group with `{ group, kind }` as input, for
// three acts: the evening PODIUM and the morning REMINDER at the group's own local times
// (`podium.time` / `reminder.time` in the group's `timezone`, social conventions), and
// since #277 the DIARY rewrite at the game's day flip.
//
//   podium:   read the group's rows for the Whippin day → dense podium → (optional) model
//             comments from the facts, the day's log and the diary → render → ONE outbound
//             command on the queue the connected task consumes.
//   reminder: read the day → one deterministic line with the link.
//   diary:    read the closed day's log and the diary → the model rewrites the diary.
//
// The Whippin day is the shared day contract's active day at the fire instant — never a
// calendar string derived from the group's time zone. A manual replay may name a date:
// invoke with `{ "group": "<jid>", "kind": "…", "date": "YYYY-MM-DD" }`. The podium's and
// the reminder's command ids are `<kind>:<group>:<day>`, so a retried invocation cannot
// post twice; the diary rewrite is idempotent by construction (the same day in, the same
// day folded).

import { SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { activeDate, dateForDayNumber, dayNumber } from '@whippin/shared';
import { dynamoDayLogStore, renderDay, type DayLogStore } from './chat/dayLog';
import { dynamoDiaryStore, rewriteDiary, type DiaryStore } from './chat/diary';
import { botRegion, loadEnv } from './config/env';
import { loadGroups, type GroupRegistry } from './config/groupConfig';
import { parseDay } from './domain/day';
import { inLanguage, type DeclarationStore } from './domain/declarations';
import { dynamoDeclarationStore } from './domain/dynamoDeclarationStore';
import { nameResolver } from './domain/names';
import { buildPodium } from './domain/podium';
import { renderPodium, renderReminder, type Comments } from './domain/podiumText';
import { HABIT_DAYS, buildPodiumContext } from './domain/shareContext';
import { createDaySourceReader, type DaySourceReader } from './puzzle/daySource';
import { createLlmProvider, type LlmProvider } from './llm';
import { generatePodiumComments, type PodiumBackground } from './llm/podiumComments';
import { createLog, tag, type Log } from './log';
import { commandIds, type OutboundQueue } from './outbound/commands';
import { sqsOutboundQueue } from './outbound/sqs';

export interface PodiumJobEvent {
  group: string;
  date?: string; // YYYY-MM-DD, for a manual replay
  // What the schedule asked for: the evening PODIUM (absent, the original), the morning
  // REMINDER (user-decided 2026-09-05), or the DIARY rewrite (#277) — ONE Lambda, since
  // each is "a schedule fires, one thing happens", and a second function would be a
  // second bundle to keep from breaking the way the first one did.
  kind?: 'podium' | 'reminder' | 'diary';
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
  // For the REMINDER: the link it carries, and the read that says whether there is a
  // puzzle to link to at all. Absent (the podium-only tests), a reminder is skipped.
  siteOrigin?: string;
  daySource?: DaySourceReader;
  // For the podium's comments and the diary: the day's conversation and the diary itself.
  // Absent, the podium is commented from the facts alone and the diary job is skipped.
  dayLog?: DayLogStore;
  diary?: DiaryStore;
}

const skipped = (group: string, dayNumber: number): PodiumJobResult => ({ outcome: 'skipped', group, dayNumber, lines: 0, comments: 0 });

// THE MORNING REMINDER. Skipped — never a bare link — when the day is not published, and
// when the read that would say so failed: inviting a group to a 404 is the one thing this
// must not do, and a morning with no reminder costs nothing. The scheduler's own retries
// cover a Lambda that fails outright; a skip is a decision, not a failure.
export async function runReminderJob(event: PodiumJobEvent, deps: PodiumJobDeps): Promise<PodiumJobResult> {
  const now = deps.now ?? (() => new Date());
  const group = deps.groups.get(event.group);
  const day = event.date == null ? dayNumber(activeDate(now())) : parseDay(event.date);
  if (day === null) {
    deps.log.warn({ event: 'reminder.bad_date', group: tag(event.group) }, 'not a real calendar date; nothing posted');
    return skipped(event.group, 0);
  }
  if (!group || !group.reminder.enabled) {
    deps.log.warn({ event: 'reminder.skipped', group: tag(event.group) }, 'group not configured for a reminder');
    return skipped(event.group, day);
  }
  if (!deps.siteOrigin || !deps.daySource) {
    deps.log.warn({ event: 'reminder.unwired', group: tag(group.id) }, 'no site or no day reader; nothing posted');
    return skipped(group.id, day);
  }
  const read = await deps.daySource.read(group.language, day, dateForDayNumber(day));
  if (!read || !read.published) {
    deps.log.info({ event: read ? 'reminder.unpublished' : 'reminder.unread', group: tag(group.id), day }, 'no puzzle to point at; nothing posted');
    return skipped(group.id, day);
  }
  await deps.outbound.enqueue({
    id: commandIds.reminder(group.id, day),
    kind: 'message',
    group: group.id,
    text: renderReminder(group.language, deps.siteOrigin, read.source?.kind ?? null, group.podium.enabled ? group.podium.time : null),
  });
  deps.log.info({ event: 'reminder.queued', group: tag(group.id), day }, 'reminder queued');
  return { outcome: 'posted', group: group.id, dayNumber: day, lines: 0, comments: 0 };
}

export async function runPodiumJob(event: PodiumJobEvent, deps: PodiumJobDeps): Promise<PodiumJobResult> {
  const now = deps.now ?? (() => new Date());
  const group = deps.groups.get(event.group);
  // A replay that names a day gets THAT day, and a date that is not a real one is refused
  // rather than rolled over into a neighbouring day's podium (see `parseDay`).
  const day = event.date == null ? dayNumber(activeDate(now())) : parseDay(event.date);
  if (day === null) {
    deps.log.warn(
      { event: 'podium.bad_date', group: tag(event.group) },
      'not a real calendar date; nothing posted',
    );
    // No day: reporting the active one would name a day this call did not act on.
    return skipped(event.group, 0);
  }
  if (!group || !group.podium.enabled) {
    deps.log.warn({ event: 'podium.skipped', group: tag(event.group) }, 'group not configured for a podium');
    return skipped(event.group, day);
  }
  const rows = inLanguage(await deps.declarations.day(group.id, day), group.language);
  const podium = buildPodium(day, rows, nameResolver(group));
  if (podium.lines.length === 0 && podium.capped.length === 0) {
    deps.log.info({ event: 'podium.empty', group: tag(group.id), day }, 'no shares today; nothing posted');
    return { outcome: 'empty', group: group.id, dayNumber: day, lines: 0, comments: 0 };
  }
  let comments: Comments = new Map();
  if (deps.provider) {
    // THE FACTS FIRST, THE BACKGROUND IF IT CAN BE READ. The window before today is what
    // every habit is computed from; without it there are no facts and no comments. The
    // day's conversation and the diary are what a callback draws on, and a read that
    // fails costs the callbacks and nothing else.
    try {
      const windowRows = await deps.declarations.range(group.id, day - HABIT_DAYS, day - 1);
      const context = buildPodiumContext({ group, dayNumber: day, todayRows: rows, windowRows });
      const background: PodiumBackground = { diary: null, conversation: null };
      if (deps.diary) {
        background.diary = await deps.diary.get(group.id).then((d) => d?.text ?? null, (error: Error) => {
          deps.log.warn({ event: 'podium.diary_unread', group: tag(group.id), error: error.message }, 'commenting without the diary');
          return null;
        });
      }
      if (deps.dayLog) {
        background.conversation = await deps.dayLog.read(group.id, day).then(
          (turns) => (turns.length ? renderDay(turns, group.timezone, group.chat.name) : null),
          (error: Error) => {
            deps.log.warn({ event: 'podium.daylog_unread', group: tag(group.id), error: error.message }, 'commenting without the day');
            return null;
          },
        );
      }
      comments = await generatePodiumComments(deps.provider, group, podium, context, background, deps.log);
    } catch (error) {
      deps.log.warn({ event: 'podium.facts_failed', group: tag(group.id), error: (error as Error).message }, 'could not read the facts; podium without comments');
    }
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

// THE DIARY REWRITE (#277), at the day flip: the day just closed is `active − 1` at the
// fire instant (a replay names the day). An empty day, an unconfigured group, a missing
// provider or store, and a model that could not answer all leave the diary AS IT WAS —
// `empty` or `skipped` — since a stale diary costs a missing joke and a blanked one costs
// everything the bot knew. `posted` here means rewritten.
export async function runDiaryJob(event: PodiumJobEvent, deps: PodiumJobDeps): Promise<PodiumJobResult> {
  const now = deps.now ?? (() => new Date());
  const group = deps.groups.get(event.group);
  const day = event.date == null ? dayNumber(activeDate(now())) - 1 : parseDay(event.date);
  if (day === null) {
    deps.log.warn({ event: 'diary.bad_date', group: tag(event.group) }, 'not a real calendar date; nothing rewritten');
    return skipped(event.group, 0);
  }
  if (!group || !group.chat.enabled) {
    deps.log.warn({ event: 'diary.skipped', group: tag(event.group) }, 'group not configured for conversation');
    return skipped(event.group, day);
  }
  if (!deps.provider || !deps.dayLog || !deps.diary) {
    deps.log.warn({ event: 'diary.unwired', group: tag(group.id) }, 'no model or no store; nothing rewritten');
    return skipped(group.id, day);
  }
  const turns = await deps.dayLog.read(group.id, day);
  if (turns.length === 0) {
    deps.log.info({ event: 'diary.empty_day', group: tag(group.id), day }, 'nothing was said; diary kept');
    return { outcome: 'empty', group: group.id, dayNumber: day, lines: 0, comments: 0 };
  }
  const previous = await deps.diary.get(group.id);
  const next = await rewriteDiary(deps.provider, group, previous, day, turns, deps.log, now);
  if (!next) return { outcome: 'empty', group: group.id, dayNumber: day, lines: turns.length, comments: 0 };
  await deps.diary.put(group.id, next);
  deps.log.info({ event: 'diary.rewritten', group: tag(group.id), day, turns: turns.length, chars: next.text.length }, 'diary rewritten');
  return { outcome: 'posted', group: group.id, dayNumber: day, lines: turns.length, comments: 1 };
}

// Lambda entry. Everything with a side effect is built here, once per container.
let deps: Promise<PodiumJobDeps> | undefined;

async function buildDeps(): Promise<PodiumJobDeps> {
  const log = createLog();
  const env = loadEnv();
  if (!env.outboundQueueUrl) throw new Error('BOT_OUTBOUND_QUEUE_URL env var is required.');
  const dynamo = new DynamoDBClient({ region: botRegion() });
  let provider: LlmProvider | null = null;
  try {
    provider = await createLlmProvider(env.llm, () => new SSMClient({ region: botRegion() }));
  } catch (error) {
    log.error({ event: 'llm.unconfigured', error: (error as Error).message }, 'podium without comments');
  }
  return {
    groups: loadGroups(env.groupsDir),
    declarations: dynamoDeclarationStore(dynamo, env.table),
    outbound: sqsOutboundQueue(new SQSClient({ region: botRegion() }), env.outboundQueueUrl),
    provider,
    log,
    siteOrigin: env.siteOrigin,
    daySource: createDaySourceReader({ apiBaseUrl: env.apiBaseUrl, log }),
    dayLog: dynamoDayLogStore(dynamo, env.table),
    diary: dynamoDiaryStore(dynamo, env.table),
  };
}

export async function handler(event: PodiumJobEvent): Promise<PodiumJobResult> {
  // A REJECTED promise must not be the cache: an SSM blip on the first invocation would
  // otherwise fail every later one for the life of the container, long after the cause.
  deps ??= buildDeps().catch((error) => {
    deps = undefined;
    throw error;
  });
  const run = event.kind === 'reminder' ? runReminderJob : event.kind === 'diary' ? runDiaryJob : runPodiumJob;
  return run(event, await deps);
}
