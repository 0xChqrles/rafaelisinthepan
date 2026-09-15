// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Hole from './Hole';
import type { HitState } from '@whippin/shared';

// Canvas pixels are unrelated to the reveal's lifetime; keep the real Hole effects,
// strikes and timers so the test exercises cancellation across React updates.
vi.mock('./MeterCanvas', () => ({ default: () => <canvas /> }));

let container: HTMLDivElement;
let root: Root;
const onHitDone = () => {};
const nearHit: HitState = {
  id: 1, holeIndex: 0, value: 8, startDelayMs: 0, fadeDelayMs: 320,
  strike: 'slash', charge: 10,
};
const exactHit: HitState = {
  id: 2, holeIndex: 0, value: 0, startDelayMs: 0, fadeDelayMs: 320,
  strike: 'ultra',
};

function render(value: number, hit: HitState | null = null, rank = 3) {
  act(() => root.render(
    <Hole
      hole={{ pos: 0, secret: 'honnete', word: 'sincère', rank, startRank: 80 }}
      holeIndex={0}
      hit={hit}
      onHitDone={onHitDone}
      charge={{ value, initial: value === 100 ? 'H' : null }}
    />,
  ));
}

function advance(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('charge reveal yields to an exact solve', () => {
  it.each([700, 950])('cancels a pending or active burst at %i ms, before board release', (elapsed) => {
    render(90);
    render(100, nearHit);
    advance(elapsed);
    if (elapsed === 950) expect(container.querySelector('.strike.burst')).not.toBeNull();

    // The ultra arrives while the displayed rank is still 3 (the deferred board).
    render(100, exactHit);
    expect(container.querySelector('.strike.ultra')).not.toBeNull();
    expect(container.querySelector('.strike.burst')).toBeNull();
    expect(container.querySelector('.hole-meter')).toBeNull();
    advance(1000);
    expect(container.querySelector('.strike.burst')).toBeNull();
    expect(container.querySelector('.hole-initial')).toBeNull();

    render(100, null, 0);
    advance(1000);
    expect(container.querySelector('.strike.burst')).toBeNull();
    expect(container.querySelector('.hole-initial')).toBeNull();
  });

  it('also cancels when a solved board arrives without a local hit', () => {
    render(90);
    render(100, nearHit);
    advance(700);
    render(100, null, 0);
    advance(1000);
    expect(container.querySelector('.strike.burst')).toBeNull();
    expect(container.querySelector('.hole-initial')).toBeNull();
  });

  it('still bursts and reveals an initial when the hole remains unsolved', () => {
    render(90);
    render(100, nearHit);
    advance(950);
    expect(container.querySelector('.strike.burst')).not.toBeNull();
    advance(150);
    expect(container.querySelector('.hole-initial')?.textContent).toBe('H');
    advance(1000);
    expect(container.querySelector('.strike.burst')).toBeNull();
    expect(container.querySelector('.hole-initial')?.textContent).toBe('H');
  });
});
