// Group behaviour is CONFIGURATION, not code (#236). Every WhatsApp group the bot may act in
// has one JSON file under `groups/`, and that directory IS the allow-list: no file, no
// ingestion, no reaction, no conversation and no scheduled message. Nothing about an
// unknown JID is inferred — the bot receives the whole account's stream (that is how it
// finds share links) and drops every message whose group is not configured here.
//
// The file carries PRODUCT behaviour and never a secret: WhatsApp auth, provider API keys
// and the like live in AWS-managed state. Two fields are load-bearing from the start —
// `language`, which the bot speaks in that group (and which decides WHICH daily's shares
// count: an `fr` group ranks the French puzzle), and `chat.prePrompt`, the group's own
// voice appended to the code-owned personality. A pre-prompt tunes style; it can grant no
// tool, widen no data access and bypass no trigger policy, because none of those are
// decided by prompt text (see chat/agent.ts).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type GroupLanguage = 'en' | 'fr';

export interface PodiumConfig {
  enabled: boolean;
  // Local wall-clock "HH:MM" in `timezone` — a SOCIAL convention of the group (a Paris group
  // follows French DST), which is why it is not the Whippin reset. The Whippin day the
  // podium ranks is still the shared day contract's (`activeDate` at the fire instant).
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
  chat: ChatConfig;
  // Deterministic reactions to a valid share (no model call). Off = acknowledge nothing.
  reactions: boolean;
  // Proactive "X takes the lead with N" text on the deterministic new-leader event. Off by
  // default: it is a second policy with its own anti-spam state (domain/leader.ts).
  leaderAnnouncements: boolean;
  // Operator override map: a sender JID -> the name the group knows them by. An override
  // NAMES a JID; it never creates another player identity, and nothing fuzzy-merges names.
  names: Record<string, string>;
}

export const GROUP_JID = /^\d{5,}@g\.us$/;
export const USER_JID = /^\d{5,}@(s\.whatsapp\.net|lid)$/;
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
    'chat',
    'reactions',
    'leaderAnnouncements',
    'names',
  ]);
  const { id, name, language, enabled, podium, chat, reactions, leaderAnnouncements, names } =
    raw;
  if (typeof id !== 'string' || !GROUP_JID.test(id)) fail(file, '"id" must be a group JID');
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

  if (reactions !== undefined && typeof reactions !== 'boolean') {
    fail(file, '"reactions" must be a boolean');
  }
  if (leaderAnnouncements !== undefined && typeof leaderAnnouncements !== 'boolean') {
    fail(file, '"leaderAnnouncements" must be a boolean');
  }
  const overrides: Record<string, string> = {};
  if (names !== undefined) {
    if (!isRecord(names)) fail(file, '"names" must be an object of JID -> name');
    for (const [jid, label] of Object.entries(names)) {
      if (!USER_JID.test(jid)) fail(file, `"names": "${jid}" is not a user JID`);
      if (typeof label !== 'string' || label.trim() === '') {
        fail(file, `"names": the name for ${jid} must be a non-empty string`);
      }
      overrides[jid] = label.trim();
    }
  }

  return {
    id,
    name: name.trim(),
    language: language as GroupLanguage,
    enabled,
    podium: { enabled: podium.enabled, time: podium.time, timezone: podium.timezone },
    chat: {
      enabled: chat.enabled,
      name: botName.trim(),
      prePrompt: prePrompt.trim(),
      perUserPerDay: perUserPerDay as number,
      perGroupPerDay: perGroupPerDay as number,
    },
    reactions: reactions ?? true,
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
        throw new GroupConfigError(`group ${config.id} is configured twice`);
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

export function readGroupConfigs(dir: string): GroupConfig[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return files.map((file) => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (error) {
      fail(file, `invalid JSON (${(error as Error).message})`);
    }
    return parseGroupConfig(file, raw);
  });
}

export function loadGroups(dir: string): GroupRegistry {
  return new GroupRegistry(readGroupConfigs(dir));
}
