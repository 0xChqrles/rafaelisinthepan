import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Source } from '@whippin/shared';
import { prefersReducedMotion } from '../hooks/useScramble';

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

// The solved sentence's attribution (issue #8), the solved stage's opening line since the
// 2026-08-14 redesign — a quote-style citation from the optional literary metadata (#5):
// a kind tag and "— Author, Work", typed big at the top of the result the dissolved
// sentence handed the screen to. Every final character is present but hidden from frame
// one so line wrapping is stable; the underscore occupies the next character's reserved
// slot. Rehydrated solves render the complete source immediately.
//
// (The `masked` veil died with the redesign: the caption used to be MOUNTED for the whole
// round to reserve the prompt zone's height, which is what put the author of an unsolved
// sentence one DevTools panel away. It now mounts only WITH the solved stage, so there is
// no unsolved DOM for the citation to leak into.)
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
  const reduceMotion = prefersReducedMotion();
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
      // A TIMER, not a frame (2026-08-03). This branch is the WHOLE completion signal for a
      // source-less puzzle (`total === 0` — `source` is optional in the schema) and for every
      // reduced-motion player: no interval runs, so this one callback is what ends the source
      // beat. A frame is the weaker guarantee of the two — `requestAnimationFrame` does not run
      // while the document is HIDDEN (a hidden document gets no rendering opportunity), where a
      // timer is merely throttled. So a player who solves and immediately locks the phone or
      // switches apps leaves the beat unfinished for as long as they are away, and any path
      // that drops the pending frame outright leaves it unfinished for good — with the result
      // stack fully pressable and only the holes locked, which is the report this came from.
      // The deferral only has to leave this commit, never to land on a paint, so the frame was
      // buying nothing in exchange for that exposure. Whether a lost frame is what the reporter
      // actually hit was NOT reproduced; `SOURCE_REVEAL_FALLBACK_MS` in `Game.tsx` is what
      // guarantees the outcome either way. This just removes the one link in the chain that
      // needed the page to be on screen.
      const id = window.setTimeout(() => onComplete?.(), 0);
      return () => window.clearTimeout(id);
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
