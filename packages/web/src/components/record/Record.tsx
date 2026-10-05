import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { mondayNarrowLabels, weekView } from '../../game/streak';
import { t } from '../../i18n';
import useToday from '../../hooks/useToday';
import { prefersReducedMotion } from '../../hooks/useScramble';
import type { AccountWeekDay } from '../../state/history';
import { clockNow } from '../animationClock';
import { foilSeed } from '../foil';
import { hexToAbgr } from '../raster';
import { LOOP_FRAME_MS, watchRaster } from '../rasterWatch';
import ReelNumber from '../ReelNumber';
import { FOIL, FOIL_DEEP, INKS, RAIL, foilInk } from '../streak/sprites';
import { StatSlot } from '../AccountStats';
import {
  RECORD_CELL_PX,
  SIDE_RUN_MS,
  SLOT_STEP_MS,
  recordBeats,
  recordCalm,
  recordLayout,
  recordScene,
  sideReelsAt,
  slotCells,
  slotLevel,
  type RecordSize,
} from './scene';

// THE RECORD — `/account`'s subject (the picture itself is `scene.ts`): the streak in the
// streak celebration's own language — its blue pixel FLAME over the big count on the count's
// reels, the week as the CHAIN beneath it, today's link struck into FOIL once it is played —
// its words standing where the scene's layout says (the unit, the initials, today's in the
// white chip), and under it all BEST and DAYS, the account's two other numbers, on the count's
// reels either side of the stippled rail.
//
// THE CLOCK is the document's animation timeline (the reels' Web Animations run on it too).
// The scene BUILDS once a page load — the first time the numbers land on it; a later visit
// finds it standing, the podium's rule for a board already shown — stepping every frame until
// it settles; then only the flame (or the pilot), today's open link and the foil move, at the
// loops' slow pace, and the clock RESTS while nobody can see it or nobody is there
// (`rasterWatch`). Reduced motion draws the settled frame and runs no clock at all.
//
// The values are WITHHELD until every collection has landed (`useAccountStats`): the layout
// and its words stand from the first frame, the count's box, the two numbers' boxes and the
// chain's links held as the stippled slate — breathing while a read is out, still once one has
// failed, when the count's box is the tap that asks again. The count's box and the chain's
// slots are the raster's own; the two numbers' are DOM slots. A build STARTS from that picture:
// each box stands until its own number's reels start, each link's slot until the link dithers
// in over it.

const FRAME_MS = 50;
// Held frame under reduced motion: the settled picture, its foil and flame at this instant.
const STILL_T = 2600;

// Built once a page load: a later visit to the screen finds the record standing.
let built = false;

// WHEN THE RECORD HAS CALMED (`recordCalm`), on the animation clock — what the page's later
// arrivals (the devices' lines) wait for. Null until the record has started: a record still
// waiting for its numbers holds them back too, and one that cannot have them (a failed read)
// lets them in at once.
let calmAt: number | null = null;
const calmListeners = new Set<() => void>();
function setCalm(at: number | null): void {
  if (calmAt === at) return;
  calmAt = at;
  for (const listener of calmListeners) listener();
}
const subscribeCalm = (listener: () => void) => {
  calmListeners.add(listener);
  return () => {
    calmListeners.delete(listener);
  };
};
// The clock time the record calms at (now or earlier: at once), or null while it has not begun.
export function useRecordCalm(): number | null {
  return useSyncExternalStore(subscribeCalm, () => calmAt);
}

export type RecordPhase = 'loading' | 'failed' | 'ready';

export default function Record({
  lang,
  stats,
  week,
  phase,
  size = 'normal',
  onRetry,
}: {
  lang: string;
  stats: { streak: number; best: number; days: number } | null;
  week: readonly AccountWeekDay[] | null;
  phase: RecordPhase;
  // The screen's height: the count one whole size up or down (`RecordSize`).
  size?: RecordSize;
  // Ask for the numbers again after a failed read.
  onRetry?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [reduced] = useState(prefersReducedMotion);
  const today = useToday();
  const initials = useMemo(() => mondayNarrowLabels(lang), [lang]);
  const ready = stats !== null && week !== null;
  const streak = stats?.streak ?? 0;
  const L = useMemo(() => recordLayout(width, streak, size), [width, streak, size]);
  const todayIndex = useMemo(() => weekView([], today).cells.findIndex((c) => c.isToday), [today]);

  // Whether THIS mount plays the build: decided once, the first time the numbers are here —
  // in the render that draws them, so the reels mounting with them know it too.
  const buildRef = useRef<boolean | null>(null);
  if (ready && buildRef.current === null) buildRef.current = !built && !reduced;
  const build = buildRef.current;
  useEffect(() => {
    if (ready) built = true;
  }, [ready]);
  const beats = useMemo(() => recordBeats(build === true, streak > 0), [build, streak]);

  // The page's later arrivals: held while the numbers are out, let in once the record calms
  // (at once when it stands already), and at once when the numbers cannot be had.
  useEffect(() => {
    if (phase === 'failed' && !ready) setCalm(clockNow());
    else if (!ready) setCalm(null);
  }, [phase, ready]);

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

  // A clock per scene: its start is the moment the numbers landed, kept across a re-layout.
  const startRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || width <= 0) return undefined;
    canvas.width = L.cols;
    canvas.height = L.rows;
    const image = ctx.createImageData(L.cols, L.rows);
    const px = new Uint32Array(image.data.buffer);
    if (!ready || build === null || !week) {
      // The count's box and the chain's place, held as the slate's checker — breathing while
      // the read is out.
      const rail = hexToAbgr(INKS[RAIL - 1]);
      const breathing = phase === 'loading' && !reduced;
      let timer = 0;
      const hold = () => {
        px.fill(0);
        for (const at of slotCells(L, slotLevel(clockNow(), breathing))) px[at] = rail;
        ctx.putImageData(image, 0, 0);
        if (breathing) timer = window.setTimeout(hold, SLOT_STEP_MS);
      };
      hold();
      return () => window.clearTimeout(timer);
    }
    const scene = recordScene(L, streak, week, beats);
    const ink = new Uint8Array(L.cols * L.rows);
    const palette = new Uint32Array([0, ...INKS.map(hexToAbgr)]);
    const foil = { u: new Float32Array(ink.length), phase: new Float32Array(ink.length) };
    const seed = foilSeed(`record:${today}`);
    startRef.current ??= clockNow();
    const start = startRef.current;
    setCalm(build ? start + recordCalm(beats, week) : clockNow());
    const paint = (at: number) => {
      scene.draw(ink, at, foil);
      const seconds = at / 1000;
      for (let i = 0; i < ink.length; i += 1) {
        const v = ink[i];
        if (v === FOIL || v === FOIL_DEEP) {
          const x = i % L.cols;
          px[i] = foilInk(x, (i - x) / L.cols, foil.u[i], foil.phase[i], seconds, seed, v === FOIL_DEEP);
        } else px[i] = palette[v];
      }
      ctx.putImageData(image, 0, 0);
    };
    if (reduced) {
      paint(STILL_T);
      return undefined;
    }
    let timer = 0;
    let stopped = false;
    const tick = () => {
      timer = 0;
      if (stopped || !watch.seen()) return;
      const at = clockNow() - start;
      // At rest the loop steps only while somebody is there; the build always runs out.
      if (at >= beats.settled && !watch.awake()) return;
      paint(at);
      timer = window.setTimeout(tick, at < beats.settled ? FRAME_MS : LOOP_FRAME_MS);
    };
    const watch = watchRaster(canvas, () => {
      if (!stopped && !timer && watch.seen()) tick();
    });
    tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      watch.stop();
    };
  }, [L, ready, build, beats, week, streak, reduced, today, width, phase]);

  // A box held as the slate until its number's reels start: before the numbers (breathing, or
  // still after a failure), and through a build's first beats.
  const held = (at: number, className = '') => (
    <StatSlot
      phase={phase === 'failed' ? 'failed' : 'loading'}
      className={`${className}${ready ? ' record-hold' : ''}`}
      style={{ '--at': `${at}ms` } as CSSProperties}
    />
  );

  const side = (value: number | undefined, label: string, i: number) => (
    <div className="record-side">
      <span className={`record-side-value${value === 0 ? ' zero' : ''}`}>
        {(value === undefined || build) && held(build ? sideReelsAt(beats, i) : 0)}
        {value !== undefined && (
          // A reel at rest stands on 0, and a 0 is a claim: a building number is not there at
          // all until its reels start (`--at`), then spins in out of its slot.
          <span
            className={`record-side-reel${build ? ' spins' : ''}`}
            style={{ '--at': `${sideReelsAt(beats, i)}ms` } as CSSProperties}
          >
            {/* (A zero never spins: a reel of digits landing on nothing reads as a number lost.) */}
            <ReelNumber
              value={value}
              delayMs={build ? sideReelsAt(beats, i) : 0}
              runMs={build && value > 0 ? SIDE_RUN_MS : 0}
            />
          </span>
        )}
      </span>
      <span className="record-side-label">{label}</span>
    </div>
  );

  const countBox: CSSProperties = {
    left: L.ox + L.count.x * RECORD_CELL_PX,
    top: L.count.y * RECORD_CELL_PX,
    width: L.count.w * RECORD_CELL_PX,
    height: L.count.h * RECORD_CELL_PX,
  };

  return (
    <div className={`record${ready ? ' ready' : ''}`}>
      <div ref={box} className="record-art" style={{ height: L.rows * RECORD_CELL_PX }}>
        <canvas
          ref={canvasRef}
          className="record-canvas"
          style={{ left: L.ox, width: L.cols * RECORD_CELL_PX, height: L.rows * RECORD_CELL_PX }}
          aria-hidden="true"
        />
        {/* A failed read: the count's held box (the raster's still checker) is the tap that
            asks again. */}
        {width > 0 && phase === 'failed' && !ready && (
          <button
            type="button"
            className="record-slot record-retry"
            style={countBox}
            aria-label={`${t(lang, 'failedHistory')} — ${t(lang, 'retry')}`}
            onClick={onRetry}
          />
        )}
        <span
          className="record-unit"
          style={{ top: L.unitY, width: 2 * L.unitX }}
          aria-hidden="true"
        >
          {t(lang, 'dayStreak')}
        </span>
        {width > 0 &&
          L.labels.map((at, i) => (
            <span
              key={i}
              className={`record-day${i === todayIndex ? ' today' : ''}`}
              style={{ left: at.x, top: at.y }}
              aria-hidden="true"
            >
              {initials[i]}
            </span>
          ))}
      </div>
      {stats && (
        <span className="sr-only">
          {stats.streak} {t(lang, 'dayStreak')}
        </span>
      )}
      <div className="record-sides">
        {side(stats?.best, t(lang, 'statBest'), 0)}
        <span className="stat-rule" aria-hidden="true" />
        {side(stats?.days, t(lang, 'statDays'), 1)}
      </div>
    </div>
  );
}
