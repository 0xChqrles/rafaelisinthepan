import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { COUNT_STILL_S, bayerThreshold, progressHeatColor } from '@whippin/shared';
import { clockNow } from '../animationClock';
import { DISSOLVE_MS } from '../bayerTiles';
import { FRAME_MS, turnLevel } from '../podium/scene';
import Strike from '../Strike';
import { BURST_ART } from '../strikeArt';
import { useDeviceIdentity } from '../../identity';
import { prefersReducedMotion } from '../../hooks/useScramble';
import { BLEED, CELL_PX, type CalGeometry } from './geometry';
import {
  codeOf,
  keysBeats,
  keysScene,
  type KeyChange,
  type KeysBeats,
  type KeysModel,
  type KeysScene,
  type KeysSpec,
} from './keysScene';
import { drawnOf, isBuilt, isStamped, markBuilt, markStamped, rememberDrawn, type DrawnCode } from './memory';

// THE MONTH'S ONE CANVAS: the keys scene (`keysScene.ts`) on the raster recipe the podium
// uses — one backing pixel a house cell, upscaled `pixelated`, laid over the grid with a bleed
// of BLEED cells round it — on the page's ONE animation clock (`clockNow`: the CSS dissolves'
// own timeline, so a slowed recording slows both), stepping every FRAME_MS until the scene has
// settled. Then THE CLOCK RESTS: only today's foil moves, repainted over a stored resting
// frame at the foil's own slow pace, and only while somebody can see it (on screen, a visible
// tab, a touch, key, wheel or scroll in the last IDLE_MS); a month still being read keeps its
// read wave going while it is seen, idle or not — a loading month must keep reading as one.
// Reduced motion draws the landed frame once and runs no clock.
//
// WHICH SCENE, off what was on screen before it (`plan`): a month shown for the first time
// today ARRIVES (built once per day and account, the memory's BUILT) — at the opening's pace,
// or under a turn's quicker one — and today DROPS once per day (STAMPED); a month already
// built stands SETTLED, and any day that says something else than when it was last DRAWN plays
// its change. A turn gives way from the frame on screen cell by cell (the podium's `turnLevel`);
// a read landing on the month on screen gives way KEY BY KEY — the scene before plays on under
// each key's cells not lit yet (the loading checker and its wave, a turn still finishing) — as
// does a changed day. A resize re-seats the scene at the same moment, never replaying it. The
// press is a one-shot redraw: it shows whether the clock runs or rests.
//
// A PICTURE only (hidden from a screen reader): the grid's buttons over it carry every day's
// date, status and tap.

// The foil and the read wave step at the meter's pace: pixel art has nothing to gain from 60fps.
const LOOP_FRAME_MS = 80;
// After this long without a touch, a key, a wheel or a scroll, the foil holds its frame.
const IDLE_MS = 9000;

// Today's foil seed, off its day: every day's foil its own picture.
function seedOf(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return ((h >>> 0) % 997) + 0.5;
}

// The model's identity: a new one is a new scene.
const signatureOf = (model: KeysModel) =>
  `${model.phase}|${model.today}|${model.keys
    .map((key) => (key.kind === 'progress' ? `p${key.pct}` : key.kind.slice(0, 2)))
    .join(',')}`;

// A month's readings by date, as the DRAWN memory keeps them.
function codesOf(model: KeysModel, cells: readonly (string | null)[]): Map<string, DrawnCode> {
  const codes = new Map<string, DrawnCode>();
  model.keys.forEach((key, i) => {
    const date = cells[i];
    const code = codeOf(key);
    if (date && code) codes.set(date, code);
  });
  return codes;
}

// The days that read differently from `was`.
function changesFrom(model: KeysModel, cells: readonly (string | null)[], was: ReadonlyMap<string, DrawnCode>): KeyChange[] {
  const changes: KeyChange[] = [];
  model.keys.forEach((key, i) => {
    const date = cells[i];
    const code = codeOf(key);
    const from = date ? was.get(date) : undefined;
    if (code && from && from !== code) changes.push({ index: i, from });
  });
  return changes;
}

// A scene on screen: its clock's start, what a turn gives way from (the frame on screen as it
// began), and — a read landing, a day changing — the scene it replaced, still playing under the
// keys not come in yet, drawn each frame into `buf` (the frame the keys give way from).
interface Layer {
  id: string;
  scene: KeysScene;
  start: number;
  from: Uint32Array | null;
  under: Layer | null;
  buf: Uint32Array | null;
  size: number;
}

// A layer's frame at `now`: what plays under it first, then its scene, then the turn's giving
// way — cells the Bayer order has not reached yet still the frame before.
function compose(layer: Layer, px: Uint32Array, now: number, pressed: number, cols: number): void {
  const t = now - layer.start;
  if (layer.under && layer.buf) {
    // Once every key has come in, nothing stands on the scene before any more.
    if (t < layer.scene.settled) compose(layer.under, layer.buf, now, -1, cols);
    else layer.under = null;
  }
  layer.scene.draw(px, t, true, pressed);
  if (!layer.from || t >= DISSOLVE_MS) return;
  const from = layer.from;
  const lv = turnLevel(t);
  for (let i = 0; i < px.length; i += 1) if (bayerThreshold(i % cols, Math.floor(i / cols)) >= lv) px[i] = from[i];
}

interface Shown {
  month: string;
  sig: string;
  activeDay: number;
  model: KeysModel;
  cells: readonly (string | null)[];
}

interface Stage extends Shown {
  id: string;
  spec: KeysSpec;
  beats: KeysBeats;
  // How it gives way from the frame on screen: the whole raster (a turn), key by key (a read
  // landing, a change), or not at all (the first frame).
  give: 'turn' | 'keys' | null;
  marks: { built: boolean; stamped: boolean };
}

// THE NEXT SCENE, from the one on screen (see the header).
function plan(prev: Shown | null, next: Shown, lang: string, accountId: string | null, motion: boolean): Omit<Stage, 'id'> {
  const { model, month, activeDay } = next;
  const same = prev !== null && prev.month === month;
  const base: KeysSpec = { model, build: null, drop: null, changes: [], digitsIn: false, ghostsIn: false, motion };
  const stage = (spec: KeysSpec, give: Stage['give'], marks = { built: false, stamped: false }) => ({
    ...next,
    spec,
    beats: keysBeats(spec),
    give: motion ? give : null,
    marks,
  });
  if (!motion) {
    const marks = { built: model.phase === 'data', stamped: model.phase === 'data' && model.today >= 0 };
    return stage(base, null, marks);
  }
  if (model.phase !== 'data') {
    // The numbers come in at the screen's opening; a turn brings them in with it. The ghosts
    // wait the skeleton's wait, unless they already stand (a failed read asked again, a read
    // failing while they stood).
    const standing = same && prev.model.phase !== 'data';
    return stage({ ...base, digitsIn: prev === null, ghostsIn: !standing }, prev === null ? null : 'turn');
  }
  const today = model.today;
  const stampNow = today >= 0 && !isStamped(lang, activeDay);
  // THE FLIP: the same month across 22:00 — everything stands, the new today drops at once.
  if (same && prev.model.phase === 'data' && prev.activeDay !== activeDay) {
    return stage(
      { ...base, drop: stampNow ? 'flip' : null, changes: changesFrom(model, next.cells, codesOf(prev.model, prev.cells)) },
      'keys',
      { built: true, stamped: stampNow },
    );
  }
  // A READ LANDING on the month on screen (or a fresh answer to it): what it was drawn saying —
  // the frame on screen, if it showed data; else the memory.
  const built = isBuilt(activeDay, accountId, lang, month);
  if (same && prev.model.phase === 'data') {
    return stage({ ...base, changes: changesFrom(model, next.cells, codesOf(prev.model, prev.cells)) }, 'keys');
  }
  const give: Stage['give'] = same ? 'keys' : prev === null ? null : 'turn';
  if (!built) {
    const build = same || prev === null ? 'arrive' : 'turn';
    return stage({ ...base, build, drop: stampNow ? 'build' : null }, give, { built: true, stamped: stampNow });
  }
  const drawn = drawnOf(accountId, lang, month);
  return stage({ ...base, changes: drawn ? changesFrom(model, next.cells, drawn) : [] }, give);
}

export default function MonthRaster({
  G,
  lang,
  month,
  activeDay,
  cells,
  model,
  pressed,
}: {
  G: CalGeometry;
  lang: string;
  // The month shown ("YYYY-MM") and the active game day (the memories' scope).
  month: string;
  activeDay: number;
  // The grid's dates (null: a pad), the cells the model describes.
  cells: readonly (string | null)[];
  model: KeysModel;
  // The key held down (its cell), or -1.
  pressed: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const accountId = useDeviceIdentity()?.accountId ?? null;
  const [reduced] = useState(prefersReducedMotion);
  // The frame on screen (what the next scene gives way from), and the scene committed last.
  const lastFrame = useRef<Uint32Array | null>(null);
  const shownRef = useRef<Stage | null>(null);
  const counter = useRef(0);
  const sig = signatureOf(model);

  const stage = useMemo<Stage>(() => {
    counter.current += 1;
    const planned = plan(shownRef.current, { month, sig, activeDay, model, cells }, lang, accountId, !reduced);
    return { ...planned, id: `${month}|${sig}|${activeDay}|${counter.current}` };
    // A new scene when what it shows changes — never for a re-render (a press, a resize).
  }, [month, sig, activeDay]);
  // What a turn gives way FROM: the frame on screen as it was decided.
  const fromRef = useRef<{ id: string; px: Uint32Array | null } | null>(null);
  if (fromRef.current?.id !== stage.id) {
    fromRef.current = { id: stage.id, px: stage.give === 'turn' && lastFrame.current ? lastFrame.current.slice() : null };
  }
  // The scene on screen, with what plays on under it.
  const layerRef = useRef<Layer | null>(null);

  useEffect(() => {
    shownRef.current = stage;
    if (stage.marks.built) markBuilt(activeDay, accountId, lang, month);
    if (stage.marks.stamped) markStamped(lang, activeDay);
  }, [stage.id]);

  // The press reaches the clock through a ref; at rest it redraws once.
  const pressedRef = useRef(pressed);
  const redrawRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    pressedRef.current = pressed;
    redrawRef.current?.();
  }, [pressed]);

  // THE CLOCK's start, once per scene: a new layout redraws the same moment.
  const startRef = useRef<{ id: string; at: number } | null>(null);
  // The bursts are up while the scene plays out.
  const [bursting, setBursting] = useState<string | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;
    canvas.width = G.cols;
    canvas.height = G.rows;
    const image = ctx.createImageData(G.cols, G.rows);
    const px = new Uint32Array(image.data.buffer);
    lastFrame.current = px;
    // (A new layout keeps the scene's start; only a new scene starts the clock, and its bursts.)
    const fresh = startRef.current?.id !== stage.id;
    if (fresh) startRef.current = { id: stage.id, at: clockNow() };
    const start = startRef.current!.at;
    const elapsed = () => clockNow() - start;
    const taken = fromRef.current?.id === stage.id ? fromRef.current.px : null;
    const from = !reduced && taken && taken.length === px.length ? taken : null;
    // A read landing, a day changing: the scene it replaces plays on under the keys not come in
    // yet (the loading wave going on, a turn still giving way finishing) — at the same size.
    const previous = layerRef.current;
    const below = reduced || stage.give !== 'keys' ? null : previous?.id === stage.id ? previous.under : previous;
    const under = below && below.size === px.length ? below : null;
    const buf = under ? new Uint32Array(px.length) : null;
    const today = stage.model.today;
    const seed = seedOf(`${lang}${today >= 0 ? stage.cells[today] : month}`);
    const scene = keysScene(G, stage.model, stage.beats, seed, buf);
    const layer: Layer = { id: stage.id, scene, start, from, under, buf, size: px.length };
    layerRef.current = layer;
    const until = Math.max(scene.settled, from ? DISSOLVE_MS : 0);

    // What the scene settles SAYING, for the next showing's changes.
    const remember = () => {
      if (stage.model.phase === 'data') rememberDrawn(accountId, lang, month, codesOf(stage.model, stage.cells));
    };
    // At rest, the frame without its foil is kept, and the foil alone is repainted over it.
    let rest: Uint32Array | null = null;
    const settle = (t: number) => {
      rest = new Uint32Array(px.length);
      scene.draw(rest, t, false, pressedRef.current);
      px.set(rest);
      scene.foil(px, rest, t, pressedRef.current);
      ctx.putImageData(image, 0, 0);
    };

    if (reduced) {
      // The held frame: the landed picture, its foil at the count's own still instant.
      const t = Math.max(scene.settled, COUNT_STILL_S * 1000);
      settle(t);
      remember();
      redrawRef.current = () => settle(t);
      return () => {
        redrawRef.current = null;
      };
    }

    let timer = 0;
    let stopped = false;
    let inView = true;
    let awake = true;
    let idle = 0;
    if (fresh) setBursting(stage.beats.bursts.length > 0 ? stage.id : null);
    const tick = () => {
      timer = 0;
      if (stopped || !inView || document.hidden) return;
      const t = elapsed();
      if (t < until) {
        compose(layer, px, start + t, pressedRef.current, G.cols);
        ctx.putImageData(image, 0, 0);
        timer = window.setTimeout(tick, FRAME_MS);
        return;
      }
      if (rest === null) {
        settle(t);
        remember();
        setBursting(null);
      } else if (scene.loop === 'wave') {
        scene.draw(px, t, false, pressedRef.current);
        ctx.putImageData(image, 0, 0);
      } else if (scene.loop === 'foil') {
        // Nobody there: the foil holds its frame until a touch wakes it.
        if (!awake) return;
        scene.foil(px, rest, t, pressedRef.current);
        for (const b of scene.foilBoxes) ctx.putImageData(image, 0, 0, b.x, b.y, b.w, b.h);
      }
      if (scene.loop !== null) timer = window.setTimeout(tick, LOOP_FRAME_MS);
    };
    const wake = () => {
      if (!stopped && !timer && inView && !document.hidden) tick();
    };
    // A press shown or released: the running clock draws it on its next frame; at rest it is
    // drawn now.
    redrawRef.current = () => {
      if (rest === null || stopped) return;
      settle(elapsed());
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
      redrawRef.current = null;
      window.clearTimeout(timer);
      window.clearTimeout(idle);
      io?.disconnect();
      document.removeEventListener('visibilitychange', wake);
      for (const name of events) window.removeEventListener(name, touched, { capture: true });
    };
    // A scene per stage and per layout; the data is the stage's.
  }, [G, stage.id, reduced]);

  // A key's centre in the raster's box, in CSS px.
  const centre = (i: number) => ({
    left: (BLEED + (i % 7) * (G.keyW + G.colGap) + G.keyW / 2) * CELL_PX,
    top: (BLEED + Math.floor(i / 7) * (G.keyH + G.rowGap) + G.keyH / 2) * CELL_PX,
  });
  const burstInk = (i: number) => {
    const key = stage.model.keys[i];
    return key.kind === 'solved' ? 'var(--accent)' : key.kind === 'progress' ? progressHeatColor(key.pct) : 'var(--fg)';
  };
  return (
    <>
      {/* The bursts UNDER the raster, clipped to its box: a landing flares through the ground
          round its key, never over a neighbour's face. */}
      <div className="cal-bursts" aria-hidden="true">
        {bursting === stage.id &&
          stage.beats.bursts.map((burst) => (
            <span key={`${stage.id}:${burst.index}`} className="cal-burst" style={centre(burst.index)}>
              <Strike id={burst.index} art={BURST_ART} color={burstInk(burst.index)} delayMs={burst.at} />
            </span>
          ))}
      </div>
      <canvas
        ref={canvasRef}
        className="cal-raster"
        aria-hidden="true"
        style={{ width: G.cols * CELL_PX, height: G.rows * CELL_PX }}
      />
    </>
  );
}
