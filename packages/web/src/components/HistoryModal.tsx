import { Fragment, useLayoutEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { HistoryModel, HistoryStop } from '../game/history';
import {
  ARRIVAL_PX,
  OffMapShelf,
  RouteLink,
  RouteRow,
  RouteTail,
  RouteWord,
  STATION_PX,
  UNKNOWN,
  dashedRun,
  linkGap,
  rankGutterChars,
  routeFrameVars,
} from './routeDrawing';
import { holeTitle, srRouteDestination, srRouteOffMap, srRouteStop } from '../i18n';
import ModalHeader from './ModalHeader';
import useModalDismiss from '../hooks/useModalDismiss';

// The HISTORY modal (user-decided 2026-08-10, replacing the #117 route map — then given
// the map's JOURNEY spine back on review the same day): tap a hole, see your tries as
// stops on ONE line walking down to the hidden word.
//
// The first cut was a flat sorted list, and it was legible but said nothing: no starting
// word, an ordering you had to read the exponents to infer, no sense of a target being
// reached. So the map's SPINE returned — what stays retired is everything that made the
// map unreadable and never helped: the censored census of every unfound group, the sticky
// "you are here" machinery. What is drawn now is only where the
// player has BEEN, on the structure that says what it means:
//
//   - the MISSED shelf at the top, its words in the dimmed coldest heat — one red block of
//     dead ends — then the broken tail: the void the line comes out of;
//   - the BEHIND stretch (stops farther than the departure — guesses that went backwards):
//     quiet words, small nodes, and the connectors STAY the broken trace, because the
//     journey has not started yet ("anything farther than the start is behind you");
//   - the DEPARTURE (muted node, dimmed word — the one stop you were given, not one you
//     earned) is where the line turns SOLID: from here down every stop is a step of the
//     walk, full-bright, spaced by its REAL distance (`dq`), with the gold "you are here"
//     node at the hole's current position;
//   - the terminus: the fixed-width `???` on the big node — the unknown target the whole
//     round is about — turning into the accented secret in solved blue once found.
//
// So the three kinds of guess are told apart by the LINE itself, not by reading numbers:
// red and shelved = never on the map, dim on the dashes = behind where you started,
// bright on the solid rail = progress.
//
// It opens scrolled to the line's END, where "how close am I, what is left" lives, and
// keeps everything the old modal decided about being a MODAL: the zoom out of the tapped
// word and the retraction back into it, useModalDismiss + the shared ModalHeader above a
// pixel-scroll scroller, close chip and Escape as the only ways out. The LINE has no
// motion of its own — the only animation is the arrival and the leaving.

// The final run into the terminus: the same solid leap the route map spent there — the
// line should visibly LEAD to the word.
const LEAP_H = 56;
// "You are here" reads a step above the rest of the line, like the map's own.
const HERE_PX = 17;

export default function HistoryModal({
  model,
  number,
  lang,
  origin,
  onClose,
}: {
  model: HistoryModel;
  // The hole's 1-based sentence position among distinct secrets — the ruler's numbering.
  number: number;
  lang: string;
  // The point the modal grows out of — the tapped word's centre in viewport coordinates,
  // which are the dialog's own (fixed, inset 0). Null falls back to the centre of the screen.
  origin?: { x: number; y: number } | null;
  onClose: () => void;
}) {
  // FIRST hook on purpose: it owns `showModal()` (a closed <dialog> is display:none — the
  // opening scroll below would measure a tree with no boxes), takes opening focus to the
  // dialog rather than the header's close chip, and turns every dismissal into the
  // retraction beat.
  const { closing, beginClose, dialogProps } = useModalDismiss('history-zoom-out');
  const scrollRef = useRef<HTMLDivElement>(null);
  const title = holeTitle(lang, number);

  // Open on the END of the line: the ground covered fills the screen above, and the
  // terminus — the point of the whole drawing — is on screen from the first frame. Set
  // directly, never smooth-scrolled (the line has no motion); a line shorter than the
  // screen makes this a no-op and the frame's auto margins centre it instead.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, []);

  // Farthest first — the order the line is travelled and drawn in.
  const stops: HistoryStop[] = [...model.stops].reverse();
  const rankChars = rankGutterChars(model.maxRank);

  // Consecutive-rank stops sit one row apart; everywhere the line SKIPS ranks the
  // connector length carries the distance (routeDrawing's own rule). Pre-#115 data has no
  // dq to space by, so a null on either end falls back to the minimum — uniform spacing,
  // never a refusal.
  const gap = (previous: HistoryStop | undefined, stop: HistoryStop): number => {
    if (!previous) return 0;
    if (previous.dq === null || stop.dq === null) {
      return linkGap({ rank: stop.rank + 1, dq: 0 }, { rank: stop.rank, dq: 0 });
    }
    return linkGap({ rank: previous.rank, dq: previous.dq }, { rank: stop.rank, dq: stop.dq });
  };

  return createPortal(
    <dialog
      {...dialogProps}
      className={`history-dialog${closing ? ' closing' : ''}`}
      // Where the opening zoom starts. Omitted when the word could not be located, so the
      // CSS fallback (dead centre) takes over rather than 0,0 throwing it to a corner.
      style={
        origin
          ? ({ '--zoom-x': `${origin.x}px`, '--zoom-y': `${origin.y}px` } as CSSProperties)
          : undefined
      }
      aria-label={title}
      onClose={onClose}
    >
      <ModalHeader lang={lang} title={title} onClose={beginClose} />

      <div className="history-scroll pixel-scroll" ref={scrollRef}>
        <div className="route-frame history-frame" style={routeFrameVars(rankChars)}>
          {/* The drawing is decorative; the sr-only list below carries the same content. */}
          <div className="route" aria-hidden="true">
            {/* Before the line even starts: the guesses that earned no rank at all. */}
            <OffMapShelf lang={lang} misses={model.misses} />
            {/* The line always comes in out of that void, whether or not this round hit it. */}
            <RouteTail />

            {stops.map((stop, i) => {
              // A connector is part of the walk only from the departure DOWN: entering a
              // behind stop — or the departure itself, from behind territory — it stays
              // the broken trace, so the solid line visibly BEGINS where the journey does.
              // (`stop` is the closer end of the pair; behind > departure > ahead in this
              // order, so the flags of the lower stop decide.) Broken heights are snapped
              // to the dash unit, or the run ends on a cut dash against the node.
              const broken = stop.behind || stop.start;
              // ONE zone class per stop, so each zone owns its colour outright (the sr
              // flags below stay complete — this is only the drawing's dress). TWO zones,
              // not three: the DEPARTURE has no dress of its own (user-decided
              // 2026-08-10) — it is a word the player holds like any other, so it renders
              // exactly as a valid guess does. What still says "the walk starts here" is
              // the LINE: the broken trace ends at it, and everything above it is grey.
              const zone = stop.best ? 'route-you' : stop.behind ? 'route-behind' : 'route-ahead';
              // ...plus one MODIFIER: a group the solve merely NAMED. It keeps its zone's
              // gold and takes the app's own "named, not found" dress (the word board's
              // distinction) — dimmed word, small node — so what the player actually held
              // still stands out of the field that was always there.
              const dress = stop.revealed ? `${zone} route-revealed` : zone;
              return (
                <Fragment key={stop.rank}>
                  {i > 0 && (
                    <RouteLink
                      height={
                        broken ? dashedRun(gap(stops[i - 1], stop)) : gap(stops[i - 1], stop)
                      }
                      broken={broken}
                    />
                  )}
                  <RouteRow rank={stop.rank} className={dress}>
                    <RouteWord word={stop.word} max={stop.best ? HERE_PX : STATION_PX} />
                  </RouteRow>
                </Fragment>
              );
            })}

            {/* The line's final run into the word: solid — the journey visibly LEADS there. */}
            <RouteLink height={LEAP_H} />
            {/* The end of the line. `???` while the hole is open — the unknown target the
                whole round is about — the accented secret in the solved blue once found. */}
            <RouteRow className={`route-arrival${model.solved ? ' route-found' : ''}`}>
              <RouteWord word={model.secret ?? UNKNOWN} max={ARRIVAL_PX} />
            </RouteRow>
          </div>

          {/* The line in words, closest first — it leads with what the drawing opens on. */}
          <ol className="sr-only">
            <li>{srRouteDestination(lang, model.secret)}</li>
            {model.stops.map((stop) => (
              <li key={stop.rank}>
                {srRouteStop(lang, {
                  rank: stop.rank,
                  word: stop.word,
                  start: stop.start,
                  best: stop.best,
                  behind: stop.behind,
                })}
              </li>
            ))}
            {model.misses.length > 0 && <li>{srRouteOffMap(lang, model.misses)}</li>}
          </ol>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
