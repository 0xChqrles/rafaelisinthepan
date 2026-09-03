// One CURRENT declaration per (group, Whippin day, sender) — the durable row a podium is
// built from once a share has been observed (#236). The WhatsApp sender JID is the player
// key; the display name is a SNAPSHOT for presentation and never identity.
//
// PRECEDENCE, and it is the whole idempotency story: the same message delivered twice is
// a no-op (same timestamp, same id); a player sharing the same result again changes
// nothing material; a LATER message with a different valid token replaces the earlier
// declaration. "Later" is the message's WhatsApp timestamp with a stable message-id tie
// break — so a replayed history batch, arriving in any order, converges on the same row.
// It is deliberately NOT an anti-cheat contract: a token proves a result, not which person
// produced it.

export interface Declaration {
  group: string; // group JID
  dayNumber: number; // the TOKEN's day — never the receive date
  sender: string; // sender JID (canonical player key)
  score: number;
  capped: boolean;
  token: string;
  messageId: string;
  messageTs: number; // WhatsApp message timestamp, seconds
  name: string; // display-name snapshot at the time of the message
  receivedAt: string; // ISO instant the bot recorded it
  lang: string;
}

export type DeclarationKey = Pick<Declaration, 'group' | 'dayNumber' | 'sender'>;

// Does `next` replace `current`? Strictly later wins; the id breaks an exact tie so two
// devices' replays agree; anything else (older, or the very same message) leaves the row.
export function supersedes(
  current: Pick<Declaration, 'messageTs' | 'messageId'> | undefined,
  next: Pick<Declaration, 'messageTs' | 'messageId'>,
): boolean {
  if (!current) return true;
  if (next.messageTs !== current.messageTs) return next.messageTs > current.messageTs;
  return next.messageId > current.messageId;
}

export type RecordOutcome = 'recorded' | 'unchanged';

export interface PlayerSummary {
  sender: string;
  name: string; // latest observed snapshot
  lastDay: number;
}

export interface DeclarationStore {
  // Writes under the precedence rule above; `unchanged` means an equal-or-newer row stood.
  record(declaration: Declaration): Promise<RecordOutcome>;
  // A day's rows, every sender.
  day(group: string, dayNumber: number): Promise<Declaration[]>;
  // Every row of the group between two days inclusive, ascending by day then sender.
  range(group: string, fromDay: number, toDay: number): Promise<Declaration[]>;
}

// Who the group has seen play in a window: one entry per sender with their LATEST
// snapshot name. The resolution universe for the chat tools (chat/tools.ts).
export function playersIn(rows: readonly Declaration[]): PlayerSummary[] {
  const byJid = new Map<string, PlayerSummary>();
  for (const row of rows) {
    const known = byJid.get(row.sender);
    if (!known || row.dayNumber >= known.lastDay) {
      byJid.set(row.sender, { sender: row.sender, name: row.name, lastDay: row.dayNumber });
    }
  }
  return [...byJid.values()].sort((a, b) => a.sender.localeCompare(b.sender));
}

// In-memory implementation: tests and local dry runs.
export function memoryDeclarationStore(): DeclarationStore & { rows(): Declaration[] } {
  const rows = new Map<string, Declaration>();
  const key = (d: DeclarationKey) => `${d.group}#${d.dayNumber}#${d.sender}`;
  return {
    async record(declaration) {
      const current = rows.get(key(declaration));
      if (!supersedes(current, declaration)) return 'unchanged';
      rows.set(key(declaration), { ...declaration });
      return 'recorded';
    },
    async day(group, dayNumber) {
      return this.range(group, dayNumber, dayNumber);
    },
    async range(group, fromDay, toDay) {
      return [...rows.values()]
        .filter((r) => r.group === group && r.dayNumber >= fromDay && r.dayNumber <= toDay)
        .sort((a, b) => a.dayNumber - b.dayNumber || a.sender.localeCompare(b.sender));
    },
    rows: () => [...rows.values()],
  };
}
