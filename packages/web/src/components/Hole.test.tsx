// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Hole from './Hole';
import type { HitState } from '@whippin/shared';

// Canvas pixels are unrelated to the activation's lifetime; keep the real Hole effects,
// strikes and timers so the test exercises cancellation across React updates. The stub
// says whether it was asked for the sea, and REPORTS THE SOLID FRAME the way the real
// canvas does: its delay, its travel, then one frame (its tween starts on the frame after
// the delay) — unless a test silences it.
const FRAME_MS = 16;
let reportsFull = true;
function StubMeter({ value, delayMs, durationMs, sea, onFull }: {
  value: number; delayMs: number; durationMs: number; sea?: boolean; onFull?: () => void;
}) {
  useEffect(() => {
    if (value < 100 || sea || !reportsFull) return undefined;
    const id = window.setTimeout(() => onFull?.(), delayMs + durationMs + FRAME_MS);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return <canvas data-sea={sea ? '1' : undefined} />;
}
vi.mock('./MeterCanvas', () => ({ default: StubMeter }));
const sea = () => container.querySelector('canvas[data-sea]');

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
      charge={{ value, active: value === 100 }}
    />,
  ));
}

function advance(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}

beforeEach(() => {
  reportsFull = true;
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

describe('the activation yields to an exact solve', () => {
  it.each([700, 1000])('cancels a pending or active burst at %i ms, before board release', (elapsed) => {
    render(90);
    render(100, nearHit);
    advance(elapsed);
    if (elapsed === 1000) expect(container.querySelector('.strike.burst')).not.toBeNull();

    // The ultra arrives while the displayed rank is still 3 (the deferred board).
    render(100, exactHit);
    expect(container.querySelector('.strike.ultra')).not.toBeNull();
    expect(container.querySelector('.strike.burst')).toBeNull();
    expect(container.querySelector('.hole-meter')).toBeNull();
    advance(1000);
    expect(container.querySelector('.strike.burst')).toBeNull();
    expect(sea()).toBeNull();

    render(100, null, 0);
    advance(1000);
    expect(container.querySelector('.strike.burst')).toBeNull();
    expect(sea()).toBeNull();
  });

  it('also cancels when a solved board arrives without a local hit', () => {
    render(90);
    render(100, nearHit);
    advance(700);
    render(100, null, 0);
    advance(1000);
    expect(container.querySelector('.strike.burst')).toBeNull();
    expect(sea()).toBeNull();
  });

  it('still bursts and starts the sea when the hole remains unsolved', () => {
    render(90);
    render(100, nearHit);
    advance(1000);
    expect(container.querySelector('.strike.burst')).not.toBeNull();
    expect(sea()).toBeNull(); // the sea waits for the burst's impact
    advance(150);
    expect(sea()).not.toBeNull();
    advance(1000);
    expect(container.querySelector('.strike.burst')).toBeNull();
    expect(sea()).not.toBeNull();
  });
});

describe('the burst waits for the fill', () => {
  // The fill waits for the sparks (960ms after the hit) less the release beat (320): it
  // travels from 640 and the canvas inks the chip solid on the frame after 940.
  it('strikes on the canvas\'s solid frame, not on the fill\'s nominal end', () => {
    render(90);
    render(100, nearHit);
    advance(945);
    expect(container.querySelector('.strike.burst')).toBeNull();
    advance(15);
    expect(container.querySelector('.strike.burst')).not.toBeNull();
  });

  it('a canvas that never reports still gets its burst, late', () => {
    reportsFull = false;
    render(90);
    render(100, nearHit);
    advance(1200);
    expect(container.querySelector('.strike.burst')).toBeNull();
    advance(50);
    expect(container.querySelector('.strike.burst')).not.toBeNull();
    advance(150);
    expect(sea()).not.toBeNull();
  });
});
