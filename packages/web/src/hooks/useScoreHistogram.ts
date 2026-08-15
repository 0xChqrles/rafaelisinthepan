import { useEffect, useRef, useState } from 'react';
import { dateForDayNumber, type ScoreHistogram } from '@whippin/shared';
import { parseScoreHistogram, postScoreBody, scoresUrl } from '../api';
import { bucketIndexOf, shouldSubmitScore } from '../game/scores';
import { turnstileToken } from '../turnstile';
import type { Mode } from '../langs';

// The solved screen's population data (#170). One rule, both modes: a FINISHED round
// that has not submitted yet POSTs its score once — carrying a fresh invisible Turnstile
// token, so the POST's response IS the histogram (one round trip on the happy path) —
// and a round already submitted GETs the read-only twin on revisits. The submitted flag
// is PERSISTED with the round (the caller owns it, next to the solved state, #7/#9), so
// a reload can never re-submit; it is marked as soon as the server ANSWERS — accepted or
// rejected, either way the conversation is over — while a transport/Turnstile failure
// leaves it unset, so the next visit may try again.
//
// EVERY failure is silent by decision: the solved screen simply shows no histogram.
// Nothing here ever surfaces an error to the player.
export interface ScorePlacement {
  histogram: ScoreHistogram;
  // The player's bucket index — the POST response's, or located from the persisted score
  // on GET. Null when nothing can honestly be highlighted.
  bucket: number | null;
}

// One browser-session conversation per round, shared across COMPONENT lifetimes. A ref
// only survives StrictMode's effect replay; it does not survive a real unmount (opening
// the archive/tutorial and coming back), while the fetch it started keeps running. The
// map lets the new mount subscribe to that same promise instead of minting a second
// Turnstile token and recording the score twice. Settled work is removed immediately:
// a later revisit must perform the normal fresh GET, and a failed POST must stay
// retryable on that revisit.
const activeScoreFlights = new Map<string, Promise<ScorePlacement | null>>();

// Exported for the submit-once contract test; callers still use the hook below.
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
      // Offline, blocked Turnstile, malformed body, missing config — all the same
      // outcome: no histogram, no message.
      return null;
    }
  })();
  activeScoreFlights.set(key, promise);
  void promise.then(() => {
    if (activeScoreFlights.get(key) === promise) activeScoreFlights.delete(key);
  });
  return promise;
}

async function syncScore(
  submitted: boolean,
  markSubmitted: () => void,
  mode: Mode,
  lang: string,
  date: string,
  score: number,
): Promise<ScorePlacement | null> {
  if (shouldSubmitScore(true, submitted)) {
    const token = await turnstileToken();
    const response = await postScoreBody(scoresUrl(lang, date, mode), {
      score,
      turnstileToken: token,
    });
    // The server answered: accepted or refused, this round's submission is settled for
    // good. (A thrown fetch never reaches this line, so a transient failure stays
    // retryable on the next visit.)
    markSubmitted();
    if (!response.ok) return null;
    const histogram = parseScoreHistogram(await response.json());
    return { histogram, bucket: histogram.bucket };
  }
  const response = await fetch(scoresUrl(lang, date, mode));
  if (!response.ok) return null;
  const histogram = parseScoreHistogram(await response.json());
  // GET returns `bucket: null` — the revisiting client locates its own persisted score
  // in the inclusive ranges.
  return { histogram, bucket: bucketIndexOf(histogram.buckets, score) };
}

export default function useScoreHistogram({
  finished,
  submitted,
  markSubmitted,
  mode,
  lang,
  dayNumber,
  score,
}: {
  finished: boolean;
  submitted: boolean;
  // Persists the flag on the round; must be idempotent (the store action is).
  markSubmitted: () => void;
  mode: Mode;
  lang: string;
  dayNumber: number;
  score: number;
}): ScorePlacement | null {
  const [placement, setPlacement] = useState<ScorePlacement | null>(null);

  // `submitted` is read at launch time rather than placed in the deps: the successful
  // POST marks it during this effect's own flight, and that re-render must not chase the
  // POST with a redundant GET.
  const submittedRef = useRef(submitted);
  submittedRef.current = submitted;
  const placementKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!finished) {
      // A republished puzzle can reset the round under the same key; drop stale results.
      placementKeyRef.current = null;
      setPlacement(null);
      return undefined;
    }
    const operation = submittedRef.current ? 'get' : 'post';
    const key = `${operation}:${mode}:${lang}:${dayNumber}:${score}`;
    if (placementKeyRef.current !== key) {
      placementKeyRef.current = key;
      // A direct solved-round -> solved-round navigation must never show the previous
      // day's standing while this day's request is in flight.
      setPlacement(null);
    }
    const promise = shareScoreFlight(key, () =>
      syncScore(
        submittedRef.current,
        markSubmitted,
        mode,
        lang,
        dateForDayNumber(dayNumber),
        score,
      ),
    );
    let cancelled = false;
    void promise.then((result) => {
      if (!cancelled && result) setPlacement(result);
    });
    return () => {
      cancelled = true;
    };
  }, [finished, markSubmitted, mode, lang, dayNumber, score]);

  return placement;
}
