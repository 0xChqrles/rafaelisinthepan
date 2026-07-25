import { useCallback, useLayoutEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DQ_MAX, type RouteModel, type RouteStop } from '../game/route';
import { rankHeatColor, HIT_HEAT_CAP } from './Hole';
import { t, routeTitle, srRouteDestination, srRouteOffMap, srRouteStop } from '../i18n';
import CloseIcon from '../assets/icons/close.svg?react';

// The route map (#117): a hole's neighborhood drawn as a JOURNEY to the word.
//
// The axis is dq — the real distance the uniform ranks erase (#115) — so the shape of the
// neighborhood is the data's, not a layout's: the near groups spread out over the top of
// the map and the far field compresses below, because that is where those words actually
// are. The player's guesses are stops on it, the roads that fork before the destination
// are lanes, and a guess with no rank at all is off the map entirely, below the break.
//
// Nothing here is persisted or animated: the whole drawing is derived from the model
// (game/route.ts), so a guess landing while it is open just adds a stop.

// The distance axis, top (dq 255, the closest group) to bottom (dq 0, the farthest kept).
function y(dq: number): number {
  return (1 - dq / DQ_MAX) * 100;
}

// Lane centers, spread evenly across the map's width. One road ⇒ one central rail.
function laneX(index: number, roads: number): number {
  return roads > 1 ? ((index + 0.5) / roads) * 100 : 50;
}

// Where a stop rides: its own lane above the fork, the trunk below it (and everything on
// the trunk when the neighborhood has a single honest facet).
function stopX(stop: { road: number | null }, roads: number): number {
  return roads > 1 && stop.road !== null ? laneX(stop.road, roads) : 50;
}

// Which way a label leans off its node. Map labels, not captions: the OUTER lanes read
// inward — the first starts at its rail, the last ends at it — so a long word can never
// run off the edge of the map (where it would simply be clipped away and lost). Everything
// with room on both sides, the trunk included, stays centered under its node.
function labelSide(lane: number | null, roads: number): 'start' | 'end' | 'center' {
  if (lane === null || roads < 2) return 'center';
  if (lane === 0) return 'start';
  if (lane === roads - 1) return 'end';
  return 'center';
}

// Closer stops paint over farther ones (labels can meet where two lanes hold neighbours at
// nearly the same distance), and "you are here" always wins.
function stopLayer(rank: number, best = false): number {
  return best ? 600 : 500 - Math.min(rank, 499);
}

function pct(value: number): string {
  return `${value}%`;
}

// The map's own width, as CSS sees it (the frame is centered and capped).
const MAP_WIDTH = 'min(520px, 100vw - 40px)';
// Press Start 2P's advance width, in em. Used only to FIT the road name plates: the lanes
// share one font size, computed so the longest name fits its lane instead of being clipped
// mid-word — on a phone with three roads there is no size that fits every French word, and
// a clipped title reads as a different word, which is worse than a small one.
const GLYPH_EM = 1.37;
const LANE_NAME_MIN = 9;
const LANE_NAME_MAX = 14;

function laneNameFont(labels: (string | null)[], roads: number): string {
  // A censored plate is a fixed 68px block, so only the real names constrain the size.
  const longest = labels.reduce((n, label) => Math.max(n, label?.length ?? 0), 1);
  const perLane = `(${MAP_WIDTH} / ${roads} - 14px)`;
  return `clamp(${LANE_NAME_MIN}px, calc(${perLane} / ${(longest * GLYPH_EM).toFixed(2)}), ${LANE_NAME_MAX}px)`;
}

// A stop's plate: its canonical accented word (or the fixed-width redacted bar, which is
// how the unfound final approach shows a position without leaking a length) plus the rank
// exponent, in the heat the same number wore when it floated over the hole.
function Plate({ word, rank }: { word: string | null; rank: number }): ReactNode {
  return (
    <span className="route-plate">
      {word === null ? (
        <span className="route-redacted" />
      ) : (
        <span className="route-word">{word}</span>
      )}
      <sup
        className="route-rank"
        style={{ '--rank-color': rankHeatColor(rank, HIT_HEAT_CAP) } as CSSProperties}
      >
        -{rank}
      </sup>
    </span>
  );
}

export default function RouteModal({
  model,
  lang,
  onClose,
}: {
  model: RouteModel;
  lang: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const terminusRef = useRef<HTMLDivElement>(null);
  const hereRef = useRef<HTMLDivElement>(null);

  const roads = model.roads.length;
  const title = routeTitle(lang, model.number);
  const forkY = y(model.forkDq);
  // "You are here" — absent on a solved hole, where the place you reached IS the terminus.
  const best: RouteStop | undefined = model.stops.find((s) => s.best);
  // The frame of reference for the opening view: that frontier while playing, else the
  // closest place reached, so a post-mortem still opens on the end of the journey.
  const anchor: RouteStop | undefined = best ?? model.stops[0];

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    // Open on the frame that answers "how close am I, and what is left": the stretch
    // between the player's best stop and the destination, centered. Set directly (never
    // smooth-scrolled) — the map has no motion, and this is the view it opens in.
    const terminus = terminusRef.current;
    const anchor = hereRef.current ?? terminus;
    if (!terminus || !anchor) return;
    const middle = (terminus.getBoundingClientRect().top + anchor.getBoundingClientRect().top) / 2;
    const box = dialog.getBoundingClientRect();
    dialog.scrollTop += middle - (box.top + box.height / 2);
  }, []);

  const close = useCallback(() => dialogRef.current?.close(), []);

  return createPortal(
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events
    <dialog
      ref={dialogRef}
      className="route-dialog"
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        // A click on the dialog element itself is the margin around the map, not the map.
        if (e.target === dialogRef.current) close();
      }}
    >
      <div className="route-head">
        <span className="route-title">{title}</span>
        <button
          type="button"
          className="dialog-close route-close"
          aria-label={t(lang, 'ariaClose')}
          onClick={close}
        >
          <CloseIcon className="pixel-icon" aria-hidden />
        </button>
      </div>

      <div
        className="route-frame"
        aria-hidden="true"
        data-roads={roads}
        // A lane's share of the map, and the one font size at which every road name fits
        // it. Both bake their divisors as literals, so no calc() has to divide by a custom
        // property.
        style={
          {
            '--lane-max': `calc(${MAP_WIDTH} / ${roads} - 14px)`,
            '--lane-font': laneNameFont(
              model.roads.map((r) => r.label),
              roads,
            ),
          } as CSSProperties
        }
      >
        {/* The destination. Censored while the hole is open; the accented secret once it
            has been found — the map becomes the post-mortem of the route taken. */}
        <div className="route-terminus" ref={terminusRef}>
          <span className={`route-secret${model.solved ? ' found' : ''}`}>
            {model.secret ?? '?'}
          </span>
          <span className={`route-terminus-node${model.solved ? ' found' : ''}`} />
        </div>

        {/* The identity leap: between the closest measurable group and the word itself
            there is no step, only a jump. It gets its own gap, and a broken trace. */}
        <div className="route-gap">
          <span className="route-leap" />
          {roads > 1 && (
            <span
              className="route-bus route-converge"
              style={{ left: pct(laneX(0, roads)), width: pct(laneX(roads - 1, roads) - laneX(0, roads)) }}
            />
          )}
          {model.roads.map((road, i) => (
            <div key={road.id} className="route-lane-head" style={{ left: pct(laneX(i, roads)) }}>
              <span className="route-lane-stub" />
              {road.label === null ? (
                <span className="route-lane-name censored">
                  <span className="route-redacted wide" />
                </span>
              ) : (
                <span className="route-lane-name">{road.label}</span>
              )}
            </div>
          ))}
        </div>

        {/* The distance axis itself: the lanes above the fork, one trunk below it. */}
        <div className="route-band">
          {roads > 1 ? (
            <>
              {model.roads.map((road, i) => (
                <span
                  key={road.id}
                  className="route-rail"
                  style={{ left: pct(laneX(i, roads)), top: 0, height: pct(forkY) }}
                />
              ))}
              <span
                className="route-bus"
                style={{
                  left: pct(laneX(0, roads)),
                  width: pct(laneX(roads - 1, roads) - laneX(0, roads)),
                  top: pct(forkY),
                }}
              />
              <span
                className="route-rail"
                style={{ left: '50%', top: pct(forkY), height: pct(100 - forkY) }}
              />
            </>
          ) : (
            <span className="route-rail" style={{ left: '50%', top: 0, height: '100%' }} />
          )}

          {best && <span className="route-here" style={{ top: pct(y(best.dq)) }} />}

          {model.hidden.map((group) => (
            <div
              key={group.rank}
              className="route-stop censored"
              data-side={labelSide(group.road, roads)}
              style={{
                left: pct(stopX(group, roads)),
                top: pct(y(group.dq)),
                zIndex: stopLayer(group.rank),
              }}
            >
              <span className="route-node" />
              <Plate word={null} rank={group.rank} />
            </div>
          ))}

          {model.stops.map((stop) => (
            <div
              key={stop.rank}
              ref={stop === anchor ? hereRef : undefined}
              className={`route-stop${stop.best ? ' here' : ''}${stop.start ? ' start' : ''}`}
              data-side={labelSide(stop.road, roads)}
              style={{
                left: pct(stopX(stop, roads)),
                top: pct(y(stop.dq)),
                zIndex: stopLayer(stop.rank, stop.best),
              }}
            >
              <span className="route-node" />
              <Plate word={stop.word} rank={stop.rank} />
            </div>
          ))}
        </div>

        {/* Past the cold end of the scale, the words that earned no rank at all. */}
        <div className="route-shelf">
          <span className="route-break" />
          {model.misses.length > 0 && (
            <>
              <p className="route-shelf-head">{t(lang, 'routeOffMap')}</p>
              <p className="route-misses">
                {model.misses.map((word) => (
                  <span key={word} className="route-miss">
                    {word}
                  </span>
                ))}
              </p>
            </>
          )}
        </div>
      </div>

      {/* The drawing is decorative; this is the map in words — closest first, misses last. */}
      <ol className="sr-only">
        <li>{srRouteDestination(lang, model.secret)}</li>
        {[
          ...model.stops.map((stop) => ({ rank: stop.rank, stop })),
          ...model.hidden.map((group) => ({ rank: group.rank, stop: null, group })),
        ]
          .sort((a, b) => a.rank - b.rank)
          .map(({ rank, stop }) => (
            <li key={rank}>
              {srRouteStop(lang, {
                rank,
                word: stop ? stop.word : null,
                road:
                  stop && stop.road !== null && roads > 1 ? model.roads[stop.road].label : null,
                start: stop?.start,
                best: stop?.best,
              })}
            </li>
          ))}
        {model.misses.length > 0 && <li>{srRouteOffMap(lang, model.misses)}</li>}
      </ol>
    </dialog>,
    document.body,
  );
}
