import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { StrikeArt } from './rarity';
import { SLASH_ART } from './rarity';

// Word mode's CLAIM feedback (#163, decided 2026-08-09): a slash across the day's word, in
// the claimed grade's colour.
//
// It REPLACED the grade name that used to stamp onto the word. A name had to be read; a
// strike is felt, which is the right register for a game played against a clock. The grade's
// name and the guess's rank survive only as the LOOT the hit knocks off the word
// (`WordLoot`, 2026-08-10) — in the air for under a second, never parked; the post-mortem
// board is where a run gets read back.
//
// The art is `assets/slash.png`, five 36x46 frames of a stroke landing and dissipating,
// drawn at an exact integer scale (see `.word-slash`). It is pure white, so it is used as a
// MASK painted in the grade's colour rather than as an image — the same technique as the
// header's globe, and the reason one sheet serves several grades.
//
// A strike is ONE BLOW of one sheet (user-decided 2026-08-11, retiring the RARE cross and
// its two-blow choreography). What varies per hit besides the sheet is the plain slash's
// DIRECTION: it lands randomly mirrored — rolled once per hit, so a re-render cannot flip a
// stroke mid-swing — which keeps a run of common claims from stamping the identical
// diagonal every time. Only the slash: the burst and the ultra star are roughly symmetric
// art, and mirroring them would say nothing.
//
// The two rarest grades get their own SHEET instead (2026-08-09): a wider detonation at
// OBSCURE, the coloured star at ARCANE. One component still — which sheet is a class, and
// the lifetime, the frame walk and the show/hide rule are shared by all three.
export default function WordSlash({
  id,
  color,
  art,
  onDone,
}: {
  id: number; // monotonic, so a new guess replaces the strike on screen
  color: string; // the grade's colour — what a MASKED sheet is painted in (the coloured
  // one carries its own palette and ignores this)
  art: StrikeArt;
  onDone?: (id: number) => void;
}) {
  // Rolled once per mount — the strike is keyed by its hit's id, so this is once per hit.
  const [mirrored] = useState(() => art === SLASH_ART && Math.random() < 0.5);

  useEffect(() => {
    const t = setTimeout(() => onDone && onDone(id), art.ms);
    return () => clearTimeout(t);
  }, [id, art, onDone]);

  return (
    <span
      className={`word-slash${art.css ? ` ${art.css}` : ''}${mirrored ? ' mirrored' : ''}`}
      style={
        {
          color,
          // Handed down rather than repeated in CSS, so the JS that ends the strike and
          // the CSS that draws it cannot disagree about how long it is.
          '--slash-ms': `${art.ms}ms`,
        } as CSSProperties
      }
    />
  );
}
