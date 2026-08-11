import { Fragment, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { WordBoardModel } from '../game/wordBoard';
import type { Rarity } from '../game/wordGame';
import { RARITY_COLORS } from './rarity';
import { SCRAMBLE_MS, useScramble } from '../hooks/useScramble';
import {
  ARRIVAL_PX,
  OffMapShelf,
  RouteLink,
  RouteRow,
  RouteTail,
  RouteWord,
  STATION_PX,
  UNKNOWN,
  fitWord,
  linkGap,
  rankGutterChars,
  routeFrameVars,
} from './routeDrawing';
import { srWordRarities, srRouteStop, srRouteOffMap, srWordBoardWord } from '../i18n';

// Word mode's POST-MORTEM surface (#156, moved off the live phase by #163): ONE trunk of
// dq-spaced stations — the sentence route's exact drawing (user-decided 2026-08-11,
// retiring the rarity LANES this board forked into until then) — as a full screen rather
// than a modal. The differences from the sentence game's line are the mode's own: the
// center word is PUBLIC, there is no departure and no "you are here", and what the player
// claimed is distinguished from what was merely named when the clock died.
//
// Everything the drawing has in common with the sentence game's history line — the
// geometry, the frame variables, the shelf, the tail, the connector rule and the station
// row itself — comes from `routeDrawing`, which owns it for both. A detail of the line
// changed there changes it on every route the app draws; that is the point of the module.
//
// **RARITY is carried by the WORD's COLOUR, not by a lane** (user-decided 2026-08-11,
// superseding 2026-08-10's grade-per-lane fork): every zone station's word is painted in
// its grade's own `RARITY_COLORS` colour — the same colour the strike and the loot wore
// when the claim landed — where the sentence line paints its stops gold. The model still
// grades every station and still ships `grades` (the sr census); only the drawing's answer
// to "where is the grade said?" changed: in the type, like the sentence map's zones.
//
// **The whole FIELD is drawn, censored until it is claimed** (decided 2026-08-05,
// restoring the `???` census after a day without it): every group of the claimable zone
// is a station with its word withheld, so the line shows its real length and population
// — the one thing a list of your own words can never say, and here it says where the run's
// expensive words WERE — and a claim lands ON a stop that was already there rather than
// appearing out of nothing. The run's end reveals every word and turns the board into the
// post-mortem.
//
// **Only the TAIL is broken** (same decision): the dashes at the cold top end mean "the
// line continues into words with no distance at all", and that is the one place on this
// board where they mean anything — every rank between the stations is itself a station, so
// a connector is never hiding ground.
//
// The line runs DOWN the page like the map does: the off-map strikes at the top, then the
// broken tail, the near strikes riding the trunk, the field farthest-first, and the
// day's word closing the line at the bottom.

// The final run into the terminus: the sentence line's own solid leap (HistoryModal spends
// the same 56 there) — with the lanes gone the two drawings share their arrival too, and
// the old junction-aware arithmetic (TEASER_MERGE_RUN/JX_STUB) went with the fork.
const LEAP_H = 56;

// One row of the line, farthest first: a group of the claimable FIELD — its word withheld
// until the player claims it, or until the run's end names the whole neighborhood, and named
// with its group's canonical form either way — or a near strike out on the trunk, which shows
// the form the player TYPED (see wordBoard.ts WordOutsideStop.word).
type Row =
  | {
      zone: true;
      rank: number;
      dq: number;
      rarity: Rarity;
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
  // Decorative like the drawing above it: the board's sr mirror already announces the word.
  return (
    <div
      className="route-frame word-frame word-terminus"
      style={routeFrameVars(1, rankChars)}
      aria-hidden="true"
    >
      <div className="route">
        <RouteRow className="route-arrival route-found">
          <RouteWord word={model.word} max={ARRIVAL_PX} />
        </RouteRow>
      </div>
    </div>
  );
}

export default function WordBoard({ model, lang }: { model: WordBoardModel; lang: string }) {
  // Farthest first, the order the line is drawn in. The model ships both lists rank
  // ascending, and every near strike ranks outside the field while every field group ranks
  // inside it — so reversed, trunk-then-field is already globally descending.
  const trunk: Row[] = [...model.outside].reverse().map((o) => ({ zone: false as const, ...o }));
  const field: Row[] = [...model.stations].reverse().map((s) => ({ zone: true as const, ...s }));
  const rows: Row[] = [...trunk, ...field];

  // The field's population per GRADE and how much of it is claimed — what the sr mirror
  // states as a count (the same reason the route map states it: a few hundred items of
  // "rank 87, hidden" would bury the words the player knows). Counted off the stations
  // themselves, so a model whose `grades` disagreed with its stations would under-report
  // a grade rather than throw on a render path.
  const population = new Map<Rarity, number>();
  let claimedCount = 0;
  for (const s of model.stations) {
    if (s.claimed) claimedCount += 1;
    population.set(s.rarity, (population.get(s.rarity) ?? 0) + 1);
  }
  const perGrade = model.grades.map((grade) => ({ grade, count: population.get(grade) ?? 0 }));

  // The gutter is reserved for the widest exponent the MAP can produce, not the widest this
  // line currently draws (see rankGutterChars): a near strike out at a 4-digit rank would
  // otherwise widen the track and shove the whole drawing sideways, mid-round.
  const rankChars = rankGutterChars(model.maxRank);

  return (
    <div className="route-frame word-frame" style={routeFrameVars(1, rankChars)}>
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
          const label = row.zone ? (row.word ?? UNKNOWN) : row.word;
          // Withheld while the run is live; named by its end, which is the post-mortem —
          // and named there is not the same as FOUND, so it keeps the small node and the
          // dimmed word (the route map's own distinction).
          const censored = row.zone && row.word === null;
          const revealed = row.zone && !row.claimed && row.word !== null;
          return (
            <Fragment key={`${row.zone ? 'z' : 'o'}${row.rank}`}>
              {previous && <RouteLink height={gap} />}
              <RouteRow
                rank={row.rank}
                className={[
                  // The station's grade, said in its word's colour (`--rarity-c` + `graded`,
                  // read by the `.word-frame` rules in index.css). A near miss out on the
                  // trunk has no grade and stays the drawing's own --fg; the class — not a
                  // rule over every station — is what lets the terminus keep route-found's
                  // solved blue.
                  row.zone ? 'graded' : '',
                  censored ? 'route-unknown' : '',
                  revealed ? 'route-unknown route-revealed' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={
                  row.zone
                    ? ({ '--rarity-c': RARITY_COLORS[row.rarity] } as CSSProperties)
                    : undefined
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

        {/* The line's final run into the word: the sentence line's own solid leap. It is the
            LINE's last row — the terminus itself is the board's pinned footer (WordTerminus),
            so scrolled to the bottom this link runs out of the scroller straight into its
            rail. */}
        <RouteLink height={LEAP_H} />
      </div>

      {/* The board in words, closest first — the drawing above is decorative. Only what
          HAS a word is enumerated; the censored field is the count above it. */}
      <ol className="sr-only">
        <li>{srWordBoardWord(lang, model.word)}</li>
        <li>{srWordRarities(lang, perGrade, claimedCount)}</li>
        {[...rows]
          .reverse()
          .filter((row) => !row.zone || row.word !== null)
          .map((row) => (
            <li key={`${row.zone ? 'z' : 'o'}${row.rank}`}>
              {/* The grade is what the station word's colour says to everyone else, so a
                  named stop says it here — the sr mirror's whole job on this board. A near
                  stop outside the field has no grade, so it says none. */}
              {srRouteStop(lang, {
                rank: row.rank,
                word: row.word,
                road: null,
                rarity: row.zone ? row.rarity : undefined,
              })}
            </li>
          ))}
        {model.misses.length > 0 && <li>{srRouteOffMap(lang, model.misses)}</li>}
      </ol>
    </div>
  );
}
