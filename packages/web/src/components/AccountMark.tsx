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

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
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

// The empty slot. Not a skeleton and not a spinner: a skeleton says "this is loading", and
// this says "this is somebody, and we do not know who yet" — which is the whole question the
// screen under it is asking. The breath is a handful of cells drifting on a long cycle,
// deliberately below the threshold of a thing you would call an animation.
function GhostMark({ size }: { size: number }) {
  const cells = useMemo(() => {
    const out: { key: number; x: number; y: number; lit: number }[] = [];
    for (let i = 0; i < AVATAR_SIZE * AVATAR_SIZE; i += 1) {
      out.push({
        key: i,
        x: (i % AVATAR_SIZE) * CELL,
        y: Math.floor(i / AVATAR_SIZE) * CELL,
        // Five of a hundred, spread across the tile by a stride coprime with its width so
        // they never line up into a row.
        lit: i % 23 === 3 ? (i % 5) * 0.6 + 0.2 : 0,
      });
    }
    return out;
  }, []);
  return (
    <svg
      className="account-mark ghost"
      width={size}
      height={size}
      viewBox={`0 0 ${SPAN} ${SPAN}`}
      aria-hidden="true"
    >
      <rect width={SPAN} height={SPAN} rx={RADIUS} className="ghost-ground" />
      {cells.map((cell) => (
        <rect
          key={cell.key}
          x={cell.x + 0.5}
          y={cell.y + 0.5}
          width={CELL - 1}
          height={CELL - 1}
          className={cell.lit ? 'ghost-cell breathing' : 'ghost-cell'}
          style={cell.lit ? { animationDelay: `${cell.lit}s` } : undefined}
        />
      ))}
    </svg>
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
