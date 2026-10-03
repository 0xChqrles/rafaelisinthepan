import { describe, expect, it } from 'vitest';
import { STAR_FRAMES, timeline, wordsAt } from './beats';

describe('the streak celebration’s beats', () => {
  it('runs its beats in order; the light reaches the crown by the relay, or by the closing chain on a full week', () => {
    for (const [hasComet, closes] of [
      [false, false],
      [true, false],
      [true, true],
    ] as const) {
      const tl = timeline(hasComet, closes, 6);
      const beats = [tl.orbitIn, tl.prevIn, tl.pour, tl.charge, tl.impact, tl.crown, tl.light, tl.flare, tl.hint, tl.settled];
      expect([...beats].sort((a, b) => a - b)).toEqual(beats);
      expect(tl.close === null).toBe(!closes);
      expect(tl.relay === null).toBe(closes);
      expect(tl.wave === null).toBe(!closes);
      if (tl.wave !== null) expect(tl.wave).toBeLessThan(tl.hint);
      if (hasComet) expect(tl.comet).toBeLessThan(tl.light);
      if (tl.close !== null) expect(tl.light < tl.close && tl.close < tl.flare).toBe(true);
      if (tl.relay !== null) expect(tl.light < tl.relay && tl.relay < tl.flare).toBe(true);
    }
  });

  it('waits for the run to reach Monday before the relay climbs to the crown', () => {
    // The later today stands in the week, the longer the run back down the chain.
    const flares = [0, 3, 6].map((todayIndex) => timeline(true, false, todayIndex).flare);
    expect([...flares].sort((a, b) => a - b)).toEqual(flares);
    expect(new Set(flares).size).toBe(3);
  });
});

describe('the words on the show’s clock', () => {
  it('lands every word, the frame and the screen by the settled frame, with no star and no jolt', () => {
    for (const closes of [false, true]) {
      const tl = timeline(true, closes);
      const w = wordsAt(tl.settled, tl);
      expect(w.screen).toBe(1);
      expect(w.days.every((o) => o === 1)).toBe(true);
      expect(w.unit).toEqual({ o: 1, dy: 0 });
      expect(w.hint).toEqual({ o: 1, dy: 0 });
      expect(w.furniture).toBe(1);
      expect(w.corners).toEqual({ o: 1, inward: 0 });
      expect(w.lit).toBe(true);
      expect(w.star).toBe(-1);
      expect(w.crownStar).toBe(-1);
      expect(w.shake).toEqual([0, 0]);
    }
  });

  it('starts on a bare screen: nothing shown before the clock moves', () => {
    const tl = timeline(true, false);
    const w = wordsAt(0, tl);
    expect(w.screen).toBe(0);
    expect(w.days.every((o) => o === 0)).toBe(true);
    expect(w.hint.o).toBe(0);
    expect(w.lit).toBe(false);
  });

  it('walks the ultra star once, frame by frame, from the moment today lights', () => {
    const tl = timeline(true, false, 4);
    expect(wordsAt(tl.light - 1, tl).star).toBe(-1);
    expect(wordsAt(tl.light - 1, tl).lit).toBe(false);
    const frames = Array.from({ length: STAR_FRAMES + 2 }, (_, i) => wordsAt(tl.light + i * 50 + 1, tl).star);
    expect(frames).toEqual([0, 1, 2, 3, 4, 5, 6, -1, -1]);
    // The crown's star strikes only the full week's closing.
    expect(Array.from({ length: 40 }, (_, i) => wordsAt(i * 100, tl).crownStar).every((f) => f === -1)).toBe(true);
    const week = timeline(true, true, 6);
    expect(wordsAt(week.flare + 1, week).crownStar).toBe(0);
  });

  it('jolts the picture by whole cells for three frames of the landing, then stands', () => {
    const tl = timeline(true, false);
    expect(wordsAt(tl.impact - 1, tl).shake).toEqual([0, 0]);
    const jolts = [0, 50, 100].map((d) => wordsAt(tl.impact + d + 1, tl).shake);
    for (const [x, y] of jolts) {
      expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
      expect(Math.abs(x) + Math.abs(y)).toBeGreaterThan(0);
    }
    expect(wordsAt(tl.impact + 151, tl).shake).toEqual([0, 0]);
  });
});
