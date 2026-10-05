import { AVATAR_PALETTES, AVATAR_SIZE } from '@whippin/shared';
import { abgr } from '../raster';

// THE CANVAS'S PICTURE (pure): what the editor's canvas shows at rest, one raster pixel a CSS
// pixel — ten SQUARE cells a row on a 1px GRID, the grid's lines the palette's own ground
// pressed toward black (never a second hardcoded shade). The canvas (`EditorCanvas`) paints it
// (`paintPicture`: a fill a cell, as cheap as a stroke needs) and the palette sweep
// (`DitherWipe`) lays it over the canvas as a raster to sweep it off (`canvasPicture`) — one
// geometry and one set of inks, so the two never disagree about a pixel.
//
//   1px line · cell · 1px line · cell · … · cell · 1px line      side = 10 × (cell + 1) + 1
//
// The cell is a whole, ODD number of px, so the PITCH (cell + its line) is even: the house's
// 2px dither, laid from the canvas's first inner pixel (`ditherCell`), then lands on every
// cell's own first pixel — a sweep or a foil never cuts a cell off-grid.

export const LINE_PX = 1;
// The grid's lines: the ground at this share, the rest black.
const LINE_SHARE = 0.58;

export const canvasPitch = (cell: number): number => cell + LINE_PX;
export const canvasSide = (cell: number): number => AVATAR_SIZE * canvasPitch(cell) + LINE_PX;

// The cell under a point of the canvas (CSS px from its top-left), or null off it. A point on a
// line belongs to the cell before it; the outer frame's own line to the edge cell.
export function cellAtPoint(x: number, y: number, cell: number): number | null {
  const side = canvasSide(cell);
  if (!(x >= 0 && y >= 0 && x < side && y < side)) return null;
  const pitch = canvasPitch(cell);
  const cx = Math.min(AVATAR_SIZE - 1, Math.max(0, Math.floor((x - LINE_PX) / pitch)));
  const cy = Math.min(AVATAR_SIZE - 1, Math.max(0, Math.floor((y - LINE_PX) / pitch)));
  return cy * AVATAR_SIZE + cx;
}

// A cell's first pixel on the canvas, along one axis.
export const cellStart = (k: number, cell: number): number => LINE_PX + k * canvasPitch(cell);

// The 2px dither cell a canvas pixel belongs to, along one axis: laid from the first inner
// pixel, so with an even pitch every cell starts a dither cell of its own.
export const ditherCell = (px: number): number => (px + LINE_PX) >> 1;

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
// The grid's line ink for a palette, as an `rgb()` and as a raster pixel.
export function lineRgb(palette: number): [number, number, number] {
  const [r, g, b] = channels(AVATAR_PALETTES[palette].bg).map((c) => Math.round(c * LINE_SHARE));
  return [r, g, b];
}

// The picture painted onto a 2D context whose pixel is a CSS pixel.
export function paintPicture(ctx: CanvasRenderingContext2D, palette: number, cells: readonly number[], cell: number): void {
  const side = canvasSide(cell);
  const { bg, fg } = AVATAR_PALETTES[palette];
  ctx.fillStyle = `rgb(${lineRgb(palette).join(', ')})`;
  ctx.fillRect(0, 0, side, side);
  for (const ink of [0, 1]) {
    ctx.fillStyle = ink === 1 ? fg : bg;
    for (let i = 0; i < cells.length; i += 1) {
      if ((cells[i] === 1 ? 1 : 0) !== ink) continue;
      ctx.fillRect(cellStart(i % AVATAR_SIZE, cell), cellStart(Math.floor(i / AVATAR_SIZE), cell), cell, cell);
    }
  }
}

// The picture, row-major, `canvasSide(cell)` raster pixels a side: ground, ink, line.
export function canvasPicture(palette: number, cells: readonly number[], cell: number): Uint32Array {
  const side = canvasSide(cell);
  const pitch = canvasPitch(cell);
  const { bg, fg } = AVATAR_PALETTES[palette];
  const [gr, gg, gb] = channels(bg);
  const [ir, ig, ib] = channels(fg);
  const ground = abgr(gr, gg, gb);
  const ink = abgr(ir, ig, ib);
  const [lr, lg, lb] = lineRgb(palette);
  const line = abgr(lr, lg, lb);
  const picture = new Uint32Array(side * side).fill(line);
  for (let cy = 0; cy < AVATAR_SIZE; cy += 1) {
    for (let cx = 0; cx < AVATAR_SIZE; cx += 1) {
      const value = cells[cy * AVATAR_SIZE + cx] === 1 ? ink : ground;
      const x0 = LINE_PX + cx * pitch;
      const y0 = LINE_PX + cy * pitch;
      for (let y = y0; y < y0 + cell; y += 1) picture.fill(value, y * side + x0, y * side + x0 + cell);
    }
  }
  return picture;
}
