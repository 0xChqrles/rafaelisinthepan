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

import type { BotMemberRound } from '@whippin/shared';
import { boundTurnText, type Turn } from '../chat/dayLog';
import type { GroupConfig } from '../config/groupConfig';
import { FORM_DAYS, buildOtherPuzzleContext, buildShareContext } from '../domain/shareContext';
import type { Declaration, DeclarationStore } from '../domain/declarations';
import type { Log } from '../log';
import { TRIED_WORDS_RULE, triedWordsFacts } from '../puzzle/groupRounds';
import { chooseLine, refusalNote } from './lineJudge';
import { buildSystemPrompt } from './personality';
import { writeCandidate, type CandidateShape } from './podiumComments';
import type { LlmProvider } from './types';

// Where the facts come from: the day's rows and the group's window before it — and what
// the player wrote around the share, when the caller had it to give (`ingest.ts` says when).
// `lang` is the share's: the group's own, or the other language's puzzle
// (`shareContext.ts` says how that one is read).
export interface ShareCommentDeps {
  declarations: DeclarationStore;
  dayNumber: number;
  sender: string;
  lang: string;
  said?: string;
  // THE SHARER'S OWN ROUND, when the bot knows who they are and the round matches the share
  // (`domain/playerIds.ts`), started by ingest beside this line and awaited with the facts.
  // Its far words become `triedWords`.
  sharer?: Promise<BotMemberRound | null>;
  // THE BOT'S OWN LINES ALREADY SAID TODAY IN THIS GROUP (v24, `ownLinesOf`), shown to the
  // writer only: they are what it must not sound like again, never facts a claim may lean on.
  earlierLines?: readonly string[];
}

// How many of today's own lines the writer is shown, the latest kept.
export const EARLIER_LINES_MAX = 10;

// THE BOT'S LINES OF THE DAY, as the day log holds them — its answers, its acknowledgements,
// the podium and the reminder as WhatsApp echoed them — cut to a line's length.
export function ownLinesOf(turns: readonly Turn[]): string[] {
  return turns
    .filter((t) => t.kind === 'bot')
    .slice(-EARLIER_LINES_MAX)
    .map((t) => boundTurnText(t.text.replace(/\s+/g, ' ').trim(), COMMENTARY_MAX_CHARS));
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
const SHAPE: CandidateShape = { maxChars: COMMENTARY_MAX_CHARS, timeoutMs: 15_000 };

// THE VERB TIC (v24, user-reported 2026-10-30): the model comes back to one verb for "got
// that score" share after share. It is shown its own lines of the day and told not to.
const EARLIER = `If you are shown "yourEarlierLines", those are your own lines already posted in this group today. Say this result differently: never the same verb or the same opening as one of them.`;

// What the player wrote around the share, when it is in the facts (`ShareCommentDeps.said`).
const SAID = `If the facts carry "said", that is what the player wrote with their share. When it asks you something or says something worth an answer, your line answers it instead of commenting the result, at the same length.`;

const TASK = `Task: react to the Whippin result below, as a message in the group, from the FACTS given. Any number, name or place you say comes from the facts, never invented.

A score is only worth something next to today's other scores. Say the ONE thing a friend would actually say about it: who it beats, who is still ahead, that it is the first one in, that for once they beat somebody they usually lose to. Say it in plain words, never as a statistic: no counts like "5 fois sur 13", no fractions, no records, no medians. A result with nothing notable gets a plain short acknowledgement. Your own life stays out of it. ${SAID} ${TRIED_WORDS_RULE} ${EARLIER} "tu" to the player, the others by name. Plain text, no quotes, one short sentence, two at most.`;

export async function generateShareComment(
  provider: LlmProvider,
  group: GroupConfig,
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
    extra: TASK,
  });
  // What they wrote with it travels beside the facts, so the judge reads it too: a line
  // that answers it is supported by it.
  const said = deps.said ? { said: deps.said } : {};
  // A share of the other language's puzzle has no form to read (`buildOtherPuzzleContext`).
  const own = deps.lang === group.language;
  let todayRows: Declaration[];
  let windowRows: Declaration[];
  let sharer: BotMemberRound | null;
  try {
    [todayRows, windowRows, sharer] = await Promise.all([
      deps.declarations.day(group.id, deps.dayNumber),
      own ? deps.declarations.range(group.id, deps.dayNumber - FORM_DAYS, deps.dayNumber - 1) : [],
      // Never a reason to lose the line: a lookup that fails is a share with no words.
      deps.sharer?.catch(() => null) ?? null,
    ]);
  } catch (error) {
    // No facts, no commentary: a line written without them is the empty one this
    // replaced. The share is recorded either way; the emoji acknowledges it.
    log.warn({ event: 'share.facts_failed', error: (error as Error).message }, 'could not read the facts; the emoji stands in');
    return null;
  }
  const context = own
    ? buildShareContext({ group, dayNumber: deps.dayNumber, sender: deps.sender, todayRows, windowRows })
    : buildOtherPuzzleContext({ group, dayNumber: deps.dayNumber, sender: deps.sender, lang: deps.lang, todayRows });
  if (!context) {
    log.warn({ event: 'share.facts_missing' }, 'the share is not on the board; the emoji stands in');
    return null;
  }
  // The judge reads what a claim may rest on — the words they tried included, so a joke
  // about one is checked against them; the writer reads that plus its own earlier lines.
  const facts = { ...context, ...said, ...(sharer ? triedWordsFacts(sharer.farGuesses) : {}) };
  const shown = JSON.stringify(facts);
  const earlier = deps.earlierLines?.length ? deps.earlierLines.slice(-EARLIER_LINES_MAX) : null;
  const writerFacts = earlier ? JSON.stringify({ ...facts, yourEarlierLines: earlier }) : shown;
  let refused: string[] = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    const content = round === 1 ? writerFacts : `${writerFacts}\n\n${refusalNote(refused)}`;
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
    const choice = await chooseLine(provider, shown, candidates, log, takeCall, 'post-none');
    if (choice.line) return choice.line;
    // Nothing written, or nothing judged, is not the judge's doing: no second try.
    if (choice.dropped === 0) return null;
    refused = choice.reasons;
    if (round < ROUNDS) log.info({ event: 'share.comment_retry', reasons: refused }, 'the judge kept none; writing again with its reasons');
  }
  return null;
}
