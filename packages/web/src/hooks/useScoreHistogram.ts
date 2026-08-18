import { useEffect, useRef, useState } from 'react';
import { dateForDayNumber, type ScoreHistogram } from '@whippin/shared';
import { parseScoreHistogram, postScoreBody, scoresUrl } from '../api';
import { bucketIndexOf, shouldSubmitScore } from '../game/scores';
import { playerSecret } from '../identity';
import { turnstileToken } from '../turnstile';
import type { Mode } from '../langs';

// The solved screen's population data (#170). One rule, both modes: a FINISHED round
// that has not submitted yet POSTs its score once — carrying a fresh invisible Turnstile
// token, so the POST's response IS the histogram (one round trip on the happy path) —
// and a round already submitted GETs the read-only twin on revisits. The submitted flag
// is PERSISTED with the round (the caller owns it, next to the solved state, #7/#9), so
// a reload can never re-submit; it is marked as soon as the server reaches a VERDICT —
// accepted (2xx) or refused (4xx), either way the conversation is over — while anything
// that is merely the backend failing (a 5xx, or a transport/Turnstile error that throws)
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

// What the standing slot renders from: the placement once the round trip lands,
// 'pending' while it is in flight (the slot shows its RANKING... shimmer), null when
// there is nothing to show — not finished yet, or the silent failure.
export type ScorePlacementState = ScorePlacement | 'pending' | null;

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

// Exported for the settled-verdict contract test; callers still use the hook below.
export async function syncScore(
  submitted: boolean,
  markSubmitted: (recorded: number | null) => void,
  mode: Mode,
  lang: string,
  date: string,
  score: number,
  recordedScore?: number,
): Promise<ScorePlacement | null> {
  if (shouldSubmitScore(true, submitted)) {
    const token = await turnstileToken();
    // The player key (#187) authenticates the write: the server derives the publicId
    // from it and keys the round's ONE first-write-wins row by that identity.
    const response = await postScoreBody(scoresUrl(lang, date, mode), {
      secret: playerSecret(),
      score,
      turnstileToken: token,
    });
    // The server SETTLED this submission only if it reached a verdict: 2xx answered with
    // the population, 4xx refused it (bad score, spent Turnstile token, over the cap) —
    // either way the conversation is over and the round must never ask again. A 5xx is
    // not a verdict: it is the backend failing, and burning the round's one submission on
    // a cold start or a throttled write would lose that score for good, on a visit the
    // player cannot repeat. So it stays retryable, exactly like the thrown fetch that
    // never gets here. (A 2xx whose body will not parse below also stays retryable —
    // harmless since #187, because a re-POST of an already-recorded round changes
    // nothing server-side and returns this same answer.)
    if (!response.ok) {
      if (response.status < 500) markSubmitted(null);
      return null;
    }
    const histogram = parseScoreHistogram(await response.json());
    // What the population actually HOLDS for this round (#187): first write wins, so a
    // duplicate submission (another device/tab under the same key) is answered with the
    // STORED row's band — persist ITS score, never this round's local count, so revisit
    // GETs locate the same standing the POST just showed. Bands are exact (min == max ==
    // the recorded score).
    const recorded = histogram.bucket == null ? null : histogram.buckets[histogram.bucket]?.min ?? null;
    markSubmitted(recorded);
    return { histogram, bucket: histogram.bucket };
  }
  const response = await fetch(scoresUrl(lang, date, mode));
  if (!response.ok) return null;
  const histogram = parseScoreHistogram(await response.json());
  // GET returns `bucket: null` — the revisiting client locates its own RECORDED score
  // (#187; the local count as the pre-#187 fallback) in the inclusive ranges.
  return { histogram, bucket: bucketIndexOf(histogram.buckets, recordedScore ?? score) };
}

export default function useScoreHistogram({
  finished,
  submitted,
  markSubmitted,
  mode,
  lang,
  dayNumber,
  score,
  recordedScore,
}: {
  finished: boolean;
  submitted: boolean;
  // Persists the flag — and, on a 2xx, the score the population recorded (#187) — on the
  // round; must be idempotent (the store action is).
  markSubmitted: (recorded: number | null) => void;
  mode: Mode;
  lang: string;
  dayNumber: number;
  score: number;
  // The persisted server-recorded score, when the round has one (#187): revisit GETs
  // locate the standing by it, since first-write-wins can hold a different score than
  // this device's own count.
  recordedScore?: number;
}): ScorePlacementState {
  const [placement, setPlacement] = useState<ScorePlacementState>(null);

  // `submitted` and `recordedScore` are read at launch time rather than placed in the
  // deps: the successful POST writes BOTH during this effect's own flight, and that
  // re-render must not chase the POST with a redundant GET.
  const submittedRef = useRef(submitted);
  submittedRef.current = submitted;
  const recordedRef = useRef(recordedScore);
  recordedRef.current = recordedScore;
  const placementKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!finished) {
      // A republished puzzle can reset the round under the same key; drop stale results.
      placementKeyRef.current = null;
      setPlacement(null);
      return undefined;
    }
    const operation = submittedRef.current ? 'get' : 'post';
    // A GET conversation is keyed by the score it will LOCATE with — the recorded one
    // when the round has it — so a stale flight can never answer for a different band.
    const recorded = recordedRef.current;
    const locate = operation === 'get' ? recorded ?? score : score;
    const key = `${operation}:${mode}:${lang}:${dayNumber}:${locate}`;
    if (placementKeyRef.current !== key) {
      placementKeyRef.current = key;
      // A direct solved-round -> solved-round navigation must never show the previous
      // day's standing while this day's request is in flight.
      setPlacement('pending');
    }
    const promise = shareScoreFlight(key, () =>
      syncScore(
        submittedRef.current,
        markSubmitted,
        mode,
        lang,
        dateForDayNumber(dayNumber),
        score,
        recorded,
      ),
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
  }, [finished, markSubmitted, mode, lang, dayNumber, score]);

  return placement;
}
