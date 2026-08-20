import { useEffect, useRef, useState } from 'react';
import { dateForDayNumber, type ScoreHistogram } from '@whippin/shared';
import { parseScoreHistogram, postScoreBody, scoresUrl } from '../api';
import { bucketIndexOf, shouldSubmitScore } from '../game/scores';
import { playerSecret } from '../identity';
import { turnstileToken } from '../turnstile';
import type { Mode } from '../langs';

// The solved screen's population data (#170). One rule, both modes, and it reads the
// POPULATION rather than the conversation: a FINISHED round whose score the population
// does not hold POSTs it — carrying a fresh invisible Turnstile token, so the POST's
// response IS the histogram (one round trip on the happy path) — and a round already IN
// the population GETs the read-only twin on revisits. What PERSISTS with the round is the
// RECORDED score itself (the caller owns it, next to the solved state, #7/#9), so a
// reload can never double-submit.
//
// Nothing else ends the conversation (user-decided 2026-08-20, retiring the submit-once
// flag a 4xx used to set): a refusal leaves the population holding nothing for this round,
// so the next visit asks again. That is the point — a 403 is Turnstile refusing the
// REQUEST, not the server judging the SCORE, and `turnstileToken()` builds a fresh widget
// on every call, so the retry asks with a token that can actually pass. Re-asking is safe
// by construction since #187: the row is first-write-wins, a duplicate consumes no IP
// allowance, and a 400/403/404 returns before the store is touched at all. The cost is a
// handful of refused requests per stuck round per day; the alternative was a score lost
// for good, silently, on a visit the player cannot repeat.
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

// Exported for the one-conversation-per-round contract test; callers still use the hook
// below. What this bounds is CONCURRENCY — two mounts of one round must not both POST —
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

// Exported for the ask-until-recorded contract test; callers still use the hook below.
export async function syncScore(
  markRecorded: (recorded: number) => void,
  mode: Mode,
  lang: string,
  date: string,
  score: number,
  recordedScore?: number,
): Promise<ScorePlacement | null> {
  if (shouldSubmitScore(true, recordedScore)) {
    const token = await turnstileToken();
    // The player key (#187) authenticates the write: the server derives the publicId
    // from it and keys the round's ONE first-write-wins row by that identity.
    const response = await postScoreBody(scoresUrl(lang, date, mode), {
      secret: playerSecret(),
      score,
      turnstileToken: token,
    });
    // ONLY a 2xx that names a band settles this round. Every other answer leaves the
    // population holding nothing, and a round the population does not hold asks again on
    // the next visit — a refusal included (see the retirement note above). Nothing is
    // persisted here, so there is no flag to burn on a cold start, a throttled write, a
    // spent Turnstile token or a body that will not parse.
    if (!response.ok) return null;
    const histogram = parseScoreHistogram(await response.json());
    // What the population actually HOLDS for this round (#187): first write wins, so a
    // duplicate submission (another device/tab under the same key) is answered with the
    // STORED row's band — persist ITS score, never this round's local count, so revisit
    // GETs locate the same standing the POST just showed. Bands are exact (min == max ==
    // the recorded score). A 2xx carrying NO band is the server saying it holds no row
    // for this caller, which the strongly-consistent read after the write makes
    // unreachable in practice; nothing is persisted for it, so it simply asks again.
    const recorded = histogram.bucket == null ? null : histogram.buckets[histogram.bucket]?.min ?? null;
    if (recorded !== null) markRecorded(recorded);
    return { histogram, bucket: histogram.bucket };
  }
  // Unreachable: the branch above claimed every round the population does not hold, which
  // is exactly the rounds with no recorded score. TypeScript cannot see that through
  // `shouldSubmitScore`, and locating the GET by anything else — the local count — would
  // place this round in whatever band another player happened to record at that score.
  if (recordedScore === undefined) return null;
  const response = await fetch(scoresUrl(lang, date, mode));
  if (!response.ok) return null;
  const histogram = parseScoreHistogram(await response.json());
  // GET returns `bucket: null` — the revisiting client locates its own RECORDED score
  // (#187) in the inclusive ranges.
  return { histogram, bucket: bucketIndexOf(histogram.buckets, recordedScore) };
}

export default function useScoreHistogram({
  finished,
  markRecorded,
  mode,
  lang,
  dayNumber,
  score,
  recordedScore,
}: {
  finished: boolean;
  // Persists the score the population recorded (#187) on the round; must be idempotent
  // (the store action is).
  markRecorded: (recorded: number) => void;
  mode: Mode;
  lang: string;
  dayNumber: number;
  score: number;
  // The persisted server-recorded score, when the population holds one (#187). It is the
  // whole state machine: ABSENT means this round still owes its score and POSTs, PRESENT
  // means revisits GET and locate the standing by it — and by it alone, since
  // first-write-wins can hold a different score than this device's own count.
  recordedScore?: number;
}): ScorePlacementState {
  const [placement, setPlacement] = useState<ScorePlacementState>(null);

  // `recordedScore` is read at launch time rather than placed in the deps: the successful
  // POST writes it during this effect's own flight, and that re-render must not chase the
  // POST with a redundant GET.
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
    // The RECORDED score decides both halves: absent, this round still owes the
    // population its score and POSTs; present, the revisit GETs and LOCATES with it, which
    // is all a revisit may use (#187). Keying the conversation by that same value is what
    // stops a stale flight answering for a different band.
    const recorded = recordedRef.current;
    const operation = recorded === undefined ? 'post' : 'get';
    const key = `${operation}:${mode}:${lang}:${dayNumber}:${recorded ?? score}`;
    if (placementKeyRef.current !== key) {
      placementKeyRef.current = key;
      // A direct solved-round -> solved-round navigation must never show the previous
      // day's standing while this day's request is in flight.
      setPlacement('pending');
    }
    const promise = shareScoreFlight(key, () =>
      syncScore(markRecorded, mode, lang, dateForDayNumber(dayNumber), score, recorded),
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
  }, [finished, markRecorded, mode, lang, dayNumber, score]);

  return placement;
}
