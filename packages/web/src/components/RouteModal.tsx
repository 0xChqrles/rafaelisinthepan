import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { type RouteModel } from '../game/route';
import {
  ARRIVAL_PX,
  HERE_PX,
  JUNCTION_H,
  Junction,
  LEAP_H,
  OffMapShelf,
  RouteLink,
  RouteRow,
  RouteTail,
  RouteWord,
  STATION_PX,
  STICK_INSET,
  UNKNOWN,
  laneColor,
  laneX,
  linkGap,
  rankGutterChars,
  routeFrameVars,
  trunkX,
} from './routeDrawing';
import {
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
//
// The drawing itself is `RouteLine` (#155, see its own comment below): this modal is its one
// consumer — the tutorial's ending, which drew the line inline for a while, shows theme
// clouds and the routes teaser instead.

// The geometry, the constants and the row parts all live in `routeDrawing` — this modal is one
// of two surfaces that draw a route (Word mode's board is the other), so none of the drawing's
// vocabulary belongs to either of them. What is left here is the modal's own: the sticky "you
// are here" row and the plumbing that measures and parks it.

// One pixel of slack before the row counts as parked. The opening view lands it EXACTLY on the
// bottom threshold by design (that is what "a few pixels short of the edge" means), so a bare
// comparison there is decided by sub-pixel noise — scrollTop is fractional on a non-integer device
// ratio, clientHeight is rounded — and a coin toss between "where it lives" and "parked" is a
// separator flickering into the opening view.
const STICK_SLACK = 1;

// How far into the SCROLLED CONTENT a row sits — the one number the sticky row's natural place,
// the opening scroll and the parked test are all expressed in.
//
// It is computed from LAYOUT metrics, never from a rect: the dialog opens on a `route-zoom`
// transform, which scales every getBoundingClientRect while leaving offsetTop/offsetHeight/
// clientHeight untouched, so a rect read here would measure a box mid-zoom.
//
// And it has to WALK the offsetParent chain, because the scroller is NOT the row's offsetParent:
// `.route-frame` is positioned (it is the containing block for the sr-only mirror it carries) and
// so takes the job. The old `here.offsetTop - scroller.offsetTop` mixed two coordinate spaces the
// moment that wrapper appeared — the row's offset was already relative to the frame, so
// subtracting the scroller's own offset took off one HEADER too many (48px at phone widths, 56 on
// desktop): the opening scroll landed the row that far below the bottom edge, and both parked
// thresholds fired that far early. Walking is right whichever ancestor happens to be positioned,
// which is the whole point — the subtraction was correct until a refactor moved the positioning,
// and said nothing when it stopped being.
function offsetWithin(el: HTMLElement, scroller: HTMLElement): number {
  let top = 0;
  let node: HTMLElement | null = el;
  while (node && node !== scroller) {
    const parent = node.offsetParent as HTMLElement | null;
    if (!parent) break;
    if (scroller.contains(parent)) {
      // Still inside the scroller (`contains` counts the scroller itself), so this offset is
      // already measured against a box within the scrolled content.
      top += node.offsetTop;
      node = parent;
    } else {
      // The chain has left the scroller: `node` and the scroller are now measured against the
      // same ancestor, so their difference converts into the scroller's own space.
      top += node.offsetTop - scroller.offsetTop;
      break;
    }
  }
  return top;
}

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

// --- the line ---------------------------------------------------------------------------
// The LINE itself: the per-map drawing variables, the decorative drawing and its sr-only
// mirror, on the `.route-frame` wrapper that owns the drawing's CSS variables. Split from
// the modal shell (#155) so the shell is only the daily game's chrome — dialog, header,
// sticky plumbing (`hereRef`, `stuck`) — around a drawing that stands alone.
function RouteLine({
  model,
  lang,
  hereRef,
  stuck = null,
}: {
  model: RouteModel;
  lang: string;
  // The modal's handle on the "you are here" row — the one row it measures and parks.
  hereRef?: RefObject<HTMLDivElement | null>;
  stuck?: 'top' | 'bottom' | null;
}) {
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

  // The rank gutter is reserved for the widest exponent THIS MAP can produce (see
  // rankGutterChars), not the widest the line currently shows. It used to take the farthest
  // station drawn — stations are farthest-first, so `stations[0]` named it — which is stable
  // only while the map is closed: a guess landing at a wider rank than anything on the line
  // widened the track and shoved the whole drawing sideways under the player. The char COUNT is
  // still baked in as a literal while the cell size stays a CSS variable, so the gutter tracks
  // the responsive `--rank-size` without any calc having to divide by a custom property.
  const rankChars = rankGutterChars(model.maxRank);

  const trunk = trunkX(lanes);
  return (
    <div className="route-frame" style={routeFrameVars(lanes, rankChars)}>
      {/* The drawing is decorative; the sr-only list below carries the same content. */}
      <div className="route" aria-hidden="true">
        {/* Before the line even starts: the guesses that earned no rank at all. */}
        <OffMapShelf lang={lang} misses={model.misses} />
        <RouteTail />

        {stations.map((station, i) => {
          const previous = stations[i - 1];
          const gap = linkGap(previous, station);
          // A censored station shows `???` while the round is live, and its real word once the
          // hole is solved — the map is then the post-mortem of the whole neighborhood.
          const label = station.hidden ? station.word ?? UNKNOWN : station.word;
          const revealed = station.hidden && station.word !== null;
          // Sits ON a road, independent of whether the line FORKS (fixed 2026-08-07 — see the
          // same note in WordBoard). A single-road map is still a route and still wears its
          // colour; `forked` gates only the junctions, which need something to fork into.
          const onLane = station.road !== null;
          const here = !station.hidden && station.best;
          return (
            <Fragment key={station.rank}>
              {forked && i === forkAt ? (
                // The fork keeps its OWN fixed height and the distance rides in front of it as
                // an ordinary trunk link. Folding the two together made the junction as tall as
                // whatever gap preceded it, which left the first lane station sitting far below
                // the bus while the merge at the other end hugged its last one — the two ends of
                // the fork have to mirror each other.
                <>
                  {previous && <RouteLink height={gap} />}
                  <Junction height={JUNCTION_H} />
                </>
              ) : (
                previous && <RouteLink height={gap} lanes={onLane} />
              )}
              <RouteRow
                rowRef={here ? hereRef : undefined}
                rank={station.rank}
                onLane={onLane}
                className={[
                  onLane ? 'on-lane' : '',
                  station.hidden ? 'route-unknown' : '',
                  revealed ? 'route-revealed' : '',
                  here ? 'route-you' : '',
                  here && stuck ? `stuck-${stuck}` : '',
                  !station.hidden && station.start ? 'route-departure' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={
                  {
                    '--node-x': `${onLane ? laneX(station.road!, lanes) : trunk}px`,
                    '--lane-c': laneColor(onLane ? station.road : null),
                  } as CSSProperties
                }
              >
                <RouteWord word={label} max={here ? HERE_PX : STATION_PX} />
              </RouteRow>
            </Fragment>
          );
        })}

        {forked && <Junction height={JUNCTION_H} converge />}
        {/* The joined line's final run into the word: an ordinary SOLID trunk link. */}
        <RouteLink height={LEAP_H} />

        {/* The end of the line. Censored while the hole is open, the accented secret in the
            solved-word blue once found — the same line then reads as the post-mortem. */}
        <RouteRow
          className={`route-arrival${model.solved ? ' route-found' : ''}`}
          style={{ '--node-x': `${trunk}px` } as CSSProperties}
        >
          <RouteWord word={model.secret ?? UNKNOWN} max={ARRIVAL_PX} />
        </RouteRow>
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
    naturalRef.current = { top: offsetWithin(here, scroller), height: here.offsetHeight };
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
      // Where the opening zoom starts. Omitted when the word could not be located, so the CSS
      // fallback (dead centre) takes over rather than an origin of 0,0 throwing it to a corner.
      style={
        origin
          ? ({ '--zoom-x': `${origin.x}px`, '--zoom-y': `${origin.y}px` } as CSSProperties)
          : undefined
      }
      aria-label={title}
      onClose={onClose}
    >
      {/* The shared modal chrome (see ModalHeader): the app's own corner-chip row, in flow
          above the scroller — which is what lets it paint nothing. */}
      <ModalHeader lang={lang} title={title} onClose={beginClose} />

      <div className="route-scroll pixel-scroll" ref={scrollRef}>
        <RouteLine model={model} lang={lang} hereRef={hereRef} stuck={stuck} />
      </div>

    </dialog>,
    document.body,
  );
}
