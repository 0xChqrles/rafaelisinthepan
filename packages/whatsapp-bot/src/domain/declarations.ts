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
//
// THE ROW FOLLOWS THE LATEST MESSAGE; THE OUTCOME SAYS WHETHER THE DECLARATION CHANGED.
// A same-token re-share still moves the row's message bookkeeping (id, timestamp, name
// snapshot) — it has to, or replays stop converging: with A(X) then C(Y) then B(X, latest)
// arriving as A, B, C, a store that ignored B would let C's Y stand over the player's
// actual latest statement. But it is `unchanged`: nothing material moved, so nothing
// reacts to it and no lead is claimed for it. `recorded` means the TOKEN standing for
// that (group, day, sender) is not the one that stood before.
//
// A WRITE WHOSE ANSWER WAS LOST IS RE-SENT, AND THE RE-SEND MUST NOT READ AS THE
// DUPLICATE. The precedence rule is strictly monotonic, so the same message sent twice is
// refused the second time — right for a second DELIVERY, wrong for the retry of a write
// that committed and then lost its response: refused, that retry answered `unchanged`,
// the share was on the podium and nobody was thanked for it, and the leader row went
// stale. `receivedAt` is what tells the two apart: it is stamped once per ingest call, so
// a standing row carrying THIS message id under THIS instant was written by an earlier
// attempt of the very same call, and the call answers `recorded` for it. What that attempt
// displaced is unknowable by then; erring towards `recorded` costs at most an emoji for a
// same-token re-share and a leader claim that is idempotent anyway, where erring the
// other way loses an acknowledgement for good.

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

// The standing row is this very write, landed by an earlier attempt of the same ingest
// call (the header says why that is `recorded`, not the duplicate it looks like).
export function ownEarlierAttempt(
  standing: Pick<Declaration, 'messageId' | 'receivedAt'> | undefined,
  next: Pick<Declaration, 'messageId' | 'receivedAt'>,
): boolean {
  return (
    standing !== undefined &&
    standing.messageId === next.messageId &&
    standing.receivedAt === next.receivedAt
  );
}

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
  // Writes under the precedence rule above. `unchanged` means an equal-or-newer row stood,
  // OR that the row moved to this message without its token changing. A refusal by the
  // caller's OWN earlier attempt (`ownEarlierAttempt`) is `recorded`.
  record(declaration: Declaration): Promise<RecordOutcome>;
  // A day's rows, every sender.
  day(group: string, dayNumber: number): Promise<Declaration[]>;
  // Every row of the group between two days inclusive, ascending by day then sender.
  range(group: string, fromDay: number, toDay: number): Promise<Declaration[]>;
}

// A read filter for the group's OWN language. Ingestion writes only rows whose share
// language matches the group's, so this earns its keep in exactly one case — a group whose
// configured `language` CHANGES — where the rows written under the old one would otherwise
// be ranked beside the new ones, on a board whose numbers then answer two different
// puzzles. Every read of the store goes through it; a filter that lives only on the write
// side is one config edit away from being no filter at all.
export function inLanguage(rows: readonly Declaration[], lang: string): Declaration[] {
  return rows.filter((row) => row.lang === lang);
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
      if (!supersedes(current, declaration)) {
        return ownEarlierAttempt(current, declaration) ? 'recorded' : 'unchanged';
      }
      rows.set(key(declaration), { ...declaration });
      return current?.token === declaration.token ? 'unchanged' : 'recorded';
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
