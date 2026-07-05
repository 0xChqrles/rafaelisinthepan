// Share-card SVG (issue #8): a pure, dependency-free renderer for the minimal OG card —
// the row of heat-colored squares, "SCORE <n>", and the puzzle id "#<dayNumber>". The
// backend rasterizes this SVG to a PNG (with the Press Start 2P font) for the link's OG
// image. Pure + deterministic, so it is fully unit-testable without any AWS/rasterizer.
//
// Colors come from the SHARED heat ramp (heat.ts), so the card matches the on-screen grid
// exactly. Only numeric fields are interpolated (score/day/pct — all clamped ints from the
// decoded token), so there is no text to escape and no injection surface.

import { heatColor } from './heat';

// Standard OG image size (Twitter/Slack/Discord `summary_large_image`).
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

// Palette — mirrors :root in web/src/index.css (dark bg, off-white fg, muted grey).
const BG = '#0a0b12';
const FG = '#f4f4f2';
const MUTED = '#c4c9d8';

const CARD_FONT = 'Press Start 2P';

export interface CardData {
  dayNumber: number;
  score: number;
  squares: number[]; // per-square mean progress % (0..100)
}

export function renderCardSvg({ dayNumber, score, squares }: CardData): string {
  const n = Math.max(1, squares.length);

  // The row of squares, centered. Cells shrink to fit the widest game (18) within the
  // margins, but are capped so a short game's squares don't become huge.
  const margin = 90;
  const gap = 14;
  const avail = CARD_WIDTH - 2 * margin;
  const cell = Math.min(84, (avail - (n - 1) * gap) / n);
  const rowWidth = n * cell + (n - 1) * gap;
  const rowX = (CARD_WIDTH - rowWidth) / 2;
  const rowY = 232;

  const rects = squares
    .map((pct, i) => {
      const x = rowX + i * (cell + gap);
      return `<rect x="${x.toFixed(2)}" y="${rowY}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" fill="${heatColor(pct / 100)}"/>`;
    })
    .join('');

  const cx = CARD_WIDTH / 2;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${BG}"/>`,
    `<g shape-rendering="crispEdges">${rects}</g>`,
    // "N TRIES", not "SCORE N": naming the unit is what tells a stranger seeing the
    // card that lower is better.
    `<text x="${cx}" y="430" text-anchor="middle" font-family="${CARD_FONT}" font-size="76" fill="${FG}">${score} ${score === 1 ? 'TRY' : 'TRIES'}</text>`,
    `<text x="${cx}" y="500" text-anchor="middle" font-family="${CARD_FONT}" font-size="30" fill="${MUTED}">#${dayNumber}</text>`,
    `</svg>`,
  ].join('');
}
