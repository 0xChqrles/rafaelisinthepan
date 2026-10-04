import { useLayoutEffect, useRef } from 'react';
import { COUNT_SHAKE, RUN_SHAKE_MS, runReel, runStop } from './countRun';
import { prefersReducedMotion } from '../hooks/useScramble';

// A BOARD'S NUMBER ON THE COUNT'S REELS: the result's slot machine (`countRun.ts` — one REEL
// per digit, all spinning from almost the same instant, STOPPING LEFT TO RIGHT with a snap, a
// shake on each stop) at a row's scale, so the board's numbers land the way the score did. The
// run is the count's own, its clock compressed to `runMs` (the count's 2s is a hero's; a line
// is one of many): the same curve, the same stops in the same order, just faster — the
// compressed run (`runReel`) the podium's values land on too.
//
// Each reel is the face's ten digits on a strip in a one-glyph window, and the strip only
// ever stands at a WHOLE FONT PIXEL (an eighth of the em: 2px at the board's 16px), sampled
// in hard steps — the count's grid, never a glyph between two of the face's pixels. A stop
// shakes the digit by whole font pixels, the count's own frames. The motion is the Web
// Animations API, so the reels cost nothing once they have stopped and follow the page's
// playback rate; nothing here is state. The window is the final number's own box from the
// first frame (one glyph a digit, the face's fixed advance), so nothing moves as it lands —
// and at rest, or under reduced motion, the strips simply stand on the number.
//
// A screen reader is told the number, never the reels.
const FRAME_MS = 33;
// The strip: 0 to 9, and 0 again, so a reel rolling past 9 shows the next 0 coming up.
const STRIP = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0];
const EM_PX = 8;

const at = (pos: number) => `translateY(-${Math.floor(pos * EM_PX) / EM_PX}em)`;

export default function ReelNumber({
  value,
  delayMs = 0,
  runMs = 0,
}: {
  value: number;
  // When the reels start, from the mount; how long until the last one stops. No run: the
  // number simply stands.
  delayMs?: number;
  runMs?: number;
}) {
  const digits = Array.from(String(Math.max(0, Math.floor(value))), Number);
  const reels = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const root = reels.current;
    if (!root || runMs <= 0 || prefersReducedMotion()) return undefined;
    const n = digits.length;
    const running: Animation[] = [];
    Array.from(root.children as HTMLCollectionOf<HTMLElement>).forEach((reel, i) => {
      const strip = reel.firstElementChild as HTMLElement | null;
      if (!strip) return;
      const frames: Keyframe[] = [];
      for (let ms = 0; ms < runMs; ms += FRAME_MS) {
        const pos = runReel(digits[i], i, n, ms, runMs).travelled % 10;
        frames.push({ transform: at(pos), offset: ms / runMs, easing: 'steps(1, end)' });
      }
      frames.push({ transform: at(digits[i]), offset: 1 });
      running.push(strip.animate(frames, { duration: runMs, delay: delayMs, fill: 'backwards' }));
      // The stop's shake, in whole font pixels, the moment this reel lands.
      const shake: Keyframe[] = COUNT_SHAKE.map(([dx, dy], k) => ({
        transform: `translate(${dx / EM_PX}em, ${dy / EM_PX}em)`,
        offset: k / COUNT_SHAKE.length,
        easing: 'steps(1, end)',
      }));
      shake.push({ transform: 'none', offset: 1 });
      running.push(
        reel.animate(shake, {
          duration: RUN_SHAKE_MS,
          delay: delayMs + runStop(i, n, runMs),
        }),
      );
    });
    return () => running.forEach((animation) => animation.cancel());
    // A number runs ONCE, when it mounts: a later read changing it simply stands it there.
  }, []);

  return (
    <span className="reel-num">
      <span ref={reels} className="reel-set" aria-hidden="true">
        {digits.map((digit, i) => (
          <span key={i} className="reel">
            <span className="reel-strip" style={{ transform: at(digit) }}>
              {STRIP.map((d, k) => (
                <span key={k}>{d}</span>
              ))}
            </span>
          </span>
        ))}
      </span>
      <span className="sr-only">{value}</span>
    </span>
  );
}
