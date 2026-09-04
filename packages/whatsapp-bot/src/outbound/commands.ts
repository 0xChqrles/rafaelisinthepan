// Outbound WhatsApp has ONE owner (#236): the connected task and the socket it holds.
// Everything that wants to say something — a podium job in a Lambda, the ingestion
// pipeline in the task itself — writes a COMMAND to the outbound queue, and the task's
// dispatcher sends it. The command id is the dedup key an ordinary retry or replay is
// caught by; the crash window between a successful send and its durable acknowledgement
// is accepted as the rare duplicate it is, in preference to marking before sending and
// silently losing a podium.

export interface MessageRef {
  id: string; // WhatsApp message id
  // Its author's JID AS THE MESSAGE KEY NAMES IT (`InboundMessage.participant`) — the LID
  // in a LID-addressed group — never the canonical player key: a reaction or a quote
  // addresses the original key, and a rewritten one addresses nothing.
  participant: string;
  fromMe?: boolean;
  // What the quoted message said (a reply only): the quote bubble is drawn from it.
  text?: string;
}

export type OutboundCommand =
  | {
      id: string;
      kind: 'message';
      group: string;
      text: string;
      replyTo?: MessageRef;
      mentions?: string[];
    }
  | { id: string; kind: 'reaction'; group: string; target: MessageRef; emoji: string };

// The id conventions — one place, so two producers can never collide by accident.
export const commandIds = {
  podium: (group: string, dayNumber: number) => `podium:${group}:${dayNumber}`,
  reaction: (group: string, messageId: string) => `react:${group}:${messageId}`,
  reply: (group: string, messageId: string) => `reply:${group}:${messageId}`,
  // The spoken acknowledgement of a share. Its own prefix, not `reply:`: the same message
  // can be both a share and a question addressed to the bot, and two commands keyed alike
  // would have the dispatcher's sent-record swallow the second as a duplicate.
  ack: (group: string, messageId: string) => `ack:${group}:${messageId}`,
  leader: (group: string, dayNumber: number, sender: string, score: number) =>
    `leader:${group}:${dayNumber}:${sender}:${score}`,
};

export interface OutboundQueue {
  enqueue(command: OutboundCommand): Promise<void>;
}

const KINDS = new Set(['message', 'reaction']);

// BOTH fields, always. The transport builds a WhatsApp message key from the id AND the
// author, so a ref missing either one addresses nothing: the send throws, the consumer
// reads that as the transient failure it looks like, and the command retries its way to
// the dead-letter queue and its alarm — where what it actually was is a malformed body
// this function is here to drop.
function isMessageRef(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const ref = value as Record<string, unknown>;
  const filled = (field: unknown) => typeof field === 'string' && field !== '';
  return (
    filled(ref.id) &&
    filled(ref.participant) &&
    (ref.text === undefined || typeof ref.text === 'string')
  );
}

// What the consumer accepts off the wire. A body that is not a command is dropped, not
// retried: the queue is the bot's own, so a malformed body is a bug, never transient.
export function parseCommand(body: string): OutboundCommand | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== 'string' || typeof c.group !== 'string' || !KINDS.has(c.kind as string)) {
    return null;
  }
  if (c.kind === 'message') {
    if (typeof c.text !== 'string' || c.text === '') return null;
    if (c.replyTo !== undefined && !isMessageRef(c.replyTo)) return null;
    if (
      c.mentions !== undefined &&
      (!Array.isArray(c.mentions) || c.mentions.some((m) => typeof m !== 'string'))
    ) {
      return null;
    }
    return c as unknown as OutboundCommand;
  }
  if (typeof c.emoji !== 'string' || c.emoji === '' || !isMessageRef(c.target)) return null;
  return c as unknown as OutboundCommand;
}
