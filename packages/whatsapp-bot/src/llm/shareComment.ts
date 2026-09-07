// THE SPOKEN ACKNOWLEDGEMENT OF A SHARE — COMMENTARY FROM THE NUMBERS (user-decided
// 2026-09-07). It used to be one line about a band word, and it said nothing, whatever
// the voice; now the bot is handed the FACTS (`domain/shareContext.ts`): the exact score,
// what a day typically costs, the day's board so far with this share placed, who is ahead
// and behind, this player's habit and recent days, and everybody else's habit — and it
// reasons over them and says what they mean, with names and numbers. The first share of a
// day is read against the typical score with the caveat that few have posted; the next
// ones against the ones before; and a player's habit is what makes today's number news.
//
// IT IS COMMENTARY, NEVER A FACT. Every number the model may say was computed here from
// the group's own declarations; the model phrases and may never revise, and a judge reads
// the line back against the facts before it is posted (`lineJudge.ts` FACT_JUDGE_SYSTEM).
// A model that is unavailable, slow, or over its ceiling costs the words and never the
// acknowledgement: `null` here means the emoji stands in (`domain/ingest.ts`).

import type { GroupConfig } from '../config/groupConfig';
import type { ShareFacts } from '../domain/reactions';
import { buildShareContext, type ShareContext } from '../domain/shareContext';
import type { Declaration, DeclarationStore } from '../domain/declarations';
import { HISTORY_WINDOW_DAYS } from '../chat/tools';
import type { Log } from '../log';
import { FACT_JUDGE_SYSTEM, chooseLine } from './lineJudge';
import { buildSystemPrompt } from './personality';
import { writeCandidate, type CandidateShape } from './podiumComments';
import type { LlmProvider } from './types';

export type { ShareFacts } from '../domain/reactions';

// Where the facts come from: the day's rows and the group's window before it.
export interface ShareCommentDeps {
  declarations: DeclarationStore;
  dayNumber: number;
  sender: string;
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
const SHAPE: CandidateShape = { maxChars: COMMENTARY_MAX_CHARS, refuse: () => null, effort: 'none', timeoutMs: 15_000 };

const TASK = (mode: ShareFacts['mode']) =>
  mode === 'word'
    ? `Task: react in one short line to the WORD MODE result below, as a message in the group. The score is how many words they named from one word's neighbourhood against a countdown, where rarer words earn more time; MORE is better, there is no cap; a typical run names about ten, a good one twenty or more. Plain text only, no quotes. Never name the word.`
    : `Task: comment on the Whippin result below, as a message in the group, from the FACTS given and nothing else. Every number, name, position and comparison you write must come from the facts; you never invent or round one.

What brings value: how the score sits against what a day typically costs; how it sits against who has posted so far — who it passes, who stays ahead, where it lands on the board; how it sits against this player's own habit and recent days, and against the habit of the people around them on the board. When few have posted, say the reading is early and the day's difficulty is not known yet; when nobody had posted, read the score against the typical day and say more players are needed. When others have posted, the comparison to them is the news. The habit, the recent days and the others' habits cover only the last "habitDays" days: a best or a worst is a best or a worst of those days, never of all time. Say what is interesting in these numbers and skip what is not; a share with nothing notable gets a plain short acknowledgement. Speak to the player as "tu" and about the others by name. Plain text only, no quotes, one or two short sentences.`;

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
    language: group.language,
    groupPrePrompt: group.chat.prePrompt,
    extra: TASK(facts.mode),
  });
  let shown: string;
  let context: ShareContext | null = null;
  if (facts.mode === 'word') {
    shown = JSON.stringify({ player: facts.player, found: facts.claims });
  } else {
    let todayRows: Declaration[];
    let windowRows: Declaration[];
    try {
      [todayRows, windowRows] = await Promise.all([
        deps.declarations.day(group.id, deps.dayNumber),
        deps.declarations.range(group.id, deps.dayNumber - HISTORY_WINDOW_DAYS, deps.dayNumber - 1),
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
    shown = JSON.stringify(context);
  }
  const written = await Promise.all(
    Array.from({ length: CANDIDATES }, async () => {
      if (!(await takeCall())) {
        log.info({ event: 'share.comment_ceiling' }, 'daily call ceiling reached');
        return null;
      }
      return writeCandidate(provider, system, shown, SHAPE, 'share.comment', log);
    }),
  );
  const candidates = written.filter((c): c is string => c !== null);
  log.info({ event: 'share.candidates', written: candidates.length, of: CANDIDATES }, 'candidates written');
  return chooseLine(provider, { system: FACT_JUDGE_SYSTEM, occasion: shown }, candidates, log, takeCall);
}
