// THE LIBRARY NEVER GETS A LOGGER THAT CAN PRINT A PAYLOAD (#236).
//
// The bot's own call sites obey the privacy rule — hashed JIDs, no message bodies — but
// Baileys' call sites are Baileys'. On its ordinary warning and error paths the pinned
// release logs `{ jid, err }`, `{ participant, retryCount }`, `{ msgId, from }`,
// `{ attrs }` and `{ node: binaryNodeToString(node) }`: raw phone numbers, and whole
// protocol nodes. Handed a plain pino instance it writes all of that into CloudWatch,
// which is precisely what `tag()` exists to prevent, and nothing in this package's own
// discipline can reach it.
//
// So the adapter keeps the three things a transport failure is actually diagnosed from —
// the level, the library's own message, and the error text — and reduces the payload to
// its FIELD NAMES, which are code-authored and say where to go and look. The rest is
// DROPPED rather than filtered: a redaction that has to recognise a value is one
// unrecognised shape away from being no redaction at all, and Baileys' payloads are
// protobufs, binary nodes and app-state blobs whose shapes are its business, not ours.
// What survives still passes through `redactJids`, because a library error message names
// the JID it failed on ("no session for …").

import type { Log } from '../log';
import { redactJids } from '../log';

// Baileys' `ILogger`, structurally — depending on the library's type here would import
// Baileys into a module the boundary rule keeps free of it.
export interface BaileysLogger {
  level: string;
  child(bindings: Record<string, unknown>): BaileysLogger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const ERROR_MAX_CHARS = 200;
const FIELDS_MAX = 12;
// Where Baileys puts the thing that went wrong. Everything else in a payload is protocol
// material; these are the ones worth carrying, and only ever as text.
const ERROR_KEYS = ['err', 'error', 'ackErr', 'e', 'reason', 'trace'];

// A string, and nothing that had to be reconstructed from an object graph.
function errorText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const message = (value as { message?: unknown }).message;
  if (typeof message === 'string') {
    const name = (value as { name?: unknown }).name;
    return typeof name === 'string' && name !== '' ? `${name}: ${message}` : message;
  }
  return undefined;
}

function clean(text: string): string {
  return redactJids(text.replace(/\s+/g, ' ').trim()).slice(0, ERROR_MAX_CHARS);
}

// What one Baileys call becomes: its message, the names of the fields it carried, and the
// error text if it carried one. Never a value.
//
// WHICH ARGUMENT IS THE MESSAGE is pino's rule, not the caller's intent: a string FIRST
// argument is the message, and everything after it is payload (pino would printf-interpolate
// it). The pinned release calls `logger.info('offline preview received', JSON.stringify(node))`
// — a whole protocol node in the SECOND position — so reading the second string as the
// message printed exactly what this adapter exists to keep out. A string payload has no
// field names to keep, so it is dropped outright.
export function summarize(
  obj: unknown,
  msg: string | undefined,
): { msg: string; fields?: string[]; error?: string } {
  if (typeof obj === 'string') return { msg: clean(obj) };
  const payload = typeof obj === 'object' && obj !== null ? (obj as Record<string, unknown>) : null;
  const out: { msg: string; fields?: string[]; error?: string } = { msg: clean(msg ?? '') };
  if (!payload) return out;
  const keys = Object.keys(payload);
  if (keys.length > 0) out.fields = keys.slice(0, FIELDS_MAX);
  // The payload may BE the error (`logger.error(err, '…')`), or carry one under a known key.
  const own = errorText(payload);
  if (own !== undefined && own !== '') {
    out.error = clean(own);
    return out;
  }
  for (const key of ERROR_KEYS) {
    const found = errorText(payload[key]);
    if (found !== undefined && found !== '') {
      out.error = clean(found);
      break;
    }
  }
  return out;
}

// `child()` bindings get the same treatment: they are the library's own scope labels, but
// nothing guarantees a value in them is not a JID, so only their NAMES travel.
export function baileysLogger(log: Log, level: string, scope: string[] = []): BaileysLogger {
  const sink = log.child({ event: 'baileys' }, { level });
  const write = (method: Level, obj: unknown, msg?: string) => {
    const { msg: text, ...rest } = summarize(obj, msg);
    sink[method]({ ...rest, ...(scope.length > 0 ? { scope } : {}) }, text);
  };
  return {
    level,
    child: (bindings) =>
      baileysLogger(log, level, [...scope, ...Object.keys(bindings ?? {})].slice(0, FIELDS_MAX)),
    trace: (obj, msg) => write('trace', obj, msg),
    debug: (obj, msg) => write('debug', obj, msg),
    info: (obj, msg) => write('info', obj, msg),
    warn: (obj, msg) => write('warn', obj, msg),
    error: (obj, msg) => write('error', obj, msg),
  };
}
