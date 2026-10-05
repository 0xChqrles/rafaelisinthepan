import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  ghostChainCells,
  recordBeats,
  recordLayout,
  recordScene,
  sideReelsAt,
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
// and its words stand from the first frame, the count's box and the two numbers' boxes held as
// the stippled slate — breathing while a read is out, still once one has failed.

const FRAME_MS = 50;
// Held frame under reduced motion: the settled picture, its foil and flame at this instant.
const STILL_T = 2600;

// Built once a page load: a later visit to the screen finds the record standing.
let built = false;
// When the building count LANDS (its last reel's stop), on the animation clock: what the
// page's later arrivals (the devices' lines) wait for.
let landsAt: number | null = null;

// How long until the record's count lands — 0 once it stands, or under reduced motion. Asked
// before the numbers are even here (the devices can answer first), it waits the whole build.
export function recordLandsIn(): number {
  if (prefersReducedMotion()) return 0;
  if (landsAt !== null) return Math.max(0, landsAt - clockNow());
  return built ? 0 : recordBeats(true).impact + 120;
}

export type RecordPhase = 'loading' | 'failed' | 'ready';

export default function Record({
  lang,
  stats,
  week,
  phase,
  compact = false,
}: {
  lang: string;
  stats: { streak: number; best: number; days: number } | null;
  week: readonly AccountWeekDay[] | null;
  phase: RecordPhase;
  // A short screen: the count one size down, so the page's call still fits above the edge.
  compact?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [reduced] = useState(prefersReducedMotion);
  const today = useToday();
  const initials = useMemo(() => mondayNarrowLabels(lang), [lang]);
  const ready = stats !== null && week !== null;
  const streak = stats?.streak ?? 0;
  const L = useMemo(() => recordLayout(width, streak, compact), [width, streak, compact]);
  const todayIndex = useMemo(() => weekView([], today).cells.findIndex((c) => c.isToday), [today]);

  // Whether THIS mount plays the build: decided once, the first time the numbers are here —
  // in the render that draws them, so the reels mounting with them know it too.
  const buildRef = useRef<boolean | null>(null);
  if (ready && buildRef.current === null) buildRef.current = !built && !reduced;
  const build = buildRef.current;
  useEffect(() => {
    if (ready) built = true;
  }, [ready]);
  const beats = useMemo(() => recordBeats(build === true), [build]);

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
      // The chain's place, held as its ghosts while the numbers are out.
      const rail = hexToAbgr(INKS[RAIL - 1]);
      for (const at of ghostChainCells(L)) px[at] = rail;
      ctx.putImageData(image, 0, 0);
      return undefined;
    }
    const scene = recordScene(L, streak, week, beats);
    const ink = new Uint8Array(L.cols * L.rows);
    const palette = new Uint32Array([0, ...INKS.map(hexToAbgr)]);
    const foil = { u: new Float32Array(ink.length), phase: new Float32Array(ink.length) };
    const seed = foilSeed(`record:${today}`);
    startRef.current ??= clockNow();
    const start = startRef.current;
    if (build) landsAt = start + beats.impact;
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
  }, [L, ready, build, beats, week, streak, reduced, today, width]);

  const side = (value: number | undefined, label: string, i: number) => (
    <div className="record-side">
      {/* A reel at rest stands on 0, and a 0 is a claim: a building number is not there at all
          until its reels start (`--at`), then spins in. */}
      <span
        className={`record-side-value${build ? ' spins' : ''}${value === 0 ? ' zero' : ''}`}
        style={{ '--at': `${sideReelsAt(beats, i)}ms` } as CSSProperties}
      >
        {value === undefined ? (
          <StatSlot phase={phase} />
        ) : (
          <ReelNumber value={value} delayMs={build ? sideReelsAt(beats, i) : 0} runMs={build ? SIDE_RUN_MS : 0} />
        )}
      </span>
      <span className="record-side-label">{label}</span>
    </div>
  );

  return (
    <div className={`record${ready ? ' ready' : ''}`}>
      <div ref={box} className="record-art" style={{ height: L.rows * RECORD_CELL_PX }} aria-hidden="true">
        <canvas
          ref={canvasRef}
          className="record-canvas"
          style={{ width: L.cols * RECORD_CELL_PX, height: L.rows * RECORD_CELL_PX }}
        />
        {!ready && width > 0 && (
          <StatSlot
            phase={phase}
            className="record-slot"
            style={{
              left: L.count.x * RECORD_CELL_PX,
              top: L.count.y * RECORD_CELL_PX,
              width: L.count.w * RECORD_CELL_PX,
              height: L.count.h * RECORD_CELL_PX,
            }}
          />
        )}
        <span className="record-unit" style={{ top: L.unitY }}>
          {t(lang, 'dayStreak')}
        </span>
        {width > 0 &&
          L.labels.map((at, i) => (
            <span
              key={i}
              className={`record-day${i === todayIndex ? ' today' : ''}`}
              style={{ left: at.x, top: at.y }}
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
