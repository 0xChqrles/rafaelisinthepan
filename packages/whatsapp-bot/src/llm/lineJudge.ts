// THE JUDGE (2026-09-07): a second, REASONING call that reads one candidate line and says
// whether it is posted. Selection is the lever construction was not: the writer stays
// free, writes several candidates with its thinking off (about a second each), and a
// strict reader with its thinking ON keeps or drops each one. Since #277 both comment
// paths write from FACTS, so the one reading here is the FACT CHECK: is every number,
// name, placing and claim in the line backed by what the writer was given. A dropped line
// costs nothing the group sees — the share gets the emoji, the podium goes out without
// comments — where a wrong one is the bot deciding a rank.
//
// ONE LINE PER CALL, never "pick the best of N". Measured against 41 lines the user had
// rated: single verdicts at `reasoning_effort: low` rejected 23 of 23 bad lines and kept
// 8-9 of 18 good ones, median 4s; asked to choose among four, the same model reasoned for
// 12-25s, truncated, and landed at half accuracy — comparison is a much harder question
// than "is this one good", and the podium Lambda's 90s cannot hold it. Precision over
// recall is the right trade for a filter: the candidates supply the recall. `high` effort
// truncated a third of its verdicts at the same budget and bought nothing.
//
import type { Log } from '../log';
import { LlmUnavailable, type LlmProvider } from './types';

// THE FACT CHECK (user-decided 2026-09-07): the share commentary is written FROM numbers —
// the score, the day's board, where the player usually lands — so what its judge asks is
// not whether the line is dry but whether it is TRUE to those numbers, and worth saying. A
// line that misplaces somebody or invents a record is worse than no line: it is the bot
// deciding a rank, which is the one thing the boundary forbids. AND A SCORE HELD AGAINST
// ANOTHER DAY'S IS DROPPED EVEN WHEN IT IS TRUE (user-decided 2026-09-14): what a day costs
// depends on its sentence, so it says nothing — and the facts no longer carry one, but the
// diary and the day's conversation a podium line is shown still do.
export const FACT_JUDGE_SYSTEM = `You check a one-line comment a WhatsApp bot is about to post in a group of friends who play a daily word game, against the FACTS the comment was written from — and, when one is given after them, the day's conversation and the bot's diary of the group. The facts are the truth; the comment may only phrase them. A callback to something said in the conversation or noted in the diary is supported when it is there; a claim about a person that is in neither is invented.

Post it only if all of this holds: every number, name, place, comparison and claim in it is supported by the facts exactly (a player said to be above is above in the facts; a record said is the record given; "usually" is backed by the form given); it says something the facts support that a friend in the group would find worth reading — where the score lands among the day's other players, how the others did, how that compares with where this player usually lands among them — rather than filler — unless the facts hold nothing notable (the usual leader leading, a player landing where they usually land), in which case a plain, short, accurate acknowledgement is exactly right and is kept; it is one or two short sentences. Drop it when it compares the score — the number of tries — with the number of tries of ANOTHER day (a past score, an average score, a best or a worst, what a day usually costs), even a true one, even one taken from the conversation or the diary. Comparing where the player lands today (their place, who they beat) with where they usually land (how many they usually beat, their recent places, their record against somebody) is what the line is for, and is kept. How it sounds is not yours to judge: boasting, rudeness, sulking, tenderness and self-congratulation are all in character and none of them is a reason to drop a line. Drop it for any invented or wrong number, any claim the facts do not back (a weekday, a mood, a reason, a person not in the facts), a line that mixes two people up (the bot itself included: it keeps the scores, it plays against nobody), a sentence that is not correct in its language (a wrong verb form, a broken sentence), or nonsense. Read the facts' own "reading" note first: the form covers the days BEFORE today and never includes it. Rounding, a paraphrase ("la quinzaine" for 14 days, "trois sur quatre" for 3 in 4, "presque tout le monde" for 9 in 10), and an ordinal for a place are NOT errors: judge the substance, not the wording.

Answer the digit first — 1 to post, 0 to drop — then, after a colon, the reason in a few words.`;

export interface JudgeBrief {
  system: string; // the reading: `FACT_JUDGE_SYSTEM`
  occasion: string; // what the line is about — for the fact check, the facts themselves
}

export type Verdict = 'keep' | 'drop' | 'unknown';

export interface Judgement {
  verdict: Verdict;
  // The judge's few words after the digit. Logged, and handed back to the writer when
  // nothing was kept.
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

// Sized to the measurement: a verdict at `low` was a few hundred reasoning tokens and
// about 4s over the band-word facts; over the form facts (2026-09-14: rivals and records
// for everybody on the board) the median verdict is ~1100 output tokens in 6s, p90 11s,
// and 17% of them ran into a 3000-token budget at ~15s and came back as no verdict at
// all. 4500 is what the timeout can hold at the measured ~200 tokens a second. `unknown`
// is a verdict that never arrived — a timeout, an outage, a truncated answer — and is
// told apart from `drop` because it says nothing about the line.
const MAX_TOKENS = 4500;
// Exported: the podium's round budget is a writer call plus one of these (`ROUND_MS`).
export const JUDGE_TIMEOUT_MS = 25_000;
const TIMEOUT_MS = JUDGE_TIMEOUT_MS;

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
// reached at all — is the caller's call (`unjudged`): the PODIUM posts the first candidate
// unjudged, logged, because an outage of the judge must not blank every podium for as
// long as it lasts; the SHARE line posts nothing, because the emoji stands in for it
// anyway and a line nobody checked is how "un gars qui me bat une fois sur deux" (the bot
// confusing itself with a rival) reached a group (2026-09-14).
export async function chooseLine(
  provider: LlmProvider,
  brief: JudgeBrief,
  candidates: readonly string[],
  log: Log,
  takeCall: () => Promise<boolean> = async () => true,
  unjudged: 'post-first' | 'post-none' = 'post-first',
): Promise<Choice> {
  if (candidates.length === 0) return { line: null, dropped: 0, reasons: [] };
  const judgements = await Promise.all(
    candidates.map(async (line) => ((await takeCall()) ? judgeLine(provider, brief, line, log) : { verdict: 'unknown' as const })),
  );
  const verdicts = judgements.map((j) => j.verdict);
  const kept = candidates.find((_, i) => verdicts[i] === 'keep');
  if (kept) return { line: kept, dropped: 0, reasons: [] };
  if (verdicts.every((v) => v === 'unknown')) {
    const post = unjudged === 'post-first';
    log.warn({ event: 'line.unjudged', candidates: candidates.length, posted: post }, post ? 'no verdict came back; posting the first candidate' : 'no verdict came back; posting nothing');
    return { line: post ? candidates[0] : null, dropped: 0, reasons: [] };
  }
  const reasons = judgements.flatMap((j) => (j.verdict === 'drop' && j.reason ? [j.reason] : []));
  log.info({ event: 'line.all_dropped', candidates: candidates.length, verdicts, reasons }, 'the judge kept none of them');
  return { line: null, dropped: verdicts.filter((v) => v === 'drop').length, reasons };
}
