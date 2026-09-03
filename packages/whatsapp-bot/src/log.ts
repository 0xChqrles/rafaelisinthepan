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
