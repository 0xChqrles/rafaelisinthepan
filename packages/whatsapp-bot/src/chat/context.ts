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
// BOUNDED IN TEXT AS WELL AS IN MESSAGES. Twenty-five is a count for chatter; a pasted
// article is ONE message, and a few of them make a prompt the provider refuses or bills
// for — and either way the next question goes unanswered. So a turn is cut to
// `TURN_MAX_CHARS` on the way in (its head kept: a wall of text says what it is about
// first), and what the window hands out is the NEWEST turns that fit `WINDOW_MAX_CHARS` —
// the newest, because a question is about what was just said.
export const TURN_MAX_CHARS = 500;
export const WINDOW_MAX_CHARS = 4000;

export function boundTurnText(text: string): string {
  return text.length > TURN_MAX_CHARS ? `${text.slice(0, TURN_MAX_CHARS - 1).trimEnd()}…` : text;
}

export class RecentContext {
  private readonly turns = new Map<string, ContextTurn[]>();

  push(group: string, turn: ContextTurn): void {
    const list = this.turns.get(group) ?? [];
    list.push({ ...turn, text: boundTurnText(turn.text) });
    while (list.length > WINDOW) list.shift();
    this.turns.set(group, list);
  }

  recent(group: string, now = Date.now()): ContextTurn[] {
    const fresh = (this.turns.get(group) ?? []).filter((t) => now - t.at <= MAX_AGE_MS);
    // Newest first into the budget, so what falls off is the oldest.
    let room = WINDOW_MAX_CHARS;
    let start = fresh.length;
    while (start > 0 && fresh[start - 1].text.length <= room) {
      room -= fresh[start - 1].text.length;
      start -= 1;
    }
    return fresh.slice(start);
  }
}
