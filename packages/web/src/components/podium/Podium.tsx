import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { COUNT_STILL_S, anonName, bayerThreshold, defaultAvatar, progressHeatColor, type BoardPlayer } from '@whippin/shared';
import Avatar from '../Avatar';
import { clockNow, onClock } from '../animationClock';
import { DISSOLVE_MS } from '../bayerTiles';
import Strike from '../Strike';
import { BURST_ART } from '../strikeArt';
import {
  CELL_PX,
  FRAME_MS,
  NAME_ROWS,
  captionRows,
  layout,
  markAt,
  podiumHeightPx,
  podiumScene,
  turnLevel,
  type BeatSpec,
  type Beats,
  type PodiumLayout,
  type PodiumMode,
  type PodiumSize,
} from './scene';
import { NO_PLACES, stepTier } from '../../game/podium';
import { prefersReducedMotion } from '../../hooks/useScramble';

// THE BOARD'S PODIUM — the board screen's subject, the way the result has its count (the scene
// itself, its steps, places, values, heat and beats, is `scene.ts`): standing on the bare
// ground between the board's head and its lines, ONE scene the screen keeps across every board
// it turns to — the raster on ONE clock, with the players' MARKS (`Avatar`, square, at 10 cells
// of a whole px) standing on it where the scene's layout says and moved by its `markAt`, each
// landing's BURST (the strike sheet, behind the mark in that place's heat ink — the winner's the
// trophy cobalt), and under the floor each player's CAPTION: the NAME in the chrome's voice, over
// the value the raster draws, over its UNIT (the result's own lockup: the count, then what it
// counts — so a period's 3 points never read as third).
//
// A NAME IS NEVER CUT: it owns a third of the podium (its slot, less a gutter each side) and
// wraps onto a second line at its joints — after an underscore, between a word and the next
// capital, before a run of digits; the browser balances the two lines, so `SwiftCactus45` reads
// `Swift` / `Cactus45` — inside a band that holds two lines whatever it holds, so nothing under
// it moves. YOUR name wears your line's corner brackets and your place is in the accent; on
// GLOBAL one of your people carries the lines' accent square.
//
// A TURN IS ONE SCENE GIVING WAY TO THE NEXT, never a blank: the raster is replaced cell by cell
// in the Bayer order (`turnLevel`, a line's own dissolve), so what both boards share — the
// steps, a value that did not change — never flickers; a player who stands on the same place on
// both STAYS (their mark and their name never move); a player leaving dissolves out where they
// stand, through the complementary cells, while the one taking the place drops in (a board
// shown for the first time in the visit) or dissolves in (a board already shown: settled from
// its first frame).
//
// THE CLOCK is the document's animation timeline (the lines' CSS and their reels' Web
// Animations run on it, so the podium and the lines never drift apart, whatever the page's
// playback rate). It steps every FRAME_MS until the scene has settled; then only first place's
// FOIL moves (its sheen and its glitter), repainted over a stored resting frame at the foil's
// own slow pace — and THE CLOCK RESTS while nobody can see it (scrolled out of view, a hidden
// tab) or nobody is there (IDLE_MS after the last touch, key, wheel or scroll, the next one
// waking it). Reduced motion draws the settled frame and runs no clock at all.
//
// The whole scene is a PICTURE (hidden from a screen reader: the screen says the places in its
// list); what the box HOLDS besides it — the empty board's line and its call, a failed read's
// RETRY — is not.

export interface PodiumEntry {
  player: BoardPlayer;
  rank: number;
  value: number;
  // The value's unit, under it in the caption.
  unit: string;
  near: number;
  me: boolean;
  // One of the reader's groups' members (the GLOBAL board's mark).
  mate: boolean;
}

// WHAT THE PODIUM SHOWS: the scene's identity (`build`: a new one is a new scene), its picture,
// its places, and the board its foil's seed is read off.
export interface PodiumShow {
  build: string;
  mode: PodiumMode;
  places: readonly (PodiumEntry | null)[];
  seedKey: string;
}

// …and how it came to show it: read off the scene before it, whether it builds, who stays,
// which values run, and when it begins. Latched by the screen (`nextStage`) when what it shows
// changes, so the lines under it are timed off the same beats.
export interface PodiumStage extends PodiumShow {
  spec: BeatSpec;
  // Per place: the unit it said before, where it changed under a player who stays (the unit
  // gives way, not the name) — else null.
  unitWas: readonly (string | null)[];
}

// THE NEXT STAGE, from the one on screen: `fresh` — the board has not been shown in this
// visit (it builds; else it is settled) — `startMs` and `runMs` from the screen's pace.
export function nextStage(
  prev: PodiumStage | null,
  next: PodiumShow,
  fresh: boolean,
  startMs: number,
  runMs: number,
): PodiumStage {
  const { places } = next;
  const before = prev?.places ?? NO_PLACES;
  const stood = places.map((entry, p) => entry !== null && before[p]?.player.publicId === entry.player.publicId);
  return {
    build: next.build,
    mode: next.mode,
    places,
    seedKey: next.seedKey,
    unitWas: places.map((entry, p) => (stood[p] && before[p]?.unit !== entry?.unit ? (before[p]?.unit ?? null) : null)),
    spec: {
      steps: next.mode === 'board',
      loading: next.mode === 'loading',
      build: fresh,
      standing: prev?.mode === 'board',
      present: places.map((entry) => entry !== null),
      firsts: places.map((entry) => entry !== null && stepTier(entry.rank) === 0),
      stood,
      reels: places.map((entry, p) => entry !== null && !(stood[p] && before[p]?.value === entry.value)),
      startMs,
      runMs,
    },
  };
}

// The foil at rest steps at the meter's pace: pixel art has nothing to gain from 60fps.
const FOIL_FRAME_MS = 80;
// After this long without a touch, a key, a wheel or a scroll, the foil holds its frame.
const IDLE_MS = 9000;
// The ghost on an empty board's middle step: the user's sprite at 3x (39 × 54), its feet this
// far over the step.
const GHOST_W = 39;
const GHOST_H = 54;
const GHOST_LIFT = 4;

// A scene's foil seed, off its board: every board's foil its own picture.
function seedOf(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return ((h >>> 0) % 997) + 0.5;
}

// A name with its JOINTS marked as break opportunities (`<wbr>`): after an underscore, before
// a capital that follows a small letter, and before digits that follow a letter.
function jointed(name: string): ReactNode[] {
  const out: ReactNode[] = [];
  let run = '';
  for (let i = 0; i < name.length; i += 1) {
    const prev = name[i - 1] ?? '';
    const ch = name[i];
    const joint =
      prev === '_' || (/[a-z]/.test(prev) && /[A-Z]/.test(ch)) || (/[A-Za-z]/.test(prev) && /[0-9]/.test(ch));
    if (joint && run) {
      out.push(run, <wbr key={i} />);
      run = '';
    }
    run += ch;
  }
  out.push(run);
  return out;
}

// Where an entry's DOM stands in a layout, in CSS px: its mark, and its caption's box — from
// the name band's top to its block's last line, so what dissolves dissolves whole.
interface Placed {
  key: string;
  p: number;
  entry: PodiumEntry;
  mark: { left: number; top: number; size: number };
  caption: { left: number; width: number; top: number; height: number; unitTop: number };
}
function placed(L: PodiumLayout, places: readonly (PodiumEntry | null)[]): Placed[] {
  const top = L.name * CELL_PX;
  return places.flatMap((entry, p) => {
    if (!entry) return [];
    const place = L.places[p];
    return [
      {
        key: `${p}:${entry.player.publicId}`,
        p,
        entry,
        mark: { left: place.mark.x * CELL_PX, top: place.mark.y * CELL_PX, size: place.mark.w * CELL_PX },
        caption: {
          left: place.slot.x * CELL_PX,
          width: place.slot.w * CELL_PX,
          top,
          height: captionRows(L, p) * CELL_PX,
          unitTop: place.unit * CELL_PX - top,
        },
      },
    ];
  });
}

function Caption({
  at,
  className,
  style,
  unitWas = null,
}: {
  at: Placed;
  className: string;
  style?: CSSProperties;
  unitWas?: string | null;
}) {
  const { entry } = at;
  const unitStyle = { top: at.caption.unitTop };
  return (
    <span
      className={`podium-caption${className}`}
      style={{ left: at.caption.left, width: at.caption.width, top: at.caption.top, height: at.caption.height, ...style }}
    >
      <span
        className={`podium-name${entry.me ? ' me' : entry.mate ? ' mate' : ''}${entry.player.name ? '' : ' anon'}`}
        style={{ height: NAME_ROWS * CELL_PX }}
      >
        <span className="podium-name-text">{jointed(entry.player.name || anonName(entry.player.publicId))}</span>
      </span>
      {unitWas !== null && (
        <span key={`out:${unitWas}`} className="podium-unit out" style={unitStyle}>
          {unitWas}
        </span>
      )}
      <span key={entry.unit} className={`podium-unit${unitWas !== null ? ' in' : ''}`} style={unitStyle}>
        {entry.unit}
      </span>
    </span>
  );
}

export default function Podium({
  stage,
  tl,
  size,
  ghost,
  failed,
}: {
  stage: PodiumStage;
  tl: Beats;
  // The podium's size, as the screen chose it off its room.
  size: PodiumSize;
  // What the box holds besides the scene: the ghost's own caption under the floor (its terse
  // line where a player's name would be, its call where their value would), and a failed
  // read's RETRY.
  ghost?: { line: ReactNode; call: ReactNode };
  failed?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const markRefs = useRef<(HTMLSpanElement | null)[]>([]);
  // Where each player's mark stands at the clock's last frame (by its key): a player leaving
  // goes out from THERE — a mark caught mid-drop leaves from mid-air, one not yet dropped never
  // shows.
  const markPos = useRef(new Map<string, { shown: boolean; dx: number; dy: number }>());
  // THE CLOCK's start, once per scene: a new layout (a rotation, the column settling) redraws
  // the same moment of the scene rather than playing it again.
  const startRef = useRef<{ build: string; at: number } | null>(null);
  // The last frame drawn — what the next scene gives way from — and the one a scene took over.
  const lastFrame = useRef<{ cols: number; rows: number; px: Uint32Array } | null>(null);
  const fromFrame = useRef<{ build: string; frame: typeof lastFrame.current } | null>(null);
  const [width, setWidth] = useState(0);
  const [reduced] = useState(prefersReducedMotion);
  const { mode, places } = stage;
  const ranks = places.map((p) => p?.rank ?? null);
  const values = places.map((p) => p?.value ?? null);
  const shapeKey = `${ranks.join(',')}|${values.join(',')}`;
  const L = useMemo(() => layout(width, size, ranks, values), [width, size, shapeKey]);
  const shown = placed(L, places);

  // THE ONES LEAVING: the scene before's players who do not stand in this one, kept where they
  // stood for the giving way, dissolving out through the cells the newcomers take.
  type Leaver = Placed & { dx: number; dy: number };
  const [leaving, setLeaving] = useState<{ build: string; entries: Leaver[] }>({ build: stage.build, entries: [] });
  const lastShown = useRef<{ build: string; entries: Placed[] }>({ build: stage.build, entries: shown });
  useLayoutEffect(() => {
    const before = lastShown.current;
    if (before.build !== stage.build) {
      const staying = new Set(shown.map((at) => at.key));
      const entries = before.entries.flatMap((at) => {
        const pos = markPos.current.get(at.key) ?? { shown: true, dx: 0, dy: 0 };
        return staying.has(at.key) || !pos.shown ? [] : [{ ...at, dx: pos.dx, dy: pos.dy }];
      });
      setLeaving({ build: stage.build, entries: reduced ? [] : entries });
      fromFrame.current = { build: stage.build, frame: lastFrame.current };
    }
    lastShown.current = { build: stage.build, entries: shown };
  });
  useEffect(() => {
    if (leaving.entries.length === 0) return undefined;
    // Gone once the giving way has played — on the page's own animation clock, as the
    // dissolve itself is.
    return onClock(box.current, DISSOLVE_MS, () =>
      setLeaving((now) => (now === leaving ? { ...now, entries: [] } : now)),
    );
  }, [leaving]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The bursts are up while the scene builds, for the players who DROP.
  const [bursting, setBursting] = useState<string | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || L.cols <= 0) return undefined;
    canvas.width = L.cols;
    canvas.height = L.rows;
    const image = ctx.createImageData(L.cols, L.rows);
    const px = new Uint32Array(image.data.buffer);
    lastFrame.current = { cols: L.cols, rows: L.rows, px };
    const scene = podiumScene(
      L,
      { mode, places: places.map((p) => (p ? { rank: p.rank, value: p.value, near: p.near, me: p.me } : null)) },
      tl,
      seedOf(stage.seedKey),
    );
    // What this scene gives way from: the frame on screen as it came, at the same size.
    const taken = fromFrame.current?.build === stage.build ? fromFrame.current.frame : null;
    const from = !reduced && taken && taken.cols === L.cols && taken.rows === L.rows ? taken.px : null;
    if (startRef.current?.build !== stage.build) startRef.current = { build: stage.build, at: clockNow() };
    const start = startRef.current.at;
    const elapsed = () => clockNow() - start;

    const placeMarks = (t: number) => {
      markPos.current.clear();
      markRefs.current.forEach((el, p) => {
        const entry = places[p];
        if (!el || !entry) return;
        const at = markAt({ land: tl.land[p], fall: tl.fall[p] }, t);
        markPos.current.set(`${p}:${entry.player.publicId}`, at);
        el.style.visibility = at.shown ? 'visible' : 'hidden';
        el.style.translate = `${at.dx * CELL_PX}px ${at.dy * CELL_PX}px`;
      });
    };
    // The scene before, still standing on the cells this one has not reached.
    const giveWay = (t: number) => {
      if (!from || t >= DISSOLVE_MS) return;
      const lv = turnLevel(t);
      for (let y = 0; y < L.rows; y += 1) {
        for (let x = 0; x < L.cols; x += 1) if (bayerThreshold(x, y) >= lv) px[y * L.cols + x] = from[y * L.cols + x];
      }
    };

    // At rest, the frame without its foil is kept, and the foil alone is repainted over it.
    let rest: Uint32Array | null = null;
    const settle = (t: number) => {
      rest = new Uint32Array(px.length);
      scene.draw(rest, t, false);
      px.set(rest);
      scene.foil(px, rest, t);
      ctx.putImageData(image, 0, 0);
    };

    if (reduced) {
      // The held frame: the settled picture, its foil at the count's own still instant.
      const t = Math.max(tl.settled, COUNT_STILL_S * 1000);
      settle(t);
      placeMarks(t);
      return undefined;
    }

    let timer = 0;
    let stopped = false;
    let inView = true;
    let awake = true;
    let idle = 0;
    setBursting(stage.build);
    const tick = () => {
      timer = 0;
      if (stopped || !inView || document.hidden) return;
      const t = elapsed();
      // Nobody there: the foil at rest holds its frame (a build always plays out).
      if (t >= tl.settled && rest !== null && !awake) return;
      if (t < tl.settled) {
        scene.draw(px, t, true);
        giveWay(t);
        ctx.putImageData(image, 0, 0);
        placeMarks(t);
        timer = window.setTimeout(tick, FRAME_MS);
        return;
      }
      if (rest === null) {
        settle(t);
        placeMarks(t);
        setBursting(null);
      } else {
        scene.foil(px, rest, t);
        for (const b of scene.foilBoxes) ctx.putImageData(image, 0, 0, b.x, b.y, b.w, b.h);
      }
      // A podium with no foil on it (nobody first) has nothing left to move.
      if (scene.foilBoxes.length > 0) timer = window.setTimeout(tick, FOIL_FRAME_MS);
    };
    const wake = () => {
      if (!stopped && !timer && inView && !document.hidden) tick();
    };
    const touched = () => {
      window.clearTimeout(idle);
      idle = window.setTimeout(() => {
        awake = false;
      }, IDLE_MS);
      if (!awake) {
        awake = true;
        wake();
      }
    };
    const io =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver((entries) => {
            // The latest word on it: a batch can hold an entry and the exit after it.
            inView = entries[entries.length - 1].isIntersecting;
            wake();
          })
        : null;
    io?.observe(canvas);
    document.addEventListener('visibilitychange', wake);
    const events = ['pointerdown', 'keydown', 'wheel', 'scroll'] as const;
    for (const name of events) window.addEventListener(name, touched, { capture: true, passive: true });
    touched();
    // The first frame before paint — the scene before, as it stood.
    tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.clearTimeout(idle);
      io?.disconnect();
      document.removeEventListener('visibilitychange', wake);
      for (const name of events) window.removeEventListener(name, touched, { capture: true });
    };
    // A scene per stage (its build) and per layout; the data is the stage's.
  }, [L, stage.build, reduced]);

  const middle = L.places[0];
  return (
    <div ref={box} className={`podium${L.compact ? ' compact' : ''}`} style={{ height: podiumHeightPx(size) }}>
      <div className="podium-art" aria-hidden="true">
        <canvas ref={canvasRef} className="podium-canvas" style={{ width: L.cols * CELL_PX, height: L.rows * CELL_PX }} />
        {mode === 'ghost' && (
          <span
            className="board-ghost podium-sprite"
            style={{
              left: Math.round((middle.step.x + middle.step.w / 2) * CELL_PX - GHOST_W / 2),
              top: middle.step.y * CELL_PX - GHOST_H - GHOST_LIFT,
            }}
          />
        )}
        {/* The bursts, clipped to the box: a landing never paints over the board's head. */}
        <div className="podium-bursts">
          {bursting === stage.build &&
            shown.map((at) => {
              if (!tl.fall[at.p]) return null;
              const first = L.places[at.p].tier === 0;
              return (
                <span
                  key={`${stage.build}:${at.key}`}
                  className={`podium-burst${first ? ' first' : ''}`}
                  style={{ left: at.mark.left + at.mark.size / 2, top: at.mark.top + at.mark.size / 2 }}
                >
                  <Strike
                    id={at.p + 1}
                    art={BURST_ART}
                    color={first ? 'var(--accent)' : progressHeatColor(at.entry.near)}
                    delayMs={tl.land[at.p] ?? 0}
                  />
                </span>
              );
            })}
        </div>
        {leaving.build === stage.build &&
          leaving.entries.map((at) => (
            <span key={`out:${at.key}`}>
              <span
                className="podium-mark out"
                style={{ left: at.mark.left, top: at.mark.top, translate: `${at.dx * CELL_PX}px ${at.dy * CELL_PX}px` }}
              >
                <Avatar avatar={at.entry.player.avatar ?? defaultAvatar(at.entry.player.publicId)} size={at.mark.size} sharp />
              </span>
              <Caption at={at} className=" out" />
            </span>
          ))}
        {shown.map((at) => {
          const { p } = at;
          // How this player comes: dropping (a build), dissolving in (a board already shown), or
          // already standing there.
          const how = stage.spec.stood[p] ? '' : tl.fall[p] ? ' drop' : ' in';
          return (
            <span key={at.key}>
              <span
                ref={(el) => {
                  markRefs.current[p] = el;
                }}
                className={`podium-mark${how === ' in' ? ' in' : ''}`}
                style={{
                  left: at.mark.left,
                  top: at.mark.top,
                  // Placed by the clock from its first frame; until then, where it rests.
                  visibility: tl.fall[p] ? 'hidden' : undefined,
                }}
              >
                <Avatar avatar={at.entry.player.avatar ?? defaultAvatar(at.entry.player.publicId)} size={at.mark.size} sharp />
              </span>
              <Caption
                at={at}
                className={how}
                style={{ '--at': `${tl.land[p] ?? 0}ms` } as CSSProperties}
                unitWas={stage.unitWas[p]}
              />
            </span>
          );
        })}
      </div>
      {/* The empty board's caption: its line on the names' band, its call on the values' row —
          one height in every empty state, bare ground where there is no line. */}
      {mode === 'ghost' && ghost && (
        <div className="podium-hold caption" style={{ top: L.name * CELL_PX }}>
          <span className="podium-hold-line" style={{ height: NAME_ROWS * CELL_PX }}>
            {ghost.line}
          </span>
          {ghost.call}
        </div>
      )}
      {mode === 'failed' && failed && <div className="podium-hold">{failed}</div>}
    </div>
  );
}
