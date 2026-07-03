import { useCallback, useEffect, useRef, useState } from 'react';
import { buildShareText } from '../game/share';
import { heatColor } from '../game/heat';

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
          (heatColor: 0 = cold/far crimson .. 1 = hot/solved cyan). Decorative — the score
          and share text carry the real numbers. */}
      <div className="heat-grid" aria-hidden="true">
        {trajectory.map((pct, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <span key={i} className="heat-cell" style={{ background: heatColor(pct / 100) }} />
        ))}
      </div>

      <div className="solved-actions">
        <span className="solved-score">SCORE {guessCount}</span>
        <button
          type="button"
          className={`share-key${copied ? ' copied' : ''}`}
          onClick={onShare}
        >
          {copied ? 'COPIED' : 'SHARE'}
        </button>
      </div>
    </div>
  );
}
