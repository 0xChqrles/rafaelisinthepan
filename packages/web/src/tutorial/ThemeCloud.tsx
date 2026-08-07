import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { AnimationEvent, CSSProperties } from 'react';
import { LANE_COLORS } from '../components/routeDrawing';
import { rankHeatColor } from '../components/Hole';
import type { RankEntry, WordRanks } from '@whippin/shared';

// The onboarding's THEME clouds (#155, findings 2026-08-04): the ending shows each theme of
// the found word as a CLOUD of its words — one cloud at a time, never two — instead of
// drawing the route line. The line is the daily game's instrument; for the lesson, a handful
// of themed words with their exponents says "these belong together, this close" with nothing
// left to decode. The cloud is painted in the theme's ROUTE COLOR (LANE_COLORS — the same
// identity the game's map will use for this road later), and every word keeps its heat-ramp
// exponent, the one scale the whole tutorial has been teaching.
//
// The words are the theme's closest groups, closest first, biggest first: font size falls
// with cloud position, so nearness reads off the type the way it reads off the exponent.
// Capped — a theme can hold 79 groups and a cloud is a taste, not an inventory.
//
// A cloud SCALES in and out, word by word on a random stagger (findings 2026-08-04): the
// words pop into being one after another rather than the block appearing whole, which is
// what makes a cloud read as a cloud — a handful of things that belong together — instead
// of as a paragraph swapped for another. `exiting` plays the same beat backwards, and the
// cloud REPORTS when the last word has finished shrinking (`onExited`) rather than leaving
// the caller to guess a duration — the same rule the game's other exit beats follow, so what
// comes next can never land over a word still on screen. Under reduced motion the global rule
// collapses the durations while keeping the delays, so the words still arrive one by one,
// just without the scaling (and `animationend` still fires, so the report is unaffected).

const CLOUD_WORDS = 12;
// The size ramp, in px of the game's word font: the closest word leads like a headline and
// the tail stays readable on a 320px phone.
const SIZE_MAX = 30;
const SIZE_MIN = 15;
// A long word must FIT the screen at whatever size the ramp hands it, so its size is capped
// by width the same way the route map's fitWord does it — arithmetic, not measurement. The
// game's word font (VT323) advances EXACTLY 1em per glyph, measured; the exponent's digits
// run at sup size, so they count for ~0.7 of a glyph (an over-estimate, which only ever
// shrinks a word further — the safe direction).
const GLYPH_EM = 1;
const SUP_EM = 0.7;
// The cloud must also FIT the play area's height — a tall cloud grew the page and made the
// view scroll (findings 2026-08-04). The whole size ramp scales down on short viewports:
// full size once ~300px of cloud room exists above the tray, floored so the tail never
// becomes unreadable. Phrased in CSS, like the width cap below (fixed 2026-08-04): read once
// at mount it went STALE on any resize — 390x844 shrunk to 320x568 kept the full ramp, grew
// the page to 624px and pushed the tray under the fold, which is exactly the failure the
// scaling exists to prevent. "The tutorial is one sitting" is not true of a rotated phone or
// a dragged window.
const CLOUD_ROOM_OFFSET = 430; // header + coach + gaps + tray, roughly
const CLOUD_ROOM_FULL = 300; // the room the unscaled ramp needs
const SCALE_MIN = 0.55;
// The per-word stagger: how late the LAST word can be. The entrance is the generous one —
// it is the cloud forming — and the exit is quicker, since it is only clearing the stage.
// Both are BRISK (findings 2026-08-04, cut from 260/150): the scatter has to read as one
// gesture, and a cloud that takes half a second to assemble reads as waiting for it.
// Tutorial.tsx's CLOUD_EXIT_FALLBACK_MS — the deadline behind the `onExited` report —
// comfortably covers OUT_STAGGER_MS plus the exit's own duration.
const IN_STAGGER_MS = 150;
const OUT_STAGGER_MS = 90;
// The room a cloud word may take: the play column, minus its padding — phrased in CSS so the
// cap stays live across resizes without this component measuring anything.
const CLOUD_AVAIL = 'min(100vw, 600px) - 40px';

// A word's size: its place on the ramp, scaled to the viewport's height and capped by the
// column's width — all three in ONE live CSS expression, so a resize re-solves it with nothing
// to recompute here.
//
// The height term is `ramp * clamp(SCALE_MIN, (100dvh - OFFSET) / FULL, 1)`. CSS cannot divide a
// length by a length to get a number, so the ratio is distributed over the multiplication
// instead: `ramp / FULL` is a plain number at this point, and number x length is a length. `dvh`
// rather than `vh` because the room being budgeted is the room the layout actually gets — the
// same unit `.game`'s own min-height speaks.
function fitSize(ramp: number, entry: RankEntry): string {
  const glyphs = entry.word.length * GLYPH_EM + (String(entry.rank).length + 1) * SUP_EM;
  const room = `calc(${(ramp / CLOUD_ROOM_FULL).toFixed(4)} * (100dvh - ${CLOUD_ROOM_OFFSET}px))`;
  const scaled = `clamp(${(ramp * SCALE_MIN).toFixed(2)}px, ${room}, ${ramp}px)`;
  return `min(${scaled}, calc((${CLOUD_AVAIL}) / ${glyphs.toFixed(1)}))`;
}

export default function ThemeCloud({
  map,
  road,
  startRank,
  exiting = false,
  onExited,
}: {
  map: WordRanks; // the board's whole rank map — the cloud filters its own theme out of it
  road: number; // which theme: the map's road id, also the cloud's LANE_COLORS index
  startRank: number; // the exponents' heat scale — the same one the board's floats use
  exiting?: boolean; // play the entrance backwards — the Tutorial's swap beat (see above)
  // Fired once, when the LAST word of an exiting cloud has finished shrinking.
  onExited?: () => void;
}) {
  // One entry per GROUP of this theme (a real map keys every inflection to the same entry),
  // closest first, capped.
  const words = useMemo<RankEntry[]>(() => {
    const byRank = new Map<number, RankEntry>();
    for (const entry of Object.values(map)) {
      if (entry.road === road && !byRank.has(entry.rank)) byRank.set(entry.rank, entry);
    }
    return [...byRank.values()]
      .sort((a, b) => a.rank - b.rank)
      .slice(0, CLOUD_WORDS);
  }, [map, road]);

  const step = words.length > 1 ? (SIZE_MAX - SIZE_MIN) / (words.length - 1) : 0;

  // Each word's own place in the stagger, rolled ONCE per cloud: re-rolling per render would
  // re-time an animation already running, and rolling per phase would cost the word the
  // personality that makes the entrance and the exit read as the same cloud breathing.
  // Deliberately NOT index-derived — a left-to-right sweep reads as a list being filled in,
  // where a scatter reads as a cloud condensing.
  const offsets = useMemo(() => words.map(() => Math.random()), [words]);

  // The exit's finish line: every word's `animationend` bubbles here, and the last one to
  // land is the cloud being gone. Counted rather than timed off the word with the biggest
  // delay — two words can share it — and reset whenever the phase flips, so a cloud that
  // enters, leaves and enters again reports each exit exactly once.
  const exited = useRef(0);
  useEffect(() => {
    exited.current = 0;
  }, [exiting, words]);
  const onWordAnimationEnd = useCallback(
    (e: AnimationEvent) => {
      if (!exiting || e.animationName !== 'cloud-word-out') return;
      exited.current += 1;
      if (exited.current >= words.length) onExited?.();
    },
    [exiting, words, onExited],
  );

  return (
    <p
      onAnimationEnd={onWordAnimationEnd}
      className="theme-cloud"
      style={{ '--cloud-c': LANE_COLORS[road % LANE_COLORS.length] } as CSSProperties}
    >
      {words.map((entry, i) => (
        <span
          key={entry.rank}
          className={`cloud-word ${exiting ? 'out' : 'in'}`}
          style={
            {
              fontSize: fitSize(SIZE_MAX - i * step, entry),
              '--cloud-delay': `${Math.round(
                offsets[i] * (exiting ? OUT_STAGGER_MS : IN_STAGGER_MS),
              )}ms`,
            } as CSSProperties
          }
        >
          {entry.word}
          <sup
            className="hole-rank"
            style={{ '--rank-color': rankHeatColor(entry.rank, startRank) } as CSSProperties}
          >
            -{entry.rank}
          </sup>
        </span>
      ))}
    </p>
  );
}
