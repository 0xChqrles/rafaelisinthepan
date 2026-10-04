import { useEffect, useRef } from 'react';
import { bayerThreshold as th } from '@whippin/shared';
import { hexToAbgr } from '../../components/raster';
import { prefersReducedMotion } from '../../hooks/useScramble';
import type { LevelArtName } from '../levels';
import type { Raster, Scene } from './scenes';

// ONE LEVEL'S ILLUSTRATION (scenes.ts): a canvas of CELLS, one canvas pixel a cell, blown up
// by an exact integer (`CELL` CSS pixels) with nearest-neighbour scaling — the pixel-art rule,
// both halves (index.css `image-rendering`). It covers its box: the grid is the box rounded
// UP to whole cells and centred, the overflow clipped by the box.
//
// It moves at the strike sheets' pace, not 60fps — pixel art has nothing to gain from more —
// and only while it is on screen and the page is visible; reduced motion (or `still`) holds
// one composed frame. The ground is left transparent: the box's own background shows.
//
// `from` starts the picture's clock at that scene time when it mounts (level 1's finale opens
// its page typing itself in); without it the clock is the page's, so every card on the list
// runs free.
//
// `foot` keeps the bottom of the box (CSS pixels) for words laid over it — a card's title:
// the scene composes above it, and the art is DITHERED OUT across the band where the two
// meet — the ordered dither's own fade, never a smooth gradient over pixels.
const CELL = 3;
const FRAME_MS = 90;
const FADE_PX = 56; // the fade band's height

// The scenes are loaded ON DEMAND, in one chunk the list and the articles share: the pictures
// are decoration on a page most sessions never open, and must not weigh on the game's first
// load. Until they arrive the box shows its own ground; a failed load leaves it so.
type ScenesModule = typeof import('./scenes');
let scenes: ScenesModule | null = null;
let scenesLoad: Promise<ScenesModule> | null = null;
function loadScenes(): Promise<ScenesModule> {
  if (!scenesLoad) {
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
    // Decoration: the picture's box keeps its ground.
  });
}

export default function LevelArt({
  name,
  still = false,
  foot = 0,
  from,
  className = '',
}: {
  name: LevelArtName;
  still?: boolean;
  foot?: number;
  from?: number;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
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
        scene.draw(raster, t);
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
          if (y >= fadeFrom) {
            const keep = y >= fadeTo ? 0 : 1 - (y - fadeFrom) / (fadeTo - fadeFrom);
            if (keep <= th(i - y * cols, y)) k = 0;
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
      palette = new Uint32Array([0, ...scene.inks.map(hexToAbgr)]);
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
        })
        .catch(() => {
          // Decoration: the box keeps its ground.
        });
    }
    return () => {
      cancelled = true;
      ro?.disconnect();
      io?.disconnect();
      document.removeEventListener('visibilitychange', wake);
      window.clearTimeout(timer);
    };
  }, [name, still, foot, from]);

  return (
    <div ref={box} className={`level-art ${className}`} aria-hidden="true">
      <canvas ref={canvasRef} className="level-art-canvas" />
    </div>
  );
}
