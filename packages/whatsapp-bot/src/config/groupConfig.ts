// Group behaviour is CONFIGURATION, not code (#236). Every WhatsApp group the bot may act in
// has one JSON config, and that set IS the allow-list: no config, no ingestion, no
// reaction, no conversation and no scheduled message. Nothing about an unknown JID is
// inferred — the bot receives the whole account's stream (that is how it finds share
// links) and drops every message whose group is not configured.
//
// THE SOURCE OF TRUTH IS SSM, NOT THIS REPOSITORY. A group JID names a real private
// conversation and this repo is public, so the configs live at `/whippin/bot/groups/<slug>`
// and `groups/local/` holds a SNAPSHOT of them, pulled immediately before a build or a
// deploy (`pnpm bot:groups`, `config/groupsStore.ts`). What this module reads is always
// that snapshot — a directory of files — so nothing at run time depends on SSM being
// reachable, and one deployment runs on one coherent set.
//
// The file carries PRODUCT behaviour and never a secret: WhatsApp auth, provider API keys
// and the like live in AWS-managed state. Two fields are load-bearing from the start —
// `language`, which the bot speaks in that group (and which decides WHICH daily's shares
// count: an `fr` group ranks the French puzzle), and `chat.prePrompt`, the group's own
// voice appended to the code-owned personality. A pre-prompt tunes style; it can grant no
// tool, widen no data access and bypass no trigger policy, because none of those are
// decided by prompt text (see chat/agent.ts).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NAME_MAX_CHARS, isBoundName } from '../domain/names';

export type GroupLanguage = 'en' | 'fr';

export interface PodiumConfig {
  enabled: boolean;
  // Local wall-clock "HH:MM" in `timezone` — a SOCIAL convention of the group (a Paris group
  // follows French DST), which is why it is not the Whippin reset. The Whippin day the
  // podium ranks is still the shared day contract's (`activeDate` at the fire instant).
  time: string;
  timezone: string;
}

// The MORNING REMINDER (user-decided 2026-09-05): one line with the link when the day's
// puzzle is up, at a local time of the group's own — off by default, because a daily ping is
// a thing a group opts into. Same time semantics as the podium.
export interface ReminderConfig {
  enabled: boolean;
  time: string;
  timezone: string;
}

export interface ChatConfig {
  enabled: boolean;
  // The direct-name form that addresses the bot without a mention ("WhippinBot, …").
  name: string;
  prePrompt: string;
  // Conversational ceilings: replies per sender per UTC day, and per group per UTC day.
  perUserPerDay: number;
  perGroupPerDay: number;
}

export interface GroupConfig {
  id: string; // the group JID, `<digits>@g.us`
  name: string;
  language: GroupLanguage;
  enabled: boolean;
  podium: PodiumConfig;
  reminder: ReminderConfig;
  chat: ChatConfig;
  // HOW a recorded share is acknowledged (user-decided 2026-09-04). `react` is the
  // deterministic emoji, no model call; `say` is one short written line the model composes,
  // which falls back to the emoji when the model cannot answer — an acknowledgement is owed
  // and is never dropped for want of a joke; `none` acknowledges nothing. It replaced a
  // `reactions` boolean: a second flag beside it would have made "both off" and "both on"
  // two ways of saying one thing, and the choice is one axis, not two.
  acknowledge: Acknowledge;
  // Proactive "X takes the lead with N" text on the deterministic new-leader event. Off by
  // default: it is a second policy with its own anti-spam state (domain/leader.ts).
  leaderAnnouncements: boolean;
  // Operator override map: a sender JID -> the name the group knows them by. An override
  // NAMES a JID; it never creates another player identity, and nothing fuzzy-merges names.
  names: Record<string, string>;
}

// How a share is acknowledged in a group — see `GroupConfig.acknowledge`.
export type Acknowledge = 'react' | 'say' | 'none';
const ACKNOWLEDGE: readonly Acknowledge[] = ['react', 'say', 'none'];

export const GROUP_JID = /^\d{5,}@g\.us$/;
export const USER_JID = /^\d{5,}@(s\.whatsapp\.net|lid)$/;
// The template's placeholder (`groups/example.json`). Format-valid but names no
// conversation, so it must never reach SSM or a snapshot — a deploy would mint a real
// schedule against a group that does not exist.
export const PLACEHOLDER_GROUP_JID = '120363000000000000@g.us';
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const LANGUAGES: readonly GroupLanguage[] = ['en', 'fr'];

export const DEFAULT_BOT_NAME = 'WhippinBot';
const DEFAULT_PER_USER_PER_DAY = 10;
const DEFAULT_PER_GROUP_PER_DAY = 60;

export class GroupConfigError extends Error {}

function fail(file: string, message: string): never {
  throw new GroupConfigError(`${file}: ${message}`);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function timezoneIsValid(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Every unknown key is refused AT EVERY LEVEL, not only the top one. `chatt` and
// `chat.perUserPerDya` fail exactly the same way, and they have to: the nested fields are
// the ones with DEFAULTS, so a typo there is the case that silently un-configures a group
// — a pre-prompt that never reaches the model, a ceiling back at ten a day — while a
// mistyped top-level key mostly loses a whole object the parser then refuses anyway.
function refuseUnknown(file: string, where: string, raw: Record<string, unknown>, known: readonly string[]): void {
  const allowed = new Set(known);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) fail(file, `unknown field "${where}${key}"`);
  }
}

// Strict: every field is checked, unknown keys are refused, and a file that fails does not
// load — a half-read configuration is exactly the "partial/default behaviour" the
// allow-list rule forbids.
export function parseGroupConfig(file: string, raw: unknown): GroupConfig {
  if (!isRecord(raw)) fail(file, 'must be a JSON object');
  refuseUnknown(file, '', raw, [
    'id',
    'name',
    'language',
    'enabled',
    'podium',
    'reminder',
    'chat',
    'acknowledge',
    'leaderAnnouncements',
    'names',
  ]);
  const { id, name, language, enabled, podium, reminder, chat, acknowledge, leaderAnnouncements, names } =
    raw;
  if (typeof id !== 'string' || !GROUP_JID.test(id)) fail(file, '"id" must be a group JID');
  if (id === PLACEHOLDER_GROUP_JID) {
    fail(file, '"id" is still the example.json placeholder — paste the real JID from `pnpm bot:cli groups`');
  }
  if (typeof name !== 'string' || name.trim() === '') fail(file, '"name" must be a string');
  if (typeof language !== 'string' || !LANGUAGES.includes(language as GroupLanguage)) {
    fail(file, `"language" must be one of ${LANGUAGES.join(', ')}`);
  }
  if (typeof enabled !== 'boolean') fail(file, '"enabled" must be a boolean');

  if (!isRecord(podium)) fail(file, '"podium" must be an object');
  refuseUnknown(file, 'podium.', podium, ['enabled', 'time', 'timezone']);
  if (typeof podium.enabled !== 'boolean') fail(file, '"podium.enabled" must be a boolean');
  if (typeof podium.time !== 'string' || !TIME.test(podium.time)) {
    fail(file, '"podium.time" must be "HH:MM"');
  }
  if (typeof podium.timezone !== 'string' || !timezoneIsValid(podium.timezone)) {
    fail(file, '"podium.timezone" must be an IANA time zone');
  }

  // Optional as a BLOCK (absent = off), strict inside it: `time` is required once the block
  // exists, the zone defaults to the podium's — one group lives in one place.
  let reminderConfig: ReminderConfig = { enabled: false, time: '09:00', timezone: podium.timezone };
  if (reminder !== undefined) {
    if (!isRecord(reminder)) fail(file, '"reminder" must be an object');
    refuseUnknown(file, 'reminder.', reminder, ['enabled', 'time', 'timezone']);
    if (typeof reminder.enabled !== 'boolean') fail(file, '"reminder.enabled" must be a boolean');
    if (typeof reminder.time !== 'string' || !TIME.test(reminder.time)) {
      fail(file, '"reminder.time" must be "HH:MM"');
    }
    const timezone = reminder.timezone ?? podium.timezone;
    if (typeof timezone !== 'string' || !timezoneIsValid(timezone)) {
      fail(file, '"reminder.timezone" must be an IANA time zone');
    }
    reminderConfig = { enabled: reminder.enabled, time: reminder.time, timezone };
  }

  if (!isRecord(chat)) fail(file, '"chat" must be an object');
  refuseUnknown(file, 'chat.', chat, [
    'enabled',
    'name',
    'prePrompt',
    'perUserPerDay',
    'perGroupPerDay',
  ]);
  if (typeof chat.enabled !== 'boolean') fail(file, '"chat.enabled" must be a boolean');
  const prePrompt = chat.prePrompt ?? '';
  if (typeof prePrompt !== 'string') fail(file, '"chat.prePrompt" must be a string');
  const botName = chat.name ?? DEFAULT_BOT_NAME;
  if (typeof botName !== 'string' || botName.trim() === '') {
    fail(file, '"chat.name" must be a non-empty string');
  }
  const perUserPerDay = chat.perUserPerDay ?? DEFAULT_PER_USER_PER_DAY;
  const perGroupPerDay = chat.perGroupPerDay ?? DEFAULT_PER_GROUP_PER_DAY;
  for (const [key, value] of [
    ['perUserPerDay', perUserPerDay],
    ['perGroupPerDay', perGroupPerDay],
  ] as const) {
    if (!Number.isInteger(value) || (value as number) < 0) {
      fail(file, `"chat.${key}" must be a non-negative integer`);
    }
  }

  if (acknowledge !== undefined && !ACKNOWLEDGE.includes(acknowledge as Acknowledge)) {
    fail(file, `"acknowledge" must be one of ${ACKNOWLEDGE.join(', ')}`);
  }
  if (leaderAnnouncements !== undefined && typeof leaderAnnouncements !== 'boolean') {
    fail(file, '"leaderAnnouncements" must be a boolean');
  }
  const overrides: Record<string, string> = {};
  if (names !== undefined) {
    if (!isRecord(names)) fail(file, '"names" must be an object of JID -> name');
    // The key IS a sender JID, so it never appears in an error: this message surfaces in
    // synth/CI logs via `BrokenParameter.reason` and `readGroupConfigs`, which are readable
    // beyond the operator (the duplicate-JID rule below). The entry index is what the
    // operator counts to in `edit`.
    const entries = Object.entries(names);
    for (let i = 0; i < entries.length; i++) {
      const [jid, label] = entries[i];
      // COUNTED FROM ONE: this is a position a human counts to down the map in `edit`, and
      // there the first entry is the first one.
      const at = `entry ${i + 1}`;
      if (!USER_JID.test(jid)) fail(file, `"names": ${at} is not a user JID`);
      if (typeof label !== 'string' || label.trim() === '') {
        fail(file, `"names": ${at} must be a non-empty string`);
      }
      // The same bound a push name gets (`domain/names.ts`): an override lands in the same
      // podium lines and prompts, and a file is where a mistake should be loud.
      const trimmed = label.trim();
      if (!isBoundName(trimmed)) {
        fail(file, `"names": ${at} must be one line of at most ${NAME_MAX_CHARS} characters`);
      }
      overrides[jid] = trimmed;
    }
  }

  return {
    id,
    name: name.trim(),
    language: language as GroupLanguage,
    enabled,
    podium: { enabled: podium.enabled, time: podium.time, timezone: podium.timezone },
    reminder: reminderConfig,
    chat: {
      enabled: chat.enabled,
      name: botName.trim(),
      prePrompt: prePrompt.trim(),
      perUserPerDay: perUserPerDay as number,
      perGroupPerDay: perGroupPerDay as number,
    },
    acknowledge: (acknowledge as Acknowledge | undefined) ?? 'react',
    leaderAnnouncements: leaderAnnouncements ?? false,
    names: overrides,
  };
}

// The loaded allow-list: enabled groups by JID. A DISABLED file is validated (so it cannot
// rot unnoticed) and then dropped — from the runtime's point of view the group does not
// exist. Two files naming one JID is a configuration error, not a merge.
export class GroupRegistry {
  private readonly byId = new Map<string, GroupConfig>();

  constructor(configs: readonly GroupConfig[]) {
    for (const config of configs) {
      if (!config.enabled) continue;
      if (this.byId.has(config.id)) {
        // No JID in the message: a group JID names a private conversation and this
        // error surfaces in synth/CI logs, which are readable beyond the operator.
        throw new GroupConfigError('one group is configured twice');
      }
      this.byId.set(config.id, config);
    }
  }

  get(jid: string): GroupConfig | undefined {
    return this.byId.get(jid);
  }

  all(): GroupConfig[] {
    return [...this.byId.values()];
  }
}

// ONE JID, ONE CONFIG — enabled or not. `GroupRegistry` refuses a duplicate too, but only
// among ENABLED configs, so two slugs could name one group as long as one was switched off,
// and enabling the second would fail at deploy rather than where it was written. Two configs
// for one conversation is a mistake at any setting: whichever the registry happened to keep
// would decide that group's language and podium.
//
// The message names SOURCES, never the JID: a group JID names a private conversation and
// this error surfaces in synth/CI logs, which are readable beyond the operator. The two
// slugs are what the operator acts on anyway.
export function assertUniqueGroupIds(configs: readonly { id: string; source: string }[]): void {
  const seen = new Map<string, string>();
  for (const { id, source } of configs) {
    const first = seen.get(id);
    if (first !== undefined) fail(source, `already configured by ${first} (one group may have only one config)`);
    seen.set(id, source);
  }
}

// The snapshot directory, as the RUNTIME reads it (the task at boot, the podium Lambda on
// every invocation). A MISSING one is an ERROR here: the directory is named by
// `BOT_GROUPS_DIR`, spelled once in the Dockerfile and once in the stack, and the two
// drifting is exactly the case this has to catch — read as "no groups", the task boots,
// reports connected, and silently ingests nothing, which no alarm watches. The throw makes
// it a crash-loop the connected-gauge alarm does see. (An EMPTY directory is a legitimate
// empty set: `groups/local/` is always present in a checkout.)
export function readGroupConfigs(dir: string): GroupConfig[] {
  if (!existsSync(dir)) {
    throw new GroupConfigError(
      `no group snapshot at ${dir} — run \`pnpm bot:groups pull\` (a deployment names it in BOT_GROUPS_DIR).`,
    );
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const configs = files.map((file) => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (error) {
      fail(file, `invalid JSON (${(error as Error).message})`);
    }
    return parseGroupConfig(file, raw);
  });
  assertUniqueGroupIds(configs.map((c, i) => ({ id: c.id, source: files[i] })));
  return configs;
}

// The same directory as SYNTH reads it, where a MISSING one is legitimately empty: every
// `cdk synth` in this repo constructs the bot stack, including the ones deploying the web
// or the backend, and those must not require a pull. What guards against deploying an
// accidentally empty set is the bot stack's own synth warning plus the pull step in
// `deploy.yml` — see bot-stack.ts. Its name says who it is for: nothing that RUNS may read
// through it.
export function readGroupConfigsForSynth(dir: string): GroupConfig[] {
  return existsSync(dir) ? readGroupConfigs(dir) : [];
}

export function loadGroups(dir: string): GroupRegistry {
  return new GroupRegistry(readGroupConfigs(dir));
}
