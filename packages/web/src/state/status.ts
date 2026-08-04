import type { RoundProgress, WordRoundProgress } from './gameStore';
import { CLAIM_ZONE } from '../game/wordGame';
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

// Word mode's status (#156), same visual grammar off the CACHED derived fields: an
// ENDED run is the day played to its end ("solved" — done for the day, gold), a live
// run with counted guesses is in progress at the fraction of the zone claimed (low
// numbers are honest: the field is deliberately unclaimable in full).
export function wordStatusOf(round: WordRoundProgress | undefined): Status {
  if (!round || round.tried.length === 0) return { kind: 'none' };
  if (round.ended) return { kind: 'solved' };
  return { kind: 'progress', pct: Math.round((100 * round.claimed) / CLAIM_ZONE) };
}

// The screen-reader status fragment appended to a card/cell's aria-label (" — solved",
// " — 45%", or "" for not started). The visual strip is decorative; this carries the
// status for assistive tech. `uiLang` is the chrome language of the surrounding screen.
export function srStatus(uiLang: string, status: Status): string {
  if (status.kind === 'solved') return ` — ${t(uiLang, 'srLangSolved')}`;
  if (status.kind === 'progress') return ` — ${status.pct}%`;
  return '';
}
