import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { SCRAMBLE_TICK_MS, prefersReducedMotion } from '../hooks/useScramble';

// THE SENTENCE DECODES ITSELF IN (user-asked 2026-09-23: the arrival "is a bit lame… I
// don't feel any juice"). It is the DISSOLVE run backwards — the exit the solved sentence
// already plays — in the churn every changing word in this game speaks (a hole's scramble,
// a hint's uncyphering): a front sweeps the sentence left to right, and each letter it
// reaches LANDS as a random glyph in the accent, churns on its own clock, and CLICKS into
// its real letter in the sentence's ink. A hole, when the front reaches it, is STAMPED in
// (the chip's hit inversion for an instant, the exponent's pop — Phrase's CSS). The pixel
// face advances every glyph 1em, so a churning letter takes exactly its letter's room:
// nothing reflows. Reduced motion prints the sentence at once.

// The churn's clock is the scramble's own.
const TICK_MS = SCRAMBLE_TICK_MS;
// The front's whole run, left to right, whatever the sentence's length…
const SWEEP_MS = 700;
// …but never slower than this a letter, so a short sentence is not dragged out.
const CHAR_MS = 14;
// How long a letter churns once the front has reached it: a hashed 2 to 5 ticks, so the
// letters click into place scattered rather than in lockstep.
const CHURN_MIN_TICKS = 2;
const CHURN_SPAN_TICKS = 4;
const GLYPHS = 'abcdefghijklmnopqrstuvwxyz';
const LETTER = /\p{L}/u;

// A stable integer hash: the same letter churns through the same glyphs on a re-render.
function hash(a: number, b: number): number {
  let h = Math.imul(a + 1, 374761393) ^ Math.imul(b + 7, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

export interface IntroPlan {
  // The front's pace, per letter (ms).
  charMs: number;
  // When the whole intro is over (ms): the last letter's landing plus the longest churn.
  totalMs: number;
}

// The pace for a sentence of `letters` letters (spaces excluded).
export function introPlan(letters: number): IntroPlan {
  const charMs = Math.min(CHAR_MS, SWEEP_MS / Math.max(1, letters));
  return { charMs, totalMs: letters * charMs + (CHURN_MIN_TICKS + CHURN_SPAN_TICKS) * TICK_MS + TICK_MS };
}

// The intro's clock: ONE rAF loop for the whole sentence, read as a store by the words
// that decode, so the sentence around them (the holes, their meters) never re-renders for
// it. `running` drops once `totalMs` has passed; it (re)starts whenever `key` — the
// sentence — changes. Off under reduced motion.
export interface IntroClock {
  running: boolean;
  subscribe: (onTick: () => void) => () => void;
  tick: () => number;
}

export function useIntroClock(key: string, totalMs: number): IntroClock {
  const [reduced] = useState(prefersReducedMotion);
  // The sentence whose intro has PLAYED: running is read off it in the render itself, so a
  // new sentence starts hidden on its very first frame rather than flashing in whole.
  const [doneKey, setDoneKey] = useState<string | null>(null);
  const running = !reduced && doneKey !== key;
  const store = useRef({ key, tick: 0, subs: new Set<() => void>() });
  if (store.current.key !== key) {
    store.current.key = key;
    store.current.tick = 0;
  }
  useEffect(() => {
    if (!running) return undefined;
    const t0 = performance.now();
    let raf = 0;
    const loop = () => {
      const t = performance.now() - t0;
      const tick = Math.floor(t / TICK_MS);
      if (tick !== store.current.tick) {
        store.current.tick = tick;
        store.current.subs.forEach((notify) => notify());
      }
      if (t >= totalMs) setDoneKey(key);
      else raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running, totalMs, key]);
  const [clock] = useState(() => ({
    subscribe: (onTick: () => void) => {
      store.current.subs.add(onTick);
      return () => {
        store.current.subs.delete(onTick);
      };
    },
    tick: () => store.current.tick,
  }));
  return { running, subscribe: clock.subscribe, tick: clock.tick };
}

// One plain word of the sentence while the intro runs: every letter a box, hidden until
// the front reaches it (`first` is the sentence-wide index of its first letter), then a
// churning glyph, then its own letter. The real word stays for a screen reader.
export function DecodeWord({
  text,
  first,
  plan,
  clock,
}: {
  text: string;
  first: number;
  plan: IntroPlan;
  clock: IntroClock;
}) {
  const tick = useSyncExternalStore(clock.subscribe, clock.tick, clock.tick);
  const now = tick * TICK_MS;
  let n = first;
  const letters = Array.from(text).map((ch, i) => {
    const g = n;
    if (ch !== ' ') n += 1;
    const lands = g * plan.charMs;
    if (now < lands) {
      return (
        <span key={i} className="dw-letter dw-wait">
          {ch}
        </span>
      );
    }
    const churn = (CHURN_MIN_TICKS + (hash(g, 0) % CHURN_SPAN_TICKS)) * TICK_MS;
    if (!LETTER.test(ch) || now >= lands + churn) {
      return (
        <span key={i} className="dw-letter">
          {ch}
        </span>
      );
    }
    return (
      <span key={i} className="dw-letter dw-churn">
        {GLYPHS[hash(g, tick) % GLYPHS.length]}
      </span>
    );
  });
  return (
    <>
      <span className="dw-run" aria-hidden="true">
        {letters}
      </span>
      <span className="sr-only">{text}</span>
    </>
  );
}
