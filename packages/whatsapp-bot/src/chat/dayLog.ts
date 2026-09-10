// THE DAY LOG (#277): everything a configured group said today, kept so the bot can read
// the day it is in. It replaces the in-memory window of 25 messages and 30 minutes, which
// was too short for a group whose exchanges span an afternoon ("t'en penses quoi ?" about
// a message forty minutes old was answered about something else) and which every deploy
// wiped — and the task is deployed several times a day.
//
// DURABLE, BOUNDED, AND THE ONLY TEXT THE BOT STORES (user-decided 2026-09-09). One row per
// turn in the bot table — `DAYLOG#<group>` / `DAY#<000000>#<instant>#<id>` — with a TTL of
// `DAY_LOG_TTL_SECONDS` (48 hours): long enough for the day and the diary rewrite that
// closes it (`diary.ts`), short enough that nothing here is a transcript. The task reloads
// today's rows on boot (`load`), so a restart forgets nothing; the diary job reads the same
// rows from its own process. What a row holds is what the window held: the text as the
// conversation can use it — the share block stripped, every mention as a name, a quote
// spelled out at the head (`quoteLead`) — and the bot's own lines and REACTIONS beside
// them, so the model can see what it already said and what it already closed with a ❤️.
//
// THE PROMPT GETS THE WHOLE DAY, NEWEST TURNS FIRST INTO THE BUDGET. A day of this group is
// ten to fifteen thousand characters; `DAY_MAX_CHARS` leaves room for a busy one and cuts
// the oldest off a pathological one. A turn is bounded on the way in (`TURN_MAX_CHARS`,
// head kept). The provider caches the prefix, so the day costs little per call.

import { QueryCommand, PutItemCommand, type AttributeValue, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { activeDate, dayNumber } from '@whippin/shared';
import { dayPrefix } from '../domain/dynamoDeclarationStore';

export type TurnKind = 'said' | 'bot' | 'reacted';

export interface Turn {
  group: string;
  day: number; // the Whippin day the instant falls in (the day flips at 22:00 ET)
  at: number; // ms
  id: string; // the WhatsApp message id; a reaction is `<message id>#react`
  kind: TurnKind;
  name: string; // the speaker's display name; '' for the bot
  text: string; // what was said, cleaned; for a reaction, the emoji
}

export const TURN_MAX_CHARS = 500;
export const DAY_MAX_CHARS = 40_000;
export const DAY_LOG_TTL_SECONDS = 48 * 60 * 60;

export function boundTurnText(text: string): string {
  return text.length > TURN_MAX_CHARS ? `${text.slice(0, TURN_MAX_CHARS - 1).trimEnd()}…` : text;
}

// A REPLY NAMES WHAT IT ANSWERS (2026-09-07). WhatsApp draws the quoted bubble; the model
// reads text, so the quote is spelled out at the head of the turn — who said it, and what.
// Bounded harder than a turn: it is orientation, not content, and the head of a long
// message is enough to recognise it by. A quote with no words left (a photo, a share the
// caller stripped) still names its author, which is most of what a reply to it means.
export const QUOTE_MAX_CHARS = 200;

export function quoteLead(author: string, text: string): string {
  const said = text.length > QUOTE_MAX_CHARS ? `${text.slice(0, QUOTE_MAX_CHARS - 1).trimEnd()}…` : text;
  return said === '' ? `[replying to a message from ${author}] ` : `[replying to ${author}: "${said}"] `;
}

export function dayOfInstant(atMs: number): number {
  return dayNumber(activeDate(new Date(atMs)));
}

export interface DayLogStore {
  append(turn: Turn): Promise<void>;
  // A day's turns, ascending by instant then id.
  read(group: string, day: number): Promise<Turn[]>;
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

// The working copy: what the task reads on every message, backed by the store. Memory
// first — a store that is slow or down costs durability across a restart, never the
// conversation in front of the bot — and the store's failure is the caller's to log.
export class DayLog {
  private readonly turns = new Map<string, Turn[]>();

  constructor(private readonly store: DayLogStore) {}

  // Today's rows, at boot: the reason a deploy no longer empties the bot's head.
  async load(group: string, day: number): Promise<number> {
    const rows = await this.store.read(group, day);
    const list = this.turns.get(group) ?? [];
    const known = new Set(list.map((t) => t.id));
    for (const row of rows) if (!known.has(row.id)) list.push(row);
    list.sort(byInstant);
    this.turns.set(group, list);
    return rows.length;
  }

  async append(turn: Turn): Promise<void> {
    const bounded = { ...turn, text: boundTurnText(turn.text) };
    const list = this.turns.get(turn.group) ?? [];
    if (list.some((t) => t.id === bounded.id)) return;
    list.push(bounded);
    list.sort(byInstant);
    // Two days is all anybody reads: today for the prompt, and the day the diary closes.
    const floor = bounded.day - 1;
    this.turns.set(
      turn.group,
      list.filter((t) => t.day >= floor),
    );
    await this.store.append(bounded);
  }

  // The bot's own line as WhatsApp echoes it back (main.ts). One already remembered when it
  // was composed — an answer, a spoken acknowledgement — is not remembered twice; one
  // nothing here composed (the podium, the reminder, sent from the queue) enters. Compared
  // with whitespace collapsed: the echo comes through `withoutShares`, which collapses it,
  // while the composed line was remembered as written, newlines and all.
  //
  // WITHIN THE DAY, NOT ACROSS IT (PR-278 review): two days are held in memory, and the
  // morning reminder is deterministic — so yesterday's identical line made today's echo
  // look like a duplicate, and today's log lost its reminder.
  async appendUnlessSaid(turn: Turn): Promise<void> {
    const text = collapse(boundTurnText(turn.text));
    const said = (this.turns.get(turn.group) ?? []).some(
      (t) => t.day === turn.day && t.kind === 'bot' && collapse(t.text) === text,
    );
    if (!said) await this.append(turn);
  }

  // The day's turns, the newest that fit the budget — so what falls off a pathological
  // day is the morning, never the question just asked.
  today(group: string, day: number): Turn[] {
    const all = (this.turns.get(group) ?? []).filter((t) => t.day === day);
    let room = DAY_MAX_CHARS;
    let start = all.length;
    while (start > 0 && all[start - 1].text.length <= room) {
      room -= all[start - 1].text.length;
      start -= 1;
    }
    return all.slice(start);
  }
}

function byInstant(a: Turn, b: Turn): number {
  return a.at - b.at || a.id.localeCompare(b.id);
}

export function dayLogPartition(group: string): string {
  return `DAYLOG#${group}`;
}

// The instant zero-padded to 13 digits (milliseconds hold that until the year 2286), so
// the sort key orders a day by time, and the id after it keeps two turns of one instant
// apart and the write idempotent.
export function dayLogSortKey(day: number, at: number, id: string): string {
  return `${dayPrefix(day)}${String(at).padStart(13, '0')}#${id}`;
}

function toItem(t: Turn): Record<string, AttributeValue> {
  return {
    pk: { S: dayLogPartition(t.group) },
    sk: { S: dayLogSortKey(t.day, t.at, t.id) },
    day: { N: String(t.day) },
    at: { N: String(t.at) },
    id: { S: t.id },
    kind: { S: t.kind },
    name: { S: t.name },
    text: { S: t.text },
    expiresAt: { N: String(Math.floor(t.at / 1000) + DAY_LOG_TTL_SECONDS) },
  };
}

function fromItem(group: string, item: Record<string, AttributeValue>): Turn {
  const kind = item.kind?.S;
  return {
    group,
    day: Number(item.day?.N ?? 0),
    at: Number(item.at?.N ?? 0),
    id: item.id?.S ?? '',
    kind: kind === 'bot' || kind === 'reacted' ? kind : 'said',
    name: item.name?.S ?? '',
    text: item.text?.S ?? '',
  };
}

export function dynamoDayLogStore(client: DynamoDBClient, tableName: string): DayLogStore {
  return {
    async append(turn) {
      // Idempotent by key: a turn written twice (a retried call) stands once.
      await client.send(new PutItemCommand({ TableName: tableName, Item: toItem(turn) }));
    },
    async read(group, day) {
      const rows: Turn[] = [];
      let cursor: Record<string, AttributeValue> | undefined;
      do {
        const response = await client.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :day)',
            ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
            ExpressionAttributeValues: { ':pk': { S: dayLogPartition(group) }, ':day': { S: dayPrefix(day) } },
            ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          }),
        );
        for (const item of response.Items ?? []) rows.push(fromItem(group, item));
        cursor = response.LastEvaluatedKey;
      } while (cursor);
      return rows.sort(byInstant);
    },
  };
}

export function memoryDayLogStore(): DayLogStore & { rows(): Turn[] } {
  const rows = new Map<string, Turn>();
  return {
    async append(turn) {
      rows.set(`${turn.group}#${turn.day}#${turn.id}`, { ...turn });
    },
    async read(group, day) {
      return [...rows.values()].filter((t) => t.group === group && t.day === day).sort(byInstant);
    },
    rows: () => [...rows.values()],
  };
}

// How a day reads in a prompt: one line per turn, stamped with the group's own wall-clock
// time so "this morning" means something, the bot's lines as the assistant's, and a
// reaction of the bot's in the very shape it would answer one (`REACT ❤️`, `agent.ts`), so
// the transcript teaches the form and shows what was already closed.
export function clockIn(timezone: string, atMs: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(atMs));
}

// The bot's answer form for a reaction (`agent.ts` reads it back off the model's answer).
export const REACT_PREFIX = 'REACT';

export function turnLine(turn: Turn, timezone: string, botName: string): string {
  const who = turn.kind === 'said' ? turn.name : botName;
  const what = turn.kind === 'reacted' ? `${REACT_PREFIX} ${turn.text}` : turn.text;
  return `[${clockIn(timezone, turn.at)}] ${who}: ${what}`;
}

// The day as one block of text — what the diary rewrite and the podium comments read.
export function renderDay(turns: readonly Turn[], timezone: string, botName: string): string {
  return turns.map((t) => turnLine(t, timezone, botName)).join('\n');
}
