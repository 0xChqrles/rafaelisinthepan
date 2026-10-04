import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { COUNT_STILL_S, bayerThreshold, progressHeatColor } from '@whippin/shared';
import { clockNow } from '../animationClock';
import { DISSOLVE_MS } from '../bayerTiles';
import { foilSeed } from '../foil';
import { FRAME_MS, turnLevel } from '../podium/scene';
import { LOOP_FRAME_MS, watchRaster } from '../rasterWatch';
import Strike from '../Strike';
import { BURST_ART } from '../strikeArt';
import { useDeviceIdentity } from '../../identity';
import { prefersReducedMotion } from '../../hooks/useScramble';
import { BLEED, CELL_PX, keyAt, type CalGeometry } from './geometry';
import { keysScene, type KeysModel, type KeysScene } from './keysScene';
import { markShown, nextStage, stageId, type Shown, type Stage, type Viewer } from './plan';

// THE MONTH'S ONE CANVAS: the keys scene (`keysScene.ts`) on the raster recipe the podium
// uses — one backing pixel a house cell, upscaled `pixelated`, laid over the grid with a bleed
// round it — on the page's ONE animation clock (`clockNow`: the CSS dissolves' own timeline,
// so a slowed recording slows both), stepping every FRAME_MS until the scene has settled. Then
// THE CLOCK RESTS: only today's foil moves, repainted over a stored resting frame at the foil's
// own slow pace, and only while somebody can see it and is there (`rasterWatch`); a month
// still being read keeps its read wave going while it is seen, idle or not — a loading month
// must keep reading as one. Reduced motion draws the landed frame once and runs no clock.
//
// WHICH SCENE, and how it gives way from the one before, is `plan.ts`'s: LATCHED whenever what
// the raster shows changes — never for a re-render (a press, a resize) — and shown at once
// (`markShown`). A TURN'S GIVING WAY, once begun, FINISHES on its own schedule whatever lands
// under it (a read, a changed day): the scene that replaces it carries the frame it gives way
// from and when it began. A stage that CARRIES an arrival goes on along that arrival's clock,
// with what plays under it and its bursts. A resize re-seats the scene at the same moment,
// never replaying it — though, mid-arrival, it drops what played under it (a turn still giving
// way, the loading checker under keys not yet in: they come in over bare ground). The press is
// a one-shot redraw: it shows whether the clock runs or rests.
//
// A PICTURE only (hidden from a screen reader): the grid's buttons over it carry every day's
// date, status and tap.

// A scene on screen: its clock's start, what a turn gives way from (the frame on screen as it
// began) and when that turn began, and — a read landing, a day changing — the scene it
// replaced, still playing under the keys not come in yet, drawn each frame into `buf` (the
// frame the keys give way from), up to `until`, its own time when it was replaced.
interface Layer {
  id: string;
  scene: KeysScene;
  start: number;
  from: Uint32Array | null;
  fromAt: number;
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
  const turned = now - layer.fromAt;
  if (!layer.from || turned >= DISSOLVE_MS) return;
  const from = layer.from;
  const lv = turnLevel(turned);
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
  // The frame on screen (what the next scene gives way from); the scene's clock start and the
  // frame it turns from with the turn's start, once per scene (a new layout redraws the same
  // moment); the scene on screen, with what plays on under it.
  const lastFrame = useRef<Uint32Array | null>(null);
  const startRef = useRef<{ id: string; at: number; from: Uint32Array | null; fromAt: number } | null>(null);
  const layerRef = useRef<Layer | null>(null);
  let staged = stage;
  if (staged === null || staged.id !== stageId(shown, viewer)) {
    // Still arriving: the stage on screen is an arrival its scene has not settled.
    const layer = layerRef.current;
    const arriving =
      stage !== null &&
      stage.spec.build !== null &&
      layer?.id === stage.id &&
      clockNow() - layer.start < layer.scene.settled;
    staged = nextStage(stage, shown, viewer, arriving);
    setStage(staged);
  }
  const id = staged.id;

  useEffect(() => markShown(staged, viewer), [staged]);

  // The press reaches the clock through a ref; at rest it redraws once.
  const pressedRef = useRef(pressed);
  const redrawRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    pressedRef.current = pressed;
    redrawRef.current?.();
  }, [pressed]);

  // The bursts are up while the scene plays out, on its clock (its start).
  const [bursting, setBursting] = useState<number | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;
    const previous = layerRef.current;
    // (A new layout keeps the scene's start; only a new scene starts the clock, and its bursts —
    // unless it carries the clock of the one it replaces.)
    const fresh = startRef.current?.id !== id;
    if (fresh) {
      const now = clockNow();
      // A turn gives way from the frame on screen; a scene replacing a turn still giving way
      // takes that giving way on, to finish on its own schedule.
      const turn = staged.give === 'turn' && lastFrame.current ? lastFrame.current.slice() : null;
      const giving =
        (staged.give === 'keys' || staged.carries) && previous?.from && now - previous.fromAt < DISSOLVE_MS
          ? previous
          : null;
      startRef.current = {
        id,
        at: staged.carries && previous ? previous.start : now,
        from: turn ?? giving?.from ?? null,
        fromAt: turn ? now : (giving?.fromAt ?? now),
      };
    }
    const { at: start, from: taken, fromAt } = startRef.current!;
    canvas.width = G.cols;
    canvas.height = G.rows;
    const image = ctx.createImageData(G.cols, G.rows);
    const px = new Uint32Array(image.data.buffer);
    lastFrame.current = px;
    const elapsed = () => clockNow() - start;
    const from = !reduced && taken && taken.length === px.length ? taken : null;
    // A read landing, a day changing: the scene it replaces plays on under the keys not come in
    // yet (the loading wave going on, a turn's arrival finishing) — at the same size — but
    // begins nothing new from here. A new layout, or a stage carrying the arrival, keeps what
    // played under the scene before it.
    const below =
      reduced || !previous
        ? null
        : previous.id === id || staged.carries
          ? previous.under
          : staged.give === 'keys'
            ? previous
            : null;
    const under = below && below.size === px.length ? below : null;
    if (under && fresh) under.until = Math.min(under.until, start - under.start);
    const buf = under ? new Uint32Array(px.length) : null;
    const today = staged.model.today;
    const seed = foilSeed(`${lang}${today >= 0 ? staged.cells[today] : staged.month}`);
    const scene = keysScene(G, staged.model, staged.beats, seed, buf);
    const layer: Layer = { id, scene, start, from, fromAt, under, buf, size: px.length, until: Infinity };
    layerRef.current = layer;
    const until = Math.max(scene.settled, from ? fromAt - start + DISSOLVE_MS : 0);
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
      redrawRef.current = () => settle(t);
      return () => {
        redrawRef.current = null;
      };
    }

    let timer = 0;
    let stopped = false;
    if (fresh) setBursting(staged.beats.bursts.length > 0 ? start : null);
    const tick = () => {
      timer = 0;
      if (stopped || !watch.seen()) return;
      const t = elapsed();
      if (t < until) {
        compose(layer, px, start + t, pressedRef.current, G.cols);
        ctx.putImageData(image, 0, 0);
        timer = window.setTimeout(tick, FRAME_MS);
        return;
      }
      if (rest === null) {
        settle(t);
        setBursting(null);
      } else if (scene.loop === 'wave') {
        scene.draw(px, t, false, pressedRef.current);
        ctx.putImageData(image, 0, 0);
      } else if (scene.loop === 'foil') {
        // Nobody there: the foil holds its frame until a touch wakes it.
        if (!watch.awake()) return;
        scene.foil(px, rest, t, pressedRef.current);
        for (const b of scene.foilBoxes) ctx.putImageData(image, 0, 0, b.x, b.y, b.w, b.h);
      }
      if (scene.loop !== null) timer = window.setTimeout(tick, LOOP_FRAME_MS);
    };
    // A press shown or released: the running clock draws it on its next frame; at rest it is
    // drawn now.
    redrawRef.current = () => {
      if (rest === null || stopped) return;
      settle(elapsed());
    };
    const watch = watchRaster(canvas, () => {
      if (!stopped && !timer && watch.seen()) tick();
    });
    // The first frame before paint — the scene before, as it stood.
    tick();
    return () => {
      stopped = true;
      redrawRef.current = null;
      window.clearTimeout(timer);
      watch.stop();
    };
    // A scene per stage and per layout; the data is the stage's.
  }, [G, id, reduced]);

  // The clock the stage shown is on: its own, or — a stage carrying an arrival, before its
  // layout has run — the arrival's.
  const clock =
    startRef.current?.id === id ? startRef.current.at : staged.carries ? (layerRef.current?.start ?? null) : null;
  const burstInk = (i: number) => {
    const key = staged.model.keys[i];
    return key.kind === 'solved' ? 'var(--accent)' : key.kind === 'progress' ? progressHeatColor(key.pct) : 'var(--fg)';
  };
  return (
    <>
      {/* The bursts UNDER the raster, in their box (`.cal-bursts`: past the grid into open
          ground, to the screen's edge): a landing flares through the ground round its key,
          never over a neighbour's face. Keyed by the clock, so a stage carrying the arrival
          neither restarts nor cuts one already up. */}
      <div className="cal-bursts" aria-hidden="true">
        {bursting !== null &&
          bursting === clock &&
          staged.beats.bursts.map((burst) => (
            <KeyBurst
              key={`${bursting}:${burst.index}`}
              G={G}
              index={burst.index}
              at={bursting + burst.at}
              color={burstInk(burst.index)}
            />
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

// A landing's BURST behind key `index`, centred on it in the bursts' box (its top the raster's,
// its left the reach past the grid's), landing at `at` on the page's clock — its delay taken
// once, as it mounts: a burst a carried stage adds lands on the arrival's beat.
function KeyBurst({ G, index, at, color }: { G: CalGeometry; index: number; at: number; color: string }) {
  const [delayMs] = useState(() => at - clockNow());
  const { x, y } = keyAt(G, index);
  const left = `calc(var(--reach) + ${(x - BLEED) * CELL_PX + G.keyWPx / 2}px)`;
  return (
    <span className="cal-burst" style={{ left, top: y * CELL_PX + G.keyHPx / 2 }}>
      <Strike id={index} art={BURST_ART} color={color} delayMs={delayMs} />
    </span>
  );
}
