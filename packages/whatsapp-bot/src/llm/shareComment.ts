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
import { lineRules, namesSomebody, readsLikeASimile, sanitizeComment, spellsANumber, type Move } from './podiumComments';
import { LlmUnavailable, type LlmProvider } from './types';

const ATTEMPTS = 3;
// GENEROUS, BECAUSE THE BUDGET WAS SHARED WITH THINKING. `deepseek-v4-flash` is a reasoning
// model: its reasoning tokens are spent from `max_tokens` and the provider only ever reads
// `message.content`, so a tight budget bought a truncated line or an empty one (measured:
// 300 truncated 1 run in 4, 800 none, 1500 still one). Since v8 this call turns the
// thinking OFF (`effort: 'none'` below) and a line costs a few dozen tokens; the budget
// stays where it was because it costs nothing, and the finish-reason check (which refuses
// every reason but `stop`) stays because a provider can still cut a generation short.
const MAX_TOKENS = 2000;
// SHORTNESS IS THE VOICE, so it is enforced and not merely asked for. A line that runs long
// is one that started explaining itself, which is the failure this register exists to avoid
// — rejecting it costs a retry, where posting it costs the joke.
const LINE_MAX_CHARS = 90;
// THE EMOJI IS WAITING BEHIND THIS, so the wait is bounded well under the provider's own
// 30s default: `ingest` awaits the line, and a long wait puts the acknowledgement of a
// share far enough after it to read as broken. With thinking off (v8) a line answers in
// about a second — the 20s this used to be covered the deliberation, whose tail ran to
// 29s — so the cut is 10s, and the refusals above can afford a third attempt: worst case
// 30s, the common case a second or two.
const TIMEOUT_MS = 10_000;

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
  `Task: react in ONE line to the Whippin result below, as a message in the group. The line only — plain text, no markdown, no quotes around it, under ${max} characters and often far less; two words is a whole message.

Three rules before anything else: no digits and no number words (their score is in the share they just posted); no name (it is on the share too); no "comme". Speak TO them — "tu" — never about them.

` +
  (mode === 'word'
    ? // WORD MODE: the other daily. "found" is how many words they named from one word's
      // neighbourhood against the clock — MORE is better, there is no cap and no floor.
      `This is a WORD MODE result: the score is how many words they named from one word's neighbourhood against a countdown, where rarer words earn more time. MORE is better; there is no cap and no perfect score. How good it was is already decided for you. React to it, never re-judge it: perfect = a huge run, say so plainly · brilliant = genuinely good, tell them · strong = solid, and you mean it · ordinary = a fine run · laboured = the clock won this time, fair game for the joke. Never name the word.`
    : `How good it was is already decided for you. React to it, never re-judge it. Three is the lowest score anyone can get, and anything under ten is good play: perfect = the best there is, nobody beats it, say so plainly · brilliant = genuinely good, tell them · strong = solid, and you mean it · ordinary = a fine day's work · laboured = slow, and fair game for the joke · failed = the sentence won today, and that is fair game too.`) +
  `

Playful at every rung: the score can be laughed at, the person never. At the bottom, nothing about having held on or gone the distance, which is what every bot says; the three moves work there too. One blunt, strange, sincere verdict on THIS person, in the words a friend types — nothing any bot could have said.`;

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
    extra: TASK(70, facts.mode),
  });
  // NEUTRAL FIELD NAMES, because the model writes with whatever vocabulary is in front of
  // it: an earlier draft called this `band` and produced "le band a gagné." Nothing here is
  // a word the answer may borrow.
  //
  // AND THE SCORE ITSELF IS NOT SENT (v8, `podiumComments.ts` says why): the verdict is
  // what the line reacts to, and a number the model never saw is one it cannot read back.
  const content = `${JSON.stringify(
    facts.mode === 'word'
      ? { player: facts.player, verdict: verdictOf(facts) }
      : { player: facts.player, solved: !facts.capped, verdict: verdictOf(facts) },
  )}\n${lineRules((Math.floor(Math.random() * 3) + 1) as Move)}`;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    if (!(await takeCall())) {
      log.info({ event: 'share.comment_ceiling', attempt }, 'daily call ceiling reached');
      return null;
    }
    let text: string | null;
    let finish: string | undefined;
    try {
      // NO THINKING, for the reason `podiumComments.ts` gives: the v8 voice pushed a
      // deliberated line past the timeout, and an undeliberated one takes about a second.
      const response = await provider.generate({
        system,
        messages: [{ role: 'user', content }],
        maxTokens: MAX_TOKENS,
        temperature: 1.1,
        effort: 'none',
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
    // The number, name and simile checks are `podiumComments.ts`'s, for its reasons: the
    // share the player posted already shows the score and the name.
    const reason = !line
      ? 'unusable'
      : line.length > LINE_MAX_CHARS
        ? 'long'
        : spellsANumber(line)
          ? 'number'
          : namesSomebody(line, [facts.player])
            ? 'name'
            : readsLikeASimile(line)
              ? 'simile'
              : null;
    if (line && !reason) return line;
    log.warn(
      { event: 'share.comment_invalid', attempt, finish, reason, length: line?.length ?? 0 },
      'rejecting a line',
    );
  }
  return null;
}
