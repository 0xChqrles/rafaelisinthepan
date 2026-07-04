import { useCallback, useEffect, useRef, useState } from 'react';
import { buildShareText } from '../game/share';
import { heatColor } from '../game/heat';
import useAnimatedNumber from '../hooks/useAnimatedNumber';

// Reveal choreography: the heat squares pop in one by one, then — once the grid is in —
// the score/share row fades in and the score tallies up from 0. This component MOUNTS at
// the reveal moment (Game gates it on the last hole's solve animation finishing), so the
// mount-time CSS/JS animations below ARE the reveal.
const SQUARE_POP_MS = 300; // one square's pop-in (matches .heat-cell animation)
const SQUARE_STAGGER_MS = 55; // gap between consecutive squares...
const GRID_MAX_SPAN_MS = 1400; // ...compressed so even a long game's grid stays snappy
const SCORE_COUNT_MS = 800; // score tally 0 -> guessCount

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
  const n = trajectory.length;
  // Per-square stagger, compressed for long games so the whole grid lands within a bound.
  const stagger = n > 1 ? Math.min(SQUARE_STAGGER_MS, GRID_MAX_SPAN_MS / (n - 1)) : 0;

  // Score counts up only AFTER the grid has finished landing. It starts at 0 and animates
  // to guessCount when `countTarget` flips (useAnimatedNumber tweens on target change).
  const [countTarget, setCountTarget] = useState(0);
  const [showActions, setShowActions] = useState(false);
  useEffect(() => {
    const gridDoneMs = Math.max(0, n - 1) * stagger + SQUARE_POP_MS;
    const t = window.setTimeout(() => {
      setShowActions(true);
      setCountTarget(guessCount);
    }, gridDoneMs);
    return () => window.clearTimeout(t);
  }, [n, stagger, guessCount]);
  const shownScore = useAnimatedNumber(countTarget, SCORE_COUNT_MS);

  // "COPIED" confirmation after a clipboard fallback (the native share sheet needs none).
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const onShare = useCallback(async () => {
    const url = typeof window !== 'undefined' ? window.location.origin : undefined;
    const text = buildShareText({ dayNumber, guessCount, trajectory, url });

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
  }, [dayNumber, guessCount, trajectory]);

  return (
    <div className="solved-results">
      {/* One flat square per guess, colored by the reconstruction % reached at that guess
          (heatColor: 0 = cold/far crimson .. 1 = hot/solved cyan). Each pops in on its own
          staggered delay. Decorative — the score and share text carry the real numbers. */}
      <div className="heat-grid" aria-hidden="true">
        {trajectory.map((pct, i) => (
          <span
            // eslint-disable-next-line react/no-array-index-key
            key={i}
            className="heat-cell"
            style={{ background: heatColor(pct / 100), animationDelay: `${Math.round(i * stagger)}ms` }}
          />
        ))}
      </div>

      <div className={`solved-actions${showActions ? ' in' : ''}`}>
        <span className="solved-score">SCORE {Math.round(shownScore)}</span>
        <button type="button" className={`share-key${copied ? ' copied' : ''}`} onClick={onShare}>
          {copied ? 'COPIED' : 'SHARE'}
        </button>
      </div>
    </div>
  );
}
