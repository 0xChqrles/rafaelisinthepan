// THE SPOKEN ACKNOWLEDGEMENT OF A SHARE — COMMENTARY FROM THE NUMBERS (user-decided
// 2026-09-07). It used to be one line about a band word, and it said nothing, whatever
// the voice; now the bot is handed the FACTS (`domain/shareContext.ts`): the exact score,
// the day's board so far with this share placed, who is above and below, the share of
// today's others it beats, and this player's FORM — where they usually land among the
// others, their recent places, their record against each person on today's board — and it
// says what that means, with names and numbers. A score is only ever read against the
// SAME day's other scores (user-decided 2026-09-14: what a day costs depends on its
// sentence, so "ton pire score des 14 jours" said nothing on the day 43 was fourth of
// six); the first share of a day therefore has nothing to be compared with yet, and says so.
//
// IT IS COMMENTARY, NEVER A FACT. Every number the model may say was computed here from
// the group's own declarations; the model phrases and may never revise, and a judge reads
// the line back against the facts before it is posted (`lineJudge.ts` FACT_JUDGE_SYSTEM).
// A model that is unavailable, slow, or over its ceiling costs the words and never the
// acknowledgement: `null` here means the emoji stands in (`domain/ingest.ts`).

import type { GroupConfig } from '../config/groupConfig';
import type { ShareFacts } from '../domain/reactions';
import { FORM_DAYS, buildShareContext, type ShareContext } from '../domain/shareContext';
import type { Declaration, DeclarationStore } from '../domain/declarations';
import type { Log } from '../log';
import { FACT_JUDGE_SYSTEM, chooseLine } from './lineJudge';
import { buildSystemPrompt } from './personality';
import { writeCandidate, type CandidateShape } from './podiumComments';
import type { LlmProvider } from './types';

export type { ShareFacts } from '../domain/reactions';

// Where the facts come from: the day's rows and the group's window before it — and what
// the player wrote around the share, when the caller had it to give (`ingest.ts` says when).
export interface ShareCommentDeps {
  declarations: DeclarationStore;
  dayNumber: number;
  sender: string;
  said?: string;
}

// Two short sentences of numbers and names need room the one-liner never had. Still a
// WhatsApp bubble, never a paragraph.
export const COMMENTARY_MAX_CHARS = 220;
// THE WRITER DOES NOT THINK; THE JUDGE DOES. Measured on the same seeded day: with its
// thinking on the writer took 15–29s a share (46s once, two candidates lost to the cut)
// and read no better than with it off (12–21s), because the facts already carry every
// comparison — the writer phrases a table, and the arithmetic slips it makes either way
// ("deux points sous" for 1.1) are the judge's to catch. Three candidates in parallel.
const CANDIDATES = 3;
// ONE MORE ROUND WHEN THE JUDGE KEPT NOTHING (2026-09-07). Three candidates against a fact
// check that drops about two in five left one share in eight with the emoji where a line
// was owed (live, the day the fact check shipped: two of sixteen, all three dropped each
// time). The judge says WHY it dropped each line, so the second round writes with those
// reasons in front of it — and is the last: an acknowledgement half a minute after the
// share reads as broken, and eight candidates a round would spend the day's ceiling.
const ROUNDS = 2;
const SHAPE: CandidateShape = { maxChars: COMMENTARY_MAX_CHARS, refuse: () => null, effort: 'none', timeoutMs: 15_000 };

// What the player wrote around the share, when it is in the facts (`ShareCommentDeps.said`).
const SAID = `If the facts carry "said", that is what the player wrote with their share: when it asks you something or says something worth an answer, your line answers it — in place of the commentary, not on top of it, at the same length.`;

const TASK = (mode: ShareFacts['mode']) =>
  mode === 'word'
    ? `Task: react in one short line to the WORD MODE result below, as a message in the group. The score is how many words they named from one word's neighbourhood against a countdown, where rarer words earn more time; MORE is better, there is no cap; a typical run names about ten, a good one twenty or more. ${SAID} Plain text only, no quotes. Never name the word.`
    : `Task: comment on the Whippin result below, as a message in the group, from the FACTS given and nothing else. Every number, name, position and comparison you write must come from the facts; you never invent or round one.

A score on its own says nothing, and neither does a score held against another day's: what it is worth depends on how the others did with the SAME sentence. So the news is where it lands among today's posters — who it beats, who is still above, how the others are doing — and how that compares with where this player usually lands: how many of the others they usually beat, their recent places, their record against the people on today's board (beating somebody they usually lose to, losing to somebody they usually beat). When nobody else has posted, there is nothing to compare it with yet: say so in a few words, with at most where they usually land. When few have posted, say the reading is early. Say what is interesting in these numbers and skip what is not — one thing said well beats three listed; a share with nothing notable gets a plain short acknowledgement. This line is about the result: your own life stays out of it. ${SAID} Speak to the player as "tu" and about the others by name. Plain text only, no quotes, one or two short sentences.`;

export async function generateShareComment(
  provider: LlmProvider,
  group: GroupConfig,
  facts: ShareFacts,
  deps: ShareCommentDeps,
  log: Log,
  // Spends one unit of the daily CALL ceiling per model call — every candidate and every
  // verdict — as the conversation does. A refused call is one candidate fewer, or one
  // candidate unjudged; refusing them all is the emoji.
  takeCall: () => Promise<boolean> = async () => true,
): Promise<string | null> {
  const system = buildSystemPrompt({
    name: group.chat.name,
    language: group.language,
    groupPrePrompt: group.chat.prePrompt,
    extra: TASK(facts.mode),
  });
  let shown: string;
  let context: ShareContext | null = null;
  // What they wrote with it travels beside the facts, so the judge reads it too: a line
  // that answers it is supported by it.
  const said = deps.said ? { said: deps.said } : {};
  if (facts.mode === 'word') {
    shown = JSON.stringify({ player: facts.player, found: facts.claims, ...said });
  } else {
    let todayRows: Declaration[];
    let windowRows: Declaration[];
    try {
      [todayRows, windowRows] = await Promise.all([
        deps.declarations.day(group.id, deps.dayNumber),
        deps.declarations.range(group.id, deps.dayNumber - FORM_DAYS, deps.dayNumber - 1),
      ]);
    } catch (error) {
      // No facts, no commentary: a line written without them is the empty one this
      // replaced. The share is recorded either way; the emoji acknowledges it.
      log.warn({ event: 'share.facts_failed', error: (error as Error).message }, 'could not read the facts; the emoji stands in');
      return null;
    }
    context = buildShareContext({ group, dayNumber: deps.dayNumber, sender: deps.sender, todayRows, windowRows });
    if (!context) {
      log.warn({ event: 'share.facts_missing' }, 'the share is not on the board; the emoji stands in');
      return null;
    }
    shown = JSON.stringify({ ...context, ...said });
  }
  let refused: string[] = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    const content =
      round === 1
        ? shown
        : `${shown}\n\nYour previous lines were refused by the fact check${refused.length > 0 ? ' for these reasons:' : '.'}${refused.map((r) => `\n- ${r}`).join('')}\nWrite a new one that avoids them.`;
    const written = await Promise.all(
      Array.from({ length: CANDIDATES }, async () => {
        if (!(await takeCall())) {
          log.info({ event: 'share.comment_ceiling' }, 'daily call ceiling reached');
          return null;
        }
        return writeCandidate(provider, system, content, SHAPE, 'share.comment', log);
      }),
    );
    const candidates = written.filter((c): c is string => c !== null);
    log.info({ event: 'share.candidates', round, written: candidates.length, of: CANDIDATES }, 'candidates written');
    const choice = await chooseLine(provider, { system: FACT_JUDGE_SYSTEM, occasion: shown }, candidates, log, takeCall, 'post-none');
    if (choice.line) return choice.line;
    // Nothing written, or nothing judged, is not the judge's doing: no second try.
    if (choice.dropped === 0) return null;
    refused = choice.reasons;
    if (round < ROUNDS) log.info({ event: 'share.comment_retry', reasons: refused }, 'the judge kept none; writing again with its reasons');
  }
  return null;
}
