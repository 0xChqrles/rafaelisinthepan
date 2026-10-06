import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { bayerThreshold as th } from '@whippin/shared';
import { DISSOLVE_MS, SKELETON_WAIT_MS } from '../../components/bayerTiles';
import { HALFTONE } from '../../components/calendar/keysScene';
import { hexToAbgr } from '../../components/raster';
import { prefersReducedMotion } from '../../hooks/useScramble';
import type { LevelArtName } from '../levels';
import type { Raster, Scene } from './scenes';
import { MUTED, RAIL } from './scenes/kit';

// ONE LEVEL'S ILLUSTRATION (scenes.ts): a canvas of CELLS, one canvas pixel a cell, blown up
// by an exact integer (`CELL` CSS pixels) with nearest-neighbour scaling — the pixel-art rule,
// both halves (index.css `image-rendering`). It covers its box: the grid is the box rounded
// UP to whole cells and centred, the overflow clipped by the box.
//
// It moves at the strike sheets' pace, not 60fps — pixel art has nothing to gain from more —
// and only while it is on screen and the page is visible; reduced motion (or `still`) holds
// one composed frame. The ground is left transparent: the picture stands on the bare ground.
//
// `from` starts the picture's clock at that scene time when it mounts (level 1's finale opens
// its page typing itself in); without it the clock is the page's, so every card on the list
// runs free.
//
// `foot` keeps the bottom of the box (CSS pixels) for words laid over it — a card's title:
// the scene composes above it, and the art is DITHERED OUT across the band where the two
// meet — the ordered dither's own fade, never a smooth gradient over pixels.
//
// `halftone` PRINTS THE PICTURE IN HALFTONE — a level not ready in this language (SOON): its
// inks given up for the slate (the brightest for the quiet grey), and only the cells under the
// archive's over-day share of the Bayer order printed (`HALFTONE`, 5/8), the rest the ground.
// The archive's own word for "there, but not for now", in the picture's own cells.
//
// `solved` is level 1 DONE (scenes/kit.ts `solvedAt`): from the frame it turns true, the scene
// draws its done state — on the list a done card's from the first frame, on the finale the
// held words inking in, cobalt, under the player's eyes.
const CELL = 3;
const FRAME_MS = 90;
const FADE_PX = 56; // the fade band's height
// A halftone's inks: the slate, and the quiet grey for an ink at least this bright.
const BRIGHT = 0.4;
const HALF_RAIL = hexToAbgr(RAIL);
const HALF_MUTED = hexToAbgr(MUTED);

function luminance(hex: string): number {
  const v = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((v >> 16) & 255) + 0.7152 * lin((v >> 8) & 255) + 0.0722 * lin(v & 255);
}

// The scenes are loaded ON DEMAND, in one chunk the list and the articles share: the pictures
// are decoration on a page most sessions never open, and must not weigh on the game's first
// load. Until they arrive the box HOLDS — the house's slate stipple breathing where the picture
// will stand, after the skeleton's wait (a quick load never flashes it); a failed load leaves
// the stipple standing still.
type ScenesModule = typeof import('./scenes');
let scenes: ScenesModule | null = null;
let scenesLoad: Promise<ScenesModule> | null = null;
// When the chunk was first asked for: a picture mounting while it is still on its way (an
// article landing over its own hold) owes only the rest of the skeleton's wait, so the hold
// never blinks out and back between two mounts of one picture.
let askedAt = 0;
function loadScenes(): Promise<ScenesModule> {
  if (!scenesLoad) {
    askedAt = performance.now();
    scenesLoad = import('./scenes')
      .then((module) => {
        scenes = module;
        return module;
      })
      .catch((error) => {
        scenesLoad = null;
        throw error;
      });
  }
  return scenesLoad;
}

// Warm the chunk ahead of a picture that must appear on time (level 1's finale).
export function preloadScenes(): void {
  loadScenes().catch(() => {
    // Decoration: the picture's box keeps its hold.
  });
}

// The hold while the scenes are out: waiting (breathing), landed (giving way to the picture
// through the dither), failed (standing still).
type Hold = 'none' | 'wait' | 'out' | 'failed';

export default function LevelArt({
  name,
  still = false,
  halftone = false,
  solved = false,
  foot = 0,
  from,
  className = '',
}: {
  name: LevelArtName;
  still?: boolean;
  halftone?: boolean;
  solved?: boolean;
  foot?: number;
  from?: number;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hold, setHold] = useState<Hold>(() => (scenes ? 'none' : 'wait'));
  // The rest of the skeleton's wait, read once as the picture mounts — and when the hold is
  // therefore first on screen: a load landing before then never shows it at all.
  const [holdDelay] = useState(() =>
    scenes ? 0 : Math.max(0, SKELETON_WAIT_MS - (askedAt ? performance.now() - askedAt : 0)),
  );
  const holdShownAt = useRef(0);
  if (holdShownAt.current === 0) holdShownAt.current = performance.now() + holdDelay;
  // The scene time the level was done at (null: not done), and the picture's own clock and
  // redraw — the done state can arrive between two frames, or on a picture that does not move.
  const solvedAt = useRef<number | null>(solved ? -Infinity : null);
  const clock = useRef<() => number>(() => 0);
  const redraw = useRef<() => void>(() => {});

  // Laid out and drawn BEFORE the first paint: a picture mounting with its scenes in hand (an
  // article landing over its own hold, the finale's card) shows its frame at once, never an
  // empty box for a frame.
  useLayoutEffect(() => {
    const el = box.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    const moving = !still && !prefersReducedMotion();
    let mod = scenes;
    let cancelled = false;
    let scene: Scene | null = null;
    let raster: Raster | null = null;
    let image: ImageData | null = null;
    let palette = new Uint32Array(1);
    let fadeFrom = Infinity;
    let fadeTo = Infinity;
    let visible = false;
    let timer = 0;

    // A picture is decoration: a scene that throws leaves its box empty and stops, it never
    // takes the page down with it.
    let broken = false;
    const draw = (t: number) => {
      if (!scene || !raster || !image || broken) return;
      raster.ink.fill(0);
      try {
        scene.draw(raster, t, solvedAt.current ?? undefined);
      } catch (error) {
        broken = true;
        if (import.meta.env.DEV) console.error(`level art "${name}"`, error);
        return;
      }
      const px = new Uint32Array(image.data.buffer);
      const { ink, cols } = raster;
      for (let i = 0; i < ink.length; i += 1) {
        let k = ink[i];
        if (k !== 0) {
          const y = (i / cols) | 0;
          const x = i - y * cols;
          if (halftone && th(x, y) >= HALFTONE) k = 0;
          else if (y >= fadeFrom) {
            const keep = y >= fadeTo ? 0 : 1 - (y - fadeFrom) / (fadeTo - fadeFrom);
            if (keep <= th(x, y)) k = 0;
          }
        }
        px[i] = palette[k];
      }
      ctx.putImageData(image, 0, 0);
    };
    const t0 = performance.now();
    const now = () =>
      !moving
        ? (mod?.STILL_T[name] ?? 0)
        : from === undefined
          ? performance.now() / 1000
          : from + (performance.now() - t0) / 1000;
    clock.current = now;
    redraw.current = () => draw(now());

    const layout = () => {
      if (!mod) return;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      const cols = Math.ceil(w / CELL);
      const rows = Math.ceil(h / CELL);
      if (raster && raster.cols === cols && raster.rows === rows) return;
      canvas.width = cols;
      canvas.height = rows;
      canvas.style.width = `${cols * CELL}px`;
      canvas.style.height = `${rows * CELL}px`;
      const stageH = Math.max(1, rows - Math.round(foot / CELL));
      try {
        scene = mod.SCENES[name](cols, rows, { w: cols, h: stageH });
      } catch (error) {
        broken = true;
        if (import.meta.env.DEV) console.error(`level art "${name}"`, error);
        return;
      }
      if (foot > 0) {
        fadeFrom = Math.round(stageH - FADE_PX / CELL / 2);
        fadeTo = Math.round(stageH + FADE_PX / CELL / 2);
      }
      palette = new Uint32Array([
        0,
        ...scene.inks.map((hex) => (!halftone ? hexToAbgr(hex) : luminance(hex) >= BRIGHT ? HALF_MUTED : HALF_RAIL)),
      ]);
      raster = { cols, rows, ink: new Uint8Array(cols * rows) };
      image = ctx.createImageData(cols, rows);
      draw(now());
    };

    const tick = () => {
      timer = 0;
      if (!visible || document.hidden || broken) return;
      draw(now());
      timer = window.setTimeout(tick, FRAME_MS);
    };
    const wake = () => {
      if (moving && scene && visible && !document.hidden && !timer) timer = window.setTimeout(tick, FRAME_MS);
    };

    layout();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(layout) : null;
    ro?.observe(el);
    const io =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver((entries) => {
            visible = entries.some((e) => e.isIntersecting);
            wake();
          })
        : null;
    if (io) io.observe(el);
    else visible = true;
    document.addEventListener('visibilitychange', wake);
    wake();
    if (!mod) {
      loadScenes()
        .then((loaded) => {
          if (cancelled) return;
          mod = loaded;
          layout();
          wake();
          // The picture dissolves in over its hold, the hold out through the cells it takes —
          // or, landed before the hold was ever on screen, simply stands.
          setHold(performance.now() >= holdShownAt.current ? 'out' : 'none');
        })
        .catch(() => {
          if (!cancelled) setHold('failed');
        });
    }
    return () => {
      cancelled = true;
      ro?.disconnect();
      io?.disconnect();
      document.removeEventListener('visibilitychange', wake);
      window.clearTimeout(timer);
    };
  }, [name, still, halftone, foot, from]);

  // The level turning done (or back, on a replay that is not): from this frame on.
  useEffect(() => {
    if (solved === (solvedAt.current !== null)) return;
    solvedAt.current = solved ? clock.current() : null;
    redraw.current();
  }, [solved]);

  // The hold gives way once the picture has dissolved in over it.
  useEffect(() => {
    if (hold !== 'out') return undefined;
    const id = window.setTimeout(() => setHold('none'), DISSOLVE_MS);
    return () => window.clearTimeout(id);
  }, [hold]);

  return (
    <div ref={box} className={`level-art ${className}`} aria-hidden="true">
      {hold !== 'none' && (
        <span
          className={`level-art-hold stat-slot${hold === 'wait' ? ' breathing' : ''}${hold === 'out' ? ' out' : ''}`}
          style={{ '--delay': `${holdDelay}ms`, '--foot': `${foot}px` } as CSSProperties}
        />
      )}
      <canvas ref={canvasRef} className={`level-art-canvas${hold === 'out' ? ' in' : ''}`} />
    </div>
  );
}
