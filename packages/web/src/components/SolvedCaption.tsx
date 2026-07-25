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
//
// `masked` is what lets the caption be MOUNTED for the whole round (it reserves the prompt
// zone's height, so the input→citation swap never moves the sentence) without the citation
// being READABLE before the solve: an unsolved round would otherwise carry "— Victor Hugo,
// Les Misérables" in the DOM, one DevTools panel away, and the author of the sentence you
// are reconstructing is a hint. Every non-space glyph is replaced; the citation is set in
// the pixel font (monospace) and the spaces — its only wrap opportunities — are kept, so
// the mask lays out to exactly the box the real text will.
const MASK_CHAR = 'M';
const veil = (text: string, masked: boolean) =>
  masked ? text.replace(/\S/gu, MASK_CHAR) : text;

export default function SolvedCaption({
  source,
  animate = false,
  masked = false,
  onComplete,
}: {
  source?: Source;
  animate?: boolean;
  masked?: boolean;
  onComplete?: () => void;
}) {
  const attribution = [source?.author, source?.work].filter(Boolean).join(', ');
  const attributionText = attribution ? `— ${attribution}` : '';
  const kindChars = useMemo(
    () => Array.from(veil(source?.kind ?? '', masked)),
    [source?.kind, masked],
  );
  const attributionChars = useMemo(
    () => Array.from(veil(attributionText, masked)),
    [attributionText, masked],
  );
  const total = kindChars.length + attributionChars.length;
  const reduceMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [shown, setShown] = useState(() => (animate && !reduceMotion ? 0 : total));

  // Rewind DURING render, not in the effect below: `animate` turns on in the same commit
  // that unhides the caption, and an effect runs after that commit has been painted — so
  // the whole citation would flash complete for a frame before the typewriter took it back
  // to zero (and its finished-typing timer would fire spuriously in between).
  const [wasAnimating, setWasAnimating] = useState(animate);
  if (animate !== wasAnimating) {
    setWasAnimating(animate);
    setShown(animate && !reduceMotion ? 0 : total);
  }

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
  // Empty while masked, so the sr-only mirror can never carry the citation either.
  const accessibleText = masked ? '' : [source?.kind, attributionText].filter(Boolean).join('. ');

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
