// The bot joins a PRIVATE conversation, and CloudWatch must not quietly become its
// transcript (#236). What a log line may carry: the event kind, a HASHED sender/group tag,
// a message id, a decoded day/score, provider latency and errors. Never a human's message
// body, never a raw phone number. `tag()` is the one spelling of that hashing.

import { createHash } from 'node:crypto';
import pino, { type Logger } from 'pino';

export type Log = Logger;

export function createLog(level = process.env.BOT_LOG_LEVEL ?? 'info'): Log {
  return pino({ level, base: undefined });
}

// A short, stable, non-reversible handle for a JID — enough to correlate lines about one
// participant across a day of logs, useless for identifying them.
export function tag(jid: string | undefined | null): string {
  if (!jid) return '-';
  return createHash('sha256').update(jid).digest('hex').slice(0, 10);
}

// A device suffix (`:12@s.whatsapp.net`) is taken WITH the number, so a JID that reached a
// log unnormalized is tagged whole rather than half. It is bounded to three digits on
// purpose: the ids this runs over are themselves colon-separated, so an unbounded suffix
// reads `…:<day>:<sender>@…` as one long JID and swallows the day with it — a device id is
// two digits and a sender is eleven, and the bound is what keeps them apart.
const JID = /\d{5,}(?::\d{1,3})?@(?:g\.us|s\.whatsapp\.net|lid)/g;

// Some strings the bot logs CONTAIN a JID rather than being one: a command id is
// `podium:<group>:<day>` or `leader:<group>:<day>:<sender>:<score>`, so logging it whole
// would put in clear exactly the identifiers `tag()` exists to keep out — a phone number
// among them. This tags every JID inside the string instead, which keeps the id readable
// and correlatable without carrying anyone's number into CloudWatch.
export function redactJids(text: string): string {
  return text.replace(JID, (jid) => tag(jid));
}
