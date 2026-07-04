import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bucketMeans, buildShareText } from '../game/share';
import { heatColor } from '../game/heat';
import useAnimatedNumber from '../hooks/useAnimatedNumber';

// Reveal choreography: the score+share row fades in and tallies up first, THEN the heat
// squares feed in as a conveyor — each new square enters at the rightmost slot while the
// whole row shifts one slot left, until the row is full. This component MOUNTS at the reveal
// moment (Game gates it on the last hole's solve animation finishing).
const BASE_STEP_MS = 170; // time between squares entering...
const CONVEYOR_MAX_SPAN_MS = 1400; // ...compressed so even a long game's conveyor stays snappy
const ACTIONS_IN_MS = 350; // score+share fade/rise into place (matches .solved-actions transition)
const SCORE_COUNT_MS = 800; // score tally 0 -> guessCount
// The conveyor runs only AFTER the score is shown (row settled + tally finished).
const CONVEYOR_START_MS = ACTIONS_IN_MS + SCORE_COUNT_MS;

// The solved results (issue #8): it takes over the on-screen keyboard's footprint once
// the sentence is solved, so the layout never reflows and no empty gap is left where the
// keyboard was. Understated + flat to match the app: a heat-grid of one pixel square per
// counted guess (colored by the game's own heat ramp — cold/far to hot/solved), the
// score, and a share control styled like a keyboard key. Reused by the already-solved
// screen (#9). The reconstructed sentence + attribution live above, in <SolvedCaption>.
export default function SolvedScreen({
  guessCount,
  trajectory,
  dayNumber,
}: {
  guessCount: number;
  trajectory: number[]; // reconstruction % after each counted guess (one per try)
  dayNumber: number | null;
}) {
  // Collapse the per-guess trajectory into a bounded set of squares (3..18), each colored
  // by its bucket's mean progress. Same array drives the on-screen grid and the share row.
  const squares = useMemo(() => bucketMeans(trajectory), [trajectory]);
  const n = squares.length;
  // Time between squares entering the conveyor, compressed so a long row still lands fast.
  const step = n > 1 ? Math.min(BASE_STEP_MS, CONVEYOR_MAX_SPAN_MS / (n - 1)) : 0;

  // Reveal in three beats: (1) the score+share row fades/rises into place, (2) the score
  // tallies up from 0 in its final position, and only THEN (3) the squares feed in as a
  // conveyor. Score first, squares after — the score is the headline, the heat trail follows.
  const [countTarget, setCountTarget] = useState(0);
  const [showActions, setShowActions] = useState(false);
  // How many squares have entered so far. Each is added at the rightmost slot while the row
  // shifts one slot left (see the transform below), so the row fills right-to-left.
  const [shown, setShown] = useState(0);

  // (1) On mount (the reveal moment), bring the row in on the next frame so its fade/rise
  //     transition actually plays.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShowActions(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  // (2) Once the row has settled into position, start the score tally from 0.
  useEffect(() => {
    if (!showActions) return undefined;
    const t = window.setTimeout(() => setCountTarget(guessCount), ACTIONS_IN_MS);
    return () => window.clearTimeout(t);
  }, [showActions, guessCount]);
  const shownScore = useAnimatedNumber(countTarget, SCORE_COUNT_MS);

  // (3) After the score, feed the conveyor: reveal one more square every `step` ms.
  useEffect(() => {
    setShown(0);
    const timers: number[] = [];
    for (let k = 1; k <= n; k += 1) {
      timers.push(window.setTimeout(() => setShown(k), CONVEYOR_START_MS + (k - 1) * step));
    }
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [n, step]);

  // "COPIED" confirmation after a clipboard fallback (the native share sheet needs none).
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const onShare = useCallback(async () => {
    const url = typeof window !== 'undefined' ? window.location.origin : undefined;
    const text = buildShareText({ dayNumber, guessCount, squares, url });

    // Prefer the Web Share API (mobile: native share sheet). Fall back to the clipboard
    // on desktop / when it is unavailable, matching the "copy to clipboard" default.
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ text });
        return;
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return; // user dismissed the sheet
        // any other failure -> fall through to the clipboard
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context / denied): nothing more we can do here.
    }
  }, [dayNumber, guessCount, squares]);

  return (
    <div className="solved-results">
      {/* One flat square per bucket (3..18), colored by the bucket's MEAN reconstruction %
          (heatColor: 0 = cold/far crimson .. 1 = hot/solved cyan). Conveyor reveal: the track
          is shifted right by `n - shown` slots, so the `shown` visible squares sit in the
          rightmost slots; each step reveals one more and shifts the track one slot left, so
          the row fills right-to-left and settles centered when full. The grid reserves the
          full width/height throughout, so nothing else shifts. Decorative — the score/share
          carry the real numbers. */}
      <div className="heat-grid" aria-hidden="true">
        <div
          className="heat-track"
          style={{ transform: `translateX(calc((var(--cell) + var(--gap)) * ${n - shown}))` }}
        >
          {squares.map((pct, i) => (
            <span
              // eslint-disable-next-line react/no-array-index-key
              key={i}
              className="heat-cell"
              style={{ background: heatColor(pct / 100), opacity: i < shown ? 1 : 0 }}
            />
          ))}
        </div>
      </div>

      <div className={`solved-actions${showActions ? ' in' : ''}`}>
        <span className="solved-score">
          SCORE{' '}
          {/* Reserve the FINAL count's exact width with a hidden ghost (same font, letter-
              spacing and all), then overlay the live tally right-aligned on top — so the
              number counting 0 -> guessCount never changes width (9 -> 10 stays put). */}
          <span className="solved-score-num">
            <span className="solved-score-ghost" aria-hidden="true">
              {guessCount}
            </span>
            <span className="solved-score-live">{Math.round(shownScore)}</span>
          </span>
        </span>
        <button type="button" className={`share-key${copied ? ' copied' : ''}`} onClick={onShare}>
          {copied ? 'COPIED' : 'SHARE'}
        </button>
      </div>
    </div>
  );
}
