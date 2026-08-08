import { Fragment, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { WordBoardModel } from '../game/wordBoard';
import { SCRAMBLE_MS, useScramble } from '../hooks/useScramble';
import {
  ARRIVAL_PX,
  JUNCTION_H,
  Junction,
  OffMapShelf,
  RouteLink,
  RouteRow,
  RouteTail,
  STATION_PX,
  UNKNOWN,
  fitWord,
  laneColor,
  laneX,
  linkGap,
  rankGutterChars,
  routeFrameVars,
  trunkX,
} from './routeDrawing';
import { srRouteRoads, srRouteStop, srRouteOffMap, srWordBoardWord } from '../i18n';

// Word mode's POST-MORTEM surface (#156, moved off the live phase by #163): the route
// drawing — lanes, dq-spaced stations, censored unfound stops — as a full screen rather
// than a modal. The differences from the sentence game's map are the mode's own: the center
// word is PUBLIC, there is no departure and no "you are here", and what the player claimed
// is distinguished from what was merely named when the clock died.
//
// Everything the drawing has in common with the daily game's route map — the geometry, the
// frame variables, the shelf, the tail, the connector rule, the junctions and the station row
// itself — comes from `routeDrawing`, which owns it for both. A detail of the line changed
// there changes it on every route the app draws; that is the point of the module.
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
// a connector is never hiding ground.
//
// The line runs DOWN the page like the map does: the off-map strikes at the top, then the
// broken tail, the near strikes riding the trunk, the fork, the field farthest-first, and the
// day's word closing the line at the bottom.

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
// until the player claims it, or until the run's end names the whole neighborhood, and named
// with its group's canonical form either way — or a near strike out on the trunk, which shows
// the form the player TYPED (see wordBoard.ts WordOutsideStop.word).
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

// A station starts as `???` and, when the player CLAIMS it, swaps in with the same
// slot-machine replacement as a sentence hole — a word you found is worth the beat.
//
// `animate` is what keeps that beat meaningful and cheap. The run's END reveals the whole
// field at once, and a scramble there would start CLAIM_ZONE of them in one frame — each its own
// 40ms interval writing state for 650ms, on top of the result tray rising — for a reveal that
// is not a "found it" moment at all but the post-mortem naming what was always there. Those
// land outright; only a claim churns. (The initial target is likewise seeded as settled, so
// loading an already-played round replays nothing.)
function StationWord({
  target,
  fontSize,
  animate,
}: {
  target: string;
  fontSize: string;
  animate: boolean;
}) {
  const { jumble, start } = useScramble();
  const [displayWord, setDisplayWord] = useState(target);

  useEffect(() => {
    if (target === displayWord) return;
    if (!animate) {
      setDisplayWord(target);
      return;
    }
    start(target, displayWord.length, () => setDisplayWord(target));
  }, [animate, displayWord, start, target]);

  const style = {
    fontSize,
    '--reveal-ms': `${SCRAMBLE_MS}ms`,
  } as CSSProperties;

  return (
    <span className={`route-word${jumble !== null ? ' revealing' : ''}`} style={style}>
      {jumble ?? displayWord}
    </span>
  );
}

// The end of the line, as the board's own PINNED FOOTER. The board is the POST-MORTEM
// (#163), so this row exists only there — the run itself shows the bare centred word
// (components/WordSubject), which is why nothing here hosts a guess's feedback any more:
// no guess can land while this is on screen.
//
// It lives OUTSIDE the scroller (WordGame renders it under the window's cut), where nothing
// can ever scroll behind it and it needs no masking background. (A sticky in-scroller row
// was tried first, 2026-08-06: its opaque `--bg` box — invisible in the route modal, whose
// dialog is flat `--bg` — read as a black patch stamped over this page's animated waves.)
// Scrolled to the bottom, the line's merge link runs out of the scroller straight into this
// row's rail; cut mid-field, the window's torn bottom rule lands on this row's top edge,
// where the rail stub runs into it. Its own `.route-frame` re-derives the SAME frame vars
// from the same model, so its grid lands on the line's columns (`.word-terminus` pads for
// the scroller's right side + scrollbar).
export function WordTerminus({ model }: { model: WordBoardModel }) {
  const rankChars = rankGutterChars(model.maxRank);
  const trunkCentre = trunkX(model.lanes);
  // Decorative like the drawing above it: the board's sr mirror already announces the word.
  return (
    <div
      className="route-frame word-frame word-terminus"
      style={routeFrameVars(model.lanes, rankChars)}
      aria-hidden="true"
    >
      <div className="route">
        <RouteRow
          className="route-arrival route-found"
          style={{ '--node-x': `${trunkCentre}px` } as CSSProperties}
        >
          <span className="route-word" style={{ fontSize: fitWord(model.word, ARRIVAL_PX) }}>
            {model.word}
          </span>
        </RouteRow>
      </div>
    </div>
  );
}

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
  // states as a count (the same reason the route map states it: a few hundred items of
  // "rank 87, hidden" would bury the words the player knows).
  const perRoad = Array.from({ length: lanes }, () => 0);
  let claimedCount = 0;
  for (const s of model.stations) {
    if (s.claimed) claimedCount += 1;
    // `road` is optional in the artifact contract. A --no-roads board already renders on
    // one trunk, so its sr mirror must count that same single-lane neighborhood instead of
    // announcing an empty field. On a multi-road artifact a stray unassigned station stays
    // unassigned rather than being misreported as part of road 1.
    const road = s.road ?? (lanes === 1 ? 0 : null);
    if (road !== null) perRoad[road] = (perRoad[road] ?? 0) + 1;
  }

  // The gutter is reserved for the widest exponent the MAP can produce, not the widest this
  // line currently draws (see rankGutterChars): a near strike out at a 4-digit rank would
  // otherwise widen the track and shove the whole drawing sideways, mid-round.
  const rankChars = rankGutterChars(model.maxRank);
  const trunkCentre = trunkX(lanes);

  return (
    <div className="route-frame word-frame" style={routeFrameVars(lanes, rankChars)}>
      {/* The drawing is decorative; the sr-only list below carries the same content. */}
      <div className="route" aria-hidden="true">
        {/* The off-map strikes, above the line and outside every distance it draws. */}
        <OffMapShelf lang={lang} misses={model.misses} />
        {/* The line always comes in out of that void, whether or not this run hit it — the
            board's ONE broken run, and the only stretch that hides anything. */}
        <RouteTail />

        {rows.map((row, i) => {
          const previous = rows[i - 1];
          const gap = linkGap(previous, row);
          // Sits ON a road — which is NOT the same question as whether the line forks, and was
          // wrongly gated on it until 2026-08-07. A neighborhood with a single honest facet
          // ships one road, and reading `forked` here drew that whole board in the colourless
          // trunk treatment: the field is a route, it is just the only one. (The stricter road
          // rules made that case common — `pain` and `vie` both fall to one road.) The node's x
          // is unaffected either way, since laneX(0, 1) and trunkX(1) are the same point; what
          // was lost was purely the colour. `forked` still gates the JUNCTIONS below, where it
          // belongs — one road has nothing to fork into, and drawing a fork there would claim a
          // structure the data does not have.
          const onLane = row.zone && row.road !== null;
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
                  {previous && <RouteLink height={gap} />}
                  <Junction height={JUNCTION_H} />
                </>
              ) : (
                previous && <RouteLink height={gap} lanes={onLane} />
              )}
              <RouteRow
                rank={row.rank}
                onLane={onLane}
                className={[
                  onLane ? 'on-lane' : '',
                  censored ? 'route-unknown' : '',
                  revealed ? 'route-unknown route-revealed' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={
                  {
                    '--node-x': `${onLane ? laneX(row.road!, lanes) : trunkCentre}px`,
                    '--lane-c': laneColor(onLane ? row.road : null),
                  } as CSSProperties
                }
              >
                <StationWord
                  target={label}
                  fontSize={fitWord(label, STATION_PX)}
                  animate={row.zone && row.claimed}
                />
              </RouteRow>
            </Fragment>
          );
        })}

        {forked && <Junction height={JUNCTION_H} converge />}
        {/* The joined line's final run into the word: an ordinary SOLID trunk link, at the
            teaser's distance (see the constants above). An unforked board has no junction to
            spend the stub, so its connector carries that share too. It is the LINE's last
            row — the terminus itself is the board's pinned footer (WordTerminus), so scrolled
            to the bottom this link runs out of the scroller straight into its rail. */}
        <RouteLink
          height={Math.max(0, TEASER_MERGE_RUN - ARRIVAL_HALF_HEAD - (forked ? JX_STUB : 0))}
        />
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
