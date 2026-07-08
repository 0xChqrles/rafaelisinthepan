import type { RoundProgress } from './gameStore';
import { t } from '../i18n';

// A device-local play status for one (day, lang), read straight from the persisted round
// map WITHOUT loading the puzzle. Shared by the language selector (today's status per
// card) and the archive calendar (#55, each day cell's status) so the two speak the same
// visual language: absent = not started, solved = gold, in progress = a % on the progress
// ramp. Statuses are local to this device — that is expected and fine.
export type Status = { kind: 'none' } | { kind: 'solved' } | { kind: 'progress'; pct: number };

// none     -> no round yet, or visited without a counted guess;
// solved   -> every hole discovered (rank 0);
// progress -> in progress, carrying the cached reconstruction % (never re-derived here).
export function statusOf(round: RoundProgress | undefined): Status {
  if (!round || round.guessCount === 0) return { kind: 'none' };
  if (round.holes.length > 0 && round.holes.every((h) => h.rank === 0)) return { kind: 'solved' };
  return { kind: 'progress', pct: Math.round(round.progress) };
}

// The screen-reader status fragment appended to a card/cell's aria-label (" — solved",
// " — 45%", or "" for not started). The visual strip is decorative; this carries the
// status for assistive tech. `uiLang` is the chrome language of the surrounding screen.
export function srStatus(uiLang: string, status: Status): string {
  if (status.kind === 'solved') return ` — ${t(uiLang, 'srLangSolved')}`;
  if (status.kind === 'progress') return ` — ${status.pct}%`;
  return '';
}
