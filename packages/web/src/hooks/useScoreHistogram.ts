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

  // The network conversation is started ONCE per finished round and cached as a promise,
  // for two reasons the deps alone cannot cover: StrictMode's dev double-mount re-runs
  // the effect (the second run must SUBSCRIBE to the first's request, not fire a second
  // POST), and marking the submitted flag mid-flight re-renders the owner (the re-run
  // must not chase its own POST with a redundant GET). `submitted` is therefore read at
  // launch time, not from the deps.
  const flight = useRef<{ key: string; promise: Promise<ScorePlacement | null> } | null>(null);
  const submittedRef = useRef(submitted);
  submittedRef.current = submitted;

  useEffect(() => {
    if (!finished) {
      // A republished puzzle can reset the round under the same key; drop stale bars.
      flight.current = null;
      setPlacement(null);
      return undefined;
    }
    const key = `${mode}:${lang}:${dayNumber}:${score}`;
    if (!flight.current || flight.current.key !== key) {
      flight.current = {
        key,
        promise: syncScore(
          submittedRef.current,
          markSubmitted,
          mode,
          lang,
          dateForDayNumber(dayNumber),
          score,
          // Offline, blocked Turnstile, malformed body, missing config — all the same
          // outcome: no histogram, no message.
        ).catch(() => null),
      };
    }
    let cancelled = false;
    void flight.current.promise.then((result) => {
      if (!cancelled && result) setPlacement(result);
    });
    return () => {
      cancelled = true;
    };
  }, [finished, markSubmitted, mode, lang, dayNumber, score]);

  return placement;
}
