import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { prefersReducedMotion } from './useScramble';

// THE DRUM — the physics every wheel in the app turns on. Extracted 2026-09-02 from
// `HistoryWheel`, the day the header's title grew a wheel of its own (`PuzzleSelect`): a
// column of rows, one of them in a fixed SLOT, driven BY HAND with no native scrolling —
// the iOS date picker's feel, settled on 2026-09-01 after four other feels ("pixel by
// pixel" → a one-row stepper, "sticky" → native snap, "snapped inertia" → a hop-by-hop
// ratchet, "unstoppable — a small swipe keeps scrolling for seconds" → this).
//
//   - A DRAG follows the finger pixel for pixel (rubber past the ends); on release the drum
//     keeps going on its velocity for a SHORT friction glide — a small swipe moves a row or
//     two, a strong one a handful, never for seconds — and lands ON a row.
//   - A mouse wheel or trackpad moves the drum directly and it snaps to the nearest row
//     once the gesture goes quiet.
//   - A tap on a row glides to it; the arrow keys move one row.
//
// The hook owns the position and every listener, and reports the row in the slot; what a
// position LOOKS like is the caller's (`write` — a scrollTop, a translate), because the
// two wheels draw their columns differently. Pointer capture is deliberately NOT used: it
// retargets the CLICK that follows a tap onto the column itself, which a dialog reads as a
// tap on nothing and folds on.

// A release at v rows/s travels `v × FLING_S` rows (the picker's friction, short), capped
// at `FLING_MAX_ROWS`, snapped to a row, over a glide of `GLIDE_BASE_MS` plus
// `GLIDE_ROW_MS` a row, eased out. A wheel/trackpad delta moves the drum by `WHEEL_GAIN`
// of its pixels and snaps `WHEEL_IDLE_MS` after the last one. A drag past the ends
// stretches by `RUBBER`.
const FLING_S = 0.16;
const FLING_MAX_ROWS = 8;
const GLIDE_BASE_MS = 240;
const GLIDE_ROW_MS = 60;
const GLIDE_MAX_MS = 700;
const SNAP_MS = 200;
const WHEEL_GAIN = 0.6;
const WHEEL_IDLE_MS = 90;
const RUBBER = 0.35;
// A press that travels this far is a drag, not a tap.
const DRAG_PX = 6;

// The glide for a travel of `dist` rows.
const glideMs = (dist: number) => Math.min(GLIDE_MAX_MS, GLIDE_BASE_MS + dist * GLIDE_ROW_MS);

export interface Drum {
  // The row in the slot — state, so the caller re-renders as the drum turns.
  current: number;
  // The row in the slot RIGHT NOW, for a closure that must not go stale (a fold's).
  peek: () => number;
  // Straight to a row, no glide — how a wheel opens on its word.
  jump: (row: number) => void;
  glideTo: (row: number, ms: number) => void;
  glideBy: (rows: number) => void;
  // A tap on row i: `drag` when the press that just ended was a drag (its click counts
  // for nothing), `slot` when the row is already in the slot, `turn` when it glides there.
  tap: (row: number) => 'drag' | 'slot' | 'turn';
  // Whether the press that just ended was a drag — consumed on read, so the click that
  // follows a drag is discounted exactly once, by whoever hears it first.
  endedDrag: () => boolean;
}

export default function useDrum({
  ref,
  // The element the gestures are heard on exists only once the wheel is anchored.
  active = true,
  count,
  pitch,
  initial,
  write,
}: {
  ref: RefObject<HTMLElement | null>;
  active?: boolean;
  count: number;
  // The distance between one row's slot position and the next, in px.
  pitch: number;
  initial: number;
  // Draw the drum at this offset (px), i.e. `pos × pitch`.
  write: (px: number) => void;
}): Drum {
  const [current, setCurrent] = useState(initial);
  const currentRef = useRef(initial);
  // Live inputs, read by listeners attached once.
  const live = useRef({ count, pitch, write });
  live.current = { count, pitch, write };
  const drum = useRef({
    pos: initial, // in rows, fractional while moving
    raf: 0,
    // the glide in flight: from → to over `ms`, since `at`
    glide: null as null | { from: number; to: number; at: number; ms: number },
    // the drag in flight
    drag: null as null | {
      id: number;
      y0: number;
      pos0: number;
      samples: { t: number; y: number }[];
      moved: boolean;
    },
  });
  const lastMoved = useRef(false);

  const clampRow = (i: number) => Math.min(live.current.count - 1, Math.max(0, i));
  const paint = useCallback((pos: number) => {
    const d = drum.current;
    d.pos = pos;
    live.current.write(pos * live.current.pitch);
    const row = clampRow(Math.round(pos));
    currentRef.current = row;
    setCurrent(row);
  }, []);
  const jump = useCallback(
    (row: number) => {
      drum.current.glide = null;
      paint(clampRow(row));
    },
    [paint],
  );
  // ONE glide from where the drum is to a row, eased out (fast, then settling) — the
  // picker's deceleration. A new glide replaces the one in flight from its current place.
  const glideTo = useCallback(
    (row: number, ms: number) => {
      const d = drum.current;
      const to = clampRow(row);
      if (prefersReducedMotion() || ms <= 0) {
        d.glide = null;
        paint(to);
        return;
      }
      d.glide = { from: d.pos, to, at: performance.now(), ms };
      const step = (now: number) => {
        const g = d.glide;
        if (!g || d.drag) {
          d.raf = 0;
          return;
        }
        const t = Math.min(1, (now - g.at) / g.ms);
        const eased = 1 - (1 - t) ** 4;
        paint(g.from + (g.to - g.from) * eased);
        if (t >= 1) {
          d.glide = null;
          d.raf = 0;
          return;
        }
        d.raf = requestAnimationFrame(step);
      };
      if (!d.raf) d.raf = requestAnimationFrame(step);
    },
    [paint],
  );
  // Where the drum is heading: the glide's end, or where it stands.
  const heading = () => drum.current.glide?.to ?? Math.round(drum.current.pos);
  const glideBy = useCallback(
    (rows: number) => {
      const to = clampRow(heading() + rows);
      glideTo(to, glideMs(Math.abs(to - drum.current.pos)));
    },
    [glideTo],
  );

  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return undefined;
    const d = drum.current;
    // A wheel or trackpad moves the drum directly, pixel for pixel (scaled), and it snaps
    // to the nearest row once the gesture has gone quiet.
    let idle = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (d.drag) return;
      d.glide = null;
      const last = live.current.count - 1;
      const pos = Math.min(last, Math.max(0, d.pos + (e.deltaY * WHEEL_GAIN) / live.current.pitch));
      paint(pos);
      window.clearTimeout(idle);
      idle = window.setTimeout(() => glideTo(Math.round(d.pos), SNAP_MS), WHEEL_IDLE_MS);
    };
    // A finger: the wheel follows it, then flies on its release velocity.
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      window.clearTimeout(idle);
      d.glide = null;
      d.drag = {
        id: e.pointerId,
        y0: e.clientY,
        pos0: d.pos,
        samples: [{ t: e.timeStamp, y: e.clientY }],
        moved: false,
      };
      // The move and the release are heard on the window, never captured (see above).
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    };
    const onMove = (e: PointerEvent) => {
      const g = d.drag;
      if (!g || e.pointerId !== g.id) return;
      const dy = g.y0 - e.clientY;
      if (Math.abs(dy) > DRAG_PX) g.moved = true;
      const last = live.current.count - 1;
      let pos = g.pos0 + dy / live.current.pitch;
      // Past either end the wheel stretches, and only a little.
      if (pos < 0) pos *= RUBBER;
      else if (pos > last) pos = last + (pos - last) * RUBBER;
      paint(pos);
      g.samples.push({ t: e.timeStamp, y: e.clientY });
      if (g.samples.length > 6) g.samples.shift();
    };
    const onUp = (e: PointerEvent) => {
      const g = d.drag;
      if (!g || e.pointerId !== g.id) return;
      d.drag = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      lastMoved.current = g.moved;
      // Release velocity off the last few samples, in rows per second.
      const a = g.samples[0];
      const b = g.samples[g.samples.length - 1];
      const dt = (b.t - a.t) / 1000;
      const v = dt > 0.012 ? (a.y - b.y) / live.current.pitch / dt : 0;
      const fling = Math.max(-FLING_MAX_ROWS, Math.min(FLING_MAX_ROWS, v * FLING_S));
      const to = clampRow(Math.round(d.pos + fling));
      glideTo(to, glideMs(Math.abs(to - d.pos)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown);
    return () => {
      if (d.raf) cancelAnimationFrame(d.raf);
      d.raf = 0;
      window.clearTimeout(idle);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [active, glideTo, paint, ref]);

  const endedDrag = useCallback(() => {
    const moved = lastMoved.current;
    lastMoved.current = false;
    return moved;
  }, []);
  const tap = useCallback(
    (row: number): 'drag' | 'slot' | 'turn' => {
      if (endedDrag()) return 'drag';
      if (row === currentRef.current) return 'slot';
      glideTo(row, glideMs(Math.abs(row - drum.current.pos)));
      return 'turn';
    },
    [endedDrag, glideTo],
  );
  const peek = useCallback(() => currentRef.current, []);

  // One object per row change, so a caller's effects and callbacks can depend on it.
  return useMemo(
    () => ({ current, peek, jump, glideTo, glideBy, tap, endedDrag }),
    [current, peek, jump, glideTo, glideBy, tap, endedDrag],
  );
}
