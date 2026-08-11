import type { CSSProperties, ReactNode, RefObject } from 'react';
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

// The dq scale (#115): the rank-1 group is pinned at 255, the farthest kept group at 0,
// per map. The affine normalization is lossless for a consumer that only reads RATIOS,
// which is exactly what a connector's length is. (Lived in `game/route.ts` until the route
// model went with its modal.)
const DQ_MAX = 255;

// --- distances ---------------------------------------------------------------------------
// A connector carries the distance between the two stations it joins: `LINK_SPAN` px per full
// dq scale, floored so two neighbours never collide and capped so the cold tail cannot push the
// destination off screen. The floor and the cap are what make this a line and not a map.
// The floor is exported: it is also the uniform spacing a surface falls back to where no dq
// exists to carry a distance (the history modal on pre-#115 data).
export const LINK_MIN = 14;
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
// Where the trunk splits into lanes, and where they merge back into the word. Its own fixed
// minimum, since it draws a shape rather than a gap.
export const JUNCTION_H = 34;
// The clearance the word board's torn-edge mask keeps its content short of the cut by
// (`.word-cut`), handed to CSS as `--stick-inset`. (Named for the route map's sticky row,
// which parked this far off the screen edge; the map is gone, the clearance idiom stays.)
const STICK_INSET = 8;

// A word you have not found — a terminus still to be reached, or a censored station. FIXED
// width: a placeholder that grew with the word would leak its length.
export const UNKNOWN = '???';

// --- lanes ---------------------------------------------------------------------------------
// A neighborhood's routes are drawn as LANES of the rail, the way a metro line draws its
// branches: which lane a station sits on is which route it belongs to. That is structural —
// you read it from the shape of the line, not from a badge — and it makes the one fact a list
// cannot state visible for free: a route nobody has reached is a lane with NO stations on it.
//
// WHAT a lane means is the SURFACE's, not this module's (decided 2026-08-10, when Word mode's
// board moved off semantic roads). The sentence map's lanes are the #115 road clusters; Word
// mode's are the five RARITY GRADES (#163). Both draw the same line, so the geometry lives
// here and the PALETTE is a parameter — `LANE_COLORS` is the default because the route map is
// the surface that owns those hues, not because the drawing knows what a lane is.
//
// Geometry lives here because the node positions and the CSS gradient that paints the lines
// have to agree exactly. Lane centres are `LANE_X0 + road * LANE_GAP`, so a LANE_W line is the
// band [x - LANE_W/2, x + LANE_W/2] and the rail column is exactly wide enough for the outer
// two — the gradient's last band lands inside it and the next one falls outside, clipped.
const LANE_GAP = 22;
const LANE_X0 = 15.5;
const LANE_W = 5;
// Past this many roads the bundle TIGHTENS instead of widening (2026-08-07, when ROAD_KS went
// to 6). The rail takes its width from the WORD column, and below ~360px there is none to
// give: at six lanes the rail ran 141px against 97, which left ~67px of word column on a 320px
// screen and wrapped a 9-letter station mid-word (`boisemen`/`t`) — fitWord floors at
// WORD_MIN_PX, so past that floor the overflow has nowhere to go. Mid-word breaks are the one
// thing that module exists to prevent, so the lanes give way instead of the type: the bundle
// spans the same LANE_SPAN whatever the road count, and only the gap between lanes closes
// (22px at <= 4 roads, 16.5 at five, 13.2 at six — still 8px of gap between 5px lines).
const LANE_BUNDLE_FULL = 4;
const LANE_SPAN = (LANE_BUNDLE_FULL - 1) * LANE_GAP;

// The gap between two lane centres, for a rail of `lanes` roads. EVERY consumer of a lane
// position goes through this, so the gradient that paints the lanes and the nodes that sit on
// them cannot disagree about where a lane is — which is the whole reason the geometry lives in
// one module (see the note above LANE_GAP).
function laneGap(lanes: number): number {
  return lanes <= LANE_BUNDLE_FULL ? LANE_GAP : LANE_SPAN / (lanes - 1);
}
// One color per lane, as vivid as the rest of the app — a metro line's whole point is that you
// can tell it from the next one at a glance. The hues are lifted from the progress ramp's own
// stops (`shared/progressColor.ts`), four of them far apart, so the map speaks the app's palette
// instead of inventing one; they are COPIED rather than imported, because that ramp means
// "progress" and these mean "identity". Ordered so the common 2- and 3-road cases get the
// widest-apart hues, and pink (never cyan) leads: lane A always holds rank 1, and cyan is what
// the heat ramp paints a rank-1 number, so leading with it would imply a rule that isn't one.
// Gold is "you" and blue is solved, so no lane may borrow either. ROAD_KS caps roads at 6.
// Exported for the drift guard in laneColors.test.ts, which pins each to the stop it was taken
// from — pink 70, cyan 30, violet 90, green 40, coral 60, magenta 80. (That guard immediately
// caught the violet as #883beb where its stop is #883ceb: a one-off in the transcription,
// invisible on screen but exactly the kind of thing "copied, not imported" can hide forever.)
//
// Lanes 5 and 6 arrived 2026-08-07 with the widened ROAD_KS, and the FIRST FOUR ARE UNCHANGED
// on purpose: every map that forks 4 ways or fewer renders exactly as it did. Only three ramp
// stops were left to choose from, and the pair was measured rather than eyeballed — coral +
// magenta hold a minimum CIE76 ΔE of 36.9 across the whole set, where either pairing with
// indigo collapses to 15.3 (indigo sits right on top of violet). ΔE is why magenta is here
// despite reading "pinkish" in the abstract: against pink it is 40+, against violet 36.9.
// (The onboarding's theme clouds used to paint each theme in these too, until the themes
// ending was retired on 2026-08-11.)
export const LANE_COLORS = ['#ef4f97', '#2ad2eb', '#883ceb', '#23dc91', '#ee674e', '#db24c8'];

export function laneX(road: number, lanes: number): number {
  return LANE_X0 + road * laneGap(lanes);
}

// Where the trunk runs: the middle of the lane bundle, so the fork and the merge are symmetric.
export function trunkX(lanes: number): number {
  return LANE_X0 + ((lanes - 1) * laneGap(lanes)) / 2;
}

// The colour a station's node and word take: its own lane's, or the trunk's where the station
// belongs to no route at all. A dark node on a vivid lane reads as the line being BROKEN, where
// the lane's own colour reads as a stop with no name on it yet — which is what an unfound
// station is.
export function laneColor(lane: number | null, colors: readonly string[] = LANE_COLORS): string {
  return lane === null ? 'var(--rail)' : colors[lane % colors.length];
}

// The rail's lines, as one gradient: a hard-stop band per lane, in that lane's tint. Built here
// (not in CSS) because the number of lanes is data — and because painting every lane in one
// background is what lets a single element carry a whole cross-section of the line.
function laneLines(lanes: number, colors: readonly string[]): string {
  const stops: string[] = [];
  for (let lane = 0; lane < lanes; lane += 1) {
    const color = colors[lane % colors.length];
    const from = laneX(lane, lanes) - LANE_W / 2;
    stops.push(`transparent ${from}px, ${color} ${from}px, ${color} ${from + LANE_W}px`);
    stops.push(`transparent ${from + LANE_W}px`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

// The junction's bus — the horizontal run the lanes elbow along to reach the trunk. Painted in
// the LANES' colors, split at the trunk, not in one neutral bar: a single grey bar at each end of
// a set of parallel lines reads as a frame drawn AROUND them, where two colored halves read as
// what they are, the outer lanes turning in toward the trunk. With more than three roads the
// inner lanes' elbows hide under the outer ones, which is what overlapping tracks do anyway.
function busGradient(lanes: number, split: number, colors: readonly string[]): string {
  const left = colors[0];
  const right = colors[(lanes - 1) % colors.length];
  const at = `${(split * 100).toFixed(2)}%`;
  return `linear-gradient(90deg, ${left} 0 ${at}, ${right} ${at} 100%)`;
}

// How many glyphs the rank gutter has to hold: the exponent's digits plus its leading `-`.
//
// It takes the widest rank the MAP can ever produce, never the widest currently DRAWN (fixed
// 2026-08-06). The gutter track is `minmax(var(--gutter), max-content)`, so sizing it to the
// line as it stands means the first guess that lands a wider exponent — a 4-digit rank on a
// board whose field ends at CLAIM_ZONE — widens the track and shoves the whole line, rail and lanes
// and words, one glyph to the right. The exponent that arrives is a REPORT on a guess; it must
// not move the map the player is reading. Reserved up front the width is a property of the
// puzzle, so it is fixed for the round and nothing shifts. It costs one glyph of gutter on a
// board that never shows a wide rank, which is the whole price of the anticipation.
export function rankGutterChars(maxRank: number): number {
  return 1 + String(Math.max(1, Math.floor(maxRank))).length;
}

// Every CSS variable the drawing needs, for a line of `lanes` roads whose widest exponent is
// `rankChars` glyphs wide. One function, so the two surfaces cannot compute a rail width, a bus
// split or a dash unit differently — the rail column, the gradients that paint it and the
// heights measured against it all derive from the same three numbers.
//
// The rank gutter's char COUNT is baked in as a literal while the cell size stays a CSS
// variable, so the gutter tracks the responsive `--rank-size` without any calc having to divide
// by a custom property. (`--gutter` is only the FALLBACK template — `.route` is one grid and
// each row a subgrid of it, so the real gutter is `max-content` across every row at once.)
export function routeFrameVars(
  lanes: number,
  rankChars: number,
  colors: readonly string[] = LANE_COLORS,
): CSSProperties {
  const railWidth = LANE_X0 * 2 + (lanes - 1) * laneGap(lanes);
  const trunk = trunkX(lanes);
  const busX = laneX(0, lanes) - LANE_W / 2;
  const busW = (lanes - 1) * laneGap(lanes) + LANE_W;
  return {
    '--gutter': `calc(var(--rank-size) * ${rankChars} + 10px)`,
    '--railw': `${railWidth}px`,
    '--trunk-x': `${trunk}px`,
    '--bus-x': `${busX}px`,
    '--bus-w': `${busW}px`,
    '--bus-grad': busGradient(lanes, (trunk - busX) / busW, colors),
    '--lane-lines': laneLines(lanes, colors),
    '--stick-inset': `${STICK_INSET}px`,
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

// The trunk splitting into lanes (and, flipped, the lanes merging into the word). Orthogonal
// only — a trunk stub, a bus across the lanes, then the lanes themselves. Unlabelled: the shape
// IS the statement, and naming it added a word the map does not need.
export function Junction({ height, converge }: { height: number; converge?: boolean }) {
  return (
    <div className={`route-station route-junction${converge ? ' converge' : ''}`} style={{ height }}>
      <span className="route-rank" />
      <span className="route-rail jx">
        <i className="jx-trunk" />
        <i className="jx-bus" />
        <i className="jx-lanes" />
      </span>
      <span className="route-body" />
    </div>
  );
}

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

// The connector between two rows. `lanes` paints it in the roads' colours rather than the
// trunk's — a link inside the forked stretch is as many lines as there are roads.
// `broken` draws it as the tail's dashed trace instead of a solid run — the history modal's
// behind-the-departure stretch, where the line is not yet the journey. A broken height must
// be `dashedRun`-snapped by the caller, or the last unit is cut wherever it falls.
export function RouteLink({
  height,
  lanes = false,
  broken = false,
}: {
  height: number;
  lanes?: boolean;
  broken?: boolean;
}) {
  return (
    <div
      className={`route-link${lanes ? ' lanes' : ''}${broken ? ' broken' : ''}`}
      style={{ height }}
    />
  );
}

// One ROW of the line: the rank in its right-aligned gutter (the "time"), the rail with this
// row's node on it, then the word cell. All three name their grid column in CSS, which is what
// makes the rail read as one unbroken line down the page.
export function RouteRow({
  rowRef,
  className = '',
  style,
  rank = null,
  onLane = false,
  children,
}: {
  // A surface's handle on a row it measures (the map's sticky "you are here").
  rowRef?: RefObject<HTMLDivElement | null>;
  className?: string;
  style?: CSSProperties;
  // The row's own distance: drawn as its heat-coloured exponent, and exposed as
  // `data-route-rank` so a surface can find the row again without re-deriving its position.
  // Null on the rows that have no distance of their own — a terminus, a junction.
  rank?: number | null;
  onLane?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      ref={rowRef}
      data-route-rank={rank ?? undefined}
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
      <span className={`route-rail${onLane ? ' lanes' : ''}`}>
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
