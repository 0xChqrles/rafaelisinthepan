import type { HistoryDay } from '@whippin/shared';
import { t } from '../i18n';

// A play status for one (day, lang), read WITHOUT loading the puzzle — the archive
// calendar's (#55, each day's key): absent = not started, solved = cobalt, in progress = a %
// on the app's one heat ramp, over = the round ended unsolved (given up, or capped): a door
// to its result, not a day to resume.
//
// UNKNOWN is #211's: the private summary this day's status comes from has not ARRIVED, so
// nothing can honestly be said about it. It is deliberately NOT `none` — "not started" is a
// CLAIM, and a whole calendar of false ones is exactly what the explicit-loading rule
// exists to prevent. Whether a read is on its way is the month's, not the day's: the
// calendar reads it off the read's own phase.
export type Status =
  | { kind: 'none' }
  | { kind: 'unknown' }
  | { kind: 'solved' }
  | { kind: 'over' }
  | { kind: 'progress'; pct: number };

// What a summary surface needs to know about one sentence round, and all it needs: the values
// the SERVER derives from the log it stores (#203) and whether the round is over — the shared
// history day, less the date it is keyed by. #211 is the read that supplies them — ONE Query
// per (month, language), held in memory by `state/history.ts` and revalidated whenever a
// month becomes the view on screen. `undefined` here means the server holds NO ROUND for that
// day; a summary that has not ARRIVED is a different thing entirely and never reaches this
// function — the surfaces render their loading state off the read's own phase, because a
// month of `{kind:'none'}` cells is the claim "none of these days was started", and a false
// one.
export type RoundSummary = Omit<HistoryDay, 'date'>;

// none     -> nothing known about this day (no round yet, or no summary loaded);
// solved   -> the server holds this round's solve;
// over     -> the server reads the round as ended unsolved — BEFORE the 0% rule, so a give-up
//             after only misses is never "not started";
// progress -> in progress, carrying the reconstruction % (never re-derived here).
export function statusOf(summary: RoundSummary | undefined): Status {
  if (!summary) return { kind: 'none' };
  if (summary.solved) return { kind: 'solved' };
  if (summary.over) return { kind: 'over' };
  if (summary.progress <= 0) return { kind: 'none' };
  return { kind: 'progress', pct: Math.round(summary.progress) };
}

// The screen-reader status fragment appended to a cell's aria-label (" — solved", " — 45%",
// " — unsolved", or "" for not started). The visual key is decorative; this carries the
// status for assistive tech. `uiLang` is the chrome language of the surrounding screen.
export function srStatus(uiLang: string, status: Status): string {
  if (status.kind === 'solved') return ` — ${t(uiLang, 'srLangSolved')}`;
  if (status.kind === 'progress') return ` — ${status.pct}%`;
  if (status.kind === 'over') return ` — ${t(uiLang, 'srUnsolved')}`;
  // The ghost says "not yet" to the eye; a reader gets it in words rather than the silence a
  // not-started day answers with.
  if (status.kind === 'unknown') return ` — ${t(uiLang, 'srStatusUnknown')}`;
  return '';
}
