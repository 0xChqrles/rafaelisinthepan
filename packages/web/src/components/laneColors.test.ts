// CONTRACT: the route map's lane colors are the PROGRESS ramp's own stops (#117), copied
// rather than imported — that ramp means "progress" and these mean "identity", so they must
// not move together by accident. Copied means nothing catches drift if the ramp's stops are
// retuned, which is what this pins: each hex still names the stop it was taken from. If a stop
// moves, this fails and the decision gets made again on purpose — re-copy the new value, or
// pick a different stop — instead of the map quietly speaking a stale palette.
// There must also be one lane per road generation can emit, or a road ships with no colour.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { progressColor } from '@whippin/shared';
import { LANE_COLORS } from './routeDrawing';

// The stop each lane was taken from, in lane order: pink leads (lane A always holds rank 1,
// and cyan is what the heat ramp paints a rank-1 number, so leading with it would imply a rule
// that isn't one), then the furthest-apart hues left. Gold and blue are excluded on purpose —
// they are "you" and "solved". Lanes 5-6 (coral, magenta) came with the widened ROAD_KS on
// 2026-08-07; the first four did not move, so a map forking 4 ways or fewer is unchanged.
const STOPS = [70, 30, 90, 40, 60, 80];

function hex(rgb: string): string {
  const [r, g, b] = rgb.match(/\d+/g)!.map(Number);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

describe('lane colors track the progress ramp stops they were copied from', () => {
  it('is one lane per stop, in the documented order', () => {
    expect(LANE_COLORS).toHaveLength(STOPS.length);
    expect(LANE_COLORS).toEqual(STOPS.map((v) => hex(progressColor(v))));
  });

  // The other half of the same contract, and the reason it is worth a cross-language read:
  // generation decides how many roads a map can fork into, the front decides how many it can
  // paint, and nothing but this connects them. Widen ROAD_KS alone and the extra road wraps
  // around to lane 0's colour (`laneColor` takes a modulo) — two roads drawn identically,
  // which is precisely the one thing lanes exist to prevent.
  it('covers every road ROAD_KS lets generation emit', () => {
    const distances = readFileSync(
      new URL('../../../generation/scripts/distances.py', import.meta.url),
      'utf8',
    );
    const declared = /^ROAD_KS = \(([\d, ]+)\)$/m.exec(distances);
    expect(declared, 'ROAD_KS is no longer a plain literal tuple in distances.py').not.toBeNull();
    const maxRoads = Math.max(...declared![1].split(',').map((n) => Number(n.trim())));
    expect(LANE_COLORS.length).toBeGreaterThanOrEqual(maxRoads);
  });
});
