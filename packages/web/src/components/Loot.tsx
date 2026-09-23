import { useEffect, useLayoutEffect, useRef } from 'react';
import { rankHeatColor } from '@whippin/shared';
import { prefersReducedMotion } from '../hooks/useScramble';

// The LOOT a cut knocks out of a hole (#301, user-decided 2026-09-15, "the same exponent
// animation"): the guess's rank, in the heat colour every exponent wears, popping out of
// the struck word.
//
// IT STAYS WITH ITS HOLE, AND IT STAYS LONG ENOUGH TO READ (user-asked 2026-09-23: "make
// sure we have the time to see them well and understand what's going on and to which hole
// are they related"). The throw used to be a random side, a line and a half up and ~45px
// across, gone 780ms after it started whatever the board was doing — on a phone it
// landed over other words, and the last of three was out of the air a beat after it came.
// Now it is three beats, each tied to the hole it came out of:
//   1. POP — out of the word to a PERCH just above its own chip (clear of the chip and of
//      nothing else), a small rolled lean either way so two hits never stamp one arc.
//   2. HANG — it holds there until the guess is RELEASED into the board, so every hole's
//      number stands over its hole at the same moment: the guess, read as one report.
//   3. RESOLVE — a number that IMPROVES its hole flies INTO the hole's own exponent and
//      arrives as the release lands, which is when the exponent pops and counts down to
//      it: the guess visibly becomes the hole's new best. One that does not improve it
//      drops away through the word and fades, the batch leaving together.
// No `scale` and no tilt: the pixel face renders blurred between pixels (the standing
// rule), and a rotated number is harder to read, which is this piece's whole job.
const RISE_MS = 260;
const INTO_MS = 240;
const DROP_MS = 380;
// The perch's clearance over the chip, and the rolled lean either side (px).
const PERCH_GAP_PX = 6;
const LEAN_MIN_PX = 3;
const LEAN_MAX_PX = 10;
// The chip is 1.267em of the word tall (`.hole-word::before`), centred on it.
const CHIP_HALF_EM = 1.267 / 2;

const POP = 'cubic-bezier(0.2, 1.45, 0.4, 1)';

// When the loot is over, from mount: an improving number arrives exactly on the release;
// any other one leaves on it and drops for DROP_MS.
export function lootEndMs(releaseMs: number, improves: boolean): number {
  return improves ? releaseMs : releaseMs + DROP_MS;
}

export default function Loot({
  id,
  rank,
  delayMs = 0,
  releaseMs,
  improves,
  onDone,
}: {
  id: number; // monotonic: a new hit replaces the loot in the air
  rank: number;
  // When the throw starts, from mount — the sentence staggers its holes' feedback.
  delayMs?: number;
  // When the guess is released into the board, from mount (the hits' shared fade beat).
  releaseMs: number;
  // Does this rank beat the hole's current best? Read once, at the hit's mount.
  improves: boolean;
  onDone?: (id: number) => void;
}) {
  const node = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const t = setTimeout(() => onDone && onDone(id), lootEndMs(releaseMs, improves));
    return () => clearTimeout(t);
    // Per hit: the component is re-keyed on each, and its beats are fixed at its mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useLayoutEffect(() => {
    const el = node.current;
    const wrap = el?.parentElement;
    if (!el || !wrap || typeof el.animate !== 'function') return undefined;
    const word = parseFloat(getComputedStyle(wrap).fontSize) || 24;
    const own = parseFloat(getComputedStyle(el).fontSize) || 24;
    const apex = -Math.round(word * CHIP_HALF_EM + own / 2 + PERCH_GAP_PX);
    const lean = Math.round((Math.random() < 0.5 ? -1 : 1) * (LEAN_MIN_PX + Math.random() * (LEAN_MAX_PX - LEAN_MIN_PX)));
    // The hole's own exponent — where an improving number goes. Measured centre to centre
    // (the loot is centred on the word's wrap); missing, the number simply drops.
    const sup = wrap.parentElement?.querySelector<HTMLElement>('.hole-rank');
    const into =
      improves && sup
        ? (() => {
            const a = wrap.getBoundingClientRect();
            const b = sup.getBoundingClientRect();
            return {
              x: Math.round(b.left + b.width / 2 - (a.left + a.width / 2)),
              y: Math.round(b.top + b.height / 2 - (a.top + a.height / 2)),
            };
          })()
        : null;

    const live = Math.max(1, releaseMs - delayMs);
    const perch = `${lean}px ${apex}px`;
    if (prefersReducedMotion()) {
      // No motion: the number stands on its perch from its beat to the release.
      const still = el.animate(
        [
          { opacity: 1, translate: perch },
          { opacity: 1, translate: perch },
        ],
        { duration: live, delay: delayMs },
      );
      return () => still.cancel();
    }
    const total = into ? live : live + DROP_MS;
    const at = (ms: number) => Math.min(1, Math.max(0, ms / total));
    const riseEnd = at(RISE_MS);
    const hangEnd = Math.max(riseEnd, at(into ? live - INTO_MS : live));
    const frames: Keyframe[] = [
      { offset: 0, opacity: 0, translate: `0px 4px` },
      { offset: at(1), opacity: 1, translate: `0px 4px`, easing: POP },
      { offset: riseEnd, opacity: 1, translate: perch },
      { offset: hangEnd, opacity: 1, translate: perch, easing: into ? 'cubic-bezier(0.5, 0, 0.6, 1)' : 'cubic-bezier(0.55, 0, 0.9, 0.5)' },
      into
        ? { offset: 1, opacity: 0.15, translate: `${into.x}px ${into.y}px` }
        : { offset: 1, opacity: 0, translate: `${Math.round(lean * 1.6)}px ${Math.round(word * 0.5)}px` },
    ];
    const flight = el.animate(frames, { duration: total, delay: delayMs });
    return () => flight.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return (
    <span ref={node} className="loot" style={{ color: rankHeatColor(rank) }} aria-hidden="true">
      {String(rank)}
    </span>
  );
}
