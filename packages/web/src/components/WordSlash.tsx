import { useEffect } from 'react';
import type { CSSProperties } from 'react';
import type { Strike } from './rarity';
import { blowMs, slashDelayMs, strikeDurationMs } from './rarity';

// Word mode's CLAIM feedback (#163, decided 2026-08-09): a slash across the day's word, in
// the claimed grade's colour.
//
// It REPLACED the grade name that used to stamp onto the word. A name had to be read; a
// strike is felt, which is the right register for a game played against a clock — and the
// grade itself is still written down, twice, in the run's history and its tally. What was
// lost is a word to read mid-sprint; what was gained is a moment.
//
// The art is `assets/slash.png`, five 36x46 frames of a stroke landing and dissipating,
// drawn at an exact integer scale (see `.word-slash`). It is pure white, so it is used as a
// MASK painted in the grade's colour rather than as an image — the same technique as the
// header's globe, and the reason one sheet serves five grades.
//
// A rare find is struck TWICE, the second mirrored so the pair crosses — and the second
// WAITS for the first to finish rather than overlapping it, so it reads as being struck
// twice instead of once with a thicker stroke. Both blows are still one event: this
// component owns their shared lifetime and reports when the LAST of them is done.
//
// The rarest two grades get `assets/ultra-slash.png` INSTEAD of a cross (2026-08-09) — a
// 7-frame burst, one blow, drawn as an IMAGE in its own palette rather than as a mask in the
// grade's colour, because unlike the stroke that sheet is authored in colour (see `rarity`).
// One component still: which sheet is a class, the lifetime and the frame walk are shared.
export default function WordSlash({
  id,
  color,
  strike,
  onDone,
}: {
  id: number; // monotonic, so a new guess replaces the strike on screen
  color: string; // the grade's colour — what the STROKE's mask is painted in (the burst
  // carries its own palette and ignores this)
  strike: Strike;
  onDone?: (id: number) => void;
}) {
  const { ultra, blows } = strike;

  useEffect(() => {
    const t = setTimeout(() => onDone && onDone(id), strikeDurationMs(strike));
    return () => clearTimeout(t);
  }, [id, strike, onDone]);

  return (
    <>
      {Array.from({ length: blows }, (_, i) => (
        <span
          key={i}
          className={`word-slash${ultra ? ' ultra' : ''}${i > 0 ? ' mirrored' : ''}`}
          style={
            {
              color,
              // Both handed down rather than repeated in CSS, so the JS that ends the
              // strike and the CSS that draws it cannot disagree about how long it is.
              '--slash-ms': `${blowMs(strike)}ms`,
              '--slash-delay': `${slashDelayMs(i)}ms`,
            } as CSSProperties
          }
        />
      ))}
    </>
  );
}
