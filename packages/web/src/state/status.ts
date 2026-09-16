import { t } from '../i18n';

// A play status for one (day, lang), read WITHOUT loading the puzzle — the archive
// calendar's (#55, each day cell's status): absent = not started, solved = gold, in
// progress = a % on the app's one heat ramp.
//
// UNKNOWN is #211's: the private summary this day's status comes from has not ARRIVED, so
// nothing can honestly be said about it. It is deliberately NOT `none` — "not started" is a
// CLAIM, and a whole calendar of false ones is exactly what the explicit-loading rule
// exists to prevent. `loading` only decides whether the placeholder breathes, and it means
// a read is IN FLIGHT: breathing promises an answer is coming, so a read that failed — and
// a surface that never asked — both rest still.
export type Status =
  | { kind: 'none' }
  | { kind: 'unknown'; loading: boolean }
  | { kind: 'solved' }
  | { kind: 'progress'; pct: number };

// What a summary surface needs to know about one sentence round, and all it needs: the two
// values the SERVER derives from the log it stores and writes onto the round row (#203).
// #211 is the read that supplies them — ONE Query per (month, language), held in
// memory by `state/history.ts` and revalidated whenever a month becomes the view on screen.
// `undefined` here means the server holds NO ROUND for that day; a summary that has not
// ARRIVED is a different thing entirely and never reaches this function — the surfaces
// render their loading state off the read's own phase, because a month of `{kind:'none'}`
// cells is the claim "none of these days was started", and a false one.
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

// The screen-reader status fragment appended to a card/cell's aria-label (" — solved",
// " — 45%", or "" for not started). The visual strip is decorative; this
// carries the status for assistive tech. `uiLang` is the chrome language of the
// surrounding screen.
export function srStatus(uiLang: string, status: Status): string {
  if (status.kind === 'solved') return ` — ${t(uiLang, 'srLangSolved')}`;
  if (status.kind === 'progress') return ` — ${status.pct}%`;
  // The visual placeholder says "not yet" by breathing; a reader gets it in words rather
  // than the silence a not-started day answers with.
  if (status.kind === 'unknown') return ` — ${t(uiLang, 'srStatusUnknown')}`;
  return '';
}
