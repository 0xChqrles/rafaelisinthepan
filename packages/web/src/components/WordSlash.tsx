import { useEffect } from 'react';
import type { CSSProperties } from 'react';
import { SECOND_SLASH_DELAY_MS, slashDurationMs } from './rarity';

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
// A rare find is struck TWICE, the second mirrored so the pair crosses. Both blows are one
// event: this component owns their shared lifetime and reports when the LAST of them is
// done.
export default function WordSlash({
  id,
  color,
  slashes,
  onDone,
}: {
  id: number; // monotonic, so a new guess replaces the strike on screen
  color: string; // the grade's colour — what the mask is painted in
  slashes: number; // 1, or 2 from DOUBLE_SLASH_FROM up
  onDone?: (id: number) => void;
}) {
  useEffect(() => {
    const t = setTimeout(() => onDone && onDone(id), slashDurationMs(slashes));
    return () => clearTimeout(t);
  }, [id, slashes, onDone]);

  return (
    <>
      {Array.from({ length: slashes }, (_, i) => (
        <span
          key={i}
          className={`word-slash${i > 0 ? ' mirrored' : ''}`}
          style={
            {
              color,
              '--slash-delay': `${i * SECOND_SLASH_DELAY_MS}ms`,
            } as CSSProperties
          }
        />
      ))}
    </>
  );
}
