// THE MARK THAT WAITS, AND THE MARK THAT RESOLVES (#204's UX rework vol. 2, 2026-08-27;
// the waiting tile and the arrival became ONE surface on 2026-08-28).
//
// The two acts the email flow performs are opposites — saving the account you hold, and
// signing into another one — and until now they wore one costume: the same taps, the same
// words, the same picture, diverging only in the last half-second. This component is the
// WORDLESS tell that separates them, and it is available only because an account's face is
// literally a 10×10 bitmap:
//
//   SAVING    the face is on screen from the first step and never changes. It is the
//             OBJECT of the sentence — this is the thing being kept.
//   RETURNING the slot opens on STATIC: the avatar palettes churning on a noise field, at
//             the marks' own resolution. A face forming and reforming, every frame a
//             plausible one, none of them yours yet. When the code lands, the noise
//             RESOLVES — cell by cell, the churn precipitates into the real drawing.
//
// Same layout, opposite narrative, no copy — the house's show-don't-tell rule applied to
// the one moment in the app that had no moment at all (the screen simply re-rendered with a
// different picture).
//
// **THE WAITING AND THE ARRIVAL ARE ONE CANVAS** (user-decided 2026-08-28). They were two
// surfaces — a churning tile that unmounted, and an SVG that composed the drawing out of
// nothing — so the instant the code landed, the thing the player had been watching
// disappeared and a different thing grew in its place. Resolving the SAME field is the
// picture the flow actually promises: the static was never noise, it was a face nobody
// could read yet. A cell that has resolved is FINAL and the rest keeps churning around it,
// so the drawing precipitates out of the storm.
//
// **IT HANDS OFF TO `Avatar`.** #188 decided the resting mark is ONE traced union-outline
// path, because cells drawn as adjacent rects can antialias a hairline seam where two of
// them meet. That decision is about the RESTING render and is untouched: this is a canvas
// at exactly 10×10 backing pixels — there are no sub-pixel edges to seam in the first place
// — for under a second, and the final frame is the canonical `Avatar`.
//
// **EVERY FRAME STAYS INSIDE THE PALETTE.** The colours are `AVATAR_PALETTES`' own — the
// user's drawings, whose hexes are canonical — so nothing is ever blended into a colour no
// avatar could wear: ONE noise field picks each cell's palette and a SECOND decides whether
// it shows that palette's ground or its ink.
//
// Under `prefers-reduced-motion` the field holds one frame and an arrival is instant: the
// information lives in the last frame, never in the movement.

import { useEffect, useMemo, useRef, useState } from 'react';
import { AVATAR_PALETTES, AVATAR_SIZE, decodeAvatar } from '@whippin/shared';
import Avatar from './Avatar';

// One octave of value noise in 3D (x, y, TIME), which is all a 10-cell tile can resolve —
// the gradient noise the request named would cost more code to be indistinguishable here.
// Integer-hashed, so the field is the same on every device and every visit.
function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const smooth = (t: number): number => t * t * (3 - 2 * t);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);
  const zf = smooth(z - zi);
  const at = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz);
  return mix(
    mix(mix(at(0, 0, 0), at(1, 0, 0), xf), mix(at(0, 1, 0), at(1, 1, 0), xf), yf),
    mix(mix(at(0, 0, 1), at(1, 0, 1), xf), mix(at(0, 1, 1), at(1, 1, 1), xf), yf),
    zf,
  );
}

// How the field moves. The INK churns at a readable pace; the PALETTE is a slow drift with
// almost no spatial term at all, which is what keeps the tile reading as ONE mark rather
// than as a colour field — see the FRONT constants.
// MEASURED AGAINST A REAL MARK (2026-08-30). What the tile is waiting for is an assigned
// avatar, and `defaultAvatar`'s are drawn to a shape: over six of them, 23% of the cells
// carry ink, a horizontal run averages 3.0 cells, and they are MIRRORED — 100% symmetric
// about the vertical axis, because that is what makes ten squares read as a creature and
// not as television static.
//
// The first cut was none of those things: at `INK_SCALE = 0.3` the field's period was
// three cells wide, so a frame was two or three enormous blobs at 62% coverage with no
// symmetry at all — a colour field, which is exactly the "the small squares are weird"
// reading the churning tile was written to replace. So the ink is sampled about the tile's
// MIDLINE (`mirror`), and the scale and threshold are set where the field's own statistics
// land on the drawing's: ~30% ink, runs of ~2.5 cells. Every frame is a plausible face
// because it is built the way the real ones are.
//
// The PALETTE front below is deliberately NOT mirrored: the shape is what has to be
// plausible, and a colour transition folded about the same axis reads as a mechanism.
const mirror = (x: number): number => (x < AVATAR_SIZE / 2 ? x : AVATAR_SIZE - 1 - x);
const INK_SCALE = 1;
const INK_SPEED = 0.34;
const PALETTE_SPEED = 0.17;
// A change of palette arrives as a FRONT crossing the tile, never as a switch. The front's
// shape is a second, very low-frequency noise field that drifts on its own clock: a plain
// `(x + y)` lean does sweep, but it draws a dead-straight 45° edge that reads as a stripe
// laid over the mark rather than as one thing becoming another. This much of a
// palette-index of spread, so about two palettes share the tile through a change, never
// more.
const FRONT_SCALE = 0.16;
const FRONT_SPEED = 0.09;
const FRONT_SPREAD = 1.4;
// A shade richer than a real mark's 23% — a drawing can be sparse because it is a definite
// shape, where a frame nobody will look at twice needs a little more to hold the tile off
// the page's own ground.
const INK_THRESHOLD = 0.57;
// Pixel art has nothing to gain from 60fps, and this sits above an input.
const FRAME_MS = 1000 / 16;
// The field is started AWAY from the lattice origin: an integer-hashed value noise is
// exactly its own hash at (0, 0, 0), and every corner of that cell is the same one — so t=0
// paints a degenerate frame, which is the one a still tile would hold forever.
const T0 = 4.2;

// How long the churn takes to precipitate into the drawing. Long enough to read as the
// static RESOLVING rather than as a cut, short enough that nobody is waiting on it — and
// the last cell lands with a beat to spare before the ending's copy arrives under it.
const RESOLVE_MS = 900;

// A deterministic shuffle, seeded by the drawing itself: one mark always resolves in its own
// order, so a re-render mid-flight cannot re-scatter the cells that have already landed.
// (`Math.random` in a render is exactly that bug.)
function shuffle(indices: number[], seed: string): number[] {
  let state = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    state = (Math.imul(state ^ seed.charCodeAt(i), 0x01000193) >>> 0) || 1;
  }
  const order = [...indices];
  for (let i = order.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// The drawing a resolving tile is heading for: a colour per cell, and the moment each one
// stops churning and takes it.
interface Target {
  colors: string[];
  settleAt: number[];
}

function read(avatar: string): Target | null {
  try {
    const { palette, cells } = decodeAvatar(avatar);
    const { bg, fg } = AVATAR_PALETTES[palette];
    const order = shuffle(
      cells.map((_, index) => index),
      avatar,
    );
    const settleAt = new Array<number>(cells.length);
    order.forEach((index, n) => {
      settleAt[index] = order.length < 2 ? 0 : (n / (order.length - 1)) * RESOLVE_MS;
    });
    return { colors: cells.map((on) => (on ? fg : bg)), settleAt };
  } catch {
    return null;
  }
}

export interface AccountMarkProps {
  // The encoded drawing, or null while nobody is known yet — which is the churning field.
  avatar: string | null;
  size: number;
  // Whether the drawing should RESOLVE out of the field rather than simply appearing. Only
  // the returning flow and an adopted ending ask for it: a saved account's face never left.
  compose?: boolean;
}

export default function AccountMark({ avatar, size, compose = false }: AccountMarkProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // The resolution runs ONCE per drawing and is over for good — a later re-render (a store
  // update, a re-read of the face) must not replay it.
  const [settled, setSettled] = useState(false);
  const reduced =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // A drawing this component cannot read still renders — `Avatar` owns that failure, and a
  // mark that cannot be decoded must not take a screen with it.
  const target = useMemo(
    () => (avatar && compose && !reduced ? read(avatar) : null),
    [avatar, compose, reduced],
  );
  // The FIELD is on screen while nobody is known, and through the resolution that follows.
  const field = !settled && (avatar === null || target !== null);

  useEffect(() => {
    if (!field) return;
    const node = canvas.current;
    const context = node?.getContext('2d');
    if (!node || !context) return;

    const count = AVATAR_PALETTES.length;
    // `elapsed` is the resolution's own clock, and it is null while nobody is known: then
    // every cell churns for as long as the tile is on screen.
    const paint = (seconds: number, elapsed: number | null) => {
      // One value for the whole tile, so the palette is a property of the MOMENT; the
      // per-cell front below is only what turns a change into a sweep.
      const drift = noise3(0, 0, seconds * PALETTE_SPEED) * count;
      for (let y = 0; y < AVATAR_SIZE; y += 1) {
        for (let x = 0; x < AVATAR_SIZE; x += 1) {
          const index = y * AVATAR_SIZE + x;
          // A RESOLVED cell is final, and the field goes on churning around it.
          if (target && elapsed !== null && elapsed >= target.settleAt[index]) {
            context.fillStyle = target.colors[index];
          } else {
            const front = noise3(x * FRONT_SCALE, y * FRONT_SCALE, seconds * FRONT_SPEED);
            // The two fields are offset in TIME so they cannot beat against each other into
            // a visible period.
            const ink = noise3(mirror(x) * INK_SCALE, y * INK_SCALE, seconds * INK_SPEED + 31.7);
            const palette = AVATAR_PALETTES[Math.floor((drift + front * FRONT_SPREAD) % count)];
            context.fillStyle = ink > INK_THRESHOLD ? palette.fg : palette.bg;
          }
          context.fillRect(x, y, 1, 1);
        }
      }
    };

    if (reduced) {
      // The picture, without the movement — and for an arrival that picture is the drawing.
      paint(T0, target ? RESOLVE_MS : null);
      if (target) setSettled(true);
      return;
    }

    let frame = 0;
    let last = -Infinity;
    const start = performance.now();
    const step = (now: number) => {
      const elapsed = now - start;
      // Hands off to `Avatar` once the last cell has landed, rather than painting a
      // finished picture forever.
      if (target && elapsed >= RESOLVE_MS) {
        paint(T0 + elapsed / 1000, elapsed);
        setSettled(true);
        return;
      }
      if (elapsed - last >= FRAME_MS) {
        last = elapsed;
        paint(T0 + elapsed / 1000, target ? elapsed : null);
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [field, target, reduced]);

  if (!field) return avatar === null ? null : <Avatar avatar={avatar} size={size} />;
  return (
    <canvas
      ref={canvas}
      className="account-mark field"
      width={AVATAR_SIZE}
      height={AVATAR_SIZE}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

// The six INKS the code prompt's cells wear, in the order they fill (`CodeInput`). They are
// AVATAR_PALETTE colours ADDRESSED rather than copied, so the prompt cannot drift from the
// drawings the tile above it is churning through: the code is typed in the same colours the
// face is being found in. The walk is cobalt → azure → cyan → lime → rose → magenta — a hue
// walk with one honest jump at the end, since this palette holds no green.
//
// IT USED TO OPEN ON VIOLET (`AVATAR_PALETTES[1].bg`, #8f06ff) and that one failed: 3.50:1
// against the cell's ground, which passes only as LARGE text and this is an 18px digit —
// the FIRST digit typed, next to a cyan at 16:1. Every colour here now clears AA (4.62 at
// the floor), which is also what pulled the row's brightness spread in from 4.9x to 3.7x.
// There is no violet in the palettes that clears it; the walk starts one step along
// instead, which costs nothing — it still crosses six hues and still ends on the jump.
export const CODE_INKS: readonly string[] = [
  AVATAR_PALETTES[0].fg,
  AVATAR_PALETTES[3].bg,
  AVATAR_PALETTES[1].fg,
  AVATAR_PALETTES[2].fg,
  AVATAR_PALETTES[2].bg,
  AVATAR_PALETTES[4].fg,
];
