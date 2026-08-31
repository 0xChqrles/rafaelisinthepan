import { useEffect, useRef, useState } from 'react';
import digitsUrl from '../assets/digits.png';

// The score watermark: the count drawn as big pixel-block digits behind the play content,
// inside its own HALO — a radial pool of the page ground that erases the halftone dither
// around the number, as if the score emitted a clean zone (user-decided 2026-08-17).
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

// Ink level over the opaque base. The hue comes from CSS (.cell-digits color).
const INK_ALPHA = 0.3;
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
// (decided 2026-08-09). Both watermarks count PLAY — tries, claims — so both cross 10
// within the first minute, and the width cap is what bites on a phone: a watermark is
// the screen's fixed furniture, and it must not resize because the game went well. So
// the number is sized for the widest 2-digit value it could become and merely rendered
// at whatever it is. Beyond two digits it does move (there is no honest way to reserve
// for a number with no bound), but 99 -> 100 is a milestone, where 9 -> 10 is the tenth
// guess of every single round.
const MIN_SIZED_DIGITS = 2;
// The halo's reach beyond the digits, as a fraction of the number's height — tied to the
// digit size so the clean zone scales with the screen exactly like the number does.
const HALO = 0.9;

type Mask = { w: number; rows: Uint8Array };

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

// The ground colour as r,g,b — the halo needs it with its own alphas.
function bgChannels(): [number, number, number] {
  const hex =
    getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#050507';
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [5, 5, 7];
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as [number, number, number];
}

export default function CellDigits({ value }: { value: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [masks, setMasks] = useState<Mask[] | null>(null);

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
      const halo = Math.round(HALO * bh);
      // The canvas box is the number PLUS its halo margin, centred on the anchor in
      // document coordinates (whole pixels — no grid to snap to any more).
      const docLeft = rect.left + window.scrollX;
      const docTop = rect.top + window.scrollY;
      const left = Math.round(docLeft + (rect.width - bw) / 2) - halo;
      const top = Math.round(docTop + (rect.height - bh) / 2) - halo;
      const boxW = bw + 2 * halo;
      const boxH = bh + 2 * halo;
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
      const next = [px, left, top, docLeft, docTop, bw, bh, halo, visLeft, visW, value, color].join();
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
      const [br, bgc, bb] = bgChannels();

      // THE HALO: a radial pool of the ground colour, opaque at the number and fading to
      // nothing — what it paints over is the body's halftone dither (this canvas sits
      // above the ground, below the content), so the dots lose their opacity around the
      // score exactly as if the number cleared them. Drawn as an ellipse matched to the
      // number's shape via a scaled circular gradient.
      const cx = halo + bw / 2;
      const cy = halo + bh / 2;
      const rx = bw / 2 + halo;
      const ry = bh / 2 + halo;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(rx, ry);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, `rgba(${br}, ${bgc}, ${bb}, 1)`);
      g.addColorStop(0.55, `rgba(${br}, ${bgc}, ${bb}, 0.85)`);
      g.addColorStop(1, `rgba(${br}, ${bgc}, ${bb}, 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(-1, -1, 2, 2);
      ctx.restore();

      const blocks: Array<[number, number]> = [];
      let gx = 0;
      for (const mask of digits) {
        for (let y = 0; y < GLYPH_ROWS; y++)
          for (let x = 0; x < mask.w; x++)
            if (mask.rows[y * mask.w + x]) blocks.push([halo + gx + x * px, halo + y * px]);
        gx += (mask.w + GAP) * px;
      }
      // Opaque base under every ink block: the dither can never show through a stroke.
      ctx.fillStyle = `rgb(${br}, ${bgc}, ${bb})`;
      for (const [bx, by] of blocks) ctx.fillRect(bx, by, px, px);
      // The ink itself, at the watermark level the element opacity used to provide.
      ctx.fillStyle = color;
      ctx.globalAlpha = INK_ALPHA;
      for (const [bx, by] of blocks) ctx.fillRect(bx, by, px, px);
      ctx.globalAlpha = 1;
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(parent);
    window.addEventListener('resize', draw);
    const interval = window.setInterval(draw, 500);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', draw);
      window.clearInterval(interval);
    };
  }, [masks, value]);

  return <canvas ref={ref} className="cell-digits" aria-hidden="true" />;
}
