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
// Hence a comfortable budget AND the finish-reason check below (which refuses every reason
// but `stop`); the retry and the emoji cover what neither catches.
const MAX_TOKENS = 2000;
// SHORTNESS IS THE VOICE, so it is enforced and not merely asked for. A line that runs long
// is one that started explaining itself, which is the failure this register exists to avoid
// — rejecting it costs a retry, where posting it costs the joke.
const LINE_MAX_CHARS = 90;
// THE EMOJI IS WAITING BEHIND THIS, so the wait is bounded well under the provider's own
// 30s default: `ingest` awaits the line, and two attempts at that default put the
// acknowledgement of a share up to a minute after it — long enough to read as broken.
// Measured over eight live calls: median 6.4s, with a tail at 28-29s, so the cut sits above
// the ordinary case and inside the tail. A call past it is treated as unavailable, which is
// retried once and then falls back — worst case ~40s rather than ~60s, the common case
// unchanged.
const TIMEOUT_MS = 20_000;

export interface ShareFacts {
  player: string; // the display name the group knows them by
  score: number;
  capped: boolean; // a run that ended at ∞
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

Speak TO them, not about them: "tu" rather than talking about a third party.

How good it was is already decided for you. React to it, never re-judge it. Three is the lowest score anyone can get, and anything under ten is good play: perfect = nobody could do better, and you resent it slightly · brilliant = very good, said without warmth · strong = good, and you acknowledge it plainly — do not imply they were slow · ordinary = unmoved · laboured = warm; they stayed with a bad day and got there, so no mockery of the number · failed = the sentence won, said kindly.

The lower somebody lands, the gentler you are. The teasing is for the top of the table.

Register, never reuse these words: "bon. c'est agaçant." / "ça fera l'affaire." / "la phrase a gagné."`;

export async function generateShareComment(
  provider: LlmProvider,
  group: GroupConfig,
  facts: ShareFacts,
  log: Log,
  // Spends one unit of the daily CALL ceiling, per attempt — the conversation charges per
  // call too, and a retry that cost nothing would leave the ceiling bounding acknowledgements
  // rather than the spend it exists to bound. Refusing is the emoji, like every other way
  // this can fail to produce words.
  takeCall: () => Promise<boolean> = async () => true,
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
    if (!(await takeCall())) {
      log.info({ event: 'share.comment_ceiling', attempt }, 'daily call ceiling reached');
      return null;
    }
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
      log.info(
        { event: 'share.comment_generated', attempt, finish: response.finish, latencyMs: response.latencyMs, tokens: response.usage },
        'llm answered',
      );
      // ONLY A FINISHED ANSWER IS AN ANSWER. `length` is the budget running out — what
      // comes back is a FRAGMENT, and a short enough fragment passes every length check
      // there is ("Gab, 7 ess" was a real one). And it is not the only way a completion
      // stops early: DeepSeek answers `insufficient_system_resource` for a generation it
      // interrupted and `content_filter` for one it cut, both of which the provider folds
      // into `other`. This call uses no tools, so the one reason that means "the model
      // said what it meant" is `stop`; anything else is refused on the REASON rather than
      // inspected, since what came back is what the model had left to say, not what it
      // meant to.
      if (response.finish !== 'stop') {
        log.warn({ event: 'share.comment_unfinished', attempt, finish: response.finish }, 'the line did not finish');
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
    log.warn(
      { event: 'share.comment_invalid', attempt, finish, length: line?.length ?? 0 },
      'rejecting an unusable line',
    );
  }
  return null;
}
