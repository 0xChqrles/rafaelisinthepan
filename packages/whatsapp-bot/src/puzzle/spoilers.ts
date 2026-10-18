// TODAY'S SENTENCE, AS THE CODE HOLDS IT AND THE PROMPT NEVER DOES (v22, 2026-10-18). With
// the web in the bot's hands, the day's line is one search away for the BOT ITSELF: a member
// pastes the visible words and asks for the missing one, or asks for the lyrics of a song,
// and the page that comes back holds the sentence whole. The model is never given the
// sentence — it cannot hold back what it does not know, and it cannot leak what it never
// saw — so the guard is the code's: a page or a search result that holds the sentence is
// WITHHELD before the model reads it, and a reply that quotes it is dropped before the group
// does (`chat/web.ts`, `chat/agent.ts`).
//
// WHAT COUNTS AS THE SENTENCE: a run of `RUN` consecutive words of it that takes in a hidden
// word. One hidden word alone is an ordinary word ("attends", "nuit") and would silence every
// page that uses it; the visible words alone are what the player already sees. A run that
// crosses a hole is the hole's answer IN CONTEXT, which is the spoiler. Both sides are read
// the same way — split on everything that is not a letter, then folded (`fold`, the game's
// own comparison) — so an apostrophe, a curly quote, a JSON comma or a page's Markdown escape
// (`\-`, `\.`) changes nothing: « t'attends » is `t attends` on both sides.

import { fold } from '@whippin/shared';

export const RUN = 4;

export interface DaySecrets {
  // The sentence's words as letter runs, in order, and which of them belong to a hidden word.
  words: string[];
  hidden: boolean[];
}

// The text as a sequence of folded letter runs: « Peut-être, t'attends… » → peut etre t attends.
export function letterRuns(text: string): string[] {
  return text
    .split(/[^\p{L}\p{M}]+/u)
    .map((piece) => fold(piece))
    .filter((piece) => piece !== '');
}

interface PuzzleLike {
  words?: unknown;
  holes?: unknown;
}

// The guard for one puzzle, or null when the artifact does not carry a readable sentence.
// A hole's TOKEN (`words[pos]`) holds its display affixes too (« t'attends » for the secret
// « attends »); only the secret's own runs are hidden, so the elided « t » is a visible word.
export function secretsOf(puzzle: PuzzleLike | null): DaySecrets | null {
  if (!puzzle || !Array.isArray(puzzle.words) || !Array.isArray(puzzle.holes)) return null;
  const secretAt = new Map<number, Set<string>>();
  for (const hole of puzzle.holes as { pos?: unknown; secret?: { word?: unknown } }[]) {
    if (typeof hole?.pos !== 'number' || typeof hole.secret?.word !== 'string') continue;
    secretAt.set(hole.pos, new Set(letterRuns(hole.secret.word)));
  }
  const words: string[] = [];
  const hidden: boolean[] = [];
  (puzzle.words as unknown[]).forEach((token, pos) => {
    if (typeof token !== 'string') return;
    const secret = secretAt.get(pos);
    for (const run of letterRuns(token)) {
      words.push(run);
      hidden.push(secret?.has(run) ?? false);
    }
  });
  return words.length > 0 && hidden.some(Boolean) ? { words, hidden } : null;
}

// Whether `text` quotes the sentence across a hole: some RUN consecutive words of it, one of
// them hidden, appear in the text in order and back to back. A sentence shorter than RUN is
// matched whole. The text is read twice — as written, and with invisible format characters
// (a soft hyphen, a zero-width space) taken out: one inside a word splits it, one between words joins them
// once removed, and either reading quoting the sentence is enough.
export function revealsSentence(text: string, secrets: DaySecrets | null): boolean {
  if (!secrets) return false;
  const readings = [text, text.replace(/\p{Cf}/gu, '')].map((t) => ` ${letterRuns(t).join(' ')} `);
  const size = Math.min(RUN, secrets.words.length);
  for (let start = 0; start + size <= secrets.words.length; start += 1) {
    if (!secrets.hidden.slice(start, start + size).some(Boolean)) continue;
    const run = ` ${secrets.words.slice(start, start + size).join(' ')} `;
    if (readings.some((said) => said.includes(run))) return true;
  }
  return false;
}
