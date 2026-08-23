import type { WordRoundProgress } from './gameStore';
import { CLAIM_ZONE } from '../game/wordGame';
import { t } from '../i18n';

// A play status for one (day, lang), read WITHOUT loading the puzzle. Shared by the
// language selector (today's status per card) and the archive calendar (#55, each day
// cell's status) so the two speak the same visual language: absent = not started,
// finished = gold, in progress = a % on the app's one heat ramp.
//
// FINISHED has two words for two games (#163): a sentence is SOLVED, a word run whose
// clock ran out is DONE — it is finished, not solved, and calling it solved would claim
// an achievement the mode does not have. They render identically (the same gold), so the
// distinction is the SPOKEN one; `isComplete` is what the visual surfaces read, in one
// place, so neither of them restates the pair.
export type Status =
  | { kind: 'none' }
  | { kind: 'solved' }
  | { kind: 'done' }
  | { kind: 'progress'; pct: number };

// Done for the day, whichever game said so — full gold, full strip, a filled cell.
export function isComplete(status: Status): boolean {
  return status.kind === 'solved' || status.kind === 'done';
}

// What a summary surface needs to know about one sentence round, and all it needs: the two
// values the SERVER derives from the log it stores and writes onto the round row (#203).
// #211 is the read that supplies them — one Query per month, the calendar's own source —
// and until it lands nothing produces them, so the archive and the chooser pass `undefined`
// and every sentence day reads as not started. That is the deliberate seam: #214 removed
// the persisted materialized view these surfaces used to read, and #211 ships with it. See
// the Ordering note on both issues — neither reaches production alone.
export interface RoundSummary {
  // Reconstruction progress (0–100). A #214 CAPPED round stays UNSOLVED and keeps the
  // percentage it reached — the cap changes the result's headline, not the day's fill.
  progress: number;
  // The server has read this round's log as solved. Only ever true.
  solved: boolean;
}

// none     -> nothing known about this day (no round yet, or no summary loaded);
// solved   -> the server holds this round's solve;
// progress -> in progress, carrying the reconstruction % (never re-derived here).
export function statusOf(summary: RoundSummary | undefined): Status {
  if (!summary) return { kind: 'none' };
  if (summary.solved) return { kind: 'solved' };
  if (summary.progress <= 0) return { kind: 'none' };
  return { kind: 'progress', pct: Math.round(summary.progress) };
}

// Word mode's status (#156, retimed by #163), same visual grammar off the round's own
// two facts: a round still at the rules gate has not started, a run past its DEADLINE is
// the day played out ("done" — gold), and a live run is in progress at the fraction of
// the zone claimed (low numbers are honest: the field is deliberately unclaimable in
// full). The clock is wall-clock, so this reads `now` — it is never a stored boolean, and
// a tab closed mid-run comes back to a finished day (there is no pause, by decision).
export function wordStatusOf(
  round: WordRoundProgress | undefined,
  now: number = Date.now(),
): Status {
  if (!round || round.startedAt === null || round.deadline === null) return { kind: 'none' };
  if (now > round.deadline) return { kind: 'done' };
  return { kind: 'progress', pct: Math.round((100 * round.claimed) / CLAIM_ZONE) };
}

// The screen-reader status fragment appended to a card/cell's aria-label (" — solved",
// " — done", " — 45%", or "" for not started). The visual strip is decorative; this
// carries the status for assistive tech. `uiLang` is the chrome language of the
// surrounding screen.
export function srStatus(uiLang: string, status: Status): string {
  if (status.kind === 'solved') return ` — ${t(uiLang, 'srLangSolved')}`;
  if (status.kind === 'done') return ` — ${t(uiLang, 'srWordDone')}`;
  if (status.kind === 'progress') return ` — ${status.pct}%`;
  return '';
}
