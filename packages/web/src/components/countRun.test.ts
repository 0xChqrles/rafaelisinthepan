// The result's count run (`countRun.ts`): ONE fixed length for every score, always a fast
// counter — the reels' reading and the ruler's tries at each instant, the contract the
// screen's clock and its card share.
import { describe, expect, it } from 'vitest';
import {
  COUNT_LOCK_RATE,
  COUNT_MIN_TURNS,
  COUNT_RUN_MS,
  countFilled,
  countPace,
  countReels,
  countTravel,
  reelsText,
} from './countRun';

const SCORES = Array.from({ length: 500 }, (_, i) => i + 1);
// The run sampled at every millisecond of its clock.
const MS = Array.from({ length: COUNT_RUN_MS + 1 }, (_, ms) => ms);
const at = (ms: number) => ms / COUNT_RUN_MS;
// Where the ones reel stands at `p`, unwrapped: values travelled.
const travelled = (score: number, p: number) => countTravel(score) * countPace(countTravel(score), p);
// The reels above the ones, read as one number.
const upper = (score: number, p: number) => {
  const text = reelsText(countReels(score, p));
  return text.length > 1 ? Number(text.slice(0, -1)) : 0;
};

describe('countRun — one fixed length, landing on the score', () => {
  it('starts on zeros: every reel on 0, the ones the only one reached, no try written', () => {
    for (const score of [3, 23, 137, 499]) {
      const reels = countReels(score, 0);
      expect(reels).toHaveLength(String(score).length);
      expect(reels.every((r) => r.pos === 0)).toBe(true);
      expect(reels.map((r) => r.live)).toEqual(reels.map((_, i) => i === reels.length - 1));
      expect(countFilled(score, 0)).toBe(0);
    }
  });

  it('lands on the score at COUNT_RUN_MS, every score: the reels read it whole, the ruler holds every try', () => {
    for (const score of SCORES) {
      const reels = countReels(score, 1);
      expect(reelsText(reels)).toBe(String(score));
      expect(reels.every((r) => r.live && Number.isInteger(r.pos))).toBe(true);
      expect(countFilled(score, 1)).toBe(score);
    }
  });

  it('writes the last try only as it lands: the run never ends early, whatever the score', () => {
    for (const score of SCORES) {
      expect(countFilled(score, at(COUNT_RUN_MS - 1))).toBeLessThan(score);
    }
  });

  it('fills the ruler try by try on the same clock, never backwards', () => {
    for (const score of [1, 3, 9, 13, 23, 137, 499]) {
      let last = 0;
      for (const ms of MS) {
        const filled = countFilled(score, at(ms));
        expect(filled).toBeGreaterThanOrEqual(last);
        expect(filled).toBeLessThanOrEqual(score);
        last = filled;
      }
    }
  });
});

describe('countRun — always a fast counter', () => {
  it('turns the ones reel at least COUNT_MIN_TURNS whole turns, and locks on the last digit', () => {
    for (const score of SCORES) {
      const travel = countTravel(score);
      expect(travel).toBeGreaterThanOrEqual(10 * COUNT_MIN_TURNS);
      expect(travel % 10).toBe(score % 10);
    }
  });

  it('cruises fast, brakes into the value, and is still turning COUNT_LOCK_RATE values a second as it locks', () => {
    for (const score of [1, 3, 9, 13, 23, 50, 137, 499]) {
      const speeds: number[] = [];
      for (let ms = 0; ms < COUNT_RUN_MS; ms += 1) {
        speeds.push((travelled(score, at(ms + 1)) - travelled(score, at(ms))) * 1000);
      }
      // Never slower than the lock; the fastest at the start, never speeding up again.
      expect(Math.min(...speeds)).toBeGreaterThanOrEqual(COUNT_LOCK_RATE - 0.5);
      expect(speeds[speeds.length - 1]).toBeCloseTo(COUNT_LOCK_RATE, 0);
      for (let i = 1; i < speeds.length; i += 1) expect(speeds[i]).toBeLessThanOrEqual(speeds[i - 1] + 1e-6);
      // A small score's spin as much as a big score's race: 25 values a second at least.
      expect(speeds[0]).toBeGreaterThanOrEqual(25);
    }
  });

  it('reads every value on the way when the score has enough of them: the count says how many tries are coloured', () => {
    for (const score of [10 * COUNT_MIN_TURNS, 77, 137, 499]) {
      let last = 0;
      for (const ms of MS) {
        const reading = Number(reelsText(countReels(score, at(ms))));
        expect(reading).toBe(countFilled(score, at(ms)));
        expect(reading).toBeGreaterThanOrEqual(last);
        last = reading;
      }
    }
  });

  it('spins a small score: its digit goes by every turn, and the reels above step on the last carries only', () => {
    // 3: the ones reel shows its 3 once a turn before it locks on it.
    let passes = 0;
    let prev = -1;
    for (const ms of MS) {
      const value = Math.floor(travelled(3, at(ms)));
      if (value !== prev && value % 10 === 3) passes += 1;
      prev = value;
    }
    expect(passes).toBe(COUNT_MIN_TURNS + 1);
    // 23: the tens waits under a slate 0 through the spin, then counts 1, 2 — never back.
    const tens: number[] = [];
    for (const ms of MS) {
      const u = upper(23, at(ms));
      if (tens[tens.length - 1] !== u) tens.push(u);
    }
    expect(tens).toEqual([0, 1, 2]);
  });
});

describe('countRun — an odometer', () => {
  it('turns a reel above only while the ones reel rolls from 9 to 0', () => {
    for (const score of [13, 23, 137, 499]) {
      for (const ms of MS) {
        const reels = countReels(score, at(ms));
        const ones = reels[reels.length - 1].pos;
        for (const reel of reels.slice(0, -1)) {
          if (!Number.isInteger(reel.pos)) expect(ones).toBeGreaterThan(9);
        }
      }
    }
  });

  it('never turns the reels above backwards', () => {
    for (const score of [13, 23, 137, 499]) {
      let last = 0;
      for (const ms of MS) {
        const u = upper(score, at(ms));
        expect(u).toBeGreaterThanOrEqual(last);
        last = u;
      }
    }
  });

  it('reaches a reel once the count does: the reached reels are the trailing ones, the rest slate zeros', () => {
    for (const score of [23, 137, 499]) {
      for (const ms of MS) {
        const reels = countReels(score, at(ms));
        const first = reels.findIndex((r) => r.live);
        expect(reels.slice(first).every((r) => r.live)).toBe(true);
        expect(reels.slice(0, first).every((r) => !r.live && r.pos < 1)).toBe(true);
        // A reel is reached once the reels above the ones read up to its place.
        const u = upper(score, at(ms));
        expect(first).toBe(reels.length - 1 - (u >= 10 ? 2 : u >= 1 ? 1 : 0));
      }
    }
  });

  it('races a big score: 137 reads 100 before the brake is done and decelerates into 137', () => {
    const times: number[] = [];
    let prev = -1;
    for (const ms of MS) {
      const reading = Number(reelsText(countReels(137, at(ms))));
      if (reading !== prev) times.push(ms);
      prev = reading;
    }
    // The hundredth value well inside the first two thirds; the last steps the slowest.
    expect(times[100]).toBeLessThan((COUNT_RUN_MS * 2) / 3);
    const steps = times.slice(1).map((t, i) => t - times[i]);
    expect(steps[steps.length - 1]).toBeGreaterThan(steps[10]);
    expect(steps[steps.length - 1]).toBeLessThanOrEqual(Math.ceil(1000 / COUNT_LOCK_RATE) + 1);
  });
});
