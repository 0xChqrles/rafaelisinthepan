// THE JUDGE (2026-09-07): a second, REASONING call that reads one candidate line and says
// whether it is posted. In production the writer was "perfect 40% of the time, cringe or
// nonsense the rest" (user-reported), and no wording of the writer's prompt moved that
// without making it worse — every rule of construction read as effort, and this model
// treats an example as a menu. Selection is the lever construction was not: the writer
// stays free, writes several candidates with its thinking off (about a second each), and
// a strict reader with its thinking ON keeps or drops each one. A dropped line costs
// nothing the group sees — the podium prints a bare line, the share gets the emoji —
// where a cringe one costs the bot its character.
//
// ONE LINE PER CALL, never "pick the best of N". Measured against 41 lines the user had
// rated: single verdicts at `reasoning_effort: low` rejected 23 of 23 bad lines and kept
// 8-9 of 18 good ones, median 4s; asked to choose among four, the same model reasoned for
// 12-25s, truncated, and landed at half accuracy — comparison is a much harder question
// than "is this one good", and the podium Lambda's 90s cannot hold it. Precision over
// recall is the right trade for a filter: the candidates supply the recall. `high` effort
// truncated a third of its verdicts at the same budget and bought nothing.
//
// THE JUDGE MAY QUOTE EXAMPLES; THE WRITER MAY NOT. A reader does not copy what it reads,
// so this prompt carries the user's own canonical lines and the named failures — the
// calibration the writer's prompt cannot afford (every quoted word came back in its lines).

import type { Log } from '../log';
import { LlmUnavailable, type LlmProvider } from './types';

export const JUDGE_SYSTEM = `You are the editor of a WhatsApp bot's one-line comments. The bot is a member of a small group of friends who play a daily word game; it is a bit much, not very bright, completely sure of itself, and loves the group out of all proportion. You are handed ONE line written for ONE occasion and you decide whether it is posted.

A good line:
- Shows no effort. One flat, short statement in plain grammar; no relative clause, no build-up, no second idea, no tail after a comma ("c'est certain", "c'est officiel", "voilà ce que tu es"). A line that visibly tries to be funny is cringe.
- Makes sense at once. The reader gets what it means without thinking. Nonsense — words that do not go together, an image nobody can picture, a sentence whose point is unclear — is worse than a bland line.
- Is strange in the bot's own way: a conclusion that does not follow stated as proof; a feeling out of all proportion reported as normal; the compliment a small child pays ("tu es un <big animal>"); or an absurd yet instantly picturable image whose detail is beside the point — a shark made of concrete, a surgeon who happens to be obese. Not the obvious weak spot of a thing (a short-sighted falcon is a joke being made), not a passing state (a hungry blacksmith is just a blacksmith), not a crafted comparison, not a metaphor with a story.
- Is never a judgement of the person. Nothing about their intelligence, worth, effort or luck; no put-down, however absurd; a slow score may be teased only through what the wait did to the bot.
- Is not what any bot would say: no "bravo", "bien joué", "beau boulot", "c'est déjà ça", "tu as tenu bon", "tu mérites une médaille", nothing generic, no "comme", no "<animal> des dictionnaires".

Four lines the group's author holds up as exactly right, to calibrate on: "Wow tu es un véritable tigre" (it makes no sense, shows no effort, and is plainly a compliment), "La précision d'un escargot malnutri" (two words, a picture you see at once, nobody ever said it), "L'information me plaît donc elle est vraie" (a conclusion that does not follow, stated flat), "Tu as fini, c'est pour ça que je t'aime" (a feeling out of all proportion, reported as if it were the normal reaction). The last two kinds — the bot's own logic and its feelings — are as good as any image, and often better. Making no sense on purpose is not nonsense; nonsense is when the reader cannot tell what is meant.

Answer 1 to post the line, 0 to drop it. No line at all is better than a cringe or a bland one: be strict. Only the digit.`;

export type Verdict = 'keep' | 'drop' | 'unknown';

// Sized to the measurement above: a verdict at `low` is a few hundred reasoning tokens and
// about 4s, with a tail to 12s; the budget refuses nothing it needs, and the cut sits above
// the tail. `unknown` is a verdict that never arrived — a timeout, an outage, a truncated
// answer — and is told apart from `drop` because it says nothing about the line.
const MAX_TOKENS = 3000;
const TIMEOUT_MS = 20_000;

export async function judgeLine(
  provider: LlmProvider,
  occasion: string,
  line: string,
  log: Log,
): Promise<Verdict> {
  try {
    const response = await provider.generate({
      system: JUDGE_SYSTEM,
      messages: [{ role: 'user', content: `Occasion: ${occasion}\nLine: ${line}\n\nAnswer 1 or 0.` }],
      maxTokens: MAX_TOKENS,
      effort: 'low',
      timeoutMs: TIMEOUT_MS,
    });
    const digit = /[01]/.exec((response.text ?? '').trim())?.[0];
    const verdict: Verdict = response.finish !== 'stop' || !digit ? 'unknown' : digit === '1' ? 'keep' : 'drop';
    log.info(
      { event: 'line.judged', verdict, finish: response.finish, latencyMs: response.latencyMs, tokens: response.usage },
      'the judge answered',
    );
    return verdict;
  } catch (error) {
    log.warn(
      { event: 'line.judge_failed', unavailable: error instanceof LlmUnavailable, error: (error as Error).message },
      'no verdict for this line',
    );
    return 'unknown';
  }
}

// The candidates are judged in PARALLEL and the first kept one, in candidate order, is
// posted. All dropped = nothing posted, by design. All UNKNOWN — the judge could not be
// reached at all — posts the first candidate unjudged, logged: an outage of the judge must
// not blank every podium for as long as it lasts, and the candidate passed every check the
// bot ran before the judge existed.
export async function chooseLine(
  provider: LlmProvider,
  occasion: string,
  candidates: readonly string[],
  log: Log,
  takeCall: () => Promise<boolean> = async () => true,
): Promise<string | null> {
  if (candidates.length === 0) return null;
  const verdicts = await Promise.all(
    candidates.map(async (line) => ((await takeCall()) ? judgeLine(provider, occasion, line, log) : ('unknown' as const))),
  );
  const kept = candidates.find((_, i) => verdicts[i] === 'keep');
  if (kept) return kept;
  if (verdicts.every((v) => v === 'unknown')) {
    log.warn({ event: 'line.unjudged', candidates: candidates.length }, 'no verdict came back; posting the first candidate');
    return candidates[0];
  }
  log.info({ event: 'line.all_dropped', candidates: candidates.length, verdicts }, 'the judge kept none of them');
  return null;
}
