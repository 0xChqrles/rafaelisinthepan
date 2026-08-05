import type { CSSProperties, ReactNode } from 'react';
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
  dashedRun,
  TAIL_H,
  JUNCTION_H,
  LINK_MIN,
  ARRIVAL_PX,
  STATION_PX,
  DASH,
  DASH_PERIOD,
} from './RouteModal';
import { t, srRouteRoads, srRouteStop, srRouteOffMap, srWordBoardWord } from '../i18n';

// Word mode's play surface (#156): the route-map CONCEPT — lanes, dq-spaced stations, a
// trunk out of the far field — as the PRIMARY, LIVE surface, not the modal reused. The
// differences are the mode's own: the center word is PUBLIC (the terminus is revealed
// from the first frame), there is no departure and no "you are here", and the drawing
// changes under the player's claims.
//
// **Only what has a WORD is drawn** (decided 2026-08-05, superseding the censored `???`
// census the board shipped with): the sentence game's map draws every unfound group
// because its whole job is to show a neighborhood you cannot see, and there the field is
// bounded by your departure. Here the field is a flat 150 and the word is already public,
// so a column of 150 placeholders said one thing 150 times and buried the handful of
// words the player actually knows. What is unfound is now UNKNOWN GROUND — the gaps
// between the stations, drawn as a broken trace — so the board starts empty and fills in
// as you claim, and the same rule turns it into the full post-mortem once the run ends
// and every group gives up its word.
//
// It reuses the route map's drawing grammar wholesale — the `.route-frame` / `.route-*`
// CSS and RouteModal's exported geometry helpers — so the two surfaces cannot drift
// apart visually. The line runs DOWN the page like the map does: the off-map strikes
// past a torn break at the top, then the near strikes riding the trunk, the fork, the
// claims farthest-first, and the day's word closing the line at the bottom.

// The merge into the word runs the ONBOARDING TEASER's distance, not the route modal's
// (decided 2026-08-05). The map spends `LEAP_H` (56) there, which with the converge
// junction's own stub below the bus and the arrival's half-row above its node puts 90px
// between the two — two and a half times the teaser's 36 — and on a board that is mostly
// unknown ground that stretch reads as the line trailing off rather than arriving
// somewhere. The teaser is the shape the player was taught the routes in, so it is the
// one to match. What the CONNECTOR contributes is only what those two do not already
// spend, which on a forked board is almost nothing: the junction's stub lands on the
// arrival row and the row's own rail carries the line down into the node.
const TEASER_MERGE_RUN = 36; // tutorial/RoutesTeaser: TRUNK_RUN 14 + ARRIVAL_H / 2 (22)
const JX_STUB = 14; // `.jx-trunk`'s run below the bus (index.css)
const ARRIVAL_HALF_HEAD = 20; // `.route-arrival`'s --head (40) / 2 — its node's offset into the row

// One drawn row: a word the player has (a claim, a near strike, or — once the run is
// over — one the reveal named). Trunk rows carry no road.
interface Drawn {
  rank: number;
  dq: number;
  word: string;
  road: number | null;
  zone: boolean; // inside the claimable field (vs a near strike out on the trunk)
  claimed: boolean;
}

export default function WordBoard({ model, lang }: { model: WordBoardModel; lang: string }) {
  const lanes = model.lanes;
  const forked = lanes > 1;

  // Farthest first, the order the line is drawn in. Every near strike ranks outside the
  // field and every claim inside it, so trunk-then-zone is already globally descending.
  const trunk: Drawn[] = model.outside
    .map((o) => ({ ...o, road: null, zone: false, claimed: false }))
    .sort((a, b) => b.rank - a.rank);
  const claims: Drawn[] = model.stations
    .filter((s) => s.word !== null)
    .map((s) => ({
      rank: s.rank,
      dq: s.dq,
      word: s.word as string,
      road: s.road,
      zone: true,
      claimed: s.claimed,
    }))
    .sort((a, b) => b.rank - a.rank);

  // The FIELD's own edges — every zone group, drawn or not (the model still ships them
  // all). Two jobs: a junction sits ON an edge, so the run touching it is unknown ground
  // unless a found word sits there too; and a connector's LENGTH is measured across
  // ground that isn't drawn, whose dq is real all the same.
  const outer = model.stations[model.stations.length - 1];
  const inner = model.stations[0];

  // The near field's population per road and how much of it is claimed — what the sr
  // mirror states as a count (the same reason the route map states it: ~150 items of
  // "rank 87, hidden" would bury the words the player knows). Counted over the WHOLE
  // field, never over the drawn rows.
  const perRoad = Array.from({ length: lanes }, () => 0);
  let claimedCount = 0;
  for (const s of model.stations) {
    if (s.road === null) continue;
    perRoad[s.road] = (perRoad[s.road] ?? 0) + 1;
    if (s.claimed) claimedCount += 1;
  }

  // The gutter fits the widest exponent the FIELD can show, not the widest drawn so far:
  // sized by the drawn rows alone it would jump a whole cell the first time a claim
  // landed farther out than the last one, dragging the rail and the word column with it.
  const widestRank = Math.max(outer?.rank ?? 1, trunk[0]?.rank ?? 1);
  const rankChars = 1 + String(widestRank).length;

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

  const station = (row: Drawn, onLane: boolean) => (
    <div
      key={`st-${row.zone ? 'z' : 'o'}${row.rank}`}
      data-word-rank={row.rank}
      className={[
        'route-station',
        onLane ? 'on-lane' : '',
        // Named by the run's END rather than claimed: the post-mortem keeps what you
        // FOUND apart from what was merely there (small node, word dimmed).
        row.zone && !row.claimed ? 'route-unknown route-revealed' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={
        {
          '--node-x': `${onLane ? laneX(row.road!) : trunkX}px`,
          '--lane-c': onLane ? LANE_COLORS[row.road! % LANE_COLORS.length] : 'var(--rail)',
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
        <span className="route-word" style={{ fontSize: fitWord(row.word, STATION_PX) }}>
          {row.word}
        </span>
      </span>
    </div>
  );

  // The line, assembled farthest-first. `prev` is whatever the next connector runs down
  // FROM — a drawn station, or a junction standing on the field's edge.
  const line: ReactNode[] = [];
  let prev: { rank: number; dq: number } | null = null;
  const connect = (to: { rank: number; dq: number }, onLanes: boolean) => {
    const from = prev;
    if (!from) return;
    // A run that SKIPS ranks is ground the player has not named, so it is drawn as a
    // BROKEN trace — the cold tail's own dash unit, meaning here exactly what it means
    // there: the line does not continue straight through. Its height is snapped to a
    // whole number of that unit (`dashedRun`), or the last unit is cut wherever it falls
    // and the stub lands right where the trace meets the next node.
    const skips = from.rank - to.rank > 1;
    line.push(
      <div
        key={`link-${from.rank}-${to.rank}`}
        className={`route-link${onLanes ? ' lanes' : ''}${skips ? ' dashed' : ''}`}
        style={{ height: skips ? dashedRun(linkHeight(from.dq, to.dq)) : LINK_MIN }}
      />,
    );
  };

  for (const row of trunk) {
    connect(row, false);
    line.push(station(row, false));
    prev = row;
  }
  if (forked && outer) {
    // Into the roads: the fork stands at the field's farthest group.
    connect(outer, false);
    line.push(<Junction key="fork" height={JUNCTION_H} />);
    prev = outer;
  }
  for (const row of claims) {
    connect(row, forked);
    line.push(station(row, forked && row.road !== null));
    prev = row;
  }
  // The last stretch before the line leaves the field: unknown ground unless the closest
  // group of all is one of the player's. (The merge into the WORD stays solid — the
  // routes have to visibly lead to it, decided 2026-08-04.)
  if (inner) connect(inner, forked);
  if (forked) line.push(<Junction key="merge" height={JUNCTION_H} converge />);

  // Closest-first, for the sr mirror: a list has no "scrolled to the end".
  const spoken = [...trunk, ...claims].sort((a, b) => a.rank - b.rank);

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

        {line}

        {/* The joined line's final run into the word: an ordinary SOLID trunk link, at the
            teaser's distance (see the constants above). An unforked board has no junction to
            spend the stub, so its connector carries that share too. */}
        <div
          className="route-link"
          style={{
            height: Math.max(
              0,
              TEASER_MERGE_RUN - ARRIVAL_HALF_HEAD - (forked ? JX_STUB : 0),
            ),
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

      {/* The board in words, closest first — the drawing above is decorative. */}
      <ol className="sr-only">
        <li>{srWordBoardWord(lang, model.word)}</li>
        <li>{srRouteRoads(lang, perRoad, claimedCount)}</li>
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
