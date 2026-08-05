import { Fragment } from 'react';
import type { CSSProperties } from 'react';
import { heatColor } from '@whippin/shared';
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
// changes under the player's claims.
//
// **The whole FIELD is drawn, censored until it is claimed** (decided 2026-08-05,
// restoring the `???` census after a day without it): every group of the claimable zone
// is a station with its word withheld, so each road shows its real length and population
// — the one thing a list of your own words can never say — and a claim lands ON a stop
// that was already there rather than appearing out of nothing. The run's end reveals every
// word and turns the board into the post-mortem.
//
// **Only the TAIL is broken** (same decision): the dashes at the cold top end mean "the
// line continues into words with no distance at all", and that is the one place on this
// board where they mean anything — every rank between the stations is itself a station, so
// a connector is never hiding ground. (The variant that drew only found words and dashed
// the gaps between them is gone with the census it existed to serve.)
//
// It reuses the route map's drawing grammar wholesale — the `.route-frame` / `.route-*`
// CSS and RouteModal's exported geometry helpers — so the two surfaces cannot drift
// apart visually. The line runs DOWN the page like the map does: the off-map strikes at
// the top, then the broken tail, the near strikes riding the trunk, the fork, the field
// farthest-first, and the day's word closing the line at the bottom.

// The merge into the word runs the ONBOARDING TEASER's distance, not the route modal's
// (decided 2026-08-05). The map spends `LEAP_H` (56) there, which with the converge
// junction's own stub below the bus and the arrival's half-row above its node puts 90px
// between the two — two and a half times the teaser's 36 — and that stretch read as the
// line trailing off rather than arriving somewhere. The teaser is the shape the player was
// taught the routes in, so it is the one to match. What the CONNECTOR contributes is only
// what those two do not already spend, which on a forked board is almost nothing: the
// junction's stub lands on the arrival row and the row's own rail carries the line into
// the node.
const TEASER_MERGE_RUN = 36; // tutorial/RoutesTeaser: TRUNK_RUN 14 + ARRIVAL_H / 2 (22)
const JX_STUB = 14; // `.jx-trunk`'s run below the bus (index.css)
const ARRIVAL_HALF_HEAD = 20; // `.route-arrival`'s --head (40) / 2 — its node's offset into the row

// One row of the line, farthest first: a group of the claimable FIELD — its word withheld
// until the player claims it, or until the run's end names the whole neighborhood — or a
// near strike out on the trunk, which always shows the word that was typed.
type Row =
  | {
      zone: true;
      rank: number;
      dq: number;
      road: number | null;
      word: string | null;
      claimed: boolean;
    }
  | { zone: false; rank: number; dq: number; word: string };

export default function WordBoard({ model, lang }: { model: WordBoardModel; lang: string }) {
  const lanes = model.lanes;

  // Farthest first, the order the line is drawn in. The model ships both lists rank
  // ascending, and every near strike ranks outside the field while every field group ranks
  // inside it — so reversed, trunk-then-field is already globally descending.
  const trunk: Row[] = [...model.outside].reverse().map((o) => ({ zone: false as const, ...o }));
  const field: Row[] = [...model.stations].reverse().map((s) => ({ zone: true as const, ...s }));
  const rows: Row[] = [...trunk, ...field];
  // The fork stands just before the field, which is where the roads begin; the merge comes
  // back out of them into the word.
  const forkAt = trunk.length;
  const forked = lanes > 1 && field.length > 0;

  // The field's population per road and how much of it is claimed — what the sr mirror
  // states as a count (the same reason the route map states it: ~150 items of "rank 87,
  // hidden" would bury the words the player knows).
  const perRoad = Array.from({ length: lanes }, () => 0);
  let claimedCount = 0;
  for (const s of model.stations) {
    if (s.road === null) continue;
    perRoad[s.road] = (perRoad[s.road] ?? 0) + 1;
    if (s.claimed) claimedCount += 1;
  }

  // The gutter fits the widest exponent the line actually shows — the farthest row, since
  // they are drawn farthest first. That is the field's own outer edge until a near strike
  // lands beyond it.
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
    // The dash unit the TAIL is cut to — the one broken run on this board.
    '--dash': `${DASH}px`,
    '--dash-period': `${DASH_PERIOD}px`,
  } as CSSProperties;

  return (
    <div className="route-frame word-frame" style={frame}>
      {/* The drawing is decorative; the sr-only list below carries the same content. */}
      <div className="route" aria-hidden="true">
        {/* The off-map strikes, above the line and outside every distance it draws. No rule
            under them (removed 2026-08-05, with the map's own): the broken tail below already
            says the line does not continue straight through. */}
        {model.misses.length > 0 && (
          <div className="route-shelf">
            {/* The heat ramp's coldest colour — what the floating `MISS` and this board's
                own strike feedback already wear (`heatColor(0)`, computed, never copied). */}
            <p className="route-shelf-head" style={{ color: heatColor(0) }}>
              {t(lang, 'routeOffMap')}
            </p>
            <p className="route-misses">
              {model.misses.map((word) => (
                <span key={word} className="route-miss">
                  {word}
                </span>
              ))}
            </p>
          </div>
        )}
        {/* The line always comes in out of that void, whether or not this run hit it — the
            board's ONE broken run, and the only stretch that hides anything. */}
        <div className="route-link tail" style={{ height: TAIL_H }} />

        {rows.map((row, i) => {
          const previous = rows[i - 1];
          // Consecutive ranks are ONE row apart whatever their dq: the field is drawn in
          // full, so the rank ladder already says they are adjacent and a proportional
          // connector there would buy nothing (the route map's own rule). Out on the trunk,
          // where the player's strikes are sparse, the length is the only thing carrying
          // the distance and stays proportional.
          const gap = !previous
            ? 0
            : previous.rank - row.rank === 1
              ? LINK_MIN
              : linkHeight(previous.dq, row.dq);
          const onLane = forked && row.zone && row.road !== null;
          const label = row.zone ? (row.word ?? UNKNOWN) : row.word;
          // Withheld while the run is live; named by its end, which is the post-mortem —
          // and named there is not the same as FOUND, so it keeps the small node and the
          // dimmed word (the route map's own distinction).
          const censored = row.zone && row.word === null;
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
                  censored ? 'route-unknown' : '',
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
        {/* The joined line's final run into the word: an ordinary SOLID trunk link, at the
            teaser's distance (see the constants above). An unforked board has no junction to
            spend the stub, so its connector carries that share too. */}
        <div
          className="route-link"
          style={{
            height: Math.max(0, TEASER_MERGE_RUN - ARRIVAL_HALF_HEAD - (forked ? JX_STUB : 0)),
          }}
        />

        {/* The end of the line: the day's word — PUBLIC, the one thing this board never
            withholds. It wears the terminus size and the found (accent) face from frame
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

      {/* The board in words, closest first — the drawing above is decorative. Only what
          HAS a word is enumerated; the censored field is the count above it. */}
      <ol className="sr-only">
        <li>{srWordBoardWord(lang, model.word)}</li>
        <li>{srRouteRoads(lang, perRoad, claimedCount)}</li>
        {[...rows]
          .reverse()
          .filter((row) => !row.zone || row.word !== null)
          .map((row) => (
            <li key={`${row.zone ? 'z' : 'o'}${row.rank}`}>
              {srRouteStop(lang, { rank: row.rank, word: row.word, road: null })}
            </li>
          ))}
        {model.misses.length > 0 && <li>{srRouteOffMap(lang, model.misses)}</li>}
      </ol>
    </div>
  );
}
