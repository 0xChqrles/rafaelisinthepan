// READING A WHATSAPP EXPORT (#277). Two operator paths start from one: the eval fixture
// (`fixture.ts`) and the diary seed (`diarySeed.ts`), so the export is parsed ONCE, here.
//
// The format is the one the operator's exporter writes: a day header, then one message per
// `[10:31 PM] **Author:** text`, a reply as a `> _Author: text_` block above its own words,
// system lines wrapped in `__…__`, and bodies that run over several lines.
//
// AN EXPORT NAMES REAL PEOPLE, AND HALF OF THEM BY PHONE NUMBER. A contact the exporter has
// no name for comes out as "+33 6 80 73 45 88", so nothing here may put an author into a
// turn unread: `speakerName` sends every one through the same `displayName` the live bot
// uses — the group's own override, or the `…last4` handle every other surface shows.

import type { GroupConfig } from './config/groupConfig';
import { boundName, displayName } from './domain/names';

export interface ExportMessage {
  day: string; // the day header, verbatim ("September 5, 2026")
  time: string; // "10:31 PM"
  author: string; // as the export spells it: a name, or a phone number
  quoted: { author: string; text: string } | null;
  text: string;
}

const HEADER = /^\[(\d{1,2}:\d{2}(?: [AP]M)?)\] \*\*(.+?):\*\*\s?(.*)$/;
const DAY_HEADER = /^## (.+)$/;
// WHERE A BODY STOPS. Anything the export stamps with a time is a new entry — the next
// message, or a system line ("[3:56 PM] __X a ajouté Y__", which is stamped exactly like a
// message and was swallowed into the body above it).
const STAMPED = /^\[\d{1,2}:\d{2}(?: [AP]M)?\] /;
const QUOTE = /^> _(.+?):\s([\s\S]*?)_\s*\n?([\s\S]*)$/;

export function parseExport(text: string): ExportMessage[] {
  const lines = text.split('\n');
  const messages: ExportMessage[] = [];
  let day = '';
  for (let i = 0; i < lines.length; i += 1) {
    const d = DAY_HEADER.exec(lines[i]);
    if (d) {
      day = d[1];
      continue;
    }
    const h = HEADER.exec(lines[i]);
    if (!h) continue;
    const body = [h[3]];
    let j = i + 1;
    // A body runs until the next message, the next day, or a system line ("__X a ajouté Y__").
    while (j < lines.length && !STAMPED.test(lines[j]) && !DAY_HEADER.test(lines[j]) && lines[j].trim() !== '---' && !lines[j].startsWith('__')) {
      body.push(lines[j]);
      j += 1;
    }
    const raw = body.join('\n').trim();
    const q = QUOTE.exec(raw);
    messages.push({
      day,
      time: h[1],
      author: h[2],
      quoted: q ? { author: q[1].trim(), text: q[2].trim() } : null,
      text: (q ? q[3] : raw).trim(),
    });
    i = j - 1;
  }
  return messages;
}

// The JID behind an author the export spells as a phone number ("+33 6 80 73 45 88"), so
// the group's own `names` override can be looked up. A named author has none.
export function jidOfAuthor(author: string): string | null {
  const trimmed = author.trim();
  if (!trimmed.startsWith('+')) return null;
  const digits = trimmed.replace(/\D/g, '');
  return digits.length >= 8 ? `${digits}@s.whatsapp.net` : null;
}

export interface SpeakerNames {
  group: GroupConfig;
  me: string; // what the exporter calls themselves ("Vous") is this person
  bot: string; // the export's name for the bot, when it is a plain name
}

// What the group calls whoever wrote a message — the ONE reading the live bot uses for a
// name it stores (`displayName`), so a seeded turn and a live one name people the same way.
export function speakerName(author: string, names: SpeakerNames): string {
  const trimmed = author.trim();
  if (trimmed === 'Vous') return names.me;
  const jid = jidOfAuthor(trimmed);
  if (jid) return displayName(names.group, jid, '');
  return boundName(trimmed.replace(/^~/, ''));
}

// THE INSTANT BEHIND A WALL-CLOCK TIME. The export prints the group's own local time and a
// turn is stored as an instant, so the zone has to be applied — and applied at the RIGHT
// instant, since two of these months sit either side of a DST change. One correction pass
// settles it: guess, read the zone's offset there, correct, read it again.
export function zoneOffsetMs(timezone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const at_ = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // `hour12: false` renders midnight as 24 in some engines; both readings mean the same day.
  const hour = at_('hour') % 24;
  return Date.UTC(at_('year'), at_('month') - 1, at_('day'), hour, at_('minute'), at_('second')) - at;
}

export function instantIn(timezone: string, y: number, month: number, d: number, hour: number, minute: number): number {
  const wall = Date.UTC(y, month - 1, d, hour, minute);
  const first = wall - zoneOffsetMs(timezone, wall);
  return wall - zoneOffsetMs(timezone, first);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "September 5, 2026" + "10:31 PM" in the group's zone → ms. Null when either is unreadable
// (the caller drops the message rather than filing it under a day it invented).
export function messageInstant(day: string, time: string, timezone: string): number | null {
  const d = /^(\w+)\s+(\d{1,2}),\s*(\d{4})$/.exec(day.trim());
  const t = /^(\d{1,2}):(\d{2})(?:\s*([AP])M)?$/i.exec(time.trim());
  if (!d || !t) return null;
  const month = MONTHS.findIndex((m) => m.toLowerCase() === d[1].toLowerCase()) + 1;
  if (month === 0) return null;
  let hour = Number(t[1]);
  if (t[3]) {
    const pm = t[3].toUpperCase() === 'P';
    hour = (hour % 12) + (pm ? 12 : 0);
  }
  return instantIn(timezone, Number(d[3]), month, Number(d[2]), hour, Number(t[2]));
}
