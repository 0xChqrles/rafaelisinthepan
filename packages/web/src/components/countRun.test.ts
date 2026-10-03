// The result's count run (`countRun.ts`): ONE fixed length for every score, a slot machine —
// a reel per digit, started almost together, stopped left to right, each stop a snap and a
// shake — and the ruler's tries on the same clock: the contract the screen's clock and its
// card share.
import { describe, expect, it } from 'vitest';
import { ROUND_GUESS_CAP } from '@whippin/shared';
import {
  COUNT_BRAKE_MS,
  COUNT_END_MS,
  COUNT_LOCK_RATE,
  COUNT_RUN_MS,
  COUNT_SETTLE_MS,
  COUNT_SHAKE,
  COUNT_SHAKE_FRAME_MS,
  COUNT_SHAKE_MS,
  COUNT_SPIN_RATE,
  COUNT_START_STAGGER_MS,
  COUNT_STOP_GAP_MS,
  countFilled,
  countReels,
  reelShake,
  reelStart,
  reelStop,
  reelTravelled,
  reelsText,
} from './countRun';

const SCORES = Array.from({ length: ROUND_GUESS_CAP }, (_, i) => i + 1);
// The run sampled at every millisecond of its clock.
const MS = Array.from({ length: COUNT_END_MS + 1 }, (_, ms) => ms);
const digitsOf = (score: number) => Array.from(String(score), Number);
// Every reel of a score: [digit, index, reel count].
const reelsOf = (score: number) => digitsOf(score).map((d, i, all) => [d, i, all.length] as const);
// A font pixel, in values.
const PIXEL = 1 / 8;

describe('countRun — a reel per digit, one fixed length', () => {
  it('gives the score one reel per digit, no leading zero, every reel resting on 0', () => {
    expect(countReels(3, 0)).toHaveLength(1);
    expect(countReels(23, 0)).toHaveLength(2);
    expect(countReels(137, 0)).toHaveLength(3);
    for (const score of [3, 23, 137, 499]) {
      expect(countReels(score, 0).every((r) => r.pos === 0 && r.dx === 0 && r.dy === 0)).toBe(true);
      expect(countFilled(score, 0)).toBe(0);
    }
  });

  it('starts the reels almost together, left to right', () => {
    for (let i = 1; i < 3; i += 1) expect(reelStart(i) - reelStart(i - 1)).toBe(COUNT_START_STAGGER_MS);
    expect(COUNT_START_STAGGER_MS).toBeGreaterThanOrEqual(50);
    expect(COUNT_START_STAGGER_MS).toBeLessThanOrEqual(80);
    // A reel stands on 0 until its start, and is spinning right after it.
    for (const score of [23, 137]) {
      for (const [d, i, n] of reelsOf(score)) {
        expect(reelTravelled(d, i, n, reelStart(i))).toBe(0);
        expect(reelTravelled(d, i, n, reelStart(i) + 20)).toBeGreaterThan(0);
      }
    }
  });

  it('stops the reels left to right, COUNT_STOP_GAP_MS apart, the last on COUNT_RUN_MS whatever the score', () => {
    for (const n of [1, 2, 3]) {
      expect(reelStop(n - 1, n)).toBe(COUNT_RUN_MS);
      for (let i = 1; i < n; i += 1) expect(reelStop(i, n) - reelStop(i - 1, n)).toBe(COUNT_STOP_GAP_MS);
    }
  });

  it('leaves every reel of the longest score a full spin before its brake, at least as long as the brake', () => {
    const n = String(ROUND_GUESS_CAP).length;
    for (let i = 0; i < n; i += 1) {
      expect(reelStop(i, n) - COUNT_SETTLE_MS - COUNT_BRAKE_MS - reelStart(i)).toBeGreaterThanOrEqual(COUNT_BRAKE_MS);
    }
  });

  it('lands on the score: once the last reel has stopped the reels read it whole, the ruler holds every try', () => {
    for (const score of SCORES) {
      for (const ms of [COUNT_RUN_MS, COUNT_END_MS]) {
        const reels = countReels(score, ms);
        expect(reelsText(reels)).toBe(String(score));
        expect(reels.every((r) => Number.isInteger(r.pos))).toBe(true);
      }
      expect(countFilled(score, COUNT_RUN_MS)).toBe(score);
      expect(countReels(score, COUNT_END_MS).every((r) => r.dx === 0 && r.dy === 0)).toBe(true);
    }
  });

  it('never lands early: the last reel and the ruler\'s last try both wait for COUNT_RUN_MS', () => {
    for (const score of SCORES) {
      const reels = reelsOf(score);
      const [d, i, n] = reels[reels.length - 1];
      expect(reelTravelled(d, i, n, COUNT_RUN_MS - 1)).not.toBe(reelTravelled(d, i, n, COUNT_RUN_MS));
      expect(countFilled(score, COUNT_RUN_MS - 1)).toBeLessThan(score);
    }
  });

  it('fills the ruler try by try on the same clock, at an even pace, never backwards', () => {
    for (const score of [1, 3, 9, 13, 23, 137, 499]) {
      let last = 0;
      for (const ms of MS) {
        const filled = countFilled(score, ms);
        expect(filled).toBeGreaterThanOrEqual(last);
        expect(filled).toBeLessThanOrEqual(score);
        expect(Math.abs(filled - (score * Math.min(ms, COUNT_RUN_MS)) / COUNT_RUN_MS)).toBeLessThan(1);
        last = filled;
      }
    }
  });
});

describe('countRun — a slot machine\'s reels', () => {
  it('spins every reel forward, fast, a whole turn after another', () => {
    for (const score of [1, 3, 9, 23, 100, 137, 499]) {
      for (const [d, i, n] of reelsOf(score)) {
        const stop = reelStop(i, n);
        let last = 0;
        for (let ms = reelStart(i); ms < stop - COUNT_SETTLE_MS; ms += 1) {
          const x = reelTravelled(d, i, n, ms);
          expect(x).toBeGreaterThanOrEqual(last);
          last = x;
        }
        // Its full spin: about COUNT_SPIN_RATE values a second (trimmed to land on its digit).
        const cruise = (reelTravelled(d, i, n, reelStart(i) + 300) - reelTravelled(d, i, n, reelStart(i) + 200)) * 10;
        expect(cruise).toBeGreaterThan(COUNT_SPIN_RATE * 0.8);
        expect(cruise).toBeLessThan(COUNT_SPIN_RATE * 1.25);
        // Whole turns and its digit.
        expect(reelTravelled(d, i, n, stop) % 10).toBe(d);
        expect(reelTravelled(d, i, n, stop)).toBeGreaterThanOrEqual(30);
      }
    }
  });

  it('brakes into its last few glyphs: never speeding up, down to COUNT_LOCK_RATE as it reaches its digit', () => {
    for (const score of [3, 23, 137, 499]) {
      for (const [d, i, n] of reelsOf(score)) {
        const overshoot = reelStop(i, n) - COUNT_SETTLE_MS;
        const speeds: number[] = [];
        for (let ms = overshoot - COUNT_BRAKE_MS - 50; ms < overshoot; ms += 1) {
          speeds.push((reelTravelled(d, i, n, ms + 1) - reelTravelled(d, i, n, ms)) * 1000);
        }
        for (let k = 1; k < speeds.length; k += 1) expect(speeds[k]).toBeLessThanOrEqual(speeds[k - 1] + 1e-6);
        expect(speeds[speeds.length - 1]).toBeCloseTo(COUNT_LOCK_RATE, 0);
        // The last glyph takes far longer to come up than a glyph at full spin.
        const crossings: number[] = [];
        let prev = 0;
        for (let ms = reelStart(i); ms <= overshoot; ms += 1) {
          const x = Math.floor(reelTravelled(d, i, n, ms));
          if (x !== prev) crossings.push(ms);
          prev = x;
        }
        const gaps = crossings.slice(1).map((t, k) => t - crossings[k]);
        expect(gaps[gaps.length - 1]).toBeGreaterThan(2.5 * (1000 / COUNT_SPIN_RATE));
      }
    }
  });

  it('snaps: one font pixel past its digit, held, then dropped into place on its stop', () => {
    for (const score of [3, 23, 137]) {
      for (const [d, i, n] of reelsOf(score)) {
        const stop = reelStop(i, n);
        const landed = reelTravelled(d, i, n, stop);
        for (let ms = stop - COUNT_SETTLE_MS; ms < stop; ms += 1) {
          expect(reelTravelled(d, i, n, ms)).toBe(landed + PIXEL);
        }
        // Never further past it than that one pixel.
        for (const ms of MS) expect(reelTravelled(d, i, n, ms)).toBeLessThanOrEqual(landed + PIXEL);
      }
    }
  });

  it('never moves a stopped reel again but for its shake, and never stops one before its time', () => {
    for (const score of [3, 23, 137, 499]) {
      for (const [d, i, n] of reelsOf(score)) {
        const stop = reelStop(i, n);
        for (const ms of MS) {
          const at = reelTravelled(d, i, n, ms) % 10;
          if (ms >= stop) expect(at).toBe(d);
        }
        expect(reelTravelled(d, i, n, stop - 1)).not.toBe(reelTravelled(d, i, n, stop));
      }
    }
  });
});

describe('countRun — the stop\'s shake', () => {
  it('shakes each reel on ITS stop, in whole font pixels, one hard step a frame, then stills it', () => {
    for (const score of [3, 23, 137]) {
      const n = String(score).length;
      for (let i = 0; i < n; i += 1) {
        const stop = reelStop(i, n);
        for (const ms of MS) {
          const [dx, dy] = reelShake(i, n, ms);
          expect(Number.isInteger(dx) && Number.isInteger(dy)).toBe(true);
          if (ms < stop || ms >= stop + COUNT_SHAKE_MS) expect([dx, dy]).toEqual([0, 0]);
          else expect([dx, dy]).toEqual(COUNT_SHAKE[Math.floor((ms - stop) / COUNT_SHAKE_FRAME_MS)]);
        }
        // countReels carries it, on that reel only.
        const reels = countReels(score, stop);
        reels.forEach((r, k) => {
          expect([r.dx, r.dy]).toEqual(k === i ? COUNT_SHAKE[0] : [0, 0]);
        });
      }
    }
  });

  it('is a recoil, never a drift: at most one font pixel, every frame moving, ending at rest', () => {
    expect(COUNT_SHAKE.length).toBeGreaterThan(1);
    for (const [dx, dy] of COUNT_SHAKE) {
      expect(Math.abs(dx)).toBeLessThanOrEqual(1);
      expect(Math.abs(dy)).toBeLessThanOrEqual(1);
      expect(dx !== 0 || dy !== 0).toBe(true);
    }
    for (let k = 1; k < COUNT_SHAKE.length; k += 1) expect(COUNT_SHAKE[k]).not.toEqual(COUNT_SHAKE[k - 1]);
    expect(COUNT_END_MS).toBe(COUNT_RUN_MS + COUNT_SHAKE_MS);
  });
});
