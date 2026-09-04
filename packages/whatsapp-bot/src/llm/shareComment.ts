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
import { scoreBand } from '../domain/reactions';
import type { Log } from '../log';
import { buildSystemPrompt } from './personality';
import { sanitizeComment } from './podiumComments';
import { LlmUnavailable, type LlmProvider } from './types';

const ATTEMPTS = 2;
// GENEROUS, BECAUSE THE BUDGET IS SHARED WITH THINKING. `deepseek-v4-flash` is a reasoning
// model: its reasoning tokens are spent from `max_tokens` and the provider only ever reads
// `message.content`, so a tight budget buys a truncated line or an empty one. Measured over
// repeated calls for a 140-character sentence: 300 truncated 1 run in 4, 800 truncated none
// — and 1500 still truncated one, because the thinking length has no ceiling worth trusting.
// Hence a comfortable budget AND the finish-reason check below; the retry and the emoji
// cover what neither catches.
const MAX_TOKENS = 2000;
// SHORTNESS IS THE VOICE, so it is enforced and not merely asked for. A line that runs long
// is one that started explaining itself, which is the failure this register exists to avoid
// — rejecting it costs a retry, where posting it costs the joke.
const LINE_MAX_CHARS = 90;

export interface ShareFacts {
  player: string; // the display name the group knows them by
  score: number;
  capped: boolean; // a run that ended at ∞
  dayNumber: number;
}

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
const TASK = (max: number) =>
  `Task: react in ONE line to the Whippin result below, as a message in the group. The line only — plain text, no markdown, no quotes around it, under ${max} characters and often far less; two words is a whole message. Do not open with the player's name and do not restate their score.

How good it was is already decided for you. React to it, never re-judge it: brilliant = grudging respect, never gushing · strong = approval, undercut · ordinary = unmoved · laboured = dry sympathy · failed = the sentence beat them.

Register, never reuse these words: "bon. c'est agaçant." / "ça fera l'affaire." / "la phrase a gagné."`;

export async function generateShareComment(
  provider: LlmProvider,
  group: GroupConfig,
  facts: ShareFacts,
  log: Log,
): Promise<string | null> {
  const system = buildSystemPrompt({
    language: group.language,
    groupPrePrompt: group.chat.prePrompt,
    extra: TASK(70),
  });
  // NEUTRAL FIELD NAMES, because the model writes with whatever vocabulary is in front of
  // it: an earlier draft called this `band` and produced "le band a gagné." Nothing here is
  // a word the answer may borrow.
  const content = JSON.stringify({
    player: facts.player,
    tries: facts.capped ? null : facts.score,
    solved: !facts.capped,
    verdict: scoreBand(facts.score, facts.capped),
  });
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let text: string | null;
    try {
      const response = await provider.generate({
        system,
        messages: [{ role: 'user', content }],
        maxTokens: MAX_TOKENS,
        temperature: 1.1,
      });
      text = response.text;
      log.info(
        { event: 'share.comment_generated', attempt, finish: response.finish, latencyMs: response.latencyMs, tokens: response.usage },
        'llm answered',
      );
      // A CUT-OFF ANSWER IS NOT AN ANSWER. What comes back when the budget runs out is a
      // FRAGMENT, and a short enough fragment passes every length check there is — the
      // observed one was "Gab, 7 ess". Length is what the model had left to say, not what
      // it meant to, so the whole response is refused on the reason rather than inspected.
      if (response.finish === 'length') {
        log.warn({ event: 'share.comment_truncated', attempt }, 'the line ran out of budget');
        continue;
      }
    } catch (error) {
      const unavailable = error instanceof LlmUnavailable;
      log.warn(
        { event: 'share.comment_failed', attempt, unavailable, error: (error as Error).message },
        'no line for this share; the emoji stands in',
      );
      // Only an availability problem is worth a second call; anything else recurs.
      if (!unavailable) return null;
      continue;
    }
    const line = sanitizeComment(text);
    if (line && line.length <= LINE_MAX_CHARS) return line;
    log.warn({ event: 'share.comment_invalid', attempt }, 'rejecting an unusable line');
  }
  return null;
}
