import { useEffect, useState } from 'react';
import { prefersReducedMotion } from './useScramble';

// The letter WAVE (#129): a word's letters ripple, quick and transform-only. It began as
// the sentence hole's tap affordance, and now says the same thing wherever a word can be
// tapped or is simply alive on screen — the day's word during a Word run, and the sentence
// result's guessed words. This hook is the third surface's doing: two copies were a
// recorded decision ("importing half a component's internals is not sharing it"), but the
// scheduling here is PURE — two timers and a random band, with no knowledge of holes,
// strikes or solved stages — so at three copies the drift costs more than the sharing does.
// Retuning the band or the stagger is now one edit that cannot leave one surface behind.
//
// What is NOT here is each surface's own answer to "is this word free to ripple right now?"
// — a hole's `ticking`, a word's letter count, a solved word's arrival. That is `active`,
// and it stays with the caller, because it is the one part the three genuinely disagree on.

// One letter's whole up-and-down, and the delay between two consecutive letters.
export const WAVE_LETTER_MS = 300;
export const WAVE_STEP_MS = 40;

// The two numbers handed to CSS rather than repeated there, so the JS that ends a wave and
// the animation that draws it read the same values. Spread onto the element's style while
// it waves; there is nothing to set while it rests.
export const WAVE_VARS: Record<string, string> = {
  '--wave-dur': `${WAVE_LETTER_MS}ms`,
  '--wave-step': `${WAVE_STEP_MS}ms`,
};

// A wave's own length: the last letter's delay plus its animation. Ending it on a timer
// rather than on `animationend` is what keeps ONE owner of the numbers above.
export function waveDurationMs(letters: number): number {
  return WAVE_LETTER_MS + Math.max(0, letters - 1) * WAVE_STEP_MS;
}

// How long a word waits between its own waves. EVERY word runs this clock independently
// (decided 2026-07-27, replacing a single round-level scheduler that picked one at a time):
// a lone ripple travelling around the sentence reads as a cursor pointing somewhere, while
// several words stirring on their own rhythms read as the words being alive — which is the
// whole claim the affordance makes. The band is wide and re-rolled per wave, so words drift
// apart on their own instead of needing to be kept apart.
const WAVE_MIN_MS = 3_000;
const WAVE_MAX_MS = 10_000;

// Is this word rippling right now? Two clocks: one waits a fresh random delay and starts a
// wave, the other ends it after its own length and re-arms the first. A wave already in
// flight is CUT the moment `active` drops — a caller's word can stop being free to ripple
// mid-wave (a guess lands, a modal opens over the sentence), and a tail showing after the
// thing that interrupted it has gone is worse than no wave. Never under reduced motion:
// the clock simply never starts.
export default function useLetterWave(active: boolean, letters: number): boolean {
  const [waving, setWaving] = useState(false);
  // Bumped by each finished wave, purely to re-arm the clock below with a fresh delay.
  const [waveCount, setWaveCount] = useState(0);

  useEffect(() => {
    if (!active || waving || prefersReducedMotion()) return undefined;
    const id = window.setTimeout(
      () => setWaving(true),
      WAVE_MIN_MS + Math.random() * (WAVE_MAX_MS - WAVE_MIN_MS),
    );
    return () => window.clearTimeout(id);
    // Re-rolled whenever the word becomes free again, so a sentence's words also scatter
    // after every guess rather than settling into lockstep off one shared start.
  }, [active, waving, waveCount]);

  useEffect(() => {
    if (!waving) return undefined;
    const id = window.setTimeout(() => {
      setWaving(false);
      setWaveCount((n) => n + 1);
    }, waveDurationMs(letters));
    return () => window.clearTimeout(id);
    // The letter count is read when the wave STARTS. A word whose length can change mid-life
    // (a hole's scramble) is not `active` while it changes, so this can never re-time a
    // wave that is already running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waving]);

  useEffect(() => {
    if (!active) setWaving(false);
  }, [active]);

  return waving;
}
