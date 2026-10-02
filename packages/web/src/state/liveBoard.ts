// THE LIVE READ (`POST /board {token, live: true}`): every group the player is in, merged —
// who finished today and who is playing, with their numbers. The ONE module that asks for it:
// the play screen's race line reads it while the round is played, and the solved screen's
// group boards read the same answer afterwards — never a second read of their own.
//
// It is asked at GUESS CADENCE, so the cost rule lives HERE and nowhere else: at most ONE
// read per `LIVE_REFRESH_MS`, ONE flight at a time. A request inside the window is never
// dropped — it runs once at the window's end (a TRAILING call), however many requests it
// stands for, so the last guess of a burst is always reflected. The server keeps the day's
// parsed artifact by revision for it (backend puzzleReads.ts), and the API runs on 10
// concurrent Lambdas: a chatty client would throttle every player's guesses.
//
// TRANSIENT and ACCOUNT-owned (`identityScope` resets it), fenced by the identity epoch like
// every private read. No token, no request (#216). A failure is SILENT and keeps the last
// answer: the numbers are ambient, and a line that blinks out on a network blip says nothing
// true.

import { create } from 'zustand';
import type { LiveBoard } from '@whippin/shared';
import { boardUrl, parseLiveBoard, postBoardBody } from '../api';
import { currentRequestIdentity, deviceIdentity, identityEpochOf } from '../identity';
import { adoptSignedOutVerdict } from './signedOutVerdict';

export const LIVE_REFRESH_MS = 10_000;

interface LiveBoardState {
  // WHICH day the answer is about (`<lang>:<date>`): a day has its own board.
  key: string | null;
  board: LiveBoard | null;
}

export const useLiveBoardStore = create<LiveBoardState>(() => ({ key: null, board: null }));

const keyOf = (lang: string, date: string) => `${lang}:${date}`;

// The day a request is waiting to be served for (the latest asked), the read out on the
// wire, the trailing call's timer, and when the last read STARTED — the window runs from there.
let wanted: { lang: string; date: string } | null = null;
let flight: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastStartedAt = Number.NEGATIVE_INFINITY;
let generation = 0;

// Ask for a fresh answer about (lang, date). At once when the window is open; otherwise
// once, at the window's end.
export function requestLiveBoard(lang: string, date: string): void {
  if (deviceIdentity() === null) return;
  wanted = { lang, date };
  schedule();
}

function schedule(): void {
  if (wanted === null || flight !== null || timer !== null) return;
  const wait = lastStartedAt + LIVE_REFRESH_MS - Date.now();
  if (wait > 0) {
    timer = setTimeout(() => {
      timer = null;
      schedule();
    }, wait);
    return;
  }
  run(wanted);
}

function run(target: { lang: string; date: string }): void {
  wanted = null;
  const identity = deviceIdentity();
  if (identity === null) return;
  const epoch = identityEpochOf(identity);
  const requestGeneration = generation;
  const current = () => generation === requestGeneration && currentRequestIdentity(epoch) !== null;
  lastStartedAt = Date.now();
  flight = (async () => {
    try {
      const resolved = currentRequestIdentity(epoch);
      if (!resolved) return;
      const response = await postBoardBody(boardUrl(target.lang, target.date), {
        token: resolved.identity.token,
        live: true,
      });
      if (!current()) return;
      if (!response.ok) {
        await adoptSignedOutVerdict(response, resolved.epoch);
        return;
      }
      const board = parseLiveBoard(await response.json());
      // Fenced: an answer that outlived its identity is about an account this device no
      // longer acts as.
      if (!current()) return;
      useLiveBoardStore.setState({ key: keyOf(target.lang, target.date), board });
    } catch {
      // Silent: the last answer stands.
    } finally {
      if (generation === requestGeneration) {
        flight = null;
        // A request that came in while this one was out is the trailing call.
        schedule();
      }
    }
  })();
}

// The answer about (lang, date), or null until one has arrived.
export function useLiveBoard(lang: string, date: string): LiveBoard | null {
  return useLiveBoardStore((state) => (state.key === keyOf(lang, date) ? state.board : null));
}

// Registered in `identityScope`: the answer belongs to the ACCOUNT.
export function resetLiveBoard(): void {
  generation += 1;
  flight = null;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  wanted = null;
  lastStartedAt = Number.NEGATIVE_INFINITY;
  useLiveBoardStore.setState({ key: null, board: null });
}
