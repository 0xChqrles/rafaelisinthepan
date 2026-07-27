// CONTRACT: the route map's lane colors are the PROGRESS ramp's own stops (#117), copied
// rather than imported — that ramp means "progress" and these mean "identity", so they must
// not move together by accident. Copied means nothing catches drift if the ramp's stops are
// retuned, which is what this pins: the four hexes still name the four stops they were taken
// from. If a stop moves, this fails and the decision gets made again on purpose — re-copy the
// new value, or pick a different stop — instead of the map quietly speaking a stale palette.
import { describe, it, expect } from 'vitest';
import { progressColor } from '@whippin/shared';
import { LANE_COLORS } from './RouteModal';

// The stop each lane was taken from, in lane order: pink leads (lane A always holds rank 1,
// and cyan is what the heat ramp paints a rank-1 number, so leading with it would imply a rule
// that isn't one), then the three furthest-apart hues left. Gold and blue are excluded on
// purpose — they are "you" and "solved".
const STOPS = [70, 30, 90, 40];

function hex(rgb: string): string {
  const [r, g, b] = rgb.match(/\d+/g)!.map(Number);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

describe('lane colors track the progress ramp stops they were copied from', () => {
  it('is one lane per stop, in the documented order', () => {
    expect(LANE_COLORS).toHaveLength(STOPS.length);
    expect(LANE_COLORS).toEqual(STOPS.map((v) => hex(progressColor(v))));
  });
});
