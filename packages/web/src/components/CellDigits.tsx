import { useEffect, useRef, useState } from 'react';
import digitsUrl from '../assets/digits.png';
import { cellSize } from './cellSize';

// The score watermark, printed WITH the background cells instead of a font floating
// over them: each glyph pixel of assets/digits.png is drawn as a block of whole --cell
// grid squares, and the block is SNAPPED to the page's graph-paper grid (the same cells
// BackgroundWaves lights), so the grid lines run through the number exactly like they
// run through the water. Each ink cell is painted OPAQUELY — the page bg, the grid
// lines redrawn on top, then currentColor at INK_ALPHA — so the number occludes the
// waves cell-for-cell instead of blending with them (a passing crest must not modulate
// the count). That is why the watermark opacity lives HERE, not on .progress-background:
// element opacity would make the occluding base translucent again.

// Ink level over the opaque base. The hue comes from CSS (.cell-digits color) — vivid
// accent blue rather than the old faint fg — so this alpha reads as color saturation.
const INK_ALPHA = 0.3;
// Solved dissolve (#110, decided 2026-07-24): once the round is over the count melts
// back into the wave field, one grid CELL at a time — each cell drops out when the
// progress passes its own deterministic threshold (a coordinate hash, stable across
// redraws), so the number pixelates away into the water's own cell language. Reduced
// motion skips straight to gone.
const DISSOLVE_MS = 1200;
const cellThreshold = (gx: number, gy: number) => {
  const s = Math.sin(gx * 127.1 + gy * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
// MUST mirror the body graph-paper gradient (index.css): a 1px line at ~2.5% fg on the
// top and left edge of every cell, redrawn inside the opaque ink cells.
const GRID_LINE = 'rgba(244, 244, 242, 0.025)';
// digits.png is a 10-slot spritesheet in KEYBOARD order (1..9 then 0), 7px slots.
const SHEET_ORDER = '1234567890';
const SLOT_W = 7;
const GLYPH_ROWS = 7;
// One glyph pixel of spacing between digits (scales with the digits).
const GAP = 1;
// Same role as the old font-size: min(62vh, 88vw/width) — height sets the ideal
// scale (rounded: a watermark may overflow its band vertically, it always did),
// width is a hard cap so the number never bleeds off-screen.
const HEIGHT_BUDGET = 0.62;
const WIDTH_BUDGET = 0.88;
// Never scale a glyph pixel past 2x2 cells: on large viewports the viewport-relative
// budgets would keep inflating the number toward the screen edges (at 3 the count
// already grazed the top of a desktop screen).
const MAX_K = 2;

type Mask = { w: number; rows: Uint8Array };

let masksPromise: Promise<Mask[]> | null = null;

// Decode the sheet once per session: alpha is the mask (the art's RGB is ignored, so
// the PNG can stay black while the cells paint in the live foreground color); each
// slot is trimmed to its ink columns so widths stay proportional (1 is narrower).
function loadMasks(): Promise<Mask[]> {
  if (!masksPromise) {
    masksPromise = (async () => {
      const img = new Image();
      img.src = digitsUrl;
      await img.decode();
      const sheet = document.createElement('canvas');
      sheet.width = img.width;
      sheet.height = img.height;
      const ctx = sheet.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, img.width, img.height).data;
      const on = (x: number, y: number) => data[(y * img.width + x) * 4 + 3] > 127;
      const masks: Mask[] = new Array(10);
      for (let slot = 0; slot < 10; slot++) {
        const x0 = slot * SLOT_W;
        let left = SLOT_W;
        let right = -1;
        for (let x = 0; x < SLOT_W; x++) {
          for (let y = 0; y < GLYPH_ROWS; y++) {
            if (on(x0 + x, y)) {
              if (x < left) left = x;
              if (x > right) right = x;
              break;
            }
          }
        }
        const w = Math.max(1, right - left + 1);
        const rows = new Uint8Array(w * GLYPH_ROWS);
        for (let y = 0; y < GLYPH_ROWS; y++)
          for (let x = 0; x < w; x++) rows[y * w + x] = on(x0 + left + x, y) ? 1 : 0;
        masks[Number(SHEET_ORDER[slot])] = { w, rows };
      }
      return masks;
    })();
  }
  return masksPromise;
}

export default function CellDigits({
  value,
  dissolve = false,
}: {
  value: number;
  // True once the solved exits begin: animates the count away cell-by-cell (a mount
  // with dissolve already true — a rehydrated solve — renders nothing, no replay).
  dissolve?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [masks, setMasks] = useState<Mask[] | null>(null);
  // Dissolve progress in [0 intact .. 1 gone], read by every draw. A ref, not state:
  // the rAF loop below repaints imperatively at animation rate.
  const progressRef = useRef(dissolve ? 1 : 0);
  const drawRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let alive = true;
    loadMasks().then((m) => {
      if (alive) setMasks(m);
    });
    return () => {
      alive = false;
    };
  }, []);

  const prevDissolve = useRef(dissolve);
  useEffect(() => {
    const was = prevDissolve.current;
    prevDissolve.current = dissolve;
    if (!dissolve) {
      // New round: the count is back (value resets alongside).
      progressRef.current = 0;
      drawRef.current?.();
      return undefined;
    }
    if (was) return undefined; // mounted already-gone (rehydrated) — nothing to play
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      progressRef.current = 1;
      drawRef.current?.();
      return undefined;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      progressRef.current = Math.min(1, (now - start) / DISSOLVE_MS);
      drawRef.current?.();
      if (progressRef.current < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dissolve]);

  useEffect(() => {
    const canvas = ref.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent || !masks) return;

    // draw() is cheap to call speculatively: it recomputes the layout signature and
    // bails when nothing moved, so the interval below can catch anchor shifts that
    // fire no resize event (content above the sentence mounting/leaving).
    let signature = '';
    const draw = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const rect = parent.getBoundingClientRect();
      if (rect.width === 0) return;
      // The page's --cell (index.css): read per draw so a breakpoint crossing that
      // shrinks the graph paper re-snaps the digits to the finer grid.
      const cell = cellSize();
      const digits = Array.from(String(value), (c) => masks[Number(c)]);
      // Glyph-pixel width of the whole number, gaps included.
      const bits = digits.reduce((sum, m) => sum + m.w, 0) + GAP * (digits.length - 1);
      const k = Math.max(
        1,
        Math.min(
          MAX_K,
          Math.round((HEIGHT_BUDGET * window.innerHeight) / (GLYPH_ROWS * cell)),
          Math.floor((WIDTH_BUDGET * window.innerWidth) / (bits * cell)),
        ),
      );
      const px = k * cell;
      const bw = bits * px;
      const bh = GLYPH_ROWS * px;
      // Center on the anchor, then snap to the page grid in DOCUMENT coordinates —
      // the body's grid scrolls with the content, and so does this anchor. The vertical
      // snap CEILS instead of rounding: nearest-rounding could seat the number up to
      // half a cell ABOVE its ideal center, which on the mobile grid read as the count
      // sitting a square too high (reported 2026-07-24); erring only downward keeps the
      // residual on the side of the empty prompt gap, never crowding the HUD.
      const docLeft = rect.left + window.scrollX;
      const docTop = rect.top + window.scrollY;
      const left = Math.round((docLeft + (rect.width - bw) / 2) / cell) * cell;
      const top = Math.ceil((docTop + (rect.height - bh) / 2) / cell) * cell;
      // Hard clamp against scroll: at k = 1 the glyphs cannot shrink further, so a wide
      // count (3 digits on a narrow phone) would extend past the document's right edge
      // and create scrollable overflow. Instead the CANVAS spans only the visible,
      // cell-aligned slice of the ideal box — the number keeps its center and loses its
      // edges symmetrically (the left edge is clamped too, for the same cell alignment).
      const docWidth = document.documentElement.clientWidth;
      const visLeft = Math.max(left, 0);
      const visRight = Math.min(left + bw, Math.floor(docWidth / cell) * cell);
      const visW = visRight - visLeft;
      if (visW <= 0) return;
      const color = getComputedStyle(canvas).color;
      const p = progressRef.current;
      const next = [cell, left, top, docLeft, docTop, bw, bh, visLeft, visW, value, color, p].join();
      if (next === signature) return;
      signature = next;

      canvas.style.left = `${visLeft - docLeft}px`;
      canvas.style.top = `${top - docTop}px`;
      canvas.style.width = `${visW}px`;
      canvas.style.height = `${bh}px`;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(visW * dpr);
      canvas.height = Math.round(bh * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Paint in ideal-box coordinates; the canvas clips whatever falls outside.
      ctx.translate(left - visLeft, 0);
      const bg =
        getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0a0b12';
      // The surviving grid CELLS of every ink block (a block is k x k cells): during a
      // dissolve, a cell is gone once the progress passes its coordinate-hash
      // threshold — deterministic, so an unrelated redraw never reshuffles the decay.
      const cells: Array<[number, number]> = [];
      let cx = 0;
      for (const mask of digits) {
        for (let y = 0; y < GLYPH_ROWS; y++)
          for (let x = 0; x < mask.w; x++)
            if (mask.rows[y * mask.w + x]) {
              const bx = cx + x * px;
              const by = y * px;
              for (let j = 0; j < k; j++)
                for (let i = 0; i < k; i++) {
                  const ox = bx + i * cell;
                  const oy = by + j * cell;
                  if (p > 0 && cellThreshold((left + ox) / cell, (top + oy) / cell) < p)
                    continue;
                  cells.push([ox, oy]);
                }
            }
        cx += (mask.w + GAP) * px;
      }
      // Opaque base: punch the waves out under every surviving cell.
      ctx.fillStyle = bg;
      for (const [ox, oy] of cells) ctx.fillRect(ox, oy, cell, cell);
      // Re-draw the graph paper the base just covered — the canvas origin is
      // grid-snapped, so cell edges land on multiples of the cell in canvas space.
      ctx.fillStyle = GRID_LINE;
      for (const [ox, oy] of cells) {
        ctx.fillRect(ox, oy, 1, cell);
        ctx.fillRect(ox, oy, cell, 1);
      }
      // The ink itself, at the watermark level the element opacity used to provide.
      ctx.fillStyle = color;
      ctx.globalAlpha = INK_ALPHA;
      for (const [ox, oy] of cells) ctx.fillRect(ox, oy, cell, cell);
      ctx.globalAlpha = 1;
    };
    drawRef.current = draw;

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(parent);
    window.addEventListener('resize', draw);
    const interval = window.setInterval(draw, 500);
    return () => {
      drawRef.current = null;
      ro.disconnect();
      window.removeEventListener('resize', draw);
      window.clearInterval(interval);
    };
  }, [masks, value]);

  return <canvas ref={ref} className="cell-digits" aria-hidden="true" />;
}
