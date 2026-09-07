// The spoken acknowledgement of a share (#236, user-decided 2026-09-04): one short line the
// model writes when a group is configured `acknowledge: "say"`.
//
// IT IS COMMENTARY, NEVER A FACT. The score, the day and the player are given to the model
// as settled input and are decided here; what comes back is prose about them. That is the
// same boundary the podium draws — "the LLM writes comments, never facts" — and it is why
// the line is validated as TEXT and never parsed for a number.
//
// AND IT IS BEST-EFFORT OVER AN ACKNOWLEDGEMENT THAT IS NOT. A share that was recorded is
// owed a sign that it landed, so a model that is unavailable, slow to make sense, or over
// its ceiling costs the JOKE and not the acknowledgement: `null` here means the caller
// sends the deterministic emoji instead (`domain/ingest.ts`). Never silence.

import type { GroupConfig } from '../config/groupConfig';
import { verdictOf, type ShareFacts } from '../domain/reactions';
import type { Log } from '../log';
import { buildSystemPrompt } from './personality';
import { CANDIDATES, COMMENT_MAX_CHARS, LINE_RULES, writeCandidate } from './podiumComments';
import { chooseLine } from './lineJudge';
import type { LlmProvider } from './types';

// The writer's budget, cut and checks are `podiumComments.ts`'s (`writeCandidate`): one
// spelling of the voice for both acknowledgements. What differs here is only who waits —
// the emoji is behind this, so the candidates are written in parallel and never retried.

export type { ShareFacts } from '../domain/reactions';

// HOW GOOD IT WAS IS ALREADY DECIDED. The band comes from `domain/reactions.ts` — the same
// thresholds the emoji uses — and reaches the model as a settled `verdict` it dresses in
// words but may never revise. Without it the model cannot calibrate at all: told only "7",
// it has no idea whether that is good, and answers the same flat line to a 3, a 7 and a 42
// (measured). It is also the invariant: the bot judges, the model writes.
//
// THE BANDS ARE DESCRIBED AS ATTITUDES, AND THE EXAMPLES ARE MARKED AS REGISTER. Given
// copyable one-liners the model treats them as a menu — an early draft answered
// "acceptable." to three different scores in a row — so the examples say what the voice
// SOUNDS like and the prompt forbids reusing their words.
const TASK = (max: number, mode: ShareFacts['mode']) =>
  `Task: react in ONE line to the Whippin result below, as a message in the group. The line only — plain text, no markdown, no quotes around it, under ${max} characters and usually far less; two words is a whole message.

Three rules before anything else: no digits and no number words (their score is in the share they just posted); no name (it is on the share too); no "comme", no "qui". Speak TO them — "tu" — never about them.

` +
  (mode === 'word'
    ? // WORD MODE: the other daily. "found" is how many words they named from one word's
      // neighbourhood against the clock — MORE is better, there is no cap and no floor.
      `This is a WORD MODE result: the score is how many words they named from one word's neighbourhood against a countdown, where rarer words earn more time. MORE is better; there is no cap and no perfect score. How good it was is already decided for you. React to it, never re-judge it: perfect = a huge run, say so plainly · brilliant = genuinely good, tell them · strong = solid, and you mean it · ordinary = a fine run · laboured = the clock won this time, fair game for the joke. Never name the word.`
    : `How good it was is already decided for you. React to it, never re-judge it. Three is the lowest score anyone can get, and anything under ten is good play: perfect = the best there is, nobody beats it, say so plainly · brilliant = genuinely good, tell them · strong = solid, and you mean it · ordinary = a fine day's work · laboured = slow, and fair game for the joke · failed = the sentence won today, and that is fair game too.`) +
  `

Playful at every rung: a slow score is teased by exaggerating the slowness, never by judging it. At the bottom, nothing about having held on or gone the distance, which is what every bot says; the three moves work there too. One blunt, strange, sincere verdict on THIS person, in the words a friend types — nothing any bot could have said.`;

export async function generateShareComment(
  provider: LlmProvider,
  group: GroupConfig,
  facts: ShareFacts,
  log: Log,
  // Spends one unit of the daily CALL ceiling per model call — every candidate and every
  // verdict — as the conversation does: a call that cost nothing would leave the ceiling
  // bounding acknowledgements rather than the spend it exists to bound. A refused call is
  // one candidate fewer, or one candidate unjudged; refusing them all is the emoji.
  takeCall: () => Promise<boolean> = async () => true,
): Promise<string | null> {
  const system = buildSystemPrompt({
    language: group.language,
    groupPrePrompt: group.chat.prePrompt,
    extra: TASK(COMMENT_MAX_CHARS, facts.mode),
  });
  // NEUTRAL FIELD NAMES, because the model writes with whatever vocabulary is in front of
  // it: an earlier draft called this `band` and produced "le band a gagné." Nothing here is
  // a word the answer may borrow.
  //
  // AND THE SCORE ITSELF IS NOT SENT (v8, `podiumComments.ts` says why): the verdict is
  // what the line reacts to, and a number the model never saw is one it cannot read back.
  const shown = JSON.stringify(
    facts.mode === 'word'
      ? { player: facts.player, verdict: verdictOf(facts) }
      : { player: facts.player, solved: !facts.capped, verdict: verdictOf(facts) },
  );
  // The candidates are written in PARALLEL — the emoji is waiting behind this, and six
  // sequential seconds would read as a bot thinking — each behind its own unit of the
  // ceiling.
  const written = await Promise.all(
    Array.from({ length: CANDIDATES }, async () => {
      if (!(await takeCall())) {
        log.info({ event: 'share.comment_ceiling' }, 'daily call ceiling reached');
        return null;
      }
      return writeCandidate(provider, system, `${shown}\n${LINE_RULES}`, [facts.player], 'share.comment', log);
    }),
  );
  const candidates = written.filter((c): c is string => c !== null);
  log.info({ event: 'share.candidates', written: candidates.length, of: CANDIDATES }, 'candidates written');
  return chooseLine(provider, `a friend posted a result, ${shown}`, candidates, log, takeCall);
}
