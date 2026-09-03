// RECENT CONTEXT (#236): a small in-memory window of the exchanges the bot took part in,
// per group, so a reply understands what was just said to it. Losing it on a task restart
// is harmless, and it holds only addressed messages and the bot's own answers — never the
// group's ordinary chatter.

export interface ContextTurn {
  role: 'user' | 'assistant';
  name: string; // the speaker's display name ('' for the bot)
  text: string;
  at: number; // ms
}

const WINDOW = 8;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

export class RecentContext {
  private readonly turns = new Map<string, ContextTurn[]>();

  push(group: string, turn: ContextTurn): void {
    const list = this.turns.get(group) ?? [];
    list.push(turn);
    while (list.length > WINDOW) list.shift();
    this.turns.set(group, list);
  }

  recent(group: string, now = Date.now()): ContextTurn[] {
    return (this.turns.get(group) ?? []).filter((t) => now - t.at <= MAX_AGE_MS);
  }
}
