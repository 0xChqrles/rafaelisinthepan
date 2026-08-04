import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { LANE_COLORS } from '../components/RouteModal';
import { rankHeatColor } from '../components/Hole';
import ChevronUp from '../assets/icons/chevron-up.svg?react';
import type { RankEntry, WordRanks } from '@whippin/shared';

// The onboarding's CLOSE (#155, findings 2026-08-04): after the theme clouds, a glimpse of
// the ROUTE MAP the game will offer on every word — the themes' colored lines at the map's
// own lane rhythm, each carrying a couple of its words as STATIONS (rank exponent in a left
// gutter like the real map's, node on the lane, word beside it in the lane's color), with
// two chevrons on the left saying "this scrolls". The lines STRETCH to the room the play
// area actually has (flex-basis 0 + min-height 0, so they can never grow the page; bounded
// by a max, with the rows spread evenly along them). It is a signpost to the real map, not
// the map — no trunk, no terminus — which is why it is decorative (aria-hidden) and the
// coach's general principle carries the meaning.

// The map's own lane geometry (RouteModal): 5px lines on a 22px pitch.
const LANE_W = 5;
const LANE_PITCH = 22;
// Stations per theme — the theme's closest words. Two keeps every color present twice while
// the rows still breathe on the shortest phone's play area.
const PER_THEME = 2;
// The rank gutter's cell: the map's own --rank-size (Press Start advances 1em per glyph).
const RANK_PX = 10;
// A station's word is a display pick, and long words are passed over for the theme's next
// closest (« intertropical » beside the rail overflowed a 320px phone) — the teaser is a
// signpost, not a ranking, so which words ride it is a layout choice.
const MAX_WORD_CHARS = 10;
// And the survivors still get a width cap, fitWord-style (the word font advances
// ~0.95em/glyph): everything left of the word — the app padding, the chevrons and their
// gaps, the rail and the word's own margin — is arithmetic, so the cap can be CSS and stay
// live across resizes.
const WORD_PX = 15;
function fitStation(word: string, overheadPx: number): string {
  return `min(${WORD_PX}px, calc((100vw - ${overheadPx}px) / ${(word.length * 0.95).toFixed(1)}))`;
}

export default function RoutesTeaser({
  map,
  lanes,
  startRank,
}: {
  map: WordRanks;
  lanes: number;
  startRank: number; // the exponents' heat scale — the same one the whole tutorial uses
}) {
  // The PER_THEME closest groups of each road, then one interleaved rank order — so the
  // colors mix down the list the way roads interleave on the real map.
  const stations = useMemo<RankEntry[]>(() => {
    const byRoad = new Map<number, RankEntry[]>();
    for (const entry of Object.values(map)) {
      if (entry.road === undefined) continue;
      const list = byRoad.get(entry.road) ?? [];
      if (!list.some((e) => e.rank === entry.rank)) {
        list.push(entry);
        byRoad.set(entry.road, list);
      }
    }
    const picks: RankEntry[] = [];
    for (const list of byRoad.values()) {
      picks.push(
        ...list
          .sort((a, b) => a.rank - b.rank)
          .filter((e) => e.word.length <= MAX_WORD_CHARS)
          .slice(0, PER_THEME),
      );
    }
    return picks.sort((a, b) => a.rank - b.rank);
  }, [map]);

  const railWidth = (lanes - 1) * LANE_PITCH + LANE_W;
  // The rank gutter fits the widest exponent actually shown, like the map's own.
  const rankChars = 1 + Math.max(...stations.map((e) => String(e.rank).length), 1);
  const gutter = rankChars * RANK_PX + 10;
  // App padding (48) + chevron column and its gap (47) + gutter + rail + word margin (16).
  const wordOverhead = 111 + gutter + railWidth;

  return (
    <div className="routes-teaser" aria-hidden="true">
      <span className="teaser-arrows">
        <ChevronUp className="pixel-icon" />
        <ChevronUp className="pixel-icon" style={{ transform: 'scaleY(-1)' }} />
      </span>
      <div
        className="teaser-map"
        style={
          {
            '--teaser-railw': `${railWidth}px`,
            '--teaser-gutter': `${gutter}px`,
          } as CSSProperties
        }
      >
        <span className="teaser-lanes">
          {Array.from({ length: lanes }, (_, road) => (
            <i key={road} style={{ background: LANE_COLORS[road % LANE_COLORS.length] }} />
          ))}
        </span>
        {stations.map((entry) => {
          const color = LANE_COLORS[entry.road! % LANE_COLORS.length];
          return (
            <span key={entry.rank} className="teaser-station">
              <span
                className="t-rank"
                style={{ color: rankHeatColor(entry.rank, startRank) }}
              >
                -{entry.rank}
              </span>
              <span className="t-rail">
                <i
                  className="t-node"
                  style={{ left: entry.road! * LANE_PITCH + LANE_W / 2, background: color }}
                />
              </span>
              <span
                className="t-word"
                style={{ color, fontSize: fitStation(entry.word, wordOverhead) }}
              >
                {entry.word}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
