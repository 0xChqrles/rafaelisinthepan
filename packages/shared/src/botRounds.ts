// THE BOT'S READ OF A WHIPPIN GROUP'S ROUNDS (user-decided 2026-10-30): the one contract
// between the backend's `BotRoundsFn` and the WhatsApp bot, which invokes it over IAM —
// no route, no CDN, nothing reachable from the internet.
//
// It answers, for ONE Whippin group (the one a bot config names as `whippinGroup`) and one
// daily, every member's round as it stands: started or not, tries, %, solved, ended unsolved
// — and the guesses that never came closer than their hole's START word. Joining that group
// is the consent; a non-member is never read.
//
// THE SPOILER RULE IS THE SERVER'S: a guess ranked at or closer than ANY hole's `start_rank`
// moved that hole (or solved it — rank 0 is the secret), so it never leaves the backend, on
// any day. What does leave is what reveals nothing beyond the start words every player
// already sees: farther-than-start words, and words the day's maps do not rank at all.

// The fixed name the backend stack gives the function and the bot stack grants invoke on,
// so neither stack exports anything to the other.
export const BOT_ROUNDS_FUNCTION_NAME = 'whippin-bot-rounds';

export interface BotRoundsRequest {
  // The Whippin group id (`GROUP_ID_PATTERN`).
  group: string;
  lang: string;
  // The daily's `YYYY-MM-DD`; never a bonus, never a day after the server's active one.
  date: string;
}

// One far guess. `try` is its 1-based position among the round's UNIQUE tries (the
// `countTries` dedup), so "your 4th try" means what the player saw. NO RANK (user-decided
// 2026-10-31): how far a word landed is not the joke, the word is — the server ranks only to
// filter and to order.
export interface BotGuess {
  try: number;
  // The accented display form of its closest group when a map ranks it; for a word no map
  // ranks (a MISS), the folded form the log stores — accents are gone, the word is right.
  word: string;
}

export interface BotMemberRound {
  publicId: string;
  // The member's Whippin display name (their profile, else the assigned pseudonym).
  name: string;
  // False: no guess recorded for the current revision (every other field is then zero/false).
  started: boolean;
  tries: number;
  // The stored derived percentage (#203), 0–100.
  progress: number;
  solved: boolean;
  gaveUp: boolean;
  // ENDED UNSOLVED — given up or capped (the shared `roundEnded`).
  over: boolean;
  // Every far guess of the log, deduped like the score, ODDEST FIRST: the misses (a word the
  // day does not rank at all), then the farthest ranks, ties by the earlier try — so a
  // reader keeping the first few keeps the oddest.
  farGuesses: BotGuess[];
}

export type BotRoundsResponse =
  | {
      ok: true;
      group: { id: string; name: string };
      // The published revision the rounds were read against; null when the day has no puzzle
      // (every member then answers `started: false`).
      revision: string | null;
      members: BotMemberRound[];
    }
  | { ok: false; error: 'bad_request' | 'unknown_group' };
