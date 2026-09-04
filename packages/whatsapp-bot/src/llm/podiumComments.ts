// Podium comments (#236): the model receives IMMUTABLE structured lines and hands back
// prose keyed to them — never a position, a name, a score or an ordering. When it is
// unavailable or persistently unusable, the podium goes out with no comments. Losing the
// comedian never loses the scoreboard.
//
// ONE CALL PER LINE, NOT ONE CALL FOR THE PODIUM (user-decided 2026-09-04). It used to ask
// for every comment at once as strict JSON, and against `deepseek-v4-flash` that produced
// NOTHING: measured on a real 5-line podium, the model spent the entire budget reasoning
// and returned an empty string on both attempts (`finish=length`, `out=460` of 460). Raising
// the budget did not rescue it either — 0/2 at 1000, 1/2 at 2000, 0/2 at 4000 — because the
// cost is the task, not the ceiling: five comments and a JSON envelope in one breath is a
// great deal of thinking before the first character is written.
//
// So it borrows the shape that demonstrably works (`shareComment.ts`): one short line, no
// JSON, a generous budget, a truncation refusal. Three consequences, all improvements —
// A LINE THAT FAILS NO LONGER TAKES THE OTHERS WITH IT (the renderer already prints a
// podium line with no comment, so a partial set is a partial podium and not a bare one);
// the calls run in PARALLEL, because the podium Lambda has 90 seconds and five sequential
// retries would not fit; and each comment is composed knowing only its own line, which is
// what it was asked to talk about anyway.

import type { GroupConfig } from '../config/groupConfig';
import type { Podium } from '../domain/podium';
import { scoreBand } from '../domain/reactions';
import { lineId, type Comments } from '../domain/podiumText';
import type { Log } from '../log';
import { buildSystemPrompt } from './personality';
import { LlmUnavailable, type LlmProvider } from './types';

export const COMMENT_MAX_CHARS = 140;
const ATTEMPTS = 2;

// Plain text only: no line breaks, no markdown emphasis marks (the renderer italicises the
// line itself), no control characters, collapsed whitespace, quotes the model wrapped it in
// removed. Null when nothing usable is left or it is too long.
export function sanitizeComment(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^["'«“].*["'»”]$/.test(text)) text = text.slice(1, -1).trim();
  if (text === '' || text.length > COMMENT_MAX_CHARS) return null;
  return text;
}

export interface PodiumCommentLine {
  id: string;
  position: number;
  score: number;
  names: string[];
}

export function podiumCommentLines(podium: Podium): PodiumCommentLine[] {
  return podium.lines.map((line) => ({
    id: lineId(line),
    position: line.position,
    score: line.score,
    names: line.players.map((p) => p.name),
  }));
}

// Tight on purpose: a longer prompt makes this model deliberate longer, and it pays for
// that thinking out of the same budget the answer needs (`shareComment.ts` measures it).
//
// IT CARRIES THE VERDICT, for the reason the share line does: told only "10", the model
// cannot know whether that is good, and it fills the gap with something that sounds like a
// comment — "le chronomètre a souffert", about a game that times nothing. The band comes
// from the same `scoreBand` the emoji uses, and the number is NAMED as tries so the model
// has no room to imagine a clock.
const TASK = `Task: one short line about ONE podium position below. The line only — plain text, no markdown, no quotes around it, under ${COMMENT_MAX_CHARS} characters and often far less. Do not restate the placing, the number of tries or the names: they are printed directly above your line.

"tries" is how many guesses it took — fewer is better, three is the floor, and nothing in this game is timed. How good it was is already decided for you: react to the verdict, never re-judge it. perfect = the best there is, nobody beats it · brilliant = genuinely good · strong = solid · ordinary = a fine day's work · laboured = they stayed with a hard one and got there. Encouraging at every rung, and warmest at the bottom. "place" is where that lands them today, which is a separate thing: a modest score can still win a modest day.

The other lines are written separately and cannot see yours, so do not reach for a consolation that would fit any bad score ("aller au bout", "rester jusqu'au bout", "c'est déjà ça"). React to what this one did — briefly, the way a friend types it, never explaining what it implies.

Register, never reuse these words: "bon, c'est propre." / "belle journée." / "bien joué d'avoir tenu."`;

const MAX_TOKENS = 4000;
// Two attempts at this must fit the podium Lambda's 90s with room for its reads, and the
// lines run in parallel, so the ceiling here is per LINE and not per podium.
const TIMEOUT_MS = 20_000;

async function commentForLine(
  provider: LlmProvider,
  system: string,
  line: PodiumCommentLine,
  outOf: number,
  log: Log,
): Promise<string | null> {
  // Neutral field names: the model writes with whatever vocabulary is in front of it, and
  // these are words it may borrow (`shareComment.ts` learned this as "le band a gagné").
  const content = JSON.stringify({
    place: line.position,
    tries: line.score,
    who: line.names,
    outOf,
    verdict: scoreBand(line.score, false), // a podium line is always a finished run
  });
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let text: string | null;
    let finish: string | undefined;
    try {
      const response = await provider.generate({
        system,
        messages: [{ role: 'user', content }],
        maxTokens: MAX_TOKENS,
        temperature: 1.1,
        timeoutMs: TIMEOUT_MS,
      });
      text = response.text;
      finish = response.finish;
    } catch (error) {
      const unavailable = error instanceof LlmUnavailable;
      log.warn(
        { event: 'podium.comment_failed', id: line.id, attempt, unavailable, error: (error as Error).message },
        'no comment for this line',
      );
      if (!unavailable) return null;
      continue;
    }
    // A cut-off answer is a FRAGMENT, and a short fragment passes every length check.
    if (finish === 'length') {
      log.warn({ event: 'podium.comment_truncated', id: line.id, attempt }, 'the line ran out of budget');
      continue;
    }
    const comment = sanitizeComment(text);
    if (comment) return comment;
    log.warn({ event: 'podium.comment_invalid', id: line.id, attempt, finish }, 'rejecting an unusable line');
  }
  return null;
}

export async function generatePodiumComments(
  provider: LlmProvider,
  group: GroupConfig,
  podium: Podium,
  log: Log,
): Promise<Comments> {
  const lines = podiumCommentLines(podium);
  if (lines.length === 0) return new Map();
  const system = buildSystemPrompt({
    language: group.language,
    groupPrePrompt: group.chat.prePrompt,
    extra: TASK,
  });
  // PARALLEL, and every line settles on its own: one that cannot be written leaves its
  // podium line bare rather than emptying the rest.
  const written = await Promise.all(
    lines.map(async (line) => [line.id, await commentForLine(provider, system, line, lines.length, log)] as const),
  );
  const comments = new Map<string, string>();
  for (const [id, comment] of written) if (comment) comments.set(id, comment);
  log.info(
    { event: 'podium.comments_generated', lines: lines.length, written: comments.size },
    'podium comments',
  );
  return comments;
}
