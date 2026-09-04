// RECENT CONTEXT (#236): a small in-memory window of what the group has just been saying,
// per group, so a reply understands the conversation it lands in. Losing it on a task
// restart is harmless.
//
// IT HOLDS ORDINARY CHATTER NOW (user-decided 2026-09-04). It used to hold only addressed
// messages and the bot's own answers, and the consequence was that the bot could not answer
// about anything it had not been told directly: "I'm thinking of 67" then "@bot what number
// am I thinking of?" was unanswerable, because the first message was never prompt material.
// The window is what reaches the provider whenever somebody addresses the bot, which is the
// cost of that and was accepted deliberately. What still never travels: a share TOKEN
// (stripped, see `withoutShareLinks`), and anything at all in a group where nobody speaks
// to the bot, since the window is only ever SENT on an addressed message.
//
// Sized for ambient traffic rather than for exchanges: eight ADDRESSED turns spanned hours,
// where eight messages of a lively group can be under a minute.

export interface ContextTurn {
  role: 'user' | 'assistant';
  name: string; // the speaker's display name ('' for the bot)
  text: string;
  at: number; // ms
}

const WINDOW = 25;
const MAX_AGE_MS = 30 * 60 * 1000;

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
