import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { StrikeArt } from './strikeArt';
import { SLASH_ART } from './strikeArt';

// A STRIKE on a game word: one blow of one sheet (`strikeArt.ts`), in one colour.
//
// The sentence game lands it on a hole (#301): the cut for a guess that charges the hole's
// meter, the burst when the meter fills, the ultra star for the exact hit. The component
// knows nothing of the board: which sheet, what colour and when are the caller's.
//
// The art is drawn at an exact integer scale (see `.strike` in index.css; the sentence
// steps it down under `.phrase`). The white sheets are used as a MASK painted in `color`
// rather than as an image — the same technique as the header's globe, and the reason one
// sheet serves several colours.
//
// A strike is ONE BLOW of one sheet (user-decided 2026-08-11, retiring the RARE cross and
// its two-blow choreography). What varies per hit besides the sheet is the plain slash's
// DIRECTION: it lands randomly mirrored — rolled once per hit, so a re-render cannot flip a
// stroke mid-swing — which keeps a run of hits from stamping the identical diagonal every
// time. Only the slash: the burst and the ultra star are roughly symmetric art, and
// mirroring them would say nothing.
export default function Strike({
  id,
  color,
  art,
  delayMs = 0,
  onDone,
}: {
  id: number; // monotonic, so a new hit replaces the strike on screen
  color: string; // what a MASKED sheet is painted in (the coloured one carries its own
  // palette and ignores this)
  art: StrikeArt;
  // How long after mount the blow lands — the sentence staggers its holes' feedback
  // (Game's `STAGGER_MS`), and the sheet must stay unseen until its turn.
  delayMs?: number;
  onDone?: (id: number) => void;
}) {
  // Rolled once per mount — the strike is keyed by its hit's id, so this is once per hit.
  const [mirrored] = useState(() => art === SLASH_ART && Math.random() < 0.5);

  useEffect(() => {
    const t = setTimeout(() => onDone && onDone(id), delayMs + art.ms);
    return () => clearTimeout(t);
  }, [id, art, delayMs, onDone]);

  return (
    <span
      className={`strike${art.css ? ` ${art.css}` : ''}${mirrored ? ' mirrored' : ''}`}
      style={
        {
          color,
          // Handed down rather than repeated in CSS, so the JS that ends the strike and
          // the CSS that draws it cannot disagree about how long it is, or when it starts.
          '--slash-ms': `${art.ms}ms`,
          '--strike-delay': `${delayMs}ms`,
        } as CSSProperties
      }
    />
  );
}
