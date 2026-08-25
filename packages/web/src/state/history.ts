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
// persistent storage: a second source of truth for a day's progress is exactly what #214 removed.
//
// **Loading is EXPLICIT.** A month that has not arrived is `days: null`, never an empty map:
// an empty map is the claim "none of these days was started", and a false one paints a whole
// calendar as untouched. The screens render a loading state off that null. There is no local
// fallback.
//
// **No token, no fetch** (#216). An identity that has never been bootstrapped cannot own
// server rows, so its calendar, chooser and streak are known-empty WITHOUT a request — and
// asking would be a private read on a visit that has performed none of the deliberate acts
// that create an identity. That is an ANSWER, not a loading state: the surfaces render an
// unplayed month and a zero streak, exactly as they would for a player who has played
// nothing.

import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { boundSolvedDays } from '@whippin/shared';
import { historyUrl, parsePlayerHistory, postHistoryBody } from '../api';
import {
  deviceIdentity,
  identityEpoch,
  identityEpochOf,
  markDeviceSignedOut,
} from '../identity';
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

// WHICH flight drives `solved[lang]`'s PHASE: the most recently started one that reads the
// collection. The entry is keyed by language while several (lang, mode, month) flights can
// be in the air at once — paging the archive quickly does exactly that — and letting every
// settle write the phase is a last-writer-wins race: a failing OLD month read landing last
// stamps `failed` onto a collection that loaded fine. The DAYS still merge off every
// successful answer (data is data); only the phase is driver-only.
const solvedReads = new Map<string, string>();

// The reads answered KNOWN-EMPTY because this device held no identity, kept so an identity
// ADOPTED from another tab (#216) can replay exactly them: those answers were about a
// device with no account, and the adopted account may hold the rows they claimed absent.
// A MINTED first identity never replays them — that account is empty by construction, so
// the tokenless answers stay true.
const answeredTokenless = new Map<string, [string, Mode, string | undefined, boolean]>();

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
  // `false` opts OUT of the solved-day collection — the language chooser wants a month
  // strip and never renders the streak, so its read must not spend the collection's
  // consistent GetItem (the request says so in its body, and this flight leaves the
  // solved entry entirely alone).
  collection = true,
): Promise<void> {
  const key = `${lang}:${mode}:${month ?? ''}:${collection ? 'c' : ''}`;
  const existing = flights.get(key);
  if (existing) return existing;

  const monthId = month === undefined ? null : monthKey(lang, mode, month);
  const identity = deviceIdentity();
  if (!identity) {
    // Known empty, and said as an ANSWER — `ready` with real values, never `idle` or a
    // pending null, or every surface would breathe forever behind a request nobody made.
    // A collection-less flight still leaves the solved entry entirely alone. The request
    // is remembered so a later ADOPTED identity can replay it (`rearmPlayerHistory`).
    answeredTokenless.set(key, [lang, mode, month, collection]);
    setMonth(monthId, (previous) => ({ phase: 'ready', days: previous.days ?? new Map() }));
    if (collection) {
      setSolved(lang, (previous) => ({ phase: 'ready', days: previous.days ?? [] }));
    }
    return;
  }
  const epoch = identityEpochOf(identity);
  const flight = (async () => {
    // A REVALIDATION keeps the values it already holds while the fresh read is in flight —
    // stale-but-good beats a skeleton over a month the player was just looking at (the
    // leaderboard's rule). Only a month that has NEVER landed renders as loading.
    setMonth(monthId, (previous) => ({ phase: 'loading', days: previous.days }));
    if (collection) {
      // This flight is now the one DRIVING the collection's phase (see `solvedReads`).
      solvedReads.set(lang, key);
      setSolved(lang, (previous) => ({ phase: 'loading', days: previous.days }));
    }
    try {
      const response = await postHistoryBody(historyUrl(lang, mode, month), {
        token: identity.token,
        ...(collection ? {} : { collection: false }),
      });
      if (!response.ok) {
        // The distinct signed-out answer (#216) raises the screen that explains it; every
        // other refusal is the ordinary failure below. A 5xx never signs anyone out.
        if (response.status === 401) await noteSignedOut(response, epoch);
        throw new Error(`history read failed: ${response.status}`);
      }
      const history = parsePlayerHistory(await response.json());
      // An answer that outlived the identity that asked for it describes an account this
      // device no longer acts as; committing it would walk that account's history into the
      // new one's surfaces.
      if (identityEpoch() !== epoch) return;
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
      //
      // **And a merge that changes NOTHING keeps the array it already holds.** Every commit
      // minting a fresh identity restarted `StreakDialog`'s whole celebration mid-air: the
      // dialog's master sequence effect depends on arrays derived from this one, and a
      // mount-time read landing while the dialog is open replayed it from the opening fade
      // for an answer that said nothing new.
      if (collection) {
        setSolved(lang, (previous) => {
          const merged = boundSolvedDays([...(previous.days ?? []), ...history.solvedDays]);
          const days =
            previous.days !== null &&
            previous.days.length === merged.length &&
            previous.days.every((day, index) => day === merged[index])
              ? previous.days
              : merged;
          return { phase: 'ready', days };
        });
        if (solvedReads.get(lang) === key) solvedReads.delete(lang);
      }
    } catch {
      // The scope listener has already cleared the old account's cache. A late failure from
      // it must not recreate FAILED entries in the new account's otherwise-empty store.
      if (identityEpoch() !== epoch) return;
      // Offline, a refusal, a malformed body — all the same outcome: the surfaces say the
      // summary could not be had, and offer to ask again. There is no local fallback.
      setMonth(monthId, (previous) => ({ phase: 'failed', days: previous.days }));
      // Only the DRIVING flight may fail the collection's phase: a stale month's failure
      // landing last must not report a collection another read just delivered (or is
      // about to) as unreadable.
      if (collection && solvedReads.get(lang) === key) {
        solvedReads.delete(lang);
        setSolved(lang, (previous) => ({ phase: 'failed', days: previous.days }));
      }
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
  collection = true,
}: {
  lang: string;
  mode?: Mode;
  month?: string;
  enabled?: boolean;
  // `false` skips the solved-day collection (the chooser: a month strip, no streak) —
  // see `loadPlayerHistory`.
  collection?: boolean;
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
    void loadPlayerHistory(lang, mode, month, collection);
  }, [enabled, lang, mode, month, collection]);

  const retry = useCallback(() => {
    if (enabled) void loadPlayerHistory(lang, mode, month, collection);
  }, [enabled, lang, mode, month, collection]);

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
// **ON TIME means ON THE DAY** (user-decided 2026-08-23), and since the PR-218 review
// `credited` is the SERVER's own verdict, carried on the solving append's answer, rather
// than a comparison this client re-makes on its own clock. The two clocks can disagree:
// the route tolerates one day of skew, so a fast device can play "tomorrow's" puzzle,
// celebrate a streak advance the server refused, and hold a phantom day the union merge
// can never remove — a streak that silently drops back on the next reload. One predicate,
// one clock, and this half only READS the answer. An archive replay and a flip-edge finish
// both come back uncredited, exactly as the one comparison ruled before.
//
// A day already held is not inserted twice, which is why a re-published puzzle cannot claim
// the same day again. And a collection that has NOT LOADED credits nothing and celebrates
// nothing: the previous value is what the choreography counts from, there is no honest way
// to guess it, and the server still records the solve either way.
export function noteSolvedDay(lang: string, solvedDay: number, credited: boolean): boolean {
  if (!credited) return false;
  const held = useHistoryStore.getState().solved[lang]?.days;
  if (!held || held.includes(solvedDay)) return false;
  setSolved(lang, (previous) => ({
    phase: previous.phase,
    days: boundSolvedDays([...(previous.days ?? []), solvedDay]),
  }));
  return true;
}

// Read the refusal's own code: only `unknown_device` means signed out, and the status alone
// would do it for any other 401 this route might ever answer.
async function noteSignedOut(response: Response, epoch: string): Promise<void> {
  try {
    const data = (await response.json()) as { error?: unknown };
    if (data.error === 'unknown_device') markDeviceSignedOut(epoch);
  } catch {
    // A refusal with no readable body says nothing about the device.
  }
}

// A FIRST identity ADOPTED from another tab (#216): replay every read the tokenless branch
// answered as known-empty, now under the token — the adopted account may hold the months
// and the collection those answers claimed absent, and the hooks' own effects will not
// refire for an identity arriving under a mounted surface. The stale ready-empty entries
// are kept on screen while the real answers load (the revalidation rule). identityScope
// calls this only on `adopted` — a minted account is empty and its answers stay true.
export function rearmPlayerHistory(): void {
  const replay = [...answeredTokenless.values()];
  answeredTokenless.clear();
  for (const [lang, mode, month, collection] of replay) {
    void loadPlayerHistory(lang, mode, month, collection);
  }
}

// Test seam: drop every cached summary and conversation (module state must not leak
// between tests).
export function resetPlayerHistory(): void {
  flights.clear();
  solvedReads.clear();
  answeredTokenless.clear();
  useHistoryStore.setState({ months: {}, solved: {} }, true);
}
