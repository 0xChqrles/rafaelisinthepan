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

import { fold } from '@whippin/shared';
import type { GroupConfig } from '../config/groupConfig';
import type { Podium } from '../domain/podium';
import { scoreBand } from '../domain/reactions';
import { lineId, type Comments } from '../domain/podiumText';
import type { Log } from '../log';
import { buildSystemPrompt } from './personality';
import { LlmUnavailable, type LlmProvider } from './types';

export const COMMENT_MAX_CHARS = 140;
const ATTEMPTS = 3;

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

// A LINE THAT SPELLS A NUMBER, NAMES SOMEBODY OR LEANS ON A SIMILE IS REFUSED (v8, 2026-09-06). The podium
// prints the tries, the placing and the names directly above the comment, and the share
// carries the score; a line that repeats one of them is padding. Asked, the model complied
// about half the time once its thinking was turned off (see `effort` below), so the rule is
// checked here and a violation costs a retry, the way shortness is enforced. Any digit
// counts, and any number word from three up in either language — "un/une/deux" stay
// allowed, since they are articles and "vous deux" (and no sentence score is under three).
const NUMBER_WORDS = new Set(
  'trois quatre cinq six sept huit neuf dix onze douze treize quatorze quinze seize vingt trente quarante cinquante soixante cent cents mille three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand'.split(
    ' ',
  ),
);

export function spellsANumber(text: string): boolean {
  if (/\d/.test(text)) return true;
  return text.split(/[^\p{L}\p{M}]+/u).some((w) => NUMBER_WORDS.has(fold(w)));
}

// A NAME ANYWHERE, not only first: allowed mid-line, the name became a tic ("Tu es un
// tracteur, Quentin") on most lines. The podium prints it above and the share quotes it.
export function namesSomebody(text: string, names: readonly string[]): boolean {
  const words = new Set(text.split(/[^\p{L}\p{M}]+/u).map(fold).filter((w) => w !== ''));
  return names.some((n) => n.split(/\s+/).some((part) => fold(part) !== '' && words.has(fold(part))));
}

// A SIMILE IS REFUSED (user-decided 2026-09-06: "instead of metaphors", then "the
// comparisons are still lame"). The joke is the bot's logic and feelings, never a picture,
// and asked not to, the model still reached for "comme un chat dans un carton" on a line
// in four. French "comme", English "like a" / "as if".
export function readsLikeASimile(text: string): boolean {
  return /\bcomme\b/iu.test(text) || /\blike an?\b|\bas if\b/iu.test(text);
}

// The rules a line is checked against, restated in the USER turn beside the facts: with
// thinking off, the model weighs what sits next to the question more than a system prompt
// read once, and the check below is what makes a lapse cost a retry rather than a post.
export const LINE_RULES = 'No digits and no number words. No name. No comparison, no image.';

// WHICH OF THE PERSONALITY'S THREE MOVES THIS LINE MAKES. Asked to rotate them, the
// model cannot: every line is its own call with no memory of the others, so left alone
// it reaches for the label every time. The caller decides — a podium walks the three from
// a day-dependent start, a share draws one — and the rule line names it.
export type Move = 1 | 2 | 3;
export function lineRules(move: Move): string {
  return `${LINE_RULES} Move ${move}.`;
}
// The label (move 3) is the weakest of the three when it lands flat, so it gets one line
// in five rather than one in three: a podium walks this cycle from a day-dependent start,
// a share draws a position in it.
export const MOVE_CYCLE: readonly Move[] = [1, 2, 1, 2, 3];
export function drawMove(): Move {
  return MOVE_CYCLE[Math.floor(Math.random() * MOVE_CYCLE.length)];
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

// IT CARRIES THE VERDICT, for the reason the share line does: told only "10", the model
// cannot know whether that is good, and it fills the gap with something that sounds like a
// comment — "le chronomètre a souffert", about a game that times nothing. The band comes
// from the same `scoreBand` the emoji uses, and the prompt says outright that the game is
// not timed so the model has no room to imagine a clock. The hard rules come FIRST: with
// its thinking off (see `effort` below) the model weighs the opening of a prompt most.
const TASK = `Task: one short line about ONE podium position below. The line only — plain text, no markdown, no quotes around it, under ${COMMENT_MAX_CHARS} characters and usually far less.

Four rules before anything else: no digits and no number words (the tries are printed directly above your line); do not write the placing; no name (printed above too — say "tu", or "vous" when the line holds two names); no comparison and no image.

The score is how many guesses it took — fewer is better, three is the floor, and the sentence game is not timed. How good it was is already decided for you: react to the verdict, never re-judge it. perfect = the best there is, nobody beats it · brilliant = genuinely good · strong = solid · ordinary = a fine day's work · laboured = slow, and fair game for the joke. Playful at every rung: a slow score is teased by exaggerating the slowness, never by judging it. "place" is where that lands them today, which is a separate thing: a modest score can still win a modest day.

The other lines are written separately and cannot see yours, so no consolation that would fit any score ("aller au bout", "c'est déjà ça") and nothing any bot could have said. One blunt, strange, sincere verdict on THIS person, in the words a friend types.`;

const MAX_TOKENS = 4000;
// COUNTS NOW THAT THINKING IS OFF (DeepSeek ignores it while thinking). 1.1 was the
// setting under thinking, and without it that much sampling produced word salad ("des
// écluses en fin de course, ça tire encore mais ça râle à chaque cran"); 0.8 measured
// clean on the same podium, at no visible cost in strangeness.
export const TEMPERATURE = 0.8;
// The attempts at this must fit the podium Lambda's 90s with room for its reads, and the
// lines run in parallel, so the ceiling here is per LINE and not per podium. With thinking
// off a line answers in about a second (the 20s here used to cover the deliberation), so
// the cut is 10s and the refusals above can afford a third attempt: 30s worst case.
const TIMEOUT_MS = 10_000;

async function commentForLine(
  provider: LlmProvider,
  system: string,
  line: PodiumCommentLine,
  outOf: number,
  move: Move,
  log: Log,
): Promise<string | null> {
  // Neutral field names: the model writes with whatever vocabulary is in front of it, and
  // these are words it may borrow (`shareComment.ts` learned this as "le band a gagné").
  // THE SCORE ITSELF IS NOT SENT (v8): the verdict is the whole of what the line reacts
  // to, and a number the model never saw is a number it cannot repeat — with it in the
  // facts, half the lines opened by reading it back, whatever the rules said.
  const content = `${JSON.stringify({
    place: line.position,
    who: line.names,
    outOf,
    verdict: scoreBand(line.score, false), // a podium line is always a finished run
  })}\n${lineRules(move)}`;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let text: string | null;
    let finish: string | undefined;
    try {
      // NO THINKING (v8, 2026-09-06). This is a reasoning model and it spent 5–19 seconds
      // deliberating over one line under v7, the last of which is the timeout; the v8 voice
      // pushed every line past it and the podium came back bare. With thinking off a line
      // takes about a second and reads no worse — the deliberation was buying nothing a
      // one-liner needs. (`reasoning_effort: low` was measured too: still up to 19s.) It
      // also makes `temperature` count, which DeepSeek ignores while thinking.
      const response = await provider.generate({
        system,
        messages: [{ role: 'user', content }],
        maxTokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        effort: 'none',
        timeoutMs: TIMEOUT_MS,
      });
      text = response.text;
      finish = response.finish;
      // PER LINE AND PER ATTEMPT, because this is now the only place the cost of a podium
      // is visible: it makes up to `ATTEMPTS × lines` calls at 4000 tokens where the old
      // shape made one, and the latency measurements the design rests on (ordinary case
      // against the Lambda's 90s) cannot be reproduced from an aggregate.
      log.info(
        {
          event: 'podium.comment_generated',
          id: line.id,
          attempt,
          finish: response.finish,
          latencyMs: response.latencyMs,
          tokens: response.usage,
        },
        'llm answered',
      );
    } catch (error) {
      const unavailable = error instanceof LlmUnavailable;
      log.warn(
        { event: 'podium.comment_failed', id: line.id, attempt, unavailable, error: (error as Error).message },
        'no comment for this line',
      );
      if (!unavailable) return null;
      continue;
    }
    // ONLY A FINISHED ANSWER IS AN ANSWER — `shareComment.ts`'s gate, whole, because this
    // borrows its shape and inherits its hazards. `length` is the budget running out and
    // what comes back is a FRAGMENT that passes every length check; `other` is DeepSeek's
    // `insufficient_system_resource` or `content_filter`, an interrupted or cut generation,
    // which arrives looking exactly the same. This call passes no tools, so `stop` is the
    // one reason that means the model said what it meant.
    if (finish !== 'stop') {
      log.warn({ event: 'podium.comment_unfinished', id: line.id, attempt, finish }, 'the line did not finish');
      continue;
    }
    const comment = sanitizeComment(text);
    const reason = !comment
      ? 'unusable'
      : spellsANumber(comment)
        ? 'number'
        : namesSomebody(comment, line.names)
          ? 'name'
          : readsLikeASimile(comment)
            ? 'simile'
            : null;
    if (comment && !reason) return comment;
    log.warn({ event: 'podium.comment_invalid', id: line.id, attempt, finish, reason }, 'rejecting a line');
  }
  return null;
}

// ONE WORD, ONCE PER PODIUM (user-decided 2026-09-04). The lines are written independently
// and in parallel, and identical verdicts converge on identical prose: a real podium came
// back telling almost everybody they had sweated ("suer" — a verb the prompt itself had
// leaked through a negative example, since removed). The prompt asks for variety and
// cannot see the other lines; this can. Read top to bottom, a comment that repeats a
// DISTINCTIVE word an earlier one already used is dropped, and its podium line goes bare,
// which the renderer already prints. Distinctive: six letters or more once folded, not a
// name on the podium, and not the game's own vocabulary, which every line may share.
const ECHO_MIN_CHARS = 6;
const SHARED_VOCABULARY = new Set(['phrase', 'journee', 'aujourdhui', 'essais', 'podium', 'whippin', 'secret', 'secrets', 'premier', 'premiere', 'dernier', 'derniere']);

function distinctiveWords(text: string, names: ReadonlySet<string>): Set<string> {
  const words = new Set<string>();
  for (const raw of text.split(/[^\p{L}\p{M}'’-]+/u)) {
    const word = fold(raw).replace(/-/g, '');
    if (word.length >= ECHO_MIN_CHARS && !SHARED_VOCABULARY.has(word) && !names.has(word)) words.add(word);
  }
  return words;
}

export function dropEchoes(
  lines: readonly PodiumCommentLine[],
  comments: ReadonlyMap<string, string>,
): { kept: Map<string, string>; dropped: string[] } {
  const names = new Set(lines.flatMap((l) => l.names).flatMap((n) => n.split(/\s+/)).map((n) => fold(n).replace(/-/g, '')));
  const used = new Set<string>();
  const kept = new Map<string, string>();
  const dropped: string[] = [];
  for (const line of lines) {
    const comment = comments.get(line.id);
    if (!comment) continue;
    const words = distinctiveWords(comment, names);
    if ([...words].some((w) => used.has(w))) {
      dropped.push(line.id);
      continue;
    }
    for (const w of words) used.add(w);
    kept.set(line.id, comment);
  }
  return { kept, dropped };
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
    lines.map(async (line, i) => {
      const move = MOVE_CYCLE[(i + podium.dayNumber) % MOVE_CYCLE.length];
      return [line.id, await commentForLine(provider, system, line, lines.length, move, log)] as const;
    }),
  );
  const comments = new Map<string, string>();
  for (const [id, comment] of written) if (comment) comments.set(id, comment);
  const { kept, dropped } = dropEchoes(lines, comments);
  if (dropped.length > 0) log.info({ event: 'podium.comment_echo', ids: dropped }, 'dropped comments echoing an earlier line');
  log.info(
    { event: 'podium.comments_generated', lines: lines.length, written: comments.size, kept: kept.size },
    'podium comments',
  );
  return kept;
}
