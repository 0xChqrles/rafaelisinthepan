// SEEDING THE DIARY FROM A WHATSAPP EXPORT (#277), an operator path run ONCE per group:
//
//   pnpm bot:diary <group JID> <export.md> [--dry-run] [--me <name>]
//                  [--mention <digits>=<name>]... [--from YYYY-MM-DD] [--force]
//
// Without it the bot deploys with no memory of a group that has been playing for months —
// who is who, who teases whom, what became a joke — and only starts learning tonight. With
// it the diary opens on everything the export holds.
//
// IT FOLDS THE HISTORY THROUGH THE NIGHTLY REWRITE, one day at a time, in order: the same
// `rewriteDiary` call the 22:20 job makes, so what comes out is a diary in the bot's own
// voice and shaped by the same prompt — not a summary written by something else once. Each
// day sees the diary as the day before left it, which is also what compresses July down to
// what still matters by September.
//
// TWO THINGS IT WILL NOT DO. It stops at the last COMPLETE Whippin day and files the
// current day's messages in the DAY LOG instead, so tonight's job folds that day itself
// with everything said after the export was taken — seeding it into the diary would make
// the job skip it (`runDiaryJob` folds a day once) and lose the evening. And it refuses to
// write over a diary that already exists unless `--force`: a diary is the only thing here
// that cannot be rebuilt from the game's own rows.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { activeDate, dateForDayNumber, dayNumber } from '@whippin/shared';
import { DayLog, dayOfInstant, dynamoDayLogStore, renderDay, type Turn } from './chat/dayLog';
import { dynamoDiaryStore, rewriteDiary, stampOf, type Diary } from './chat/diary';
import { quoteLead } from './chat/dayLog';
import { withMentionNames } from './chat/trigger';
import { botRegion, loadEnv } from './config/env';
import { GROUP_JID, loadGroups, type GroupConfig } from './config/groupConfig';
import { parseDay } from './domain/day';
import { withoutShares } from './domain/share';
import { createLlmProvider, type LlmProvider } from './llm';
import { createLog } from './log';
import { messageInstant, parseExport, speakerName, type ExportMessage } from './whatsappExport';

interface Options {
  dryRun: boolean;
  force: boolean;
  me: string;
  mentions: Map<string, string>;
  from: number | null;
}

function usage(message: string): never {
  console.error(message);
  console.error('usage: pnpm bot:diary <group JID> <export.md> [--dry-run] [--me <name>] [--mention <digits>=<name>] [--from YYYY-MM-DD] [--force]');
  process.exit(2);
}

function parseArgs(argv: string[]): { group: string; file: string; options: Options } {
  const rest: string[] = [];
  const options: Options = { dryRun: false, force: false, me: 'Vous', mentions: new Map(), from: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--me') options.me = argv[++i] ?? usage('--me needs a name');
    else if (arg === '--from') {
      const day = parseDay(argv[++i]);
      if (day === null) usage('--from needs a real YYYY-MM-DD');
      options.from = day;
    } else if (arg === '--mention') {
      const [digits, ...name] = (argv[++i] ?? '').split('=');
      if (!/^\d+$/.test(digits) || name.length === 0) usage('--mention takes <digits>=<name>');
      options.mentions.set(digits, name.join('='));
    } else if (arg.startsWith('--')) usage(`unknown option ${arg}`);
    else rest.push(arg);
  }
  const [group, file] = rest;
  if (!group || !GROUP_JID.test(group)) usage('the first argument is the group JID');
  if (!file) usage('the second argument is the export file');
  return { group, file, options };
}

// One turn, composed the way `main.ts` composes what it files for a live message: the share
// block out (never the raw contents of one), every mention as a name, and the quote spelled
// out at the head. A message that leaves nothing is not a turn.
function turnOf(message: ExportMessage, at: number, group: GroupConfig, options: Options, siteOrigin: string, id: string): Turn | null {
  const names = { group, me: options.me, bot: group.chat.name };
  const mentions = options.mentions;
  const text = withMentionNames(withoutShares(message.text, siteOrigin), mentions);
  const quoted = message.quoted;
  const lead = quoted
    ? quoteLead(
        speakerName(quoted.author, names) === group.chat.name ? 'you' : speakerName(quoted.author, names),
        withMentionNames(withoutShares(quoted.text, siteOrigin), mentions),
      )
    : '';
  const kept = `${lead}${text}`.trim();
  if (kept === '') return null;
  const who = speakerName(message.author, names);
  const bot = who === group.chat.name;
  return { group: group.id, day: dayOfInstant(at), at, id, kind: bot ? 'bot' : 'said', name: bot ? '' : who, text: kept };
}

async function main(): Promise<void> {
  const { group: groupJid, file, options } = parseArgs(process.argv.slice(2));
  const log = createLog('warn');
  const env = loadEnv();
  const group = loadGroups(env.groupsDir).get(groupJid);
  if (!group) {
    console.error('No enabled config for that group in the snapshot (`pnpm bot:groups pull`).');
    process.exit(1);
  }
  if (!group.chat.enabled) {
    console.error('That group has chat disabled: it keeps no diary.');
    process.exit(1);
  }
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const messages = parseExport(readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), file), 'utf8'));

  // BY WHIPPIN DAY, which is not the export's calendar day: the day flips at 22:00 Eastern,
  // so a Paris message at one in the morning belongs to the day before.
  const byDay = new Map<number, Turn[]>();
  let dropped = 0;
  for (const [i, message] of messages.entries()) {
    const at = messageInstant(message.day, message.time, group.timezone);
    if (at === null) {
      dropped += 1;
      continue;
    }
    const turn = turnOf(message, at, group, options, env.siteOrigin, `seed-${i}`);
    if (!turn) continue;
    const list = byDay.get(turn.day) ?? [];
    list.push(turn);
    byDay.set(turn.day, list);
  }
  const today = dayNumber(activeDate(new Date()));
  const days = [...byDay.keys()].filter((d) => d < today && (options.from === null || d >= options.from)).sort((a, b) => a - b);
  const todays = byDay.get(today) ?? [];
  console.log(`${messages.length} messages${dropped ? ` (${dropped} unreadable, dropped)` : ''} → ${days.length} complete days to fold, ${todays.length} turns of today (${dateForDayNumber(today)}) for the day log.`);
  if (days.length === 0) {
    console.error('Nothing to fold.');
    process.exit(1);
  }

  const dynamo = new DynamoDBClient({ region: botRegion() });
  const diaries = dynamoDiaryStore(dynamo, env.table);
  const standing = await diaries.get(group.id);
  if (standing && !options.force) {
    console.error(`This group already has a diary (${standing.text.length} chars, through ${dateForDayNumber(standing.day)}). Pass --force to replace it.`);
    process.exit(1);
  }
  let provider: LlmProvider | null = null;
  try {
    provider = await createLlmProvider(env.llm, () => new SSMClient({ region: botRegion() }));
  } catch (error) {
    console.error(`No model: ${(error as Error).message}`);
    process.exit(1);
  }
  if (!provider) {
    console.error('No model configured (BOT_LLM_API_KEY or BOT_LLM_API_KEY_PARAMETER): the diary is written by the model.');
    process.exit(1);
  }

  // `--from` continues a run that stopped: what stands is where it got to.
  let diary: Diary | null = options.from !== null ? standing : null;
  for (const day of days) {
    const turns = byDay.get(day) ?? [];
    const started = Date.now();
    const next = await rewriteDiary(provider, group, diary, day, turns, log);
    const took = Math.round((Date.now() - started) / 100) / 10;
    if (!next) {
      console.log(`  ${dateForDayNumber(day)}  ${String(turns.length).padStart(3)} turns  — no diary came back (kept as it was, ${took}s)`);
      continue;
    }
    diary = next;
    console.log(`  ${dateForDayNumber(day)}  ${String(turns.length).padStart(3)} turns  → ${String(next.text.length).padStart(4)} chars  ${took}s`);
  }
  if (!diary) {
    console.error('Nothing was written at all; the diary is unchanged.');
    process.exit(1);
  }

  console.log(`\n──────── the diary, through ${dateForDayNumber(diary.day)} ────────\n${diary.text}\n────────\n`);
  if (todays.length > 0) {
    console.log(`──────── today's turns, for the day log ────────\n${renderDay(todays.slice(-12), group.timezone, group.chat.name)}\n────────\n`);
  }
  if (options.dryRun) {
    console.log('--dry-run: nothing was stored.');
    return;
  }
  if (!(await diaries.put(group.id, diary, stampOf(standing)))) {
    console.error('The diary changed while this was running; nothing stored.');
    process.exitCode = 1;
    return;
  }
  const dayLog = new DayLog(dynamoDayLogStore(dynamo, env.table));
  for (const turn of todays) await dayLog.append(turn);
  console.log(`Stored: the diary, and ${todays.length} turns of today. Tonight's job folds today itself.`);
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error((error as Error).message);
    process.exit(1);
  },
);
