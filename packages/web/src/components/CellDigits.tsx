import { useEffect, useRef, useState } from 'react';
import digitsUrl from '../assets/digits.png';

// The score watermark: the count drawn as big PIXEL BLOCKS behind the play content, solid
// (user-decided 2026-09-01 — a hollow 1px CONTOUR shipped for one pass the same day and was
// rolled back; the number reads as a mass, not as a wireframe). It is `--fg` at 20%: white
// rather than the `--muted` it used to wear, which is the ground's own neutral instead of a
// blue-grey cast on the one shape that must not draw the eye.
//
// ITS HALO WENT WITH THE FILL. From 2026-08-17 the canvas painted a radial pool of the page
// ground around the digits, to erase the halftone dither the ground used to wear — and it
// laid an OPAQUE ground block under every ink cell for the same reason, so the dots could
// never show through a stroke. The 2026-09-01 rebrand made the ground ONE FLAT SHEET, which
// left both of them painting `--bg` onto `--bg`: invisible, and not cheap — the halo alone
// made the canvas 2.8x the number's height and 1.9x its width, cleared and gradient-filled
// on every draw. Both are deleted; the canvas is now the number plus room for its stroke.
//
// SIZED BY THE SCREEN ALONE (same decision): each glyph pixel of assets/digits.png is a
// px×px block whose size comes continuously from the viewport budgets below. The old
// implementation quantized that size to whole `--cell` grid squares and SNAPPED the
// number to the graph-paper grid — that existed so the BackgroundWaves field and the
// body grid ran through the digits cell-for-cell, and both are gone (the waves deleted,
// the grid now a dot matrix the number no longer needs to align with). `cellSize.ts`
// retired with it.
//
// Each ink block is still painted over an OPAQUE base — the ground colour, then
// currentColor at INK_ALPHA — so the dither can never show through a stroke and the
// alpha reads as colour saturation, not translucency. The watermark opacity lives HERE,
// not on the container: element opacity would make the occluding base translucent again.

// Ink level over the ground; the hue comes from CSS (.cell-digits color, now `--fg`). The
// alpha lives HERE and not on the container, because element opacity would fade the canvas
// as a whole rather than mixing the ink into the ground.
const INK_ALPHA = 0.2;
// digits.png is a 10-slot spritesheet in KEYBOARD order (1..9 then 0), 7px slots.
const SHEET_ORDER = '1234567890';
const SLOT_W = 7;
const GLYPH_ROWS = 7;
// One glyph pixel of spacing between digits (scales with the digits).
const GAP = 1;
// Same role as a font-size clamp: min(62vh, 88vw/width) — height sets the ideal scale
// (a watermark may overflow its band vertically, it always did), width is a hard cap so
// the number never bleeds off-screen.
const HEIGHT_BUDGET = 0.62;
const WIDTH_BUDGET = 0.88;
// Glyph-pixel bounds: the ceiling is the old 2-grid-cell cap (at 3 cells the count
// grazed the top of a desktop screen); the floor keeps the number legible as blocks.
const MAX_PX = 48;
const MIN_PX = 6;
// The width budget is spent on at least TWO digits, whatever the number currently is
// (decided 2026-08-09). The watermark counts tries, so it crosses 10 early in a round,
// and the width cap is what bites on a phone: a watermark is
// the screen's fixed furniture, and it must not resize because the game went well. So
// the number is sized for the widest 2-digit value it could become and merely rendered
// at whatever it is. Beyond two digits it does move (there is no honest way to reserve
// for a number with no bound), but 99 -> 100 is a milestone, where 9 -> 10 is the tenth
// guess of every single round.
const MIN_SIZED_DIGITS = 2;

type Mask = { w: number; rows: Uint8Array };

// THE TICK: when the count moves, the cells that change FLIP rather than the number being
// swapped — each cell the new number lights comes on bright on its own hashed beat and
// settles to the ink, each cell it drops goes dark on its own beat (the dissolve's
// scattered order, cell by cell). Cells both numbers share never move. The flip's whole
// span is FLIP_STAGGER_MS of beats plus one settle; reduced motion swaps outright.
const FLIP_STAGGER_MS = 160;
const FLIP_SETTLE_MS = 360;
const FLIP_PEAK_ALPHA = 0.45;
// Alphas are bucketed so a frame is still a handful of fills, each a union of blocks (the
// one-path rule below: separate fills seam at a fractional dpr — tolerated for the flip's
// half second, never at rest). NINE levels because 4/9 of the peak IS the ink (0.2): the
// cells both numbers share paint at exactly INK_ALPHA mid-flip, never a step brighter.
const FLIP_LEVELS = 9;

// A cell's beat in [0, 1): an integer hash of its grid position, so the order is scattered
// but the same for the same number.
function beatOf(cx: number, cy: number): number {
  let h = Math.imul(cx, 374761393) ^ Math.imul(cy, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// The lit cells of a drawing, keyed by their DOCUMENT position (whole pixels), so the next
// count can tell which cells it shares with this one.
type Drawn = { value: number; px: number; cells: Set<string> };
// The drawing before the first: no cells, and any cell size (`px` -1), so the first count
// flips in from nothing.
const ARRIVAL: Drawn = { value: -1, px: -1, cells: new Set() };

let masksPromise: Promise<Mask[]> | null = null;

// Decode the sheet once per session: alpha is the mask (the art's RGB is ignored, so
// the PNG can stay black while the blocks paint in the live foreground color); each
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

export default function CellDigits({ value }: { value: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [masks, setMasks] = useState<Mask[] | null>(null);
  // What the canvas last showed — the flip's starting point when the count moves.
  const drawn = useRef<Drawn | null>(null);

  useEffect(() => {
    let alive = true;
    loadMasks().then((m) => {
      if (alive) setMasks(m);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent || !masks) return;

    // A count that MOVED since the last drawing flips from it; the FIRST drawing flips in
    // from nothing — the number materializing cell by cell with the sentence decoding over
    // it (`PhraseIntro`). Never under reduced motion.
    const from = drawn.current ?? ARRIVAL;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let flip = from.value !== value && !reduced ? { from, start: performance.now() } : null;
    let frame = 0;

    // draw() is cheap to call speculatively: it recomputes the layout signature and
    // bails when nothing moved, so the interval below can catch anchor shifts that
    // fire no resize event (content above the sentence mounting/leaving).
    let signature = '';
    const draw = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const rect = parent.getBoundingClientRect();
      if (rect.width === 0) return;
      const digits = Array.from(String(value), (c) => masks[Number(c)]);
      // Glyph-pixel width of the whole number, gaps included.
      const bits = digits.reduce((sum, m) => sum + m.w, 0) + GAP * (digits.length - 1);
      // What the number is SIZED by: never fewer than MIN_SIZED_DIGITS of the widest glyph,
      // so the scale is the same the moment the count grows into them. Only `px` reads
      // this — the box below stays the real number's width, so it still centres on its
      // own ink.
      const widest = masks.reduce((max, m) => Math.max(max, m.w), 0);
      const sized = Math.max(bits, MIN_SIZED_DIGITS * widest + GAP * (MIN_SIZED_DIGITS - 1));
      // The glyph-pixel size, CONTINUOUS from the viewport (whole device pixels only, for
      // crisp blocks) — no grid quantization since the ground stopped being a grid.
      const px = Math.max(
        MIN_PX,
        Math.min(
          MAX_PX,
          Math.floor(
            Math.min(
              (HEIGHT_BUDGET * window.innerHeight) / GLYPH_ROWS,
              (WIDTH_BUDGET * window.innerWidth) / sized,
            ),
          ),
        ),
      );
      const bw = bits * px;
      const bh = GLYPH_ROWS * px;
      // The canvas box is exactly the number, centred on the anchor in document
      // coordinates (whole pixels — no grid to snap to any more, and a fill has no stroke
      // hanging outside its shape to leave room for).
      const docLeft = rect.left + window.scrollX;
      const docTop = rect.top + window.scrollY;
      const left = Math.round(docLeft + (rect.width - bw) / 2);
      const top = Math.round(docTop + (rect.height - bh) / 2);
      const boxW = bw;
      const boxH = bh;
      // Hard clamp against scroll: at MIN_PX the glyphs cannot shrink further, so a wide
      // count (3 digits on a narrow phone) — or the halo margin itself — would extend
      // past the document's right edge and create scrollable overflow. The CANVAS spans
      // only the visible slice of the ideal box; the drawing keeps its centre and loses
      // its edges.
      const docWidth = document.documentElement.clientWidth;
      const visLeft = Math.max(left, 0);
      const visRight = Math.min(left + boxW, docWidth);
      const visW = visRight - visLeft;
      if (visW <= 0) return;
      const color = getComputedStyle(canvas).color;
      const t = flip ? performance.now() - flip.start : 0;
      const next = [px, left, top, docLeft, docTop, bw, bh, visLeft, visW, value, color, flip ? t : ''].join();
      if (next === signature) return;
      signature = next;

      canvas.style.left = `${visLeft - docLeft}px`;
      canvas.style.top = `${top - docTop}px`;
      canvas.style.width = `${visW}px`;
      canvas.style.height = `${boxH}px`;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(visW * dpr);
      canvas.height = Math.round(boxH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Paint in ideal-box coordinates; the canvas clips whatever falls outside.
      ctx.translate(left - visLeft, 0);

      // THE DIGITS: one block per lit cell of the mask. They are collected into ONE path and
      // filled ONCE — a `fillRect` per block is a separate composite, so at a fractional dpr
      // (1.5, 2.5) two neighbours each paint a half-covered pixel along the edge they share
      // and a hairline seam shows through the middle of a solid stroke. One fill unions them.
      const cells = new Set<string>();
      const lit: [number, number][] = [];
      let gx = 0;
      for (const mask of digits) {
        for (let y = 0; y < GLYPH_ROWS; y++)
          for (let x = 0; x < mask.w; x++)
            if (mask.rows[y * mask.w + x]) {
              const cx = gx + x * px;
              const cy = y * px;
              lit.push([cx, cy]);
              cells.add(`${left + cx},${top + cy}`);
            }
        gx += (mask.w + GAP) * px;
      }
      drawn.current = { value, px, cells };

      // At rest (and whenever the flip cannot be read against this layout — a new cell
      // size): every block in ONE path, filled ONCE.
      const active = flip;
      ctx.fillStyle = color;
      if (!active || (active.from.px !== px && active.from.px !== -1) || t >= FLIP_STAGGER_MS + FLIP_SETTLE_MS) {
        flip = null;
        const path = new Path2D();
        for (const [cx, cy] of lit) path.rect(cx, cy, px, px);
        ctx.globalAlpha = INK_ALPHA;
        ctx.fill(path);
        ctx.globalAlpha = 1;
        return;
      }
      // Mid-flip: shared cells at the ink, arriving cells dark until their beat and then
      // settling from the peak, leaving cells at the ink until their beat.
      const levels = Array.from({ length: FLIP_LEVELS + 1 }, () => new Path2D());
      const used = new Array<boolean>(FLIP_LEVELS + 1).fill(false);
      const put = (alpha: number, cx: number, cy: number) => {
        const level = Math.round((alpha / FLIP_PEAK_ALPHA) * FLIP_LEVELS);
        if (level <= 0) return;
        levels[level].rect(cx, cy, px, px);
        used[level] = true;
      };
      const since = (cx: number, cy: number) =>
        t - beatOf(Math.round((left + cx) / px), Math.round((top + cy) / px)) * FLIP_STAGGER_MS;
      for (const [cx, cy] of lit) {
        const key = `${left + cx},${top + cy}`;
        if (active.from.cells.has(key)) {
          put(INK_ALPHA, cx, cy);
          continue;
        }
        const d = since(cx, cy);
        if (d < 0) continue;
        const k = Math.min(1, d / FLIP_SETTLE_MS);
        const ease = 1 - (1 - k) * (1 - k);
        put(FLIP_PEAK_ALPHA + (INK_ALPHA - FLIP_PEAK_ALPHA) * ease, cx, cy);
      }
      for (const key of active.from.cells) {
        if (cells.has(key)) continue;
        const [ax, ay] = key.split(',').map(Number);
        const cx = ax - left;
        const cy = ay - top;
        if (since(cx, cy) < 0) put(INK_ALPHA, cx, cy);
      }
      for (let level = 1; level <= FLIP_LEVELS; level++) {
        if (!used[level]) continue;
        ctx.globalAlpha = (level / FLIP_LEVELS) * FLIP_PEAK_ALPHA;
        ctx.fill(levels[level]);
      }
      ctx.globalAlpha = 1;
    };

    const tick = () => {
      draw();
      frame = flip ? requestAnimationFrame(tick) : 0;
    };
    tick();
    const ro = new ResizeObserver(draw);
    ro.observe(parent);
    window.addEventListener('resize', draw);
    const interval = window.setInterval(draw, 500);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', draw);
      window.clearInterval(interval);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [masks, value]);

  return <canvas ref={ref} className="cell-digits" aria-hidden="true" />;
}
