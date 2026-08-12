import type { CSSProperties, ReactNode } from 'react';
import { heatColor } from '@whippin/shared';
import { rankHeatColor, HIT_HEAT_CAP } from './Hole';
import { t } from '../i18n';

// The ROUTE DRAWING: the geometry and the row parts of a neighborhood drawn as a line,
// shared by Word mode's post-mortem board (`WordBoard`, #156) and the sentence game's
// hole-history modal (`HistoryModal`, which on 2026-08-10 replaced the #117 route map but
// kept its trunk: a single line of the player's own stops walking down to the `???`
// terminus). A detail of the line changed here changes on every route the app draws,
// which is only true while there is one copy of it.
//
// What stays with a surface is what is genuinely its own: the board's censored field and
// its claim reveal (and its pinned terminus footer, WordTerminus), the history's journey
// model, and each one's screen-reader mirror.
//
// Both routes draw ONE trunk. What a station IS gets said in its dress — the board paints a
// word in its rarity's colour, the history line tells its zones apart by node and brightness.

// The dq scale (#115): the rank-1 group is pinned at 255, the farthest kept group at 0,
// per map. The affine normalization is lossless for a consumer that only reads RATIOS,
// which is exactly what a connector's length is. (Lived in `game/route.ts` until the route
// model went with its modal.)
const DQ_MAX = 255;

// --- distances ---------------------------------------------------------------------------
// A connector carries the distance between the two stations it joins: `LINK_SPAN` px per full
// dq scale, floored so two neighbours never collide and capped so the cold tail cannot push the
// destination off screen. The floor and the cap are what make this a line and not a map.
// The floor doubles as the uniform spacing `linkGap` falls back to where no dq exists to
// carry a distance (the history modal on pre-#115 data).
const LINK_MIN = 14;
const LINK_MAX = 92;
const LINK_SPAN = 300;

function linkHeight(dqA: number, dqB: number): number {
  const span = (Math.abs(dqA - dqB) / DQ_MAX) * LINK_SPAN;
  return Math.round(Math.min(LINK_MAX, Math.max(LINK_MIN, span)));
}

// The connector between two consecutive ROWS of a line. Consecutive ranks are ONE row apart
// whatever their dq: with every group of the field drawn, the rank ladder itself already says
// they are adjacent, so a proportional connector in there buys nothing and costs one glaring
// outlier — dq pins rank 1 at the top of its scale, so 1 and 2 are always further apart than
// any other pair of neighbours. The length stays proportional wherever the line SKIPS ranks
// (the trunk, where the player's stops are sparse and the length is the only thing carrying
// the distance at all). One rule, both surfaces.
export function linkGap(
  previous: { rank: number; dq: number } | undefined,
  row: { rank: number; dq: number },
): number {
  if (!previous) return 0;
  return previous.rank - row.rank === 1 ? LINK_MIN : linkHeight(previous.dq, row.dq);
}

// The broken trace is drawn from ONE repeating unit: DASH px of line, then DASH_GAP px of
// nothing. It is handed to CSS as well (`--dash`, `--dash-period`), because the gradient that
// paints the unit and the height that has to be a whole number of it cannot be allowed to
// disagree.
const DASH = 5;
const DASH_GAP = 8;
const DASH_PERIOD = DASH + DASH_GAP;
// A dashed run is a whole number of units PLUS its closing dash. Any other height cuts the last
// unit wherever it happens to fall, and the stub lands exactly where the trace meets the solid
// rail — a 3px sliver of gap against a station reads as a rendering slip, not as a broken line.
// Snapped, both ends are clean: the run opens on a full dash and closes on one.
// Exported: a surface that draws its own broken connectors (the history modal's
// behind-the-departure stretch) must snap their heights by the same unit.
export const dashedRun = (px: number) =>
  Math.max(1, Math.round((px - DASH) / DASH_PERIOD)) * DASH_PERIOD + DASH;

// The cold end of the line, above the first station: it always continues into the words that
// have no distance at all, whether or not this round produced any. Not a distance, so not a
// solid line — the ONE broken trace the board draws.
const TAIL_H = dashedRun(34); // 31
// A word you have not found — a terminus still to be reached, or a censored station. FIXED
// width: a placeholder that grew with the word would leak its length.
export const UNKNOWN = '???';

// --- the rail ------------------------------------------------------------------------------
// Where the line runs across its column. The node positions and the CSS that paints the rail
// have to agree exactly, so the geometry lives here: TRUNK_X is the trunk's centre, and the
// rail column is exactly wide enough for the line drawn on it (`--line-w`, CSS's own).
const TRUNK_X = 15.5;

// How many glyphs the rank gutter has to hold: the exponent's digits plus its leading `-`.
//
// It takes the widest rank the MAP can ever produce, never the widest currently DRAWN (fixed
// 2026-08-06). The gutter track is `minmax(var(--gutter), max-content)`, so sizing it to the
// line as it stands means the first guess that lands a wider exponent — a 4-digit rank on a
// board whose field ends at CLAIM_ZONE — widens the track and shoves the whole line, rail and
// words, one glyph to the right. The exponent that arrives is a REPORT on a guess; it must
// not move the map the player is reading. Reserved up front the width is a property of the
// puzzle, so it is fixed for the round and nothing shifts. It costs one glyph of gutter on a
// board that never shows a wide rank, which is the whole price of the anticipation.
export function rankGutterChars(maxRank: number): number {
  return 1 + String(Math.max(1, Math.floor(maxRank))).length;
}

// Every CSS variable the drawing needs, for a line whose widest exponent is `rankChars`
// glyphs wide. One function, so the two surfaces cannot compute a rail width or a dash unit
// differently — the rail column and the heights measured against it derive from the same
// numbers.
//
// The rank gutter's char COUNT is baked in as a literal while the cell size stays a CSS
// variable, so the gutter tracks the responsive `--rank-size` without any calc having to divide
// by a custom property. (`--gutter` is only the FALLBACK template — `.route` is one grid and
// each row a subgrid of it, so the real gutter is `max-content` across every row at once.)
export function routeFrameVars(rankChars: number): CSSProperties {
  return {
    '--gutter': `calc(var(--rank-size) * ${rankChars} + 10px)`,
    '--railw': `${TRUNK_X * 2}px`,
    '--trunk-x': `${TRUNK_X}px`,
    // The dash unit the tail is cut to (see dashedRun): the gradient paints it, the height
    // counts it, so both read it from here.
    '--dash': `${DASH}px`,
    '--dash-period': `${DASH_PERIOD}px`,
  } as CSSProperties;
}

// --- type sizes ------------------------------------------------------------------------------
// The word column's own width is known in CSS (`--wordw`), and Press Start 2P advances
// EXACTLY 1em per glyph — measured, not assumed — so the size at which a word fits its column
// is arithmetic: width / length. A long French compound therefore shrinks a little instead of
// breaking mid-word (`incontestableme/nt` reads as a different word) or running off the map.
// The divisor is baked as a literal rather than passed as a custom property, so no calc() has
// to divide by a var. Below the floor the CSS `overflow-wrap` still catches it.
const WORD_MIN_PX = 8;
export function fitWord(word: string, max: number): string {
  return `clamp(${WORD_MIN_PX}px, calc(var(--wordw) / ${Math.max(1, word.length)}), ${max}px)`;
}
// Type sizes per station state: a terminus reads as a headline, everything else at the
// line's own size.
export const ARRIVAL_PX = 24;
export const STATION_PX = 15;

// --- the parts ---------------------------------------------------------------------------
// The rows every route is built out of. A surface composes them and supplies what is its own
// (which rows exist, in what order, and what stands in the word cell); none of the markup or
// the class grammar is written twice.

// ABOVE the line: the guesses that earned no rank at all. Beyond the top-K there is no distance
// left to draw, and that IS the mechanic. It carries no rule under it (removed 2026-08-05): the
// shelf sits above the line's own broken tail, so a second horizontal tear only fenced the words
// off from what they are already outside of.
export function OffMapShelf({ lang, misses }: { lang: string; misses: string[] }) {
  if (misses.length === 0) return null;
  return (
    <div className="route-shelf">
      {/* In the heat ramp's COLDEST colour — the exact one the floating `MISS` wears when a
          guess is too far to rank (`heatColor(0)`, computed rather than copied, so the two can
          never drift). The heading names the same outcome, so it says it in the same voice. */}
      <p className="route-shelf-head" style={{ color: heatColor(0) }}>
        {t(lang, 'routeOffMap')}
      </p>
      {/* The words wear the same coldest heat, DIMMED (`.route-miss` opacity): they are the
          shelf's own dead ends, one voice with the heading and the float, but quieter than a
          label — so the shelf reads as one red block of "nothing here" at a glance instead of
          a muted list that could pass for ordinary words (decided 2026-08-10). */}
      <p className="route-misses" style={{ color: heatColor(0) }}>
        {misses.map((word) => (
          <span key={word} className="route-miss">
            {word}
          </span>
        ))}
      </p>
    </div>
  );
}

// The line always comes in out of that void, whether or not this round hit it.
export function RouteTail() {
  return <div className="route-link tail" style={{ height: TAIL_H }} />;
}

// The connector between two rows. `broken` draws it as the tail's dashed trace instead of a
// solid run — the history modal's behind-the-departure stretch, where the line is not yet the
// journey. A broken height must be `dashedRun`-snapped by the caller, or the last unit is cut
// wherever it falls.
export function RouteLink({ height, broken = false }: { height: number; broken?: boolean }) {
  return <div className={`route-link${broken ? ' broken' : ''}`} style={{ height }} />;
}

// One ROW of the line: the rank in its right-aligned gutter (the "time"), the rail with this
// row's node on it, then the word cell. All three name their grid column in CSS, which is what
// makes the rail read as one unbroken line down the page.
export function RouteRow({
  className = '',
  style,
  rank = null,
  children,
}: {
  className?: string;
  style?: CSSProperties;
  // The row's own distance, drawn as its heat-coloured exponent. Null on the rows that
  // have no distance of their own — a terminus.
  rank?: number | null;
  children?: ReactNode;
}) {
  return (
    <div
      className={`route-station${className ? ` ${className}` : ''}`}
      style={style}
    >
      <span
        className="route-rank"
        style={
          rank === null
            ? undefined
            : ({ '--rank-color': rankHeatColor(rank, HIT_HEAT_CAP) } as CSSProperties)
        }
      >
        {rank === null ? null : `-${rank}`}
      </span>
      <span className="route-rail">
        <i className="route-node" />
      </span>
      <span className="route-body">{children}</span>
    </div>
  );
}

// A row's word, sized to the column it has to fit.
export function RouteWord({ word, max }: { word: string; max: number }) {
  return (
    <span className="route-word" style={{ fontSize: fitWord(word, max) }}>
      {word}
    </span>
  );
}
