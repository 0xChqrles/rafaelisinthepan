import { useEffect, useRef, useState } from 'react';
import { dateForDayNumber, type ScoreHistogram } from '@whippin/shared';
import { parseScoreHistogram, scoresUrl } from '../api';
import { deviceIdentity } from '../identity';
import type { Mode } from '../langs';

// The solved screen's population data (#170), a plain READ since #203.
//
// It used to be a round trip with a state machine behind it: a finished round POSTed its
// own score — carrying an invisible Turnstile token and the player's key — and persisted
// whatever band the server answered with, so a revisit could GET instead, and a REFUSED
// submission left the round asking again on the next visit. All of that is retired. The
// server now derives the score from the guess log it already holds (#201) and records the
// row itself the moment the round finishes, so there is nothing left to claim, nothing to
// validate and nothing to retry.
//
// What replaced the state machine is a FACT ABOUT THE SERVER: `recorded` for a sentence
// round (the server has read its log as solved), `submitted` for a word run. The caller
// gates `finished` on it, which is what keeps this read from landing before the row it is
// looking for exists — the local board flips solved a beat earlier, while the solving
// append is still in flight.
//
// **The read NAMES the player, and the server answers WHICH BAND IS THEIRS** (corrected on
// review). Matching the local count against the returned bands only ever says "somebody
// scored this": a round whose row the IP cap refused, or a Word daily another device
// submitted first, would borrow an unrelated player's standing and show a rank it never
// earned. `id` is the PUBLIC id, so it may travel in the query (the /board rule).
//
// EVERY failure is silent by decision: the solved screen simply shows no standing, never
// an error.
export interface ScorePlacement {
  histogram: ScoreHistogram;
  // The player's bucket index, as the SERVER located it among the day's rows. Null when
  // nothing can honestly be highlighted — including a population holding no row for this
  // player, which is drawn as no standing rather than as somebody else's.
  bucket: number | null;
}

// What the standing slot renders from: the placement once the read lands, 'pending' while
// it is in flight (the slot shows its RANKING... shimmer), null when there is nothing to
// show — not finished yet, or the silent failure.
export type ScorePlacementState = ScorePlacement | 'pending' | null;

// One browser-session conversation per round, shared across COMPONENT lifetimes. A ref
// only survives StrictMode's effect replay; it does not survive a real unmount (opening
// the archive/tutorial and coming back), while the fetch it started keeps running. The map
// lets the new mount subscribe to that same promise instead of firing a second read.
// Settled work is removed immediately: a later revisit performs a normal fresh read, since
// the population is live.
const activeScoreFlights = new Map<string, Promise<ScorePlacement | null>>();

// Exported for the one-conversation-per-round contract test; callers still use the hook
// below. What this bounds is CONCURRENCY — two mounts of one round must not both read —
// never how many visits may ask; a settled flight leaves the map so the next one can.
export function shareScoreFlight(
  key: string,
  start: () => Promise<ScorePlacement | null>,
): Promise<ScorePlacement | null> {
  const existing = activeScoreFlights.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      return await start();
    } catch {
      // Offline, a malformed body, missing config — all the same outcome: no standing,
      // no message.
      return null;
    }
  })();
  activeScoreFlights.set(key, promise);
  void promise.then(() => {
    if (activeScoreFlights.get(key) === promise) activeScoreFlights.delete(key);
  });
  return promise;
}

// Exported for the contract test; callers still use the hook below.
export async function readPopulation(
  mode: Mode,
  lang: string,
  date: string,
): Promise<ScorePlacement | null> {
  // The caller's PUBLIC id, which is what makes the returned band THEIRS. Since #216 it is
  // the SERVER-assigned account id this device already holds, so there is nothing to derive
  // and no `crypto.subtle` to be missing outside a secure context (the LAN-IP mobile check
  // that used to need its own try/catch here). A device with no identity has recorded
  // nothing, so there is no standing to read.
  const identity = deviceIdentity();
  if (!identity) return null;
  const response = await fetch(scoresUrl(lang, date, mode, identity.accountId));
  if (!response.ok) return null;
  const histogram = parseScoreHistogram(await response.json());
  // `bucket` is the server's answer about THIS player, so a population that does not hold
  // them says so with null instead of handing back whoever else recorded the same number.
  return { histogram, bucket: histogram.bucket };
}

export default function useScoreHistogram({
  finished,
  mode,
  lang,
  dayNumber,
  score,
}: {
  // The round is over AND THE SERVER HOLDS IT: `recorded` for a sentence round, `submitted`
  // for a word run. Gating on the local board alone would read a population that does not
  // yet contain this round — the score row is written by the append that solves it.
  finished: boolean;
  mode: Mode;
  lang: string;
  dayNumber: number;
  score: number;
}): ScorePlacementState {
  const [placement, setPlacement] = useState<ScorePlacementState>(null);
  const placementKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!finished) {
      // A republished puzzle can reset the round under the same key; drop stale results.
      placementKeyRef.current = null;
      setPlacement(null);
      return undefined;
    }
    const key = `${mode}:${lang}:${dayNumber}:${score}`;
    if (placementKeyRef.current !== key) {
      placementKeyRef.current = key;
      // A direct solved-round -> solved-round navigation must never show the previous
      // day's standing while this day's request is in flight.
      setPlacement('pending');
    }
    const promise = shareScoreFlight(key, () =>
      readPopulation(mode, lang, dateForDayNumber(dayNumber)),
    );
    let cancelled = false;
    void promise.then((result) => {
      // A null result settles the slot to empty — the silent failure must not leave the
      // RANKING... shimmer up forever.
      if (!cancelled) setPlacement(result);
    });
    return () => {
      cancelled = true;
    };
  }, [finished, mode, lang, dayNumber, score]);

  return placement;
}
