import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { LANE_COLORS } from '../components/RouteModal';
import { rankHeatColor } from '../components/Hole';
import { prefersReducedMotion } from '../hooks/useScramble';
import ChevronUp from '../assets/icons/chevron-up.svg?react';
import { t } from '../i18n';
import type { RankEntry, WordRanks } from '@whippin/shared';

// The onboarding's CLOSE (#155, findings 2026-08-04): after the theme clouds, a real glimpse
// of the ROUTE MAP the game will offer on every word — the themes' colored lines at the map's
// own lane rhythm, every group of the near field riding them as a STATION (rank exponent in a
// left gutter, node on its lane, word beside it in the lane's color).
//
// It runs the way the real map runs: the line is TRAVELLED, so it reads DOWN the page from the
// far field to the word — the farthest rank at the top, `-1` at the BOTTOM — and it opens
// scrolled to that bottom, where the destination is. The two chevrons on the left are the
// scroll CONTROL: real buttons that page the line up toward `-100` and back down to `-1`,
// dimmed at each end. (Wheel, drag and trackpad work too — it is an ordinary scroller.)
//
// Still a signpost and not the map: no trunk, no junctions, no terminus, nothing censored —
// the drawing is decorative (aria-hidden) and the coach's general principle carries the
// meaning. The chevron BUTTONS sit outside that subtree, so the one interactive thing here is
// named rather than hidden from assistive tech.

// The map's own lane geometry (RouteModal) at the miniature's tighter pitch: the rhythm is the
// map's, closed up because this line shares its row with a word column a 320px phone must fit.
const LANE_W = 5;
const LANE_PITCH = 16;
// How far out the line goes. The near field runs to 150, but the claim is "there is a lot more
// here", and -1..-100 says it while keeping the rank gutter four glyphs wide.
const TEASER_TOP = 100;
// One station's row, and the fraction of a screenful a chevron press travels.
const ROW_H = 30;
const PAGE_FRACTION = 0.8;
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

function fitStation(word: string, overheadPx: number): string {
  const glyphs = (word.length * GLYPH_EM).toFixed(1);
  return `clamp(${WORD_MIN_PX}px, calc((100cqw - ${overheadPx}px) / ${glyphs}), ${WORD_PX}px)`;
}

export default function RoutesTeaser({
  map,
  lanes,
  startRank,
  lang,
}: {
  map: WordRanks;
  lanes: number;
  startRank: number; // the exponents' heat scale — the same one the whole tutorial uses
  lang: string;
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

  const scrollRef = useRef<HTMLDivElement>(null);
  // Which end the line is parked at, so a chevron can say when it has nowhere to go.
  const [atTop, setAtTop] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const readEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtTop(el.scrollTop <= 1);
    setAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 1);
  }, []);

  // Open at the BOTTOM: the word is the end of the line, so the closest ranks are where the
  // player lands and the far field is what the up chevron goes looking for.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    readEdges();
  }, [readEdges]);

  const page = useCallback((dir: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({
      top: dir * el.clientHeight * PAGE_FRACTION,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, []);

  return (
    <div className="routes-teaser">
      <div className="teaser-arrows">
        <button
          type="button"
          className="teaser-arrow"
          aria-label={t(lang, 'ariaScrollFar')}
          disabled={atTop}
          onClick={() => page(-1)}
        >
          <ChevronUp className="pixel-icon" aria-hidden />
        </button>
        <button
          type="button"
          className="teaser-arrow"
          aria-label={t(lang, 'ariaScrollClose')}
          disabled={atBottom}
          onClick={() => page(1)}
        >
          <ChevronUp className="pixel-icon flipped" aria-hidden />
        </button>
      </div>
      <div className="teaser-scroll" ref={scrollRef} onScroll={readEdges} aria-hidden="true">
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
        </div>
      </div>
    </div>
  );
}
