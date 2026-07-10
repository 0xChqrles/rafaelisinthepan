import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Source } from '@whippin/shared';

const TYPE_MS = 18;
const CURSOR_HOLD_MS = 140;
const HIDDEN: CSSProperties = { visibility: 'hidden' };

function typedLine(chars: string[], shown: number, cursor: boolean) {
  return (
    <>
      {chars.map((char, index) => {
        const visible = index < shown;
        const cursorHere = cursor && index === shown;
        return (
          // Static display metadata: its character index is a stable identity.
          // eslint-disable-next-line react/no-array-index-key
          <span key={index} className={cursorHere ? 'source-type-slot' : undefined}>
            <span style={visible ? undefined : HIDDEN}>{char}</span>
            {cursorHere && <span className="source-type-cursor">_</span>}
          </span>
        );
      })}
      {cursor && shown >= chars.length && <span className="source-type-cursor">_</span>}
    </>
  );
}

// The solved sentence's attribution (issue #8), shown under the reconstructed phrase in
// place of the input — a quote-style citation from the optional literary metadata (#5):
// a kind tag and "— Author, Work". A fresh solve types the source after the streak screen;
// every final character is present but hidden from frame one so line wrapping is stable.
// The underscore occupies the next character's reserved slot, then disappears before the
// result stack starts. Rehydrated solves render the complete source immediately.
export default function SolvedCaption({
  source,
  animate = false,
  onComplete,
}: {
  source?: Source;
  animate?: boolean;
  onComplete?: () => void;
}) {
  const attribution = [source?.author, source?.work].filter(Boolean).join(', ');
  const attributionText = attribution ? `— ${attribution}` : '';
  const kindChars = useMemo(() => Array.from(source?.kind ?? ''), [source?.kind]);
  const attributionChars = useMemo(() => Array.from(attributionText), [attributionText]);
  const total = kindChars.length + attributionChars.length;
  const reduceMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [shown, setShown] = useState(() => (animate && !reduceMotion ? 0 : total));

  useEffect(() => {
    if (!animate) {
      setShown(total);
      return undefined;
    }
    if (reduceMotion || total === 0) {
      setShown(total);
      const raf = requestAnimationFrame(() => onComplete?.());
      return () => cancelAnimationFrame(raf);
    }

    setShown(0);
    const id = window.setInterval(() => {
      setShown((current) => {
        if (current >= total - 1) {
          window.clearInterval(id);
          return total;
        }
        return current + 1;
      });
    }, TYPE_MS);
    return () => window.clearInterval(id);
  }, [animate, onComplete, reduceMotion, total]);

  useEffect(() => {
    if (!animate || reduceMotion || total === 0 || shown < total) return undefined;
    const id = window.setTimeout(() => onComplete?.(), CURSOR_HOLD_MS);
    return () => window.clearTimeout(id);
  }, [animate, onComplete, reduceMotion, shown, total]);

  const visible = animate ? shown : total;
  const kindShown = Math.min(visible, kindChars.length);
  const attributionShown = Math.max(0, visible - kindChars.length);
  const typingKind = kindChars.length > 0 && visible < kindChars.length;
  const showCursor = animate && !reduceMotion && total > 0;
  const kindCursor = showCursor && (typingKind || attributionChars.length === 0);
  const attributionCursor = showCursor && !typingKind && attributionChars.length > 0;
  const accessibleText = [source?.kind, attributionText].filter(Boolean).join('. ');

  return (
    <div className="solved-caption">
      {animate && accessibleText && <span className="sr-only">{accessibleText}</span>}
      {source?.kind && (
        <span className="solved-kind" aria-hidden={animate || undefined}>
          {typedLine(kindChars, kindShown, kindCursor)}
        </span>
      )}
      {attribution && (
        <p className="solved-attribution" aria-hidden={animate || undefined}>
          {typedLine(attributionChars, attributionShown, attributionCursor)}
        </p>
      )}
    </div>
  );
}
