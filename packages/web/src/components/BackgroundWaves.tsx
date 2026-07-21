import { useEffect, useRef } from 'react';
import { cellSize } from './cellSize';

// The app-wide animated backdrop: the ocean seen from above, rendered on the SAME
// --cell squares the body's graph-paper grid outlines (cellSize()). A single fixed
// canvas behind everything (see .bg-waves) varies ONLY the fill opacity of whole
// cells — full squares, no inset, no borders — so the grid lines just show through
// the translucent fill.
//
// The look comes from RIDGED Perlin noise: brightness peaks along the ZERO-CROSSINGS of
// a multi-octave field (r = 1 - |n|, sharpened), which draws thin connected crest lines
// with dim swell between them — water caustics. Two elongated swells drift against each
// other plus a small chop octave, so the crest lines continuously emerge, collide, merge
// and die instead of one frozen pattern sliding by. Honors prefers-reduced-motion by
// rendering one static frame (the texture without the motion).

// Per-octave anisotropic scales (noise-space per cell): the two swells are stretched
// horizontally (x-scale < y-scale => wider-than-tall features), so crests read as
// roughly-horizontal wave lines; the chop octave is fine and isotropic.
const SWELL_A_X = 0.05;
const SWELL_A_Y = 0.09;
const SWELL_B_X = 0.075;
const SWELL_B_Y = 0.06;
const CHOP = 0.18;
// Octave weights: two comparable swells is what makes crest lines cross and interfere;
// the chop just roughens the edges.
const W_A = 0.55;
const W_B = 0.45;
const W_C = 0.2;
// Drift velocities (noise-space per second). The swells travel AGAINST each other —
// that opposition is where collisions and die-offs come from; the chop skitters faster.
const DRIFT_A_X = 0.1;
const DRIFT_A_Y = 0.04;
const DRIFT_B_X = -0.06;
const DRIFT_B_Y = 0.05;
const DRIFT_C_X = 0.16;
const DRIFT_C_Y = -0.09;
// The combined field realistically stays within ±NORM (this 8-gradient Perlin never
// nears its theoretical bound; weights rarely align) — dividing by it spreads values
// over [-1, 1] so the ridge falloff covers the intended range.
const NORM = 0.8;
// A cell ON a crest line peaks at MAX_ALPHA fg; the cubic ridge falloff leaves the
// swell between the lines at a ~1-3% wash, just under the 2.5% grid lines. Below
// SKIP_ALPHA a fill is invisible on the near-black bg — not worth the fillRect.
const MAX_ALPHA = 0.055;
const SKIP_ALPHA = 0.005;
// The drift is slow enough that 30fps steps are invisible; no reason to burn 60.
const FRAME_MS = 33;

// Classic improved-Perlin 2D noise (fade curve + 8 corner gradients), inlined so the
// backdrop needs no dependency. Output roughly in [-1, 1].
const PERM = (() => {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const doubled = new Uint8Array(512);
  for (let i = 0; i < 512; i++) doubled[i] = p[i & 255];
  return doubled;
})();

function fade(t: number) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number) {
  return a + t * (b - a);
}

function grad(h: number, x: number, y: number) {
  switch (h & 7) {
    case 0:
      return x + y;
    case 1:
      return x - y;
    case 2:
      return -x + y;
    case 3:
      return -x - y;
    case 4:
      return x;
    case 5:
      return -x;
    case 6:
      return y;
    default:
      return -y;
  }
}

function noise2(x: number, y: number) {
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;
  x -= Math.floor(x);
  y -= Math.floor(y);
  const u = fade(x);
  const v = fade(y);
  const a = PERM[X] + Y;
  const b = PERM[X + 1] + Y;
  return lerp(
    lerp(grad(PERM[a], x, y), grad(PERM[b], x - 1, y), u),
    lerp(grad(PERM[a + 1], x, y - 1), grad(PERM[b + 1], x - 1, y - 1), u),
    v,
  );
}

export default function BackgroundWaves() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const fg =
      getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() || '#f4f4f2';

    let w = 0;
    let h = 0;
    let cell = 24;
    let lastT = 0;

    const draw = (t: number) => {
      lastT = t;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = fg;
      const cols = Math.ceil(w / cell);
      const rows = Math.ceil(h / cell);
      for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
          const n =
            (W_A * noise2(cx * SWELL_A_X + t * DRIFT_A_X, cy * SWELL_A_Y + t * DRIFT_A_Y) +
              W_B *
                noise2(cx * SWELL_B_X + t * DRIFT_B_X + 37.3, cy * SWELL_B_Y + t * DRIFT_B_Y + 11.7) +
              W_C * noise2(cx * CHOP + t * DRIFT_C_X + 91.1, cy * CHOP + t * DRIFT_C_Y + 53.7)) /
            NORM;
          // Ridge: 1 at a zero-crossing of the field (a crest line), falling off with
          // distance; cubed to thin the lines into filaments.
          const r = 1 - Math.abs(n);
          if (r <= 0) continue;
          const alpha = r * r * r * MAX_ALPHA;
          if (alpha < SKIP_ALPHA) continue;
          ctx.globalAlpha = alpha;
          ctx.fillRect(cx * cell, cy * cell, cell, cell);
        }
      }
      ctx.globalAlpha = 1;
    };

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      // The page's --cell (index.css): re-read here so crossing the mobile breakpoint
      // (which shrinks the graph paper) re-tunes the wave field in the same resize.
      cell = cellSize();
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(lastT);
    };

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let raf = 0;
    let lastFrame = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - lastFrame < FRAME_MS) return;
      lastFrame = now;
      draw(now / 1000);
    };
    const start = () => {
      cancelAnimationFrame(raf);
      if (reduced.matches) {
        // Static crest texture: the depth without the motion.
        draw(0);
      } else {
        raf = requestAnimationFrame(frame);
      }
    };

    resize();
    start();
    window.addEventListener('resize', resize);
    reduced.addEventListener('change', start);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      reduced.removeEventListener('change', start);
    };
  }, []);

  return <canvas ref={ref} className="bg-waves" aria-hidden="true" />;
}
