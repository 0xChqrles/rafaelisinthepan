// THE MARK THAT WAITS, AND THE MARK THAT ARRIVES (#204's UX rework vol. 2, 2026-08-27).
//
// The two acts the email flow performs are opposites — saving the account you hold, and
// signing into another one — and until now they wore one costume: the same taps, the same
// words, the same picture, diverging only in the last half-second. This component is the
// WORDLESS tell that separates them, and it is available only because an account's face is
// literally a 10×10 bitmap:
//
//   SAVING    the face is on screen from the first step and never changes. It is the
//             OBJECT of the sentence — this is the thing being kept.
//   RETURNING the face slot opens EMPTY: a hairline grid with nothing in it, breathing.
//             Somebody is out there, and this screen is how you reach them. When the code
//             lands, the account DEVELOPS into that grid, cell by cell.
//
// Same layout, opposite narrative, no copy — the house's show-don't-tell rule applied to
// the one moment in the app that had no moment at all (the screen simply re-rendered with a
// different picture).
//
// **THE COMPOSITION IS TRANSIENT AND HANDS OFF TO `Avatar`.** #188 decided the resting mark
// is ONE traced union-outline path, because cells drawn as adjacent rects can antialias a
// hairline seam where two of them meet. That decision is about the RESTING render and is
// untouched: this draws per-cell rects for ~700ms only (with a sub-unit bleed, so even the
// transient frames have nothing to seam), and the final frame is the canonical `Avatar`.
//
// Under `prefers-reduced-motion` there is no composition at all — the information lives in
// the last frame, never in the animation.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { AVATAR_PALETTES, AVATAR_SIZE, decodeAvatar } from '@whippin/shared';
import Avatar from './Avatar';

const CELL = 10; // viewBox units per cell — `Avatar`'s own scale, so the two are swappable
const SPAN = AVATAR_SIZE * CELL;
const RADIUS = 3.6; // the tile's outer rounding, `Avatar`'s exact value
// A hair of overlap, so two neighbouring cells never leave a rasterizer a seam to find
// during the composition.
const BLEED = 0.4;

// How the composition is spent: the last cell starts at SPREAD and takes POP, so the whole
// thing resolves just under three quarters of a second — long enough to read as developing,
// short enough that nobody is waiting on it.
const POP_MS = 220;
const SPREAD_MS = 460;
const COMPOSE_MS = SPREAD_MS + POP_MS + 40;

// A deterministic shuffle, seeded by the drawing itself: one mark always develops in its own
// order, so a re-render mid-composition cannot re-scatter the cells that have already
// landed. (`Math.random` in a render is exactly that bug.)
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

// ── THE EMPTY SLOT ────────────────────────────────────────────────────────────────────
// Not a skeleton and not a spinner: a skeleton says "this is loading", and this says "this
// is somebody, and we do not know who yet" — which is the whole question the screen under
// it is asking. So it is drawn as WHAT IT IS WAITING FOR: a mark. The tile churns through
// the AVATAR PALETTES on a slow value-noise field, at the marks' own 10×10 resolution — a
// face forming and reforming, every frame a plausible one, none of them yours yet.
//
// (It was a hairline grid with five cells breathing until 2026-08-28, user-decided: "the
// small squares are weird". They read as a technical placeholder — the absence of a
// drawing rather than the presence of a question.)
//
// **EVERY FRAME STAYS INSIDE THE PALETTE.** The colours are `AVATAR_PALETTES`' own — the
// user's drawings, whose hexes are canonical — so nothing is ever blended into a colour no
// avatar could wear: ONE noise field picks each cell's palette and a SECOND decides whether
// it shows that palette's ground or its ink. The palette field is deliberately very
// low-frequency in space and slow in time, so the tile is mostly ONE palette at a time and
// a change arrives as a sweep across it rather than as a switch.
//
// It is a CANVAS at 10×10 backing pixels, scaled up with `image-rendering: pixelated` — the
// standing pixel-art rule, and the cheapest possible surface for this: a hundred pixels
// repainted a dozen times a second, where a hundred React-managed rects would be a hundred
// style writes per frame on the one screen whose job is to stay out of the way of an input.

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
  const z0 = mix(
    mix(mix(at(0, 0, 0), at(1, 0, 0), xf), mix(at(0, 1, 0), at(1, 1, 0), xf), yf),
    mix(mix(at(0, 0, 1), at(1, 0, 1), xf), mix(at(0, 1, 1), at(1, 1, 1), xf), yf),
    zf,
  );
  return z0;
}

// How the field moves. The INK churns at a readable pace; the PALETTE is a slow drift with
// almost no spatial term at all, which is what keeps the tile reading as ONE mark rather
// than as a colour field — see `PALETTE_SWEEP`.
const INK_SCALE = 0.30;
const INK_SPEED = 0.34;
const PALETTE_SPEED = 0.17;
// A change of palette arrives as a FRONT crossing the tile, never as a switch. The front's
// shape is a second, very low-frequency noise field that drifts on its own clock: a plain
// `(x + y)` lean does sweep, but it draws a dead-straight 45° edge that reads as a stripe
// laid over the mark rather than as one thing becoming another. This much of a
// palette-index of spread, so about two palettes share the tile through a change and never
// more.
const FRONT_SCALE = 0.16;
const FRONT_SPEED = 0.09;
const FRONT_SPREAD = 1.4;
// A shade OVER half the cells carry ink. Real marks are drawn sparser than that, but this
// is a signal rather than a drawing, and at the sparse end the darker palettes' grounds sit
// close enough to the page that the tile reads as a hole rather than as something alive.
const INK_THRESHOLD = 0.47;
// Pixel art has nothing to gain from 60fps, and this sits above an input.
const FRAME_MS = 1000 / 14;
// The field is started AWAY from the lattice origin: an integer-hashed value noise is
// exactly its own hash at (0, 0, 0), and every corner of that cell is the same one — so t=0
// paints a degenerate frame, which is the one a still tile would hold forever.
const T0 = 4.2;

function GhostMark({ size }: { size: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const node = canvas.current;
    const context = node?.getContext('2d');
    if (!node || !context) return;

    const count = AVATAR_PALETTES.length;
    const paint = (seconds: number) => {
      // One value for the whole tile, so the palette is a property of the MOMENT; the
      // per-cell lean below is only what turns a change into a sweep.
      const drift = noise3(0, 0, seconds * PALETTE_SPEED) * count;
      for (let y = 0; y < AVATAR_SIZE; y += 1) {
        for (let x = 0; x < AVATAR_SIZE; x += 1) {
          const front = noise3(x * FRONT_SCALE, y * FRONT_SCALE, seconds * FRONT_SPEED);
          const which = (drift + front * FRONT_SPREAD) % count;
          // The two fields are offset in TIME so they cannot beat against each other into a
          // visible period.
          const ink = noise3(x * INK_SCALE, y * INK_SCALE, seconds * INK_SPEED + 31.7);
          const palette = AVATAR_PALETTES[Math.floor(which)];
          context.fillStyle = ink > INK_THRESHOLD ? palette.fg : palette.bg;
          context.fillRect(x, y, 1, 1);
        }
      }
    };

    // Reduced motion keeps the PICTURE and drops the movement: one frame of the field is
    // still a mark-shaped absence, which is the whole message.
    const still =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (still) {
      paint(T0);
      return;
    }

    let frame = 0;
    let last = -Infinity;
    const start = performance.now();
    const step = (now: number) => {
      if (now - last >= FRAME_MS) {
        last = now;
        paint(T0 + (now - start) / 1000);
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <canvas
      ref={canvas}
      className="account-mark ghost"
      width={AVATAR_SIZE}
      height={AVATAR_SIZE}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

interface Drawing {
  bg: string;
  fg: string;
  order: Map<number, number>; // cell index -> its delay in ms
}

function read(avatar: string): Drawing | null {
  try {
    const { palette, cells } = decodeAvatar(avatar);
    const lit: number[] = [];
    for (let i = 0; i < cells.length; i += 1) if (cells[i]) lit.push(i);
    const shuffled = shuffle(lit, avatar);
    const order = new Map<number, number>();
    shuffled.forEach((index, n) => {
      order.set(index, shuffled.length < 2 ? 0 : (n / (shuffled.length - 1)) * SPREAD_MS);
    });
    return { bg: AVATAR_PALETTES[palette].bg, fg: AVATAR_PALETTES[palette].fg, order };
  } catch {
    return null;
  }
}

export interface AccountMarkProps {
  // The encoded drawing, or null while nobody is known yet — which is the ghost.
  avatar: string | null;
  size: number;
  // Whether this mark should DEVELOP when it arrives rather than simply appearing. Only the
  // returning flow and an adopted ending ask for it: a saved account's face never left.
  compose?: boolean;
}

export default function AccountMark({ avatar, size, compose = false }: AccountMarkProps) {
  // The composition runs ONCE per drawing and is over for good — a later re-render (a
  // resend, a store update) must not replay it.
  const clipId = useId();
  const [settled, setSettled] = useState(false);
  const reduced =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const drawing = useMemo(
    () => (avatar && compose && !reduced ? read(avatar) : null),
    [avatar, compose, reduced],
  );

  useEffect(() => {
    if (!drawing) return;
    setSettled(false);
    const timer = setTimeout(() => setSettled(true), COMPOSE_MS);
    return () => clearTimeout(timer);
  }, [drawing]);

  if (avatar === null) return <GhostMark size={size} />;
  // A drawing this component could not read still renders — `Avatar` owns that failure, and
  // a mark that cannot be decoded must not take a screen with it.
  if (!drawing || settled) return <Avatar avatar={avatar} size={size} />;

  const cells: ReactNode[] = [];
  drawing.order.forEach((delay, index) => {
    cells.push(
      <rect
        key={index}
        x={(index % AVATAR_SIZE) * CELL - BLEED}
        y={Math.floor(index / AVATAR_SIZE) * CELL - BLEED}
        width={CELL + BLEED * 2}
        height={CELL + BLEED * 2}
        fill={drawing.fg}
        className="mark-cell"
        style={{ animationDelay: `${delay.toFixed(0)}ms`, animationDuration: `${POP_MS}ms` }}
      />,
    );
  });

  return (
    <svg
      className="account-mark composing"
      width={size}
      height={size}
      viewBox={`0 0 ${SPAN} ${SPAN}`}
      aria-hidden="true"
    >
      <clipPath id={clipId}>
        <rect width={SPAN} height={SPAN} rx={RADIUS} />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>
        {/* The GROUND lands first and the drawing grows into it — an account appearing out
            of nothing, in the order its own pixels were shuffled. */}
        <rect width={SPAN} height={SPAN} fill={drawing.bg} className="mark-ground" />
        {cells}
      </g>
    </svg>
  );
}
