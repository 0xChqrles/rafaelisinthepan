import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { LANE_COLORS } from '../components/RouteModal';
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

const CLOUD_WORDS = 12;
// The size ramp, in px of the game's word font: the closest word leads like a headline and
// the tail stays readable on a 320px phone.
const SIZE_MAX = 30;
const SIZE_MIN = 15;
// A long word must FIT the screen at whatever size the ramp hands it, so its size is capped
// by width the same way the route map's fitWord does it — arithmetic, not measurement. The
// game's word font advances ~0.95em per glyph (measured: « intertropical-5 » at 30px laid
// out 424px), and the exponent's digits run at sup size, so they count for ~0.7 of a glyph.
const GLYPH_EM = 0.95;
const SUP_EM = 0.7;
// The cloud must also FIT the play area's height — a tall cloud grew the page and made the
// view scroll (findings 2026-08-04). The whole size ramp scales down on short viewports:
// full size once ~300px of cloud room exists above the tray, floored so the tail never
// becomes unreadable. Read once at mount — the tutorial is one sitting, and a mid-cloud
// resize at worst wraps a line early.
const CLOUD_ROOM_OFFSET = 430; // header + coach + gaps + tray, roughly
const CLOUD_ROOM_FULL = 300; // the room the unscaled ramp needs
const SCALE_MIN = 0.55;
// The room a cloud word may take: the play column, minus its padding — phrased in CSS so the
// cap stays live across resizes without this component measuring anything.
const CLOUD_AVAIL = 'min(100vw, 600px) - 40px';

function fitSize(ramp: number, entry: RankEntry): string {
  const glyphs = entry.word.length * GLYPH_EM + (String(entry.rank).length + 1) * SUP_EM;
  return `min(${ramp}px, calc((${CLOUD_AVAIL}) / ${glyphs.toFixed(1)}))`;
}

export default function ThemeCloud({
  map,
  road,
  startRank,
}: {
  map: WordRanks; // the board's whole rank map — the cloud filters its own theme out of it
  road: number; // which theme: the map's road id, also the cloud's LANE_COLORS index
  startRank: number; // the exponents' heat scale — the same one the board's floats use
}) {
  const scale = useMemo(() => {
    if (typeof window === 'undefined') return 1;
    return Math.min(1, Math.max(SCALE_MIN, (window.innerHeight - CLOUD_ROOM_OFFSET) / CLOUD_ROOM_FULL));
  }, []);

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

  return (
    <p
      className="theme-cloud"
      style={{ '--cloud-c': LANE_COLORS[road % LANE_COLORS.length] } as CSSProperties}
    >
      {words.map((entry, i) => (
        <span
          key={entry.rank}
          className="cloud-word"
          style={{ fontSize: fitSize(Math.round((SIZE_MAX - i * step) * scale), entry) }}
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
