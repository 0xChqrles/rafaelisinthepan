// The meter's ramp (`meterRamp.ts`): a chip short of 100 ends in white, and a fill that
// reaches 100 inks its last cells frame by frame — the chip turns solid as part of the fill,
// never in one snap — and `frontIsSolid` names exactly the frame it does, which is where the
// hole's burst strikes (`MeterCanvas`'s `onFull`).
import { describe, expect, it } from 'vitest';
import { cellInked, easeOut, frontIsSolid, meterFront, rampDensity, travelFront } from './meterRamp';

// A sentence chip: 13 cells tall, its ramp 12 (one chip height); words from 36px to 200px.
const ROWS = 13;
const RAMP = 12;
const WIDTHS = [18, 36, 50, 69, 100];

function inkedShare(front: number, cols: number, rows = ROWS, ramp = RAMP): number {
  let n = 0;
  for (let cx = 0; cx < cols; cx += 1) {
    for (let cy = 0; cy < rows; cy += 1) if (cellInked(rampDensity(front, cx, ramp), cx, cy)) n += 1;
  }
  return n / (cols * rows);
}

// The travel's frames at 60fps over the hole's 300ms.
function travel(from: number, cols: number): { share: number; solid: boolean }[] {
  const frames = [];
  for (let t = 1000 / 60; ; t += 1000 / 60) {
    const k = Math.min(1, t / 300);
    const front = travelFront(from, 100, easeOut(k), cols, RAMP);
    frames.push({ share: inkedShare(front, cols), solid: frontIsSolid(front, cols, ROWS, RAMP) });
    if (k === 1) return frames;
  }
}

describe('a chip short of 100', () => {
  it.each(WIDTHS)('ends in white at %i columns', (cols) => {
    for (const reading of [90, 95, 99, 99.9]) {
      const front = meterFront(reading, cols, RAMP);
      let last = 0;
      for (let cy = 0; cy < ROWS; cy += 1) if (cellInked(rampDensity(front, cols - 1, RAMP), cols - 1, cy)) last += 1;
      // Its last column's density is under one ramp step: a few stray cells at most.
      expect(rampDensity(front, cols - 1, RAMP)).toBeLessThan(1 / RAMP);
      expect(last / ROWS).toBeLessThanOrEqual(1 / 3);
      expect(frontIsSolid(front, cols, ROWS, RAMP)).toBe(false);
    }
  });
});

describe('a fill reaching 100', () => {
  it.each(WIDTHS.flatMap((cols) => [80, 97.8].map((from) => [cols, from])))(
    'at %i columns from %f inks its last cells frame by frame, solid before the travel ends',
    (cols, from) => {
      const frames = travel(from, cols);
      const solidAt = frames.findIndex((f) => f.share === 1);
      expect(solidAt).toBeGreaterThan(0);
      expect(solidAt).toBeLessThan(frames.length - 1);
      // The frame that turns it solid inks almost nothing new (the reading's tween inked
      // the whole trailing ramp — 5% to 30% of the chip — on that one frame).
      expect(1 - frames[solidAt - 1].share).toBeLessThanOrEqual(0.015);
      // And the burst's cue is that frame: never before, always after.
      frames.forEach((f, i) => expect(f.solid).toBe(i >= solidAt));
    },
  );
});

describe('frontIsSolid', () => {
  it('is true exactly when every cell is inked', () => {
    for (const ramp of [4, 8, 12]) {
      for (const rows of [1, 3, 8, 13]) {
        for (const cols of [1, 5, 18, 37]) {
          for (let front = 0; front <= cols + ramp + 1; front += 0.125) {
            expect(frontIsSolid(front, cols, rows, ramp)).toBe(inkedShare(front, cols, rows, ramp) === 1);
          }
        }
      }
    }
  });

  it('holds at a full reading, whatever the width', () => {
    for (const cols of [1, ...WIDTHS]) expect(frontIsSolid(meterFront(100, cols, RAMP), cols, ROWS, RAMP)).toBe(true);
  });
});
