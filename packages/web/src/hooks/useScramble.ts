import { useCallback, useEffect, useRef, useState } from 'react';

// The "slot-machine" scramble shared by the game's word swap (Hole) and the tutorial's
// mix demo (MixWord, #51): a word's letters churn through random glyphs and settle
// left-to-right into the target over SCRAMBLE_MS. When the target is a different length
// than the word it replaces, the visible length interpolates across the settle —
// letters are added/removed one at a time as it churns — so the word, and the sentence
// wrapping around it, grows or shrinks gradually instead of snapping (issue #102).
//
// An optional `holdMs` churns the OLD length in place FIRST, without settling any letter
// or touching the length, then runs the settle. The game passes RANK_MAX_MS so the
// exponent/rank tween has finished before the word starts fixing letters and reflowing —
// the length change never competes with the number dropping (#102).

// Keep this duration fixed: the settle is independent of the exponent/rank tween.
// The tutorial uses it only to schedule its own mix-stage timing (see MixWord / Tutorial).
export const SCRAMBLE_MS = 650;
const SCRAMBLE_TICK_MS = 40;
const GLYPHS = 'abcdefghijklmnopqrstuvwxyz';

export function randomGlyphs(n: number): string {
  let out = '';
  for (let i = 0; i < n; i += 1) out += GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
  return out;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

// The scramble's displayed string at progress `p` (0..1): the first `settled` letters of
// the target are locked in place (left-to-right), the rest of the interpolated current
// length are random glyphs. Length runs from `fromLen` at p=0 to the target's length at
// p=1, so a longer/shorter replacement grows/shrinks by one letter at a time. Because the
// old length only ever adds to the gap, `settled <= curLen` for every p, so the random
// tail count is never negative and the locked prefix is never garbled. At p>=1 it is
// exactly the target.
export function scrambleFrame(target: string, fromLen: number, p: number): string {
  if (p >= 1) return target;
  const toLen = target.length;
  const curLen = Math.round(fromLen + (toLen - fromLen) * p);
  const settled = Math.floor(p * toLen);
  return target.slice(0, settled) + randomGlyphs(curLen - settled);
}

// Drives one scramble at a time. `jumble` is the churning string while a scramble is in
// flight, or null when idle/settled (the caller then renders the resolved word itself).
// Call `start(target, fromLen, onDone?, holdMs?)` to (optionally) churn `fromLen` glyphs
// in place for `holdMs` first, then settle them into `target`; `onDone` fires once the
// target is fully settled. Honors prefers-reduced-motion by settling instantly (jumble
// goes null, `onDone` fires synchronously — no churn/hold). The interval is torn down on
// a restart and on unmount.
export function useScramble(): {
  jumble: string | null;
  start: (target: string, fromLen: number, onDone?: () => void, holdMs?: number) => void;
} {
  const [jumble, setJumble] = useState<string | null>(null);
  const intervalRef = useRef<number | undefined>(undefined);

  const stop = useCallback(() => {
    if (intervalRef.current !== undefined) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = undefined;
    }
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback(
    (target: string, fromLen: number, onDone?: () => void, holdMs = 0) => {
      stop();
      if (prefersReducedMotion()) {
        setJumble(null);
        onDone?.();
        return;
      }
      const started = Date.now();
      setJumble(randomGlyphs(fromLen));
      intervalRef.current = window.setInterval(() => {
        const elapsed = Date.now() - started;
        // Hold phase: keep churning the OLD length in place — no letter fixed, no length
        // change — so the caller's exponent tween can finish before the settle begins.
        if (elapsed < holdMs) {
          setJumble(randomGlyphs(fromLen));
          return;
        }
        const p = (elapsed - holdMs) / SCRAMBLE_MS;
        if (p >= 1) {
          stop();
          setJumble(null);
          onDone?.();
          return;
        }
        setJumble(scrambleFrame(target, fromLen, p));
      }, SCRAMBLE_TICK_MS);
    },
    [stop],
  );

  return { jumble, start };
}
