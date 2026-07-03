import { useCallback, useEffect, useRef, useState } from 'react';
import type { Source } from '@whippin/shared';
import { buildShareText } from '../game/share';

// The solved panel (issue #8): shown once every hole is solved, in place of the input.
// Renders the literary metadata (when present), the score, and a share button. The
// reconstructed sentence itself stays on screen via <Phrase> above this panel, so this
// component is composed WITH it (Game and the already-solved screen #9 both render the
// solved <Phrase> then this panel).
export default function SolvedScreen({
  guessCount,
  trajectory,
  source,
  dayNumber,
}: {
  guessCount: number;
  trajectory: number[]; // reconstruction % after each counted guess (one per try)
  source?: Source;
  dayNumber: number | null;
}) {
  // "COPIED!" confirmation after a clipboard fallback (the native share sheet needs none).
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

  // Attribution line from whatever source fields exist (all optional, #5): "Author, Work".
  const attribution = [source?.author, source?.work].filter(Boolean).join(', ');
  const hasSource = source && (source.kind || attribution || source.context);

  return (
    <div className="solved-panel">
      <p className="solved-label">SOLVED!</p>

      {hasSource && (
        <div className="solved-source">
          {source?.kind && <p className="solved-kind">{source.kind}</p>}
          {attribution && <p className="solved-attribution">— {attribution}</p>}
          {source?.context && <blockquote className="solved-context">{source.context}</blockquote>}
        </div>
      )}

      <p className="solved-score">SCORE {guessCount}</p>

      <button type="button" className="btn btn-primary share-btn" onClick={onShare}>
        {copied ? 'COPIED!' : 'SHARE'}
      </button>
    </div>
  );
}
