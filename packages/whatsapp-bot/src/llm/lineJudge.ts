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
// NO EXAMPLES HERE EITHER (v9, user-decided 2026-09-07: "less is better … without giving
// examples that might pollute"). A first cut carried the user's canonical lines to
// calibrate on, and the kept lines leaned toward their kind; the criteria are now the
// same short list the writer is given, and nothing to imitate.

import type { Log } from '../log';
import { LlmUnavailable, type LlmProvider } from './types';

export const JUDGE_SYSTEM = `You are the editor of a WhatsApp bot's one-line comments in a group of friends who play a daily word game. The bot is dry: nonchalant, a little cynical, entirely serious, never trying to be funny. You read ONE line written for ONE occasion and decide whether it is posted.

Post it only if all of this holds: one short flat sentence in plain words; it makes sense at once; it is dry, not enthusiastic; it could not have come from any bot (no praise formula, no consolation formula); it says nothing against the person — the game, the day, the sentence and the bot itself are the only targets. Drop it if it tries to be funny, gushes, explains, piles a clause on a clause, ends with a tail after a comma, compares with "comme", is nonsense, is generic, or is a put-down.

Answer 1 to post, 0 to drop. No line is better than a weak one: be strict. Only the digit.`;

// THE FACT CHECK (user-decided 2026-09-07): the share commentary is written FROM numbers —
// the score, the day's board, the player's habit — so what its judge asks is not whether
// the line is dry but whether it is TRUE to those numbers, and worth saying. A line that
// misplaces somebody or invents an average is worse than no line: it is the bot deciding
// a rank, which is the one thing the boundary forbids.
export const FACT_JUDGE_SYSTEM = `You check a one-line comment a WhatsApp bot is about to post in a group of friends who play a daily word game, against the FACTS the comment was written from. The facts are the truth; the comment may only phrase them.

Post it only if all of this holds: every number, name, position, comparison and claim in it is supported by the facts exactly (a player said to be ahead is ahead in the facts; an average said is the average given; "usually" is backed by the habit given); it says something the facts support that a friend in the group would find worth reading — how the score sits against a typical day, against who has posted, against this player's habit — rather than filler — unless the facts hold nothing notable (the usual leader leading, a score at a player's usual level with nobody passed), in which case a plain, short, accurate acknowledgement is exactly right and is kept; it is one or two short plain sentences with no gushing, no consolation formula, no praise formula, and nothing against the person. Drop it for any invented or wrong number, any claim the facts do not back (a weekday, a mood, a reason, a person not in the facts), or nonsense. Read the facts' own "reading" note first: the habit and the recent days cover the window BEFORE today, so today's score beyond habit.best or habit.worst IS the player's best or worst of the window, today included, and a ∞ today after one in the window IS the second. Rounding (26 for 26.3), a paraphrase ("la quinzaine" for 14 days, "la moyenne d'un jour classique" for the typical median), and an ordinal for a position are NOT errors: judge the substance, not the wording.

Answer the digit first — 1 to post, 0 to drop — then, after a colon, the reason in a few words.`;

export interface JudgeBrief {
  system: string; // which reading: `JUDGE_SYSTEM` (the voice) or `FACT_JUDGE_SYSTEM` (the numbers)
  occasion: string; // what the line is about — for the fact check, the facts themselves
}

export type Verdict = 'keep' | 'drop' | 'unknown';

export interface Judgement {
  verdict: Verdict;
  // The judge's few words after the digit (the fact check asks for them; the voice judge
  // answers the digit alone). Logged, and handed back to the writer when nothing was kept.
  reason?: string;
}

const REASON_MAX_CHARS = 200;

// "1: the placing is right" → keep; "0 — Zou is ahead in the facts" → drop with the reason;
// "sure, 1" → keep (the first digit anywhere, as before); no digit → nothing.
export function parseVerdict(text: string): Judgement | null {
  const at = text.search(/[01]/);
  if (at < 0) return null;
  const reason = text
    .slice(at + 1)
    .replace(/^[\s:\-–—.]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REASON_MAX_CHARS);
  return { verdict: text[at] === '1' ? 'keep' : 'drop', ...(reason ? { reason } : {}) };
}

// Sized to the measurement above: a verdict at `low` is a few hundred reasoning tokens and
// about 4s, with a tail to 12s; the budget refuses nothing it needs, and the cut sits above
// the tail. `unknown` is a verdict that never arrived — a timeout, an outage, a truncated
// answer — and is told apart from `drop` because it says nothing about the line.
const MAX_TOKENS = 3000;
const TIMEOUT_MS = 20_000;

export async function judgeLine(
  provider: LlmProvider,
  brief: JudgeBrief,
  line: string,
  log: Log,
): Promise<Judgement> {
  try {
    const response = await provider.generate({
      system: brief.system,
      messages: [{ role: 'user', content: `Occasion: ${brief.occasion}\nLine: ${line}\n\nAnswer 1 or 0.` }],
      maxTokens: MAX_TOKENS,
      effort: 'low',
      timeoutMs: TIMEOUT_MS,
    });
    const parsed = response.finish === 'stop' ? parseVerdict(response.text ?? '') : null;
    const judgement: Judgement = parsed ?? { verdict: 'unknown' };
    // The reason is logged with the verdict (2026-09-07): a run of drops was unreadable
    // without it — two shares fell back to the emoji and the log said only "drop" thrice.
    log.info(
      { event: 'line.judged', ...judgement, finish: response.finish, latencyMs: response.latencyMs, tokens: response.usage },
      'the judge answered',
    );
    return judgement;
  } catch (error) {
    log.warn(
      { event: 'line.judge_failed', unavailable: error instanceof LlmUnavailable, error: (error as Error).message },
      'no verdict for this line',
    );
    return { verdict: 'unknown' };
  }
}

export interface Choice {
  line: string | null;
  // How many candidates the judge DROPPED (an `unknown` is not a drop), and the reasons it
  // gave for those — what a caller that writes again has to go on.
  dropped: number;
  reasons: string[];
}

// The candidates are judged in PARALLEL and the first kept one, in candidate order, is
// posted. All dropped = nothing posted, by design. All UNKNOWN — the judge could not be
// reached at all — posts the first candidate unjudged, logged: an outage of the judge must
// not blank every podium for as long as it lasts, and the candidate passed every check the
// bot ran before the judge existed.
export async function chooseLine(
  provider: LlmProvider,
  brief: JudgeBrief,
  candidates: readonly string[],
  log: Log,
  takeCall: () => Promise<boolean> = async () => true,
): Promise<Choice> {
  if (candidates.length === 0) return { line: null, dropped: 0, reasons: [] };
  const judgements = await Promise.all(
    candidates.map(async (line) => ((await takeCall()) ? judgeLine(provider, brief, line, log) : { verdict: 'unknown' as const })),
  );
  const verdicts = judgements.map((j) => j.verdict);
  const kept = candidates.find((_, i) => verdicts[i] === 'keep');
  if (kept) return { line: kept, dropped: 0, reasons: [] };
  if (verdicts.every((v) => v === 'unknown')) {
    log.warn({ event: 'line.unjudged', candidates: candidates.length }, 'no verdict came back; posting the first candidate');
    return { line: candidates[0], dropped: 0, reasons: [] };
  }
  const reasons = judgements.flatMap((j) => (j.verdict === 'drop' && j.reason ? [j.reason] : []));
  log.info({ event: 'line.all_dropped', candidates: candidates.length, verdicts, reasons }, 'the judge kept none of them');
  return { line: null, dropped: verdicts.filter((v) => v === 'drop').length, reasons };
}
