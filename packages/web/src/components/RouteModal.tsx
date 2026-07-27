import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { DQ_MAX, type RouteModel } from '../game/route';
import { rankHeatColor, HIT_HEAT_CAP } from './Hole';
import {
  t,
  routeTitle,
  srRouteDestination,
  srRouteOffMap,
  srRouteRoads,
  srRouteStop,
} from '../i18n';
import ModalHeader from './ModalHeader';
import useModalDismiss from '../hooks/useModalDismiss';

// The route map (#117): a hole's neighborhood drawn as a LINE you travel.
//
// The line runs DOWN, departure to arrival, like a trip: the cold end at the top (past a break,
// the guesses that earned no rank at all), then every station you have reached, farthest first,
// and the word itself at the bottom. It opens scrolled to that bottom, because the end of the
// line is where the two questions live — how close am I, what is left.
//
// Redesigned 2026-07-26 — the first version was a to-scale map: `dq` straight onto absolute
// positions over four viewport heights. It was honest and unreadable. dq's real shape is a
// steep near field and a very long cold tail (rank 1 sits at 255, the start word around 120,
// rank 10 000 at 0), so a linear map spends most of its height on emptiness: the departure
// landed two screens below the destination with nothing in between.
//
// So the geometry moved from POSITION to the LENGTH OF THE LINE BETWEEN STATIONS. It is the
// same information — dq differences, which is all dq means — but every station now costs a
// row, so the whole journey is one screen instead of four and the order it reads in is the
// order it is drawn in. Long stretches still read as long, just bounded (LINK_MAX).
//
// Nothing here is persisted, and the LINE is not animated — the only motion is the map arriving
// and leaving: it zooms out of the tapped word (`route-zoom`) and retracts back into it
// (`route-zoom-out`). That is the transition into and out of the map, not part of the drawing.
// The whole drawing is derived from the model (game/route.ts), so a guess landing while it is
// open just adds a station.

// A connector carries the distance between the two stations it joins: `LINK_SPAN` px per full
// dq scale, floored so two neighbours never collide and capped so the cold tail cannot push the
// destination off screen. The floor and the cap are what make this a line and not a map.
const LINK_MIN = 14;
const LINK_MAX = 92;
const LINK_SPAN = 300;
// The two broken traces are drawn from ONE repeating unit: DASH px of line, then DASH_GAP px of
// nothing. It is handed to CSS as well (`--dash`, `--dash-period`), because the gradient that
// paints the unit and the heights that have to be a whole number of it cannot be allowed to
// disagree.
const DASH = 5;
const DASH_GAP = 8;
const DASH_PERIOD = DASH + DASH_GAP;
// A dashed run is a whole number of units PLUS its closing dash. Any other height cuts the last
// unit wherever it happens to fall, and the stub lands exactly where the trace meets the solid
// rail — a 3px sliver of gap against a station reads as a rendering slip, not as a broken line.
// Snapped, both ends are clean: the run opens on a full dash and closes on one.
const dashedRun = (px: number) =>
  Math.max(1, Math.round((px - DASH) / DASH_PERIOD)) * DASH_PERIOD + DASH;

// The identity leap (#115): between the closest measurable group and the word itself there is
// no step, only a jump. Fixed height, broken trace — it is not a distance.
const LEAP_H = dashedRun(56); // 57
// The cold end of the line, above the first station: it always continues into the words that
// have no distance at all, whether or not this round produced any.
const TAIL_H = dashedRun(34); // 31
// Where the trunk splits into lanes, and where they merge back into the word. Its own fixed
// minimum, since it draws a shape rather than a gap.
const JUNCTION_H = 34;
// How far short of the screen edge the "you are here" row parks — flush against it reads as
// clipped rather than pinned. It is one number in three places (the CSS offsets, the opening
// scroll and the parked test), so it is declared here and handed to CSS as `--stick-inset`.
const STICK_INSET = 8;
// One pixel of slack before the row counts as parked. The opening view lands it EXACTLY on the
// bottom threshold by design (that is what "a few pixels short of the edge" means), so a bare
// comparison there is decided by sub-pixel noise — scrollTop is fractional on a non-integer device
// ratio, clientHeight is rounded — and a coin toss between "where it lives" and "parked" is a
// separator flickering into the opening view.
const STICK_SLACK = 1;

// A word you have not found — the destination, or a station of the censored final approach.
// FIXED width: a placeholder that grew with the word would leak its length.
const UNKNOWN = '???';

// --- lanes -----------------------------------------------------------------------------
// The roads (#115) are drawn as LANES of the rail, the way a metro line draws its branches:
// which lane a station sits on is its road. That is structural — you read it from the shape of
// the line, not from a badge — and it makes the one fact a list cannot state visible for free:
// a road nobody has reached is a lane with NO stations on it.
//
// Geometry lives here because the node positions and the CSS gradient that paints the lines
// have to agree exactly. Lane centres are `LANE_X0 + road * LANE_GAP`, so a LANE_W line is the
// band [x - LANE_W/2, x + LANE_W/2] and the rail column is exactly wide enough for the outer
// two — the gradient's last band lands inside it and the next one falls outside, clipped.
const LANE_GAP = 22;
const LANE_X0 = 15.5;
const LANE_W = 5;
// One color per lane, as vivid as the rest of the app — a metro line's whole point is that you
// can tell it from the next one at a glance. The hues are lifted from the progress ramp's own
// stops (`shared/progressColor.ts`), four of them far apart, so the map speaks the app's palette
// instead of inventing one; they are COPIED rather than imported, because that ramp means
// "progress" and these mean "identity". Ordered so the common 2- and 3-road cases get the
// widest-apart hues, and pink (never cyan) leads: lane A always holds rank 1, and cyan is what
// the heat ramp paints a rank-1 number, so leading with it would imply a rule that isn't one.
// Gold is "you" and blue is solved, so no lane may borrow either. ROAD_KS caps roads at 4.
// Exported for the drift guard in laneColors.test.ts, which pins each to the stop it was taken
// from — pink 70, cyan 30, violet 90, green 40. (That guard immediately caught the violet as
// #883beb where its stop is #883ceb: a one-off in the transcription, invisible on screen but
// exactly the kind of thing "copied, not imported" can hide forever.)
export const LANE_COLORS = ['#ef4f97', '#2ad2eb', '#883ceb', '#23dc91'];

function laneX(road: number): number {
  return LANE_X0 + road * LANE_GAP;
}

// The rail's lines, as one gradient: a hard-stop band per lane, in that lane's tint. Built here
// (not in CSS) because the number of lanes is data — and because painting every lane in one
// background is what lets a single element carry a whole cross-section of the line.
function laneLines(lanes: number): string {
  const stops: string[] = [];
  for (let road = 0; road < lanes; road += 1) {
    const color = LANE_COLORS[road % LANE_COLORS.length];
    const from = laneX(road) - LANE_W / 2;
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
function busGradient(lanes: number, split: number): string {
  const left = LANE_COLORS[0];
  const right = LANE_COLORS[(lanes - 1) % LANE_COLORS.length];
  const at = `${(split * 100).toFixed(2)}%`;
  return `linear-gradient(90deg, ${left} 0 ${at}, ${right} ${at} 100%)`;
}

function linkHeight(dqA: number, dqB: number): number {
  const span = (Math.abs(dqA - dqB) / DQ_MAX) * LINK_SPAN;
  return Math.round(Math.min(LINK_MAX, Math.max(LINK_MIN, span)));
}

// The word column's own width is known in CSS (`--wordw`), and Press Start 2P advances
// EXACTLY 1em per glyph — measured, not assumed — so the size at which a word fits its column
// is arithmetic: width / length. A long French compound therefore shrinks a little instead of
// breaking mid-word (`incontestableme/nt` reads as a different word) or running off the map.
// The divisor is baked as a literal rather than passed as a custom property, so no calc() has
// to divide by a var. Below the floor the CSS `overflow-wrap` still catches it.
const WORD_MIN_PX = 8;
function fitWord(word: string, max: number): string {
  return `clamp(${WORD_MIN_PX}px, calc(var(--wordw) / ${Math.max(1, word.length)}), ${max}px)`;
}
// Type sizes per station state: the destination reads as a headline, "you are here" a step
// above the rest of the line, everything else at the line's own size.
const ARRIVAL_PX = 24;
const HERE_PX = 17;
const STATION_PX = 15;

// One row of the line, FARTHEST first. `hidden` stations are real positions with the word
// withheld; the model hands them over separately and they interleave by rank.
type Station =
  | {
      hidden: false;
      rank: number;
      dq: number;
      word: string;
      road: number | null;
      start: boolean;
      best: boolean;
    }
  | { hidden: true; rank: number; dq: number; road: number | null; word: string | null };

function stationsOf(model: RouteModel): Station[] {
  const rows: Station[] = [
    ...model.stops.map((s) => ({ hidden: false as const, ...s })),
    ...model.hidden.map((h) => ({ hidden: true as const, ...h })),
  ];
  // Descending rank: the line is travelled, so the far end comes first and the word is last.
  return rows.sort((a, b) => b.rank - a.rank);
}

// The trunk splitting into lanes (and, flipped, the lanes merging into the word). Orthogonal
// only — a trunk stub, a bus across the lanes, then the lanes themselves. Unlabelled: the shape
// IS the statement, and naming it added a word the map does not need.
function Junction({ height, converge }: { height: number; converge?: boolean }) {
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

export default function RouteModal({
  model,
  lang,
  origin,
  onClose,
}: {
  model: RouteModel;
  lang: string;
  // The point the map grows out of — the tapped word's centre in viewport coordinates, which
  // are the dialog's own (fixed, inset 0). Null falls back to the centre of the screen.
  origin?: { x: number; y: number } | null;
  onClose: () => void;
}) {
  // FIRST hook of the component on purpose: it owns the `showModal()` layout effect, and a
  // closed `<dialog>` is `display: none` — everything measured below would read a tree with no
  // boxes (see the measuring effects). It also takes opening focus to the dialog rather than to
  // the header's close chip, and turns every dismissal into the retraction beat.
  const { dialogRef, closing, beginClose, dialogProps } = useModalDismiss('route-zoom-out');
  const scrollRef = useRef<HTMLDivElement>(null);
  const hereRef = useRef<HTMLDivElement>(null);
  // Where the "you are here" row sits in the LINE, as opposed to where it is parked. Measured
  // rather than derived because only the DOM knows how tall every row above it came out.
  const naturalRef = useRef<{ top: number; height: number } | null>(null);
  // Which edge it is currently parked against, if any — the row is the one thing on the map that
  // can be somewhere it does not belong, and that has to be visible (see `.route-you.stuck-*`).
  const [stuck, setStuck] = useState<'top' | 'bottom' | null>(null);
  const title = routeTitle(lang, model.number);
  const stations = stationsOf(model);

  // A single road is generation's honest fallback for a neighborhood with no fork (#115): one
  // lane IS the trunk, and no junction is drawn.
  const lanes = model.roads.length;
  // Roads only exist from the departure in to the word, so in descending-rank order the stations
  // that have one are a contiguous tail — the fork goes right before the first of them, which on
  // an untouched map is the departure itself.
  const forkAt = stations.findIndex((s) => s.road !== null);
  const forked = lanes > 1 && forkAt >= 0;

  // The near field's population per road, and how much of it the player has reached — what the
  // full roads were drawn to SHOW, and so what the screen-reader mirror has to state in words.
  const nearPerRoad = Array.from({ length: lanes }, () => 0);
  let nearFound = 0;
  for (const station of stations) {
    if (station.road === null) continue;
    nearPerRoad[station.road] = (nearPerRoad[station.road] ?? 0) + 1;
    if (!station.hidden) nearFound += 1;
  }

  // Closest-first, and only what has a word to announce (see the sr-only list below).
  const spoken = [...stations].reverse().filter((s) => !s.hidden || s.word !== null);

  // The rank gutter fits the widest exponent this line actually shows, rather than the widest a
  // TOP_K map could ever produce: stations are farthest-first, so the first one names it. The char
  // COUNT is baked in as a literal and the cell size stays a CSS variable, so the gutter tracks the
  // responsive `--rank-size` without any calc having to divide by a custom property.
  const rankChars = 1 + String(stations[0]?.rank ?? 1).length;

  const railWidth = LANE_X0 * 2 + (lanes - 1) * LANE_GAP;
  const trunkX = LANE_X0 + ((lanes - 1) * LANE_GAP) / 2;
  const busX = laneX(0) - LANE_W / 2;
  const busW = (lanes - 1) * LANE_GAP + LANE_W;
  const frame = {
    '--gutter': `calc(var(--rank-size) * ${rankChars} + 10px)`,
    '--railw': `${railWidth}px`,
    '--trunk-x': `${trunkX}px`,
    '--bus-x': `${busX}px`,
    '--bus-w': `${busW}px`,
    '--bus-grad': busGradient(lanes, (trunkX - busX) / busW),
    '--lane-lines': laneLines(lanes),
    '--stick-inset': `${STICK_INSET}px`,
    // The dash unit the leap and the tail are cut to (see dashedRun): the gradient paints it,
    // the heights count it, so both read it from here.
    '--dash': `${DASH}px`,
    '--dash-period': `${DASH_PERIOD}px`,
    // Where the opening zoom starts. Omitted when the word could not be located, so the CSS
    // fallback (dead centre) takes over rather than an origin of 0,0 throwing it to a corner.
    ...(origin ? { '--zoom-x': `${origin.x}px`, '--zoom-y': `${origin.y}px` } : null),
  } as CSSProperties;

  // Where is the row parked, if it is parked at all? Pure arithmetic against the scroll offset —
  // asking the DOM would be circular, since a sticky box reports the parked position either way.
  const readStuck = useCallback(() => {
    const scroller = scrollRef.current;
    const natural = naturalRef.current;
    if (!scroller || !natural) return;
    const top = scroller.scrollTop;
    if (top > natural.top - STICK_INSET + STICK_SLACK) setStuck('top');
    else if (
      top + scroller.clientHeight + STICK_SLACK <
      natural.top + natural.height + STICK_INSET
    ) {
      setStuck('bottom');
    } else setStuck(null);
  }, []);

  // Everything below MEASURES, so it all depends on the dialog already being open — which is
  // why `useModalDismiss` is called first (a closed `<dialog>` is `display: none` and has no
  // boxes at all, so a row's offsetTop, its offsetHeight and the scrollport's clientHeight all
  // read 0 — not a small error but a total one: a natural position of 0 makes every scroll
  // offset test as "parked at the top", so the torn separator draws under the row for the
  // modal's whole life and the opening scroll clamps to the top of the line). Dev hides it:
  // StrictMode re-runs layout effects after mount, by which time the dialog is open, so it only
  // ever showed in a build.

  // The row's place IN the line, re-measured whenever the model changes — a guess landing while
  // the map is open can add rows above it, or make a different station the closest one. Suspending
  // the stickiness is what makes the read honest (see the opening scroll below).
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const here = hereRef.current;
    if (!scroller || !here) {
      naturalRef.current = null;
      setStuck(null);
      return;
    }
    here.style.position = 'static';
    naturalRef.current = { top: here.offsetTop - scroller.offsetTop, height: here.offsetHeight };
    here.style.position = '';
    readStuck();
  }, [model, readStuck]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return undefined;
    // Cheap: arithmetic per event, and setStuck bails out on an unchanged value, so the ~100-row
    // list only re-renders on an actual transition.
    scroller.addEventListener('scroll', readStuck, { passive: true });
    return () => scroller.removeEventListener('scroll', readStuck);
  }, [readStuck]);

  useLayoutEffect(() => {
    // Open on the closest word you have reached, sitting at the BOTTOM of the screen: the ground
    // you have covered fills the view above it, and everything still ahead — the words closer than
    // yours, and the destination — waits just below the fold. A solved hole has no "here", so it
    // opens on the terminus instead.
    //
    // Its place in the line was measured just above, with the stickiness suspended: a sticky box
    // reports its PARKED position — offsetTop and its rect alike — so at scrollTop 0 it has
    // already pinned itself to the bottom and measuring it there just hands back the viewport
    // height. Both reads live in layout effects, i.e. synchronous work before the browser paints.
    // Set directly, never smooth-scrolled — the map has no motion, and this is the view it opens
    // in. The browser clamps the result into the scroll range.
    const scroller = scrollRef.current;
    if (!scroller) return;
    const natural = naturalRef.current;
    scroller.scrollTop = natural
      ? natural.top + natural.height - scroller.clientHeight + STICK_INSET
      : scroller.scrollHeight;
    readStuck();
  }, [readStuck]);

  // Closing RETRACTS into the word, the same zoom run backwards — the map goes back where it
  // came from, so the sentence underneath is somewhere you returned to rather than somewhere
  // you were dropped. `useModalDismiss` above owns that beat (and the fact that the ONLY way
  // out is the header's close chip: tapping the map's own margin does nothing since
  // 2026-07-27).
  //
  // The origin does not need re-measuring: while the map is open the input is gated
  // (`WordInput active`) and the keyboard is behind it, so no guess can land and the word it
  // grew out of cannot have moved.
  return createPortal(
    <dialog
      {...dialogProps}
      className={`route-dialog${closing ? ' closing' : ''}`}
      style={frame}
      aria-label={title}
      onClose={onClose}
    >
      {/* The shared modal chrome (see ModalHeader): the app's own corner-chip row, in flow
          above the scroller — which is what lets it paint nothing. */}
      <ModalHeader lang={lang} title={title} onClose={beginClose} />

      <div className="route-scroll" ref={scrollRef}>
        {/* The drawing is decorative; the sr-only list below carries the same content. */}
        <div className="route" aria-hidden="true">
          {/* Before the line even starts: the guesses that earned no rank at all. Beyond the
              top-K there is no distance left to draw, and that IS the mechanic. */}
          {model.misses.length > 0 && (
            <div className="route-shelf">
              <p className="route-shelf-head">{t(lang, 'routeOffMap')}</p>
              <p className="route-misses">
                {model.misses.map((word) => (
                  <span key={word} className="route-miss">
                    {word}
                  </span>
                ))}
              </p>
              <span className="route-break" />
            </div>
          )}
          {/* The line always comes in out of that void, whether or not this round hit it. */}
          <div className="route-link tail" style={{ height: TAIL_H }} />

          {stations.map((station, i) => {
            const previous = stations[i - 1];
            // Consecutive ranks are ONE row apart, whatever their dq. With every near-field group
            // drawn the rank ladder itself already says they are adjacent, so a proportional
            // connector in there buys nothing and costs one glaring outlier: dq pins rank 1 at the
            // top of its scale, so 1 and 2 are always further apart than any other neighbours. The
            // length stays proportional wherever the line SKIPS ranks — the trunk, where it is the
            // only thing carrying the distance at all.
            const gap = !previous
              ? 0
              : previous.rank - station.rank === 1
                ? LINK_MIN
                : linkHeight(previous.dq, station.dq);
            // A censored station shows `???` while the round is live, and its real word once the
            // hole is solved — the map is then the post-mortem of the whole neighborhood.
            const label = station.hidden ? station.word ?? UNKNOWN : station.word;
            const revealed = station.hidden && station.word !== null;
            const onLane = forked && station.road !== null;
            return (
              <Fragment key={station.rank}>
                {forked && i === forkAt ? (
                  // The fork keeps its OWN fixed height and the distance rides in front of it as
                  // an ordinary trunk link. Folding the two together made the junction as tall as
                  // whatever gap preceded it, which left the first lane station sitting far below
                  // the bus while the merge at the other end hugged its last one — the two ends of
                  // the fork have to mirror each other.
                  <>
                    {previous && <div className="route-link" style={{ height: gap }} />}
                    <Junction height={JUNCTION_H} />
                  </>
                ) : (
                  previous && (
                    <div
                      className={`route-link${onLane ? ' lanes' : ''}`}
                      style={{ height: gap }}
                    />
                  )
                )}
                <div
                  ref={!station.hidden && station.best ? hereRef : undefined}
                  className={[
                    'route-station',
                    onLane ? 'on-lane' : '',
                    station.hidden ? 'route-unknown' : '',
                    revealed ? 'route-revealed' : '',
                    !station.hidden && station.best ? 'route-you' : '',
                    !station.hidden && station.best && stuck ? `stuck-${stuck}` : '',
                    !station.hidden && station.start ? 'route-departure' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={
                    {
                      '--node-x': `${onLane ? laneX(station.road!) : trunkX}px`,
                      // Its own line's color, so an UNFOUND station can be drawn in it: a dark
                      // node on a vivid lane reads as a gap in the line — as though the line
                      // were broken — where the lane's own color reads as a stop with no name
                      // on it yet, which is what it is. Found stations ignore this.
                      '--lane-c': onLane ? LANE_COLORS[station.road! % LANE_COLORS.length] : 'var(--rail)',
                    } as CSSProperties
                  }
                >
                  <span
                    className="route-rank"
                    style={
                      { '--rank-color': rankHeatColor(station.rank, HIT_HEAT_CAP) } as CSSProperties
                    }
                  >
                    -{station.rank}
                  </span>
                  <span className={`route-rail${onLane ? ' lanes' : ''}`}>
                    <i className="route-node" />
                  </span>
                  <span className="route-body">
                    <span
                      className="route-word"
                      style={{
                        fontSize: fitWord(
                          label,
                          !station.hidden && station.best ? HERE_PX : STATION_PX,
                        ),
                      }}
                    >
                      {label}
                    </span>
                  </span>
                </div>
              </Fragment>
            );
          })}

          {forked && <Junction height={JUNCTION_H} converge />}
          <div className="route-link leap" style={{ height: LEAP_H }} />

          {/* The end of the line. Censored while the hole is open, the accented secret in the
              solved-word blue once found — the same line then reads as the post-mortem. */}
          <div
            className={`route-station route-arrival${model.solved ? ' route-found' : ''}`}
            style={{ '--node-x': `${trunkX}px` } as CSSProperties}
          >
            <span className="route-rank" />
            <span className="route-rail">
              <i className="route-node" />
            </span>
            <span className="route-body">
              <span
                className="route-word"
                style={{ fontSize: fitWord(model.secret ?? UNKNOWN, ARRIVAL_PX) }}
              >
                {model.secret ?? UNKNOWN}
              </span>
            </span>
          </div>
        </div>
      </div>

      {/* The line in words. Closest FIRST here: a list has no "scrolled to the end", so it leads
          with what the drawing opens on. Only stations with a WORD are announced — the player's
          own stops always, plus the whole revealed neighborhood once solved. A still-censored
          station is a position and a lane, nothing a reader can act on, so while the round is live
          those ~100 are left to srRouteRoads' count rather than read out one at a time. */}
      <ol className="sr-only">
        <li>{srRouteDestination(lang, model.secret)}</li>
        <li>{srRouteRoads(lang, nearPerRoad, nearFound)}</li>
        {spoken.map((station) => (
          <li key={station.rank}>
            {srRouteStop(lang, {
              rank: station.rank,
              word: station.word,
              road: forked && station.road !== null ? model.roads[station.road].label : null,
              start: station.hidden ? false : station.start,
              best: station.hidden ? false : station.best,
            })}
          </li>
        ))}
        {model.misses.length > 0 && <li>{srRouteOffMap(lang, model.misses)}</li>}
      </ol>
    </dialog>,
    document.body,
  );
}
