// Share-card SVG (issue #8): a pure, dependency-free renderer for the minimal OG card —
// the player's RUN RULER, "<n> TRIES", and the puzzle's DAY as a calendar date. The backend
// rasterizes this SVG to a PNG (with the Press Start 2P font) for the link's OG image. Pure
// + deterministic, so it is fully unit-testable without any AWS/rasterizer.
//
// The day reads "2026-08-02", not "#20667" (decided 2026-08-03): a stranger seeing the card
// can date the sentence, where the internal day index says nothing to anyone but the game.
// It is still the SERVER-owned day, never the reader's local date — `dateForDayNumber` is the
// exact inverse of `dayNumber`, so the token's day index maps to the one calendar date that
// game day IS, identically in every timezone. Nothing about the token changes: it has always
// carried the day index, and the same date already names the archive URL the card links to.
//
// The ruler is the SAME display as the solved screen's (web components/RunRuler.tsx), scaled
// to the card (decided 2026-07-25, replacing the bucketed heat squares — the v2 token carries
// the raw run): one cell per counted try on the shared PROGRESS ramp (progressColor, so the
// card matches the on-screen bar exactly), a tick where each secret dropped, and that hole's
// sentence index (1..3) under it. The share TEXT's emoji row summarises this same bar into a
// bounded 3..18 cells on the same ramp (it has to fit a text message); the card draws every
// try AND the ticks, so it stays the richer view.
//
// The only interpolated strings are numeric fields (score/day/pct/hole index — all clamped
// ints from the decoded token, the day formatted to digits + hyphens by dateForDayNumber) and
// the try-count UNIT, which is a fixed per-lang table CONSTANT (never interpolated input) — so
// there is no text to escape and no injection surface.

import { dateForDayNumber } from './day';
import { progressColor } from './progressColor';

// Standard OG image size (Twitter/Slack/Discord `summary_large_image`).
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

// Palette — mirrors :root in web/src/index.css (dark bg, off-white fg, muted grey).
const BG = '#0a0b12';
const FG = '#f4f4f2';
const MUTED = '#c4c9d8';

const CARD_FONT = 'Press Start 2P';

// Ruler geometry: the on-screen bar's proportions (340×16 with 2px ticks overhanging 3px,
// 10px indices) blown up to the card's margins. The vertical rhythm leaves room for the
// deepest possible index stack (one guess dropping every secret) to clear the score below it.
const MARGIN = 90;
const BAR_X = MARGIN;
const BAR_W = CARD_WIDTH - 2 * MARGIN;
const BAR_Y = 180;
const BAR_H = 48;
const TICK_W = 6;
const TICK_OVERHANG = 9;
const NUM_SIZE = 28;
const NUM_TOP = BAR_Y + BAR_H + TICK_OVERHANG + 8 + NUM_SIZE; // first index baseline
const NUM_STEP = 32; // stacked indices under one shared tick

// The try-count unit, keyed by the token's language. A FIXED table of constants (never
// interpolated input), so the renderer's "no text to escape" guarantee holds. Unknown
// lang -> en (matches the token codec, which only ever encodes a known lang).
const UNITS: Record<string, { one: string; many: string }> = {
  en: { one: 'TRY', many: 'TRIES' },
  fr: { one: 'ESSAI', many: 'ESSAIS' },
};

export interface CardData {
  lang: string; // 2-letter code; selects the try-count unit (en/fr), unknown -> en
  dayNumber: number; // the server-owned day index — DRAWN as its calendar date (YYYY-MM-DD)
  score: number;
  trajectory: number[]; // reconstruction % (0..100) after each counted try -> the cells
  solvedAt: (number | null)[]; // per distinct secret in sentence order -> the ticks
}

// Word mode's card (#156): the run has no trajectory to draw — the whole result is the
// claim count — so the card is the count with its unit named ("12 WORDS": higher is
// better here, and the unit says what was counted), over the day's calendar date. Same
// palette, same no-injection guarantee: every interpolated value is a clamped int or a
// fixed per-lang constant.
const WORD_UNITS: Record<string, { one: string; many: string }> = {
  en: { one: 'WORD', many: 'WORDS' },
  fr: { one: 'MOT', many: 'MOTS' },
};

export interface WordCardData {
  lang: string;
  dayNumber: number; // drawn as its calendar date, like the sentence card
  score: number; // top-zone words claimed before striking out
}

export function renderWordCardSvg({ lang, dayNumber, score }: WordCardData): string {
  const unit = WORD_UNITS[lang] ?? WORD_UNITS.en;
  const cx = CARD_WIDTH / 2;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${BG}"/>`,
    `<text x="${cx}" y="340" text-anchor="middle" font-family="${CARD_FONT}" font-size="76" fill="${FG}">${score} ${score === 1 ? unit.one : unit.many}</text>`,
    `<text x="${cx}" y="420" text-anchor="middle" font-family="${CARD_FONT}" font-size="30" fill="${MUTED}">${dateForDayNumber(dayNumber)}</text>`,
    `</svg>`,
  ].join('');
}

export function renderCardSvg({ lang, dayNumber, score, trajectory, solvedAt }: CardData): string {
  const n = Math.max(1, trajectory.length);

  // Integer cell boundaries so adjacent cells share an edge EXACTLY — no hairline seams
  // under crispEdges — and, because the boundaries tile [BAR_X, BAR_X + BAR_W) exactly,
  // the row can never spill past the bar's right edge.
  const edge = (i: number) => BAR_X + Math.round((i * BAR_W) / n);
  // ONE rect per occupied PIXEL COLUMN, not per try. Past BAR_W tries several tries land
  // on the same column, and emitting a 1px rect for each only stacks them (the last one
  // painted wins) while handing the rasterizer thousands of invisible rects — a hand-built
  // token may declare a score of up to SCORE_MAX, so the count has to be bounded by the
  // CARD, not by the token. Skipping the zero-width ones paints the identical image with
  // at most BAR_W rects, and the survivors still tile the bar with no seams.
  const cells = trajectory
    .map((pct, i) => {
      const x = edge(i);
      const w = edge(i + 1) - x;
      if (w <= 0) return ''; // fully covered by a later try in the same column
      return `<rect x="${x}" y="${BAR_Y}" width="${w}" height="${BAR_H}" fill="${progressColor(pct)}"/>`;
    })
    .join('');

  // Solve moments: one tick per solving try, on the RIGHT edge of that try's cell (the state
  // AFTER the guess), with the dropped holes' sentence indices stacked under it — several
  // secrets falling to one guess share a single tick, exactly as on screen.
  const ticks: { at: number; holes: number[] }[] = [];
  solvedAt.forEach((at, i) => {
    if (at == null) return;
    const tick = ticks.find((x) => x.at === at);
    if (tick) tick.holes.push(i + 1);
    else ticks.push({ at, holes: [i + 1] });
  });
  ticks.sort((a, b) => a.at - b.at);

  const marks = ticks
    .map(({ at, holes }) => {
      const cx = BAR_X + (Math.min(at, n) / n) * BAR_W;
      const nums = holes
        .map(
          (h, k) =>
            `<text x="${cx.toFixed(2)}" y="${NUM_TOP + k * NUM_STEP}" text-anchor="middle" font-family="${CARD_FONT}" font-size="${NUM_SIZE}" fill="${FG}">${h}</text>`,
        )
        .join('');
      return `<rect x="${(cx - TICK_W / 2).toFixed(2)}" y="${BAR_Y - TICK_OVERHANG}" width="${TICK_W}" height="${BAR_H + 2 * TICK_OVERHANG}" fill="${FG}"/>${nums}`;
    })
    .join('');

  const unit = UNITS[lang] ?? UNITS.en;
  const cx = CARD_WIDTH / 2;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${BG}"/>`,
    `<g shape-rendering="crispEdges">${cells}</g>`,
    marks,
    // "N TRIES", not "SCORE N": naming the unit is what tells a stranger seeing the
    // card that lower is better. Localized by the token's lang (#59).
    `<text x="${cx}" y="430" text-anchor="middle" font-family="${CARD_FONT}" font-size="76" fill="${FG}">${score} ${score === 1 ? unit.one : unit.many}</text>`,
    `<text x="${cx}" y="500" text-anchor="middle" font-family="${CARD_FONT}" font-size="30" fill="${MUTED}">${dateForDayNumber(dayNumber)}</text>`,
    `</svg>`,
  ].join('');
}
