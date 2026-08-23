// The PRIVATE player history (#211), client side: what the SUMMARY surfaces read now that
// #214 has removed the persisted sentence round.
//
// Opening a daily still loads its complete authoritative round (`state/roundSync.ts`), but
// the archive calendar, the language chooser and the streak cannot open every daily merely
// to discover what happened — so they read the server's own summary instead: one Query per
// (month, language, mode) for the calendar, and the language's solved-day collection for
// the streak. Both come back from ONE call, because both are facts about the same player.
//
// **The cache is IN-MEMORY and nothing here is persisted.** Archive days are playable, so a
// past month is not immutable — playing an old daily changes it, and another device can do
// the same — which is why a month REVALIDATES whenever it becomes the view on screen (the
// hook's own effect) rather than being trusted from an earlier visit. Nothing is written to
// localStorage: a second source of truth for a day's progress is exactly what #214 removed.
//
// **Loading is EXPLICIT.** A month that has not arrived is `days: null`, never an empty map:
// an empty map is the claim "none of these days was started", and a false one paints a whole
// calendar as untouched. The screens render a loading state off that null. There is no local
// fallback.

import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { boundSolvedDays } from '@whippin/shared';
import { historyUrl, parsePlayerHistory, postHistoryBody } from '../api';
import { playerSecret } from '../identity';
import type { Mode } from '../langs';
import { statusOf, type RoundSummary, type Status } from './status';

// Where one summary read is. `idle` = nothing has asked for it (a Word mode archive never
// asks); the rest are the read's own three outcomes.
export type HistoryPhase = 'idle' | 'loading' | 'ready' | 'failed';

interface MonthEntry {
  phase: HistoryPhase;
  // The month's per-day summaries, keyed by ISO date. NULL until a read has landed — see
  // the explicit-loading rule above. A day the server holds no round for is simply ABSENT,
  // which is how "not started" is said.
  days: Map<string, RoundSummary> | null;
}

interface SolvedEntry {
  phase: HistoryPhase;
  // The language's solved game days, ascending. NULL until a read has landed: the streak
  // choreography needs the PREVIOUS value, and a guess at it would print a wrong number.
  days: number[] | null;
}

export interface HistoryState {
  months: Record<string, MonthEntry>;
  solved: Record<string, SolvedEntry>;
}

// Transient by construction — nothing here is persisted, and the store is exported for the
// same reason `useGameStore` is: the contract tests read it directly rather than through a
// second, test-only accessor that could describe something the app never sees.
export const useHistoryStore = create<HistoryState>(() => ({ months: {}, solved: {} }));

const IDLE_MONTH: MonthEntry = { phase: 'idle', days: null };
const IDLE_SOLVED: SolvedEntry = { phase: 'idle', days: null };

const monthKey = (lang: string, mode: Mode, month: string) => `${lang}:${mode}:${month}`;

// ONE conversation per request key, shared across component lifetimes (the
// `activeScoreFlights` pattern): the chooser mounts two languages at once and React's
// development effect replay fires every effect twice, and neither may mint a second read.
// A settled flight leaves the map, so the NEXT mount revalidates — which is the whole
// caching policy.
const flights = new Map<string, Promise<void>>();

function setMonth(key: string | null, entry: (previous: MonthEntry) => MonthEntry): void {
  if (key === null) return;
  useHistoryStore.setState((state) => ({
    months: { ...state.months, [key]: entry(state.months[key] ?? IDLE_MONTH) },
  }));
}

function setSolved(lang: string, entry: (previous: SolvedEntry) => SolvedEntry): void {
  useHistoryStore.setState((state) => ({
    solved: { ...state.solved, [lang]: entry(state.solved[lang] ?? IDLE_SOLVED) },
  }));
}

// Exported for the contract test — the one that has to drive a real ANSWER through the
// commit path rather than restate what it should do (`useScoreHistogram`'s own rule).
// Callers still use the hook below.
export async function loadPlayerHistory(
  lang: string,
  mode: Mode,
  month: string | undefined,
): Promise<void> {
  const key = `${lang}:${mode}:${month ?? ''}`;
  const existing = flights.get(key);
  if (existing) return existing;

  const monthId = month === undefined ? null : monthKey(lang, mode, month);
  const flight = (async () => {
    // A REVALIDATION keeps the values it already holds while the fresh read is in flight —
    // stale-but-good beats a skeleton over a month the player was just looking at (the
    // leaderboard's rule). Only a month that has NEVER landed renders as loading.
    setMonth(monthId, (previous) => ({ phase: 'loading', days: previous.days }));
    setSolved(lang, (previous) => ({ phase: 'loading', days: previous.days }));
    try {
      const response = await postHistoryBody(historyUrl(lang, mode, month), {
        secret: playerSecret(),
      });
      if (!response.ok) throw new Error(`history read failed: ${response.status}`);
      const history = parsePlayerHistory(await response.json());
      setMonth(monthId, () => ({
        phase: 'ready',
        days: new Map(
          history.days.map((day) => [day.date, { progress: day.progress, solved: day.solved }]),
        ),
      }));
      // **The collection is MERGED, never replaced** (corrected on review). A read started
      // before a solve can land after `noteSolvedDay` has credited it — the read was issued
      // against a log the append had not reached — and replacing would then take the day
      // straight back out from under a mounted `StreakDialog`, which counts its transition
      // off exactly this array. A union is the honest reconciliation and not merely the safe
      // one: within a language the collection only ever GROWS (the server never un-credits,
      // and a republish does not take a day back), and the only value this client ever adds
      // is a solve the server is recording anyway. `boundSolvedDays` sorts, dedupes and caps
      // the result, so a union of two bounded sets stays one bounded set.
      setSolved(lang, (previous) => ({
        phase: 'ready',
        days: boundSolvedDays([...(previous.days ?? []), ...history.solvedDays]),
      }));
    } catch {
      // Offline, a refusal, a malformed body — all the same outcome: the surfaces say the
      // summary could not be had, and offer to ask again. There is no local fallback.
      setMonth(monthId, (previous) => ({ phase: 'failed', days: previous.days }));
      setSolved(lang, (previous) => ({ phase: 'failed', days: previous.days }));
    }
  })();

  flights.set(key, flight);
  void flight.then(() => {
    if (flights.get(key) === flight) flights.delete(key);
  });
  return flight;
}

export interface HistoryView {
  // The asked-for month, null until it lands (and on a screen that asked for none).
  days: Map<string, RoundSummary> | null;
  daysPhase: HistoryPhase;
  // The language's solved game days, null until they land.
  solvedDays: number[] | null;
  solvedPhase: HistoryPhase;
  // Ask again after a failure. Nothing else retries: a navigation read has no queue.
  retry: () => void;
}

// Read one player's private history. `month` is omitted by the surfaces that only need the
// streak (the game screen), which is what keeps a game load from spending a whole
// calendar's Query. `enabled` is false where the summary is not the server's at all — Word
// mode's calendar is still local state (#214 deliberately kept its clock/outbox), and a
// server-backed Word month needs its own product contract.
export function usePlayerHistory({
  lang,
  mode = 'sentence',
  month,
  enabled = true,
}: {
  lang: string;
  mode?: Mode;
  month?: string;
  enabled?: boolean;
}): HistoryView {
  const monthId = month === undefined ? null : monthKey(lang, mode, month);
  const monthEntry = useHistoryStore((state) =>
    monthId === null ? undefined : state.months[monthId],
  );
  const solvedEntry = useHistoryStore((state) => state.solved[lang]);

  // REVALIDATE whenever this (language, mode, month) becomes the view on screen — a mount,
  // a month step, a language switch. An archive day is playable, so a past month is not
  // immutable and an earlier visit's answer is not evidence.
  useEffect(() => {
    if (!enabled) return;
    void loadPlayerHistory(lang, mode, month);
  }, [enabled, lang, mode, month]);

  const retry = useCallback(() => {
    if (enabled) void loadPlayerHistory(lang, mode, month);
  }, [enabled, lang, mode, month]);

  const monthState = monthEntry ?? IDLE_MONTH;
  const solvedState = solvedEntry ?? IDLE_SOLVED;
  return {
    days: monthState.days,
    daysPhase: monthState.phase,
    solvedDays: solvedState.days,
    solvedPhase: solvedState.phase,
    retry,
  };
}

// One SENTENCE day's status, straight off a month read — the one place the difference
// between "the server holds no round for this day" and "this month has not arrived" is
// turned into something a surface can draw. A missing DAY is `none`; a missing MONTH is
// `unknown`, and the two must never collapse into each other.
//
// `loading` says a read is IN FLIGHT, so it is read off that phase alone — never as "not
// failed". The placeholder breathes to mean "an answer is coming", and an IDLE surface (one
// whose read is disabled, or the frame before the effect fires) has nothing coming: it must
// rest still, like a read that failed. Idle is unreachable on today's surfaces — Word mode
// is the only `enabled: false` caller and it reads `wordStatusOf` instead — but a
// placeholder that breathes forever with no request behind it is the exact false promise
// the explicit-loading rule exists to prevent.
export function daySummaryStatus(view: HistoryView, date: string): Status {
  if (view.days === null) return { kind: 'unknown', loading: view.daysPhase === 'loading' };
  return statusOf(view.days.get(date));
}

// The solved-day collection alone, as a plain STORE READ with no fetch of its own — for a
// surface that only ever renders inside one that already loaded it (`StreakDialog`, which
// the game screen mounts).
export function useSolvedDays(lang: string): number[] | null {
  return useHistoryStore((state) => state.solved[lang]?.days ?? null);
}

// Credit a freshly solved day to the transient collection — the client half of what the
// server records on the append that confirms the solve (#211). It reports whether this call
// actually inserted the day, which is the signal the celebration rides: a re-solve, an
// archive replay and a rehydration must not replay the streak's progression.
//
// **ON TIME means ON THE DAY** (user-decided 2026-08-23), which is the SAME rule the server
// credits by: the solved day must BE the active day. A round finished at 22:00:01 was not
// finished on time, and an archive replay never was — one comparison now says both.
// It replaced a window that tolerated `activeDay - 1` for the flip-edge, plus an ACTIVE-DAY
// gate at the caller to tell that edge from an archive replay of yesterday, the two being
// numerically identical. With the edge ruled late there is nothing to disambiguate, so the
// caller's gate went with the tolerance.
//
// A day already held is not inserted twice, which is why a re-published puzzle cannot claim
// the same day again. And a collection that has NOT LOADED credits nothing and celebrates
// nothing: the previous value is what the choreography counts from, there is no honest way
// to guess it, and the server still records the solve either way.
export function noteSolvedDay(lang: string, solvedDay: number, activeDay: number): boolean {
  if (solvedDay !== activeDay) return false;
  const held = useHistoryStore.getState().solved[lang]?.days;
  if (!held || held.includes(solvedDay)) return false;
  setSolved(lang, (previous) => ({
    phase: previous.phase,
    days: boundSolvedDays([...(previous.days ?? []), solvedDay]),
  }));
  return true;
}

// Test seam: drop every cached summary and conversation (module state must not leak
// between tests).
export function resetPlayerHistory(): void {
  flights.clear();
  useHistoryStore.setState({ months: {}, solved: {} }, true);
}
