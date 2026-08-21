// The #201 sync engine: the server owns each round's guess log from the first guess,
// whether or not an account is ever linked. Local state stays the WORKING COPY — the
// judge of every guess (a submit must never round-trip before the board reacts) and the
// write buffer — and this engine keeps the server's copy converged behind it.
//
//   guess lands -> board reacts -> POST goes out -> response reconciles.
//
// Writes are COALESCED (sentence mode streams: fast typing accumulates while the
// ~ROUND_WRITE_MIN_MS pacing waits, then flushes as one batch) and every answer carries
// the FULL stored log, which is adopted as truth — so an open tab reconciles on its own
// next write, and a second device's tries merge into the same board. Failed or slow
// writes queue and retry with a capped backoff: the game still works on a bad
// connection, because durability lives in the persisted `tried` log, not in the queue —
// a killed tab catches up on the next visit's read, which diffs the server log against
// localStorage and flushes the difference. That read is also what makes a player's full
// history follow them to a new device (#201), archive rounds included.
//
// At ROUND_GUESS_CAP the server refuses further appends (`round_full`): the round keeps
// playing locally but has stopped counting — the engine marks it capped and closes the
// conversation, and the solved screen suppresses its score submission accordingly.
//
// One conversation per round lives in a MODULE-level map (the activeScoreFlights
// pattern): a ref would not survive a real unmount, and neither the queue nor the
// in-flight write may be duplicated by a remount (archive round-trips, StrictMode).

import { ROUND_GUESS_CAP, ROUND_WRITE_MIN_MS, type RankMap, type RuntimeHole } from '@whippin/shared';
import { parseRound, postRoundBody, roundUrl } from '../api';
import { applyGuessToHoles, guessKey } from '../game/scoring';
import type { Mode } from '../langs';
import { useGameStore } from './gameStore';
import { playerSecret } from '../identity';

export interface RoundSyncContext {
  roundKey: string;
  lang: string;
  mode: Mode;
  date: string;
  ranks: RankMap;
  freshHoles: RuntimeHole[];
}

interface RoundFlight extends RoundSyncContext {
  // Prefix of the round's persisted `tried` believed acked by the server. Everything
  // from here on is the pending batch; adoption resets it to the acked prefix length.
  pendingFrom: number;
  // The initial read has landed (or 404'd): local extras are safe to append from here on.
  readDone: boolean;
  lastAttemptAt: number;
  failures: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  closed: boolean;
}

const flights = new Map<string, RoundFlight>();

// How long the next attempt waits: never sooner than one interval after the last
// (server refuses faster writes per player), doubled per consecutive failure up to a
// 30s ceiling so an outage cannot spin a request a second. Pure, and injected `now`, so
// the schedule is asserted without sleeping.
export function flushDelayMs(lastAttemptAt: number, failures: number, now: number): number {
  const windowMs = Math.min(ROUND_WRITE_MIN_MS * 2 ** failures, 30_000);
  return Math.max(0, lastAttemptAt + windowMs - now);
}

// Merge the server's log with the local one: server entries first (they are the acked
// truth), then local-only tries in their own order, deduped throughout by canonical
// identity (#104's guessKey) — the same dedup recordGuess applies, so the merged log
// replays to exactly one board. Returns how many of the merged entries came from the
// SERVER: that prefix needs no further writing, and everything after it is the pending
// batch.
export function mergeLogs(
  server: string[],
  local: string[],
  keyOf: (typed: string) => string,
): { guesses: string[]; acked: number } {
  const seen = new Set<string>();
  const guesses: string[] = [];
  const push = (typed: string) => {
    const id = keyOf(typed);
    if (seen.has(id)) return;
    seen.add(id);
    guesses.push(typed);
  };
  for (const g of server) push(g);
  const acked = guesses.length;
  for (const g of local) push(g);
  return { guesses, acked };
}

// Replay a whole log onto fresh holes — the board as the server's truth sees it.
export function replayHoles(
  freshHoles: RuntimeHole[],
  ranks: RankMap,
  tried: string[],
): RuntimeHole[] {
  const holes = freshHoles.map((h) => ({ ...h }));
  for (const typed of tried) applyGuessToHoles(holes, ranks, typed);
  return holes;
}

function schedule(key: string, delay: number) {
  const f = flights.get(key);
  if (!f || f.closed || f.timer !== null) return;
  // Global setTimeout, not window's: the engine also runs under node in tests.
  f.timer = setTimeout(() => {
    f.timer = null;
    void pump(key);
  }, delay);
}

// Register a round's sync context (Game mounts one per round) and start its
// conversation: the first registration reads the server's copy and adopts whatever the
// local device is missing; later registrations only refresh the context.
export function beginRoundSync(ctx: RoundSyncContext): void {
  let f = flights.get(ctx.roundKey);
  if (!f) {
    f = {
      ...ctx,
      pendingFrom: 0,
      readDone: false,
      lastAttemptAt: 0,
      failures: 0,
      timer: null,
      inFlight: null,
      closed: false,
    };
    flights.set(ctx.roundKey, f);
    void pump(ctx.roundKey);
    return;
  }
  Object.assign(f, ctx);
}

// A counted guess just entered the local log: something may now be pending.
export function notifyGuess(roundKey: string): void {
  if (!flights.has(roundKey)) return;
  void pump(roundKey);
}

async function pump(key: string): Promise<void> {
  const f = flights.get(key);
  if (!f || f.closed || f.inFlight) return;

  const round = useGameStore.getState().rounds[key];
  if (!round) return;
  // A re-published sentence resets the local round under the same key: the acked
  // prefix no longer describes this log, so start the conversation over.
  if (round.tried.length < f.pendingFrom) {
    f.pendingFrom = 0;
    f.readDone = false;
  }

  const delay = flushDelayMs(f.lastAttemptAt, f.failures, Date.now());
  if (delay > 0) {
    schedule(key, delay);
    return;
  }

  if (!f.readDone) {
    f.inFlight = readRound(f, key);
  } else if (round.tried.length > f.pendingFrom) {
    f.inFlight = appendBatch(f, key, round.tried.slice(f.pendingFrom));
  } else {
    return; // nothing pending
  }
  await f.inFlight;
  f.inFlight = null;
  void pump(key); // reassess: retries, coalesced arrivals, adoption leftovers
}

async function readRound(f: RoundFlight, key: string): Promise<void> {
  f.lastAttemptAt = Date.now();
  try {
    const response = await postRoundBody(roundUrl(f.lang, f.date, f.mode), {
      secret: playerSecret(),
    });
    // 404 = the server holds nothing yet: local state is authoritative-pending, and the
    // first append will create the record. Anything else non-2xx is a failed attempt.
    if (response.ok) {
      adopt(f, key, parseRound(await response.json()).guesses);
    } else if (response.status !== 404) {
      throw new Error(`round read failed: ${response.status}`);
    }
    f.readDone = true;
    f.failures = 0;
  } catch {
    f.failures += 1;
  }
}

async function appendBatch(f: RoundFlight, key: string, batch: string[]): Promise<void> {
  f.lastAttemptAt = Date.now();
  try {
    const response = await postRoundBody(roundUrl(f.lang, f.date, f.mode), {
      secret: playerSecret(),
      guesses: batch,
    });
    if (response.status === 409) {
      // The cap: the round stops counting (#201). Mark the round so the score is never
      // submitted, close the conversation, and let local play continue untouched.
      useGameStore.getState().markRoundCapped(key);
      f.closed = true;
      return;
    }
    if (!response.ok) throw new Error(`round append failed: ${response.status}`);
    adopt(f, key, parseRound(await response.json()).guesses);
    f.failures = 0;
  } catch {
    // Rate refusals (429), transport errors, 5xx: the batch stays pending and the
    // backoff decides when it tries again.
    f.failures += 1;
  }
}

// Adopt the server's log as this round's truth: merge it under the local log, replay
// the merged board, and hand BOTH to the store in one write. The acked prefix becomes
// the new pending watermark.
function adopt(f: RoundFlight, key: string, serverGuesses: string[]): void {
  const round = useGameStore.getState().rounds[key];
  if (!round) return;
  const { guesses, acked } = mergeLogs(serverGuesses, round.tried, (t) => guessKey(f.ranks, t));
  useGameStore
    .getState()
    .adoptRound(key, guesses, replayHoles(f.freshHoles, f.ranks, guesses));
  f.pendingFrom = Math.max(f.pendingFrom, acked);
}

// Test seam: drop every conversation (module state must not leak between tests).
export function resetRoundSync(): void {
  for (const f of flights.values()) if (f.timer !== null) clearTimeout(f.timer);
  flights.clear();
}
