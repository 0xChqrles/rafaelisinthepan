import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { LANE_COLORS } from '../components/RouteModal';
import { rankHeatColor } from '../components/Hole';
import type { RankEntry, WordRanks } from '@whippin/shared';

// The onboarding's CLOSE (#155, findings 2026-08-04): after the theme clouds, a real glimpse
// of the ROUTE MAP the game will offer on every word — the themes' colored lines at the map's
// own lane rhythm, every group of the near field riding them as a STATION (rank exponent in a
// left gutter, node on its lane, word beside it in the lane's color).
//
// It runs the way the real map runs: the line is TRAVELLED, so it reads DOWN the page from the
// far field to the word — the farthest rank at the top, `-1` at the bottom, and THE WORD ITSELF
// at the very foot, in the solved blue past the lanes' MERGE — the routes join onto a bus and
// one solid trunk leads into the word, so the lines are visibly leading to it rather than just
// running out. It opens scrolled to that bottom, where the
// destination is. It SCROLLS, by drag/wheel/trackpad, and
// its own squared-off scrollbar is what says so: the two chevrons that used to flank it were
// removed on findings 2026-08-04 — one affordance for one gesture is enough, and the column
// they took was width the words needed on a 320px phone. The frame's own EDGES say the rest:
// whichever side still has line beyond it wears a torn dashed rule, so parked at the bottom the
// top edge is visibly cut off rather than simply ending there.
//
// Still a signpost and not the map: no trunk, no junctions, no terminus, nothing censored —
// the whole thing is decorative (aria-hidden), and the coach's general principle beside it
// carries the meaning.

// The map's own lane geometry (RouteModal) at the miniature's tighter pitch: the rhythm is the
// map's, closed up because this line shares its row with a word column a 320px phone must fit.
const LANE_W = 5;
const LANE_PITCH = 16;
// How far out the line goes. The near field runs to 150, but the claim is "there is a lot more
// here", and -1..-100 says it while keeping the rank gutter four glyphs wide.
const TEASER_TOP = 100;
// One station's row.
const ROW_H = 30;
// The terminus at the foot of the line: the word the routes lead to. The lanes MERGE just
// above it — they elbow onto a bus and ONE solid trunk leads down into the word's node, the
// real map's converge junction at the miniature's scale (decided 2026-08-04, superseding the
// dashed identity leap: the routes should visibly JOIN and LEAD to the word, and a broken
// trace read as the line not quite reaching it). The arrival's type is the map's own size,
// and the lanes' `bottom` is the arrival + the join summed.
const ARRIVAL_H = 44;
// The join: the bus is one lane thick, and the trunk runs the real map's 14px jx stub from
// the bus to the arrival row before continuing to the node's centre.
const BUS_H = LANE_W;
const TRUNK_RUN = 14;
const ARRIVAL_PX = 22;
// The word column's type: capped at WORD_PX, shrunk to FIT when a long word would not. `cqw`
// makes that exact rather than guessed — `.teaser-map` is an inline-size container, so 100cqw
// IS the row's real width (scrollbar already excluded) at any viewport.
const WORD_PX = 15;
// The floor is the route map's own (fitWord's WORD_MIN_PX): below it a word stops being
// readable anyway, and above it the longest word a board ships would clip on a 320px phone.
const WORD_MIN_PX = 8;
// VT323 advances EXACTLY 1em per glyph (measured; 0.95 was a guess, and it clipped the
// longest words at the far end of the line).
const GLYPH_EM = 1;
// The rank gutter's cell: the map's own --rank-size (Press Start advances 1em per glyph).
const RANK_PX = 10;
// Sub-pixel scroll offsets: a scrollport sitting exactly on an edge reports a fractional
// remainder, and without this slack that edge's rule would flicker on and off.
const EDGE_SLACK = 1;

function fitStation(word: string, overheadPx: number, max = WORD_PX): string {
  const glyphs = (word.length * GLYPH_EM).toFixed(1);
  return `clamp(${WORD_MIN_PX}px, calc((100cqw - ${overheadPx}px) / ${glyphs}), ${max}px)`;
}

export default function RoutesTeaser({
  map,
  lanes,
  startRank,
  word,
}: {
  map: WordRanks;
  lanes: number;
  startRank: number; // the exponents' heat scale — the same one the whole tutorial uses
  word: string; // the destination: the accented word every one of these routes leads to
}) {
  // Every group of the near field out to TEASER_TOP, one entry per GROUP (a real map keys
  // every inflection to the same entry), FARTHEST FIRST — the order the line is drawn in.
  const stations = useMemo<RankEntry[]>(() => {
    const byRank = new Map<number, RankEntry>();
    for (const entry of Object.values(map)) {
      if (entry.road === undefined || entry.rank > TEASER_TOP) continue;
      if (!byRank.has(entry.rank)) byRank.set(entry.rank, entry);
    }
    return [...byRank.values()].sort((a, b) => b.rank - a.rank);
  }, [map]);

  const railWidth = (lanes - 1) * LANE_PITCH + LANE_W;
  // The gutter fits the widest exponent actually shown, like the map's own.
  const rankChars = 1 + Math.max(...stations.map((e) => String(e.rank).length), 1);
  const gutter = rankChars * RANK_PX + 10;
  // Everything on a row that is NOT the word: the two fixed columns and the word's margin.
  const wordOverhead = gutter + railWidth + 16;

  // Open at the BOTTOM: the word is the end of the line, so the closest ranks are where the
  // player lands and the far field is what scrolling goes looking for.
  const scrollRef = useRef<HTMLDivElement>(null);

  // Which way the line still runs past the visible edge. The frame then wears a torn dashed
  // rule on that side — the route map's own vocabulary for "it does not continue straight
  // through here". Opened parked at the destination that is the TOP edge; scrolled out to the
  // far field, the BOTTOM one; anywhere between, both.
  const [more, setMore] = useState({ up: false, down: false });
  const readEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const up = el.scrollTop > EDGE_SLACK;
    const down = el.scrollTop + el.clientHeight < el.scrollHeight - EDGE_SLACK;
    // Bail on an unchanged value: a scroll event fires per frame and the line is ~100 rows.
    setMore((prev) => (prev.up === up && prev.down === down ? prev : { up, down }));
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    readEdges();
  }, [readEdges]);

  // A resize (rotation, a dragged window) changes clientHeight/scrollHeight under an
  // unchanged scrollTop, so the edges go stale without a scroll event — the same failure
  // class as the cloud's mount-read height scale (findings 2026-08-04).
  useEffect(() => {
    window.addEventListener('resize', readEdges);
    return () => window.removeEventListener('resize', readEdges);
  }, [readEdges]);

  return (
    <div
      className={`routes-teaser${more.up ? ' more-up' : ''}${more.down ? ' more-down' : ''}`}
      aria-hidden="true"
    >
      {/* tabIndex -1: browsers make scrollers keyboard-focusable, and a focusable element
          may not live inside the aria-hidden frame. Scroll stays pointer/wheel, as designed. */}
      <div className="teaser-scroll pixel-scroll" ref={scrollRef} onScroll={readEdges} tabIndex={-1}>
        <div
          className="teaser-map"
          style={
            {
              '--teaser-railw': `${railWidth}px`,
              '--teaser-gutter': `${gutter}px`,
              '--teaser-foot': `${ARRIVAL_H + TRUNK_RUN + BUS_H}px`,
              '--teaser-join-h': `${TRUNK_RUN + BUS_H}px`,
              '--teaser-trunk-h': `${TRUNK_RUN + ARRIVAL_H / 2}px`,
              '--teaser-trunk-x': `calc(var(--teaser-gutter) + ${railWidth / 2}px)`,
              // The bus wears the lanes' colors, split at the trunk, exactly like the map's
              // own (`busGradient`): the two halves read as the outer lanes turning in.
              '--teaser-bus-grad': `linear-gradient(90deg, ${LANE_COLORS[0]} 0 50%, ${
                LANE_COLORS[(lanes - 1) % LANE_COLORS.length]
              } 50% 100%)`,
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
              <span key={entry.rank} className="teaser-station" style={{ height: ROW_H }}>
                <span className="t-rank" style={{ color: rankHeatColor(entry.rank, startRank) }}>
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
          {/* The merge, then the word: the lanes end on the bus (see `--teaser-foot`), one
              solid trunk leads down into the word's node, and the terminus wears the solved
              blue the sentence gives a found word. */}
          <i className="teaser-bus" />
          <i className="teaser-trunk" />
          <span className="teaser-arrival" style={{ height: ARRIVAL_H }}>
            <span className="t-rank" />
            <span className="t-rail">
              <i className="t-node" style={{ left: railWidth / 2 }} />
            </span>
            <span
              className="t-word"
              style={{ fontSize: fitStation(word, wordOverhead, ARRIVAL_PX) }}
            >
              {word}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
