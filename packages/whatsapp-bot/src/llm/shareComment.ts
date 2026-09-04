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

import { dateForDayNumber } from '@whippin/shared';
import type { GroupConfig } from '../config/groupConfig';
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
const MAX_TOKENS = 800;

export interface ShareFacts {
  player: string; // the display name the group knows them by
  score: number;
  capped: boolean; // a run that ended at ∞
  dayNumber: number;
}

// The model gets the facts and the group's voice; the TASK forbids it inventing any of the
// numbers back, because the renderer does not print them — this line IS the whole message.
const TASK = (max: number) =>
  `Task: one short line reacting to a Whippin result somebody just shared in this group. You receive the facts as JSON (player, score, capped, date). Lower scores are better; "capped": true means they ran out of guesses and did not finish. Reply with the LINE ONLY — plain text, one sentence, no line breaks, no markdown, no quotes around it, at most ${max} characters, in the group's language. Tease or congratulate. You may mention the player and the score, but never invent a rank, a comparison with another player, or any number you were not given.`;

export async function generateShareComment(
  provider: LlmProvider,
  group: GroupConfig,
  facts: ShareFacts,
  log: Log,
): Promise<string | null> {
  const system = buildSystemPrompt({
    language: group.language,
    groupPrePrompt: group.chat.prePrompt,
    extra: TASK(140),
  });
  const content = JSON.stringify({
    player: facts.player,
    score: facts.capped ? null : facts.score,
    capped: facts.capped,
    date: dateForDayNumber(facts.dayNumber),
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
    if (line) return line;
    log.warn({ event: 'share.comment_invalid', attempt }, 'rejecting an unusable line');
  }
  return null;
}
