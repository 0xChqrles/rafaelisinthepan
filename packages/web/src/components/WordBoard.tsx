import { Fragment } from 'react';
import type { CSSProperties } from 'react';
import type { WordBoardModel } from '../game/wordBoard';
import { rankHeatColor, HIT_HEAT_CAP } from './Hole';
import {
  Junction,
  LANE_COLORS,
  LANE_GAP,
  LANE_X0,
  LANE_W,
  laneX,
  laneLines,
  busGradient,
  linkHeight,
  fitWord,
  TAIL_H,
  LEAP_H,
  JUNCTION_H,
  LINK_MIN,
  UNKNOWN,
  ARRIVAL_PX,
  STATION_PX,
  DASH,
  DASH_PERIOD,
} from './RouteModal';
import { t, srRouteRoads, srRouteStop, srRouteOffMap, srWordBoardWord } from '../i18n';

// Word mode's play surface (#156): the route-map CONCEPT — lanes, dq-spaced stations,
// censored unfound stops — as the PRIMARY, LIVE surface, not the modal reused. The
// differences are the mode's own: the center word is PUBLIC (the terminus is revealed
// from the first frame), there is no departure and no "you are here", and the drawing
// changes under the player's claims — a claimed station gives up its word in its lane's
// color, and the run ending reveals the whole field (the post-mortem, like the solved
// route map).
//
// It reuses the route map's drawing grammar wholesale — the `.route-frame` / `.route-*`
// CSS and RouteModal's exported geometry helpers — so the two surfaces cannot drift
// apart visually. The line runs DOWN the page like the map does: the off-map strikes
// past a torn break at the top, then the near strikes riding the trunk, the fork, the
// zone farthest-first, and the day's word closing the line at the bottom.

// One row of the line, farthest first — either a zone station or a near strike on the
// trunk above the fork.
type Row =
  | { zone: true; rank: number; dq: number; road: number | null; word: string | null; claimed: boolean }
  | { zone: false; rank: number; dq: number; word: string };

export default function WordBoard({ model, lang }: { model: WordBoardModel; lang: string }) {
  const rows: Row[] = [
    ...model.outside.map((o) => ({ zone: false as const, ...o })),
    ...model.stations.map((s) => ({ zone: true as const, ...s })),
  ].sort((a, b) => b.rank - a.rank);

  const lanes = model.lanes;
  // The fork goes right before the first zone station (descending order) — the roads ARE
  // the zone, so on this board the whole censored field sits inside the fork.
  const forkAt = rows.findIndex((r) => r.zone);
  const forked = lanes > 1 && forkAt >= 0;

  // The near field's population per road and how much of it is claimed — what the sr
  // mirror states as a count (see the route map's srRouteRoads for why).
  const perRoad = Array.from({ length: lanes }, () => 0);
  let found = 0;
  for (const s of model.stations) {
    if (s.road === null) continue;
    perRoad[s.road] = (perRoad[s.road] ?? 0) + 1;
    if (s.claimed) found += 1;
  }

  // Closest-first, only what has a word to announce (claims, near strikes, and the whole
  // revealed field once the run ends).
  const spoken = [...rows].reverse().filter((r) => r.zone === false || r.word !== null);

  const rankChars = 1 + String(rows[0]?.rank ?? 1).length;
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
    '--dash': `${DASH}px`,
    '--dash-period': `${DASH_PERIOD}px`,
  } as CSSProperties;

  return (
    <div className="route-frame word-frame" style={frame}>
      {/* The drawing is decorative; the sr-only list below carries the same content. */}
      <div className="route" aria-hidden="true">
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
        <div className="route-link tail" style={{ height: TAIL_H }} />

        {rows.map((row, i) => {
          const previous = rows[i - 1];
          // Same connector rule as the route map: consecutive ranks are one row apart
          // whatever their dq (the zone is dense, so its rungs are uniform); where the
          // line SKIPS ranks — the trunk above the fork — the length carries the
          // distance, proportional.
          const gap = !previous
            ? 0
            : previous.rank - row.rank === 1
              ? LINK_MIN
              : linkHeight(previous.dq, row.dq);
          const onLane = forked && row.zone && row.road !== null;
          const label = row.zone ? (row.word ?? UNKNOWN) : row.word;
          const revealed = row.zone && !row.claimed && row.word !== null;
          return (
            <Fragment key={`${row.zone ? 'z' : 'o'}${row.rank}`}>
              {forked && i === forkAt ? (
                <>
                  {previous && <div className="route-link" style={{ height: gap }} />}
                  <Junction height={JUNCTION_H} />
                </>
              ) : (
                previous && (
                  <div className={`route-link${onLane ? ' lanes' : ''}`} style={{ height: gap }} />
                )
              )}
              <div
                data-word-rank={row.rank}
                className={[
                  'route-station',
                  onLane ? 'on-lane' : '',
                  row.zone && !row.claimed && !revealed ? 'route-unknown' : '',
                  revealed ? 'route-unknown route-revealed' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={
                  {
                    '--node-x': `${onLane && row.zone ? laneX(row.road!) : trunkX}px`,
                    '--lane-c':
                      onLane && row.zone && row.road !== null
                        ? LANE_COLORS[row.road % LANE_COLORS.length]
                        : 'var(--rail)',
                  } as CSSProperties
                }
              >
                <span
                  className="route-rank"
                  style={{ '--rank-color': rankHeatColor(row.rank, HIT_HEAT_CAP) } as CSSProperties}
                >
                  -{row.rank}
                </span>
                <span className={`route-rail${onLane ? ' lanes' : ''}`}>
                  <i className="route-node" />
                </span>
                <span className="route-body">
                  <span className="route-word" style={{ fontSize: fitWord(label, STATION_PX) }}>
                    {label}
                  </span>
                </span>
              </div>
            </Fragment>
          );
        })}

        {forked && <Junction height={JUNCTION_H} converge />}
        <div className="route-link" style={{ height: LEAP_H }} />

        {/* The end of the line: the day's word — PUBLIC, the one thing this board never
            censors. It wears the terminus size and the found (accent) face from frame
            one: the whole game is naming what leads to it. */}
        <div
          className="route-station route-arrival route-found"
          style={{ '--node-x': `${trunkX}px` } as CSSProperties}
        >
          <span className="route-rank" />
          <span className="route-rail">
            <i className="route-node" />
          </span>
          <span className="route-body">
            <span className="route-word" style={{ fontSize: fitWord(model.word, ARRIVAL_PX) }}>
              {model.word}
            </span>
          </span>
        </div>
      </div>

      {/* The board in words, closest first — the drawing above is decorative. */}
      <ol className="sr-only">
        <li>{srWordBoardWord(lang, model.word)}</li>
        <li>{srRouteRoads(lang, perRoad, found)}</li>
        {spoken.map((row) => (
          <li key={`${row.zone ? 'z' : 'o'}${row.rank}`}>
            {srRouteStop(lang, { rank: row.rank, word: row.word, road: null })}
          </li>
        ))}
        {model.misses.length > 0 && <li>{srRouteOffMap(lang, model.misses)}</li>}
      </ol>
    </div>
  );
}
