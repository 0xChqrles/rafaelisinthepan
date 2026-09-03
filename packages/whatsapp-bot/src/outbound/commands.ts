// Outbound WhatsApp has ONE owner (#236): the connected task and the socket it holds.
// Everything that wants to say something — a podium job in a Lambda, the ingestion
// pipeline in the task itself — writes a COMMAND to the outbound queue, and the task's
// dispatcher sends it. The command id is the dedup key an ordinary retry or replay is
// caught by; the crash window between a successful send and its durable acknowledgement
// is accepted as the rare duplicate it is, in preference to marking before sending and
// silently losing a podium.

export interface MessageRef {
  id: string; // WhatsApp message id
  participant: string; // its author's JID (what a reaction / quote needs in a group)
  fromMe?: boolean;
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
  leader: (group: string, dayNumber: number, sender: string, score: number) =>
    `leader:${group}:${dayNumber}:${sender}:${score}`,
};

export interface OutboundQueue {
  enqueue(command: OutboundCommand): Promise<void>;
}

const KINDS = new Set(['message', 'reaction']);

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
    return c as unknown as OutboundCommand;
  }
  const target = c.target as Record<string, unknown> | undefined;
  if (typeof c.emoji !== 'string' || !target || typeof target.id !== 'string') return null;
  return c as unknown as OutboundCommand;
}
