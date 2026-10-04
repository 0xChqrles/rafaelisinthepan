import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { COUNT_STILL_S, bayerThreshold, progressHeatColor } from '@whippin/shared';
import { clockNow } from '../animationClock';
import { DISSOLVE_MS } from '../bayerTiles';
import { foilSeed } from '../foil';
import { FRAME_MS, turnLevel } from '../podium/scene';
import Strike from '../Strike';
import { BURST_ART } from '../strikeArt';
import { useDeviceIdentity } from '../../identity';
import { prefersReducedMotion } from '../../hooks/useScramble';
import { BLEED, CELL_PX, HEADROOM, type CalGeometry } from './geometry';
import { keysScene, type KeysModel, type KeysScene } from './keysScene';
import { markBuilt, markStamped, rememberDrawn } from './memory';
import { codesOf, nextStage, stageId, type Shown, type Stage, type Viewer } from './plan';

// THE MONTH'S ONE CANVAS: the keys scene (`keysScene.ts`) on the raster recipe the podium
// uses — one backing pixel a house cell, upscaled `pixelated`, laid over the grid with a bleed
// round it — on the page's ONE animation clock (`clockNow`: the CSS dissolves' own timeline,
// so a slowed recording slows both), stepping every FRAME_MS until the scene has settled. Then
// THE CLOCK RESTS: only today's foil moves, repainted over a stored resting frame at the foil's
// own slow pace, and only while somebody can see it (on screen, a visible tab, a touch, key,
// wheel or scroll in the last IDLE_MS); a month still being read keeps its read wave going
// while it is seen, idle or not — a loading month must keep reading as one. Reduced motion
// draws the landed frame once and runs no clock.
//
// WHICH SCENE (`plan.ts`) is LATCHED whenever what the raster shows changes, read off the
// stage before it — never for a re-render (a press, a resize). A turn gives way from the frame
// on screen cell by cell (the podium's `turnLevel`); a read landing on the month on screen
// gives way KEY BY KEY — the scene before plays on under each key's cells not lit yet (the
// loading checker and its wave, a turn still finishing), though nothing in it that had not
// begun to come in by then ever does — as does a changed day. A resize re-seats the scene at
// the same moment, never replaying it. The press is a one-shot redraw: it shows whether the
// clock runs or rests.
//
// A PICTURE only (hidden from a screen reader): the grid's buttons over it carry every day's
// date, status and tap.

// The foil and the read wave step at the meter's pace: pixel art has nothing to gain from 60fps.
const LOOP_FRAME_MS = 80;
// After this long without a touch, a key, a wheel or a scroll, the foil holds its frame.
const IDLE_MS = 9000;

// A scene on screen: its clock's start, what a turn gives way from (the frame on screen as it
// began), and — a read landing, a day changing — the scene it replaced, still playing under the
// keys not come in yet, drawn each frame into `buf` (the frame the keys give way from), up to
// `until`, its own time when it was replaced.
interface Layer {
  id: string;
  scene: KeysScene;
  start: number;
  from: Uint32Array | null;
  under: Layer | null;
  buf: Uint32Array | null;
  size: number;
  until: number;
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
  layer.scene.draw(px, t, true, pressed, layer.until);
  if (!layer.from || t >= DISSOLVE_MS) return;
  const from = layer.from;
  const lv = turnLevel(t);
  for (let i = 0; i < px.length; i += 1) if (bayerThreshold(i % cols, Math.floor(i / cols)) >= lv) px[i] = from[i];
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

  // THE STAGE, latched when what is shown changes (Leaderboard's podium does the same).
  const viewer: Viewer = { lang, accountId, motion: !reduced };
  const shown: Shown = { month, activeDay, model, cells };
  const [stage, setStage] = useState<Stage | null>(null);
  let staged = stage;
  if (staged === null || staged.id !== stageId(shown, viewer)) {
    staged = nextStage(stage, shown, viewer);
    setStage(staged);
  }
  const id = staged.id;

  useEffect(() => {
    if (staged.marks.built) markBuilt(staged.activeDay, accountId, lang, staged.month);
    if (staged.marks.stamped) markStamped(lang, staged.activeDay);
  }, [staged]);

  // The press reaches the clock through a ref; at rest it redraws once.
  const pressedRef = useRef(pressed);
  const redrawRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    pressedRef.current = pressed;
    redrawRef.current?.();
  }, [pressed]);

  // The frame on screen (what the next scene gives way from); the scene's clock start and the
  // frame it turns from, once per scene (a new layout redraws the same moment); the scene on
  // screen, with what plays on under it.
  const lastFrame = useRef<Uint32Array | null>(null);
  const startRef = useRef<{ id: string; at: number; from: Uint32Array | null } | null>(null);
  const layerRef = useRef<Layer | null>(null);
  // The bursts are up while the scene plays out.
  const [bursting, setBursting] = useState<string | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;
    // (A new layout keeps the scene's start; only a new scene starts the clock, and its bursts.)
    const fresh = startRef.current?.id !== id;
    if (fresh) {
      const turnFrom = staged.give === 'turn' && lastFrame.current ? lastFrame.current.slice() : null;
      startRef.current = { id, at: clockNow(), from: turnFrom };
    }
    const { at: start, from: taken } = startRef.current!;
    canvas.width = G.cols;
    canvas.height = G.rows;
    const image = ctx.createImageData(G.cols, G.rows);
    const px = new Uint32Array(image.data.buffer);
    lastFrame.current = px;
    const elapsed = () => clockNow() - start;
    const from = !reduced && taken && taken.length === px.length ? taken : null;
    // A read landing, a day changing: the scene it replaces plays on under the keys not come in
    // yet (the loading wave going on, a turn still giving way finishing) — at the same size —
    // but begins nothing new from here.
    const previous = layerRef.current;
    const below = reduced || staged.give !== 'keys' ? null : previous?.id === id ? previous.under : previous;
    const under = below && below.size === px.length ? below : null;
    if (under && fresh) under.until = Math.min(under.until, start - under.start);
    const buf = under ? new Uint32Array(px.length) : null;
    const today = staged.model.today;
    const seed = foilSeed(`${lang}${today >= 0 ? staged.cells[today] : staged.month}`);
    const scene = keysScene(G, staged.model, staged.beats, seed, buf);
    const layer: Layer = { id, scene, start, from, under, buf, size: px.length, until: Infinity };
    layerRef.current = layer;
    const until = Math.max(scene.settled, from ? DISSOLVE_MS : 0);

    // What the scene settles SAYING, for the next showing's changes.
    const remember = () => {
      if (staged.model.phase === 'data') rememberDrawn(accountId, lang, staged.month, codesOf(staged.model, staged.cells));
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
    if (fresh) setBursting(staged.beats.bursts.length > 0 ? id : null);
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
  }, [G, id, reduced]);

  // A key's centre in the raster's box, in CSS px.
  const centre = (i: number) => ({
    left: (BLEED + (i % 7) * (G.keyW + G.colGap) + G.keyW / 2) * CELL_PX,
    top: (HEADROOM + Math.floor(i / 7) * (G.keyH + G.rowGap) + G.keyH / 2) * CELL_PX,
  });
  const burstInk = (i: number) => {
    const key = staged.model.keys[i];
    return key.kind === 'solved' ? 'var(--accent)' : key.kind === 'progress' ? progressHeatColor(key.pct) : 'var(--fg)';
  };
  return (
    <>
      {/* The bursts UNDER the raster, clipped to its box: a landing flares through the ground
          round its key, never over a neighbour's face. */}
      <div className="cal-bursts" aria-hidden="true">
        {bursting === id &&
          staged.beats.bursts.map((burst) => (
            <span key={`${id}:${burst.index}`} className="cal-burst" style={centre(burst.index)}>
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
