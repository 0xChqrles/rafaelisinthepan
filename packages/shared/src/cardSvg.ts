// Share-card SVG (issue #8): a pure, dependency-free renderer for the OG cards the backend
// draws per link — a shared RESULT and a GROUP invite. The backend rasterizes this SVG to a
// PNG (with the pixel face and the chrome's mono) for the link's OG image. Pure +
// deterministic, so it is fully unit-testable without any AWS/rasterizer.
//
// Both wear the FRAME of the site's own link previews (web `linkPreviews.ts`, the cards in
// `assets/previews/`): the flat ground, the device frame's corner brackets, and the lockup —
// the app's mark in the accent beside its name in the chrome's mono. A result is the solved
// screen's CARD laid down (web `SolvedCard`): the count in the pixel face's own cells, in the
// holographic foil, over its unit, the run's heat rising off the run ruler; a group is its name
// in the title chip, its members' marks on an orbit around it — as the home card holds its
// hidden word.
//
// The day reads "2026-08-02", not "#20667" (decided 2026-08-03): a stranger seeing the card
// can date the sentence, where the internal day index says nothing to anyone but the game.
// It is still the SERVER-owned day, never the reader's local date — `dateForDayNumber` is the
// exact inverse of `dayNumber`, so the token's day index maps to the one calendar date that
// game day IS, identically in every timezone. Nothing about the token changes: it has always
// carried the day index, and the same date already names the archive URL the card links to.
//
// The ruler is the SAME display as the solved screen's (web components/RunRuler.tsx), scaled
// to the card: one cell per counted try on the shared HEAT ramp (progressHeatColor — the
// game's one ramp, each try's % read straight as heat), a tick where each secret dropped, and
// that hole's sentence index (1..3) under it. The share TEXT's emoji row summarises this same
// bar into a bounded 3..18 cells on the same ramp (it has to fit a text message); the card
// draws every try AND the ticks, so it stays the richer view.
//
// Result-card strings are numeric fields plus fixed units. The one free text a card draws is
// a NAME (a signed share's signer, a group card's group), XML-escaped before interpolation.

import { anonName, defaultAvatar } from './assigned';
import { AVATAR_PALETTES, AVATAR_SIZE, decodeAvatar } from './avatar';
import { avatarOutlinePath } from './avatarOutline';
import { dateForDayNumber } from './day';
import { bayerThreshold } from './bayer';
import { COUNT_EM, COUNT_ROWS, capCorners, countInk, glyphBoxes, inkEms } from './countCells';
import {
  COUNT_GLINT_CELL_PX,
  COUNT_SPARKLE,
  COUNT_STILL_S,
  FOIL_CELL_PX,
  FOIL_WHITE,
  countGlints,
  foilCells,
  foilGlitter,
  foilInkRgb,
} from './foil';
import { DIGIT_MASKS, INFINITY_EM_HEIGHT, INFINITY_GLYPH, MARK_GLYPH, PIXEL_INK_LIFT_EM } from './glyphs';
import { progressHeatColor } from './heat';
import { HEAT_CLEAR_PX, HEAT_UNIT_CLEAR_PX, HEAT_UNIT_RAMP_PX, heatCells, heatKeepOut, type HeatKeep } from './runHeat';
import type { ShareResult } from './shareCard';

// Standard OG image size (Twitter/Slack/Discord `summary_large_image`).
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

// Palette — mirrors :root in web/src/index.css (the 2026-09-01 rebrand: white fg on a
// near-black ground, the solve cobalt as the one accent).
const BG = '#050507';
const FG = '#ffffff';
const ACCENT = '#4a6aff';

// The two voices: the PIXEL face for what the game shows (the count, the indices), the
// chrome's MONO for everything else — its bold, the one weight the rasterizer is handed.
// Both are monospaced, so a line's width is a sum of advances and nothing is measured:
// the pixel face advances 1em a glyph, the mono 0.65em.
const PIXEL_FONT = 'Press Start 2P';
const UI_FONT = 'Azeret Mono';
const UI_ADVANCE_EM = 0.65;
// The mono's cap height (its OS/2 table), to stand a line of capitals on a centre.
const UI_CAP_EM = 0.698;

// A line of the chrome's mono: tracked capitals (or a name, case kept), bold.
function uiText(
  text: string,
  x: number,
  baseline: number,
  size: number,
  tracking: number,
  fill: string,
  anchor: 'start' | 'middle' | 'end' = 'start',
  opacity = 1,
): string {
  return (
    `<text x="${x}" y="${baseline}" text-anchor="${anchor}" font-family="${UI_FONT}" font-weight="700" font-size="${size}" ` +
    `letter-spacing="${(tracking * size).toFixed(2)}" font-variant-ligatures="none" fill="${fill}"` +
    (opacity < 1 ? ` fill-opacity="${opacity}"` : '') +
    `>${text}</text>`
  );
}
// How wide a tracked mono line is: every glyph's advance and the tracking between them.
const uiWidth = (glyphs: number, size: number, tracking: number) =>
  glyphs * UI_ADVANCE_EM * size + Math.max(0, glyphs - 1) * tracking * size;

// The try-count unit, keyed by the token's language. A FIXED table of constants (never
// interpolated input), so the renderer's "no text to escape" guarantee holds. Unknown
// lang -> en (matches the token codec, which only ever encodes a known lang).
const UNITS: Record<string, { one: string; many: string }> = {
  en: { one: 'TRY', many: 'TRIES' },
  fr: { one: 'ESSAI', many: 'ESSAIS' },
};

// What the card draws IS what the token carries, so the renderer takes the codec's own
// result type rather than a second declaration of the same five fields.
export type CardData = ShareResult;

function escapeSvgText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── The FRAME ─────────────────────────────────────────────────────────────────────────
// The device frame's corner brackets, at the site previews' weight.
const BRACKET_INSET = 20;
const BRACKET_ARM = 24;
const BRACKET_STROKE = 2;
function brackets(): string {
  const a = BRACKET_ARM;
  const s = BRACKET_STROKE;
  const l = BRACKET_INSET;
  const r = CARD_WIDTH - BRACKET_INSET;
  const t = BRACKET_INSET;
  const b = CARD_HEIGHT - BRACKET_INSET;
  const corner = (x: number, y: number, dx: number, dy: number) =>
    `M${x} ${y}h${dx * a}v${dy * s}h${-dx * (a - s)}v${dy * (a - s)}h${-dx * s}z`;
  return (
    `<path d="${corner(l, t, 1, 1)} ${corner(r, t, -1, 1)} ${corner(l, b, 1, -1)} ${corner(r, b, -1, -1)}" ` +
    `fill="${FG}" fill-opacity="0.38"/>`
  );
}

// The lockup, top left: the mark at a whole scale in the accent, the name beside it.
const APP_NAME = 'WHIPPIN AI';
const LOCKUP_X = 64;
const LOCKUP_Y = 56;
const LOCKUP_SCALE = 2;
const LOCKUP_SIZE = 22;
const LOCKUP_GAP = 14;
const LOCKUP_TRACKING = 0.14;
// The top row's centre line: the edition (a result's day) stands on it too, at the right.
const TOP_ROW_CY = LOCKUP_Y + (MARK_GLYPH.height * LOCKUP_SCALE) / 2;
const onRow = (size: number) => Math.round(TOP_ROW_CY + (UI_CAP_EM * size) / 2);
function lockup(): string {
  const px = MARK_GLYPH.width * LOCKUP_SCALE;
  return (
    `<g transform="translate(${LOCKUP_X} ${LOCKUP_Y}) scale(${LOCKUP_SCALE})" shape-rendering="crispEdges">` +
    `<path d="${MARK_GLYPH.path}" fill="${ACCENT}"/></g>` +
    uiText(APP_NAME, LOCKUP_X + px + LOCKUP_GAP, onRow(LOCKUP_SIZE), LOCKUP_SIZE, LOCKUP_TRACKING, FG)
  );
}

// ── Pixel material ────────────────────────────────────────────────────────────────────
// Cells on a grid as ONE path of row runs: what a dithered stroke or a checker is drawn
// as, so a few thousand cells cost one element.
function cellsPath(cols: number, rows: number, on: (x: number, y: number) => boolean, cell: number, ox: number, oy: number): string {
  const runs: string[] = [];
  for (let y = 0; y < rows; y += 1) {
    let x = 0;
    while (x < cols) {
      if (!on(x, y)) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < cols && on(x, y)) x += 1;
      runs.push(`M${ox + start * cell} ${oy + y * cell}h${(x - start) * cell}v${cell}h${-(x - start) * cell}z`);
    }
  }
  return runs.join(' ');
}

// A pixel-face line standing on a centre line: the face's ink is its cap height
// (`INFINITY_EM_HEIGHT`), lifted `PIXEL_INK_LIFT_EM` off the nominal baseline.
const pixelBaseline = (centre: number, size: number) =>
  Math.round(centre + (INFINITY_EM_HEIGHT / 2 + PIXEL_INK_LIFT_EM) * size);

// The white title chip of the site's previews (web `.chipm`, the header's page chip): the
// mono's bold capitals in the ground's ink on a white block, 0.2em of side padding, 1.12em
// tall. Returns its markup and its box.
const CHIP_PAD_X = 0.2;
const CHIP_HEIGHT = 1.12;
const CHIP_TRACKING = 0.02;
function chip(text: string, size: number, centreX: number, centreY: number): { svg: string; w: number; h: number; x: number; y: number } {
  const glyphs = Math.max(1, Array.from(text).length);
  const w = Math.round(uiWidth(glyphs, size, CHIP_TRACKING) + 2 * CHIP_PAD_X * size);
  const h = Math.round(CHIP_HEIGHT * size);
  const x = Math.round(centreX - w / 2);
  const y = Math.round(centreY - h / 2);
  const baseline = Math.round(centreY + (UI_CAP_EM * size) / 2);
  return {
    svg:
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${FG}"/>` +
      uiText(escapeSvgText(text), Math.round(x + CHIP_PAD_X * size), baseline, size, CHIP_TRACKING, BG),
    w,
    h,
    x,
    y,
  };
}

// ── Marks ─────────────────────────────────────────────────────────────────────────────
// A tile's corner radius: the previews' 4px ceiling.
const TILE_RADIUS = 4;

// The mark is the app's ONE avatar drawing: the palette's ground, the union outline of
// the filled cells on top, the tile's corners rounded (the web's `Avatar`, whose renderer
// this shares), always at a WHOLE scale — a size of ten whole cells, on whole pixels — so
// it is the same crisp pixel art the app draws. A stored string that will not decode falls
// back to the assigned mark rather than leaving a hole — a card must always draw a face,
// and the store only ever holds validated avatars anyway. Drawn by the group card's ring and
// by a SIGNED result card's portrait; `id` names the clip, which must be unique within one
// SVG.
function markTile(
  id: string,
  publicId: string,
  avatar: string | null,
  x: number,
  y: number,
  px: number,
): string {
  const cell = px / AVATAR_SIZE;
  const draw = (encoded: string) => {
    const { palette, cells } = decodeAvatar(encoded);
    return { ...AVATAR_PALETTES[palette], outline: avatarOutlinePath(cells, cell) };
  };
  let drawing: { bg: string; fg: string; outline: string };
  try {
    drawing = draw(avatar ?? defaultAvatar(publicId));
  } catch {
    drawing = draw(defaultAvatar(publicId));
  }
  return (
    `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${px}" height="${px}" rx="${TILE_RADIUS}"/></clipPath>` +
    // The clip sits on an UNtransformed group, in the same absolute space its rect is
    // written in, and the translate goes on a group inside it: whether a rasterizer
    // resolves a clip path before or after the referencing element's own transform is
    // exactly the kind of thing renderers disagree about, and this nesting has no
    // opinion to disagree with.
    `<g clip-path="url(#${id})"><g transform="translate(${x} ${y})" shape-rendering="crispEdges">` +
    `<rect width="${px}" height="${px}" fill="${drawing.bg}"/>` +
    (drawing.outline ? `<path d="${drawing.outline}" fill="${drawing.fg}"/>` : '') +
    `</g></g>`
  );
}

// A player as a card draws them: a signed share's signer, a group card's member.
export interface CardFace {
  publicId: string;
  // The STORED profile: '' / null when the player never customized one. The card
  // resolves the assigned fallbacks itself, so "the card shows what a board shows"
  // is a property of one function rather than of every caller.
  name: string;
  avatar: string | null;
}

// The room under the top row every card composes in.
const ROOM_TOP = 128;
const ROOM_BOTTOM = CARD_HEIGHT - 36;
const ROOM_CY = (ROOM_TOP + ROOM_BOTTOM) / 2;

// ── The GROUP invite link's card (#271, replacing #189's player card) ─────────────────
//
// What a `/g/<groupId>` link unfurls into in a chat: the group's NAME, its members'
// MARKS, and the APP NAME. Nothing else — no call to action, no daily. The link is
// already sent by a person to their people, so the message around it says what it is;
// the card only has to say WHICH group, and who is already in it.
//
// Drawn as the home card is (web `assets/previews/whippin.png`): the name in the title chip
// at the centre, where the home card holds its hidden word, and the members' marks around
// it on ONE orbit — a group is a circle of people. The orbit is the page's slate, never the
// heat: it means "in the group", not a distance. A group of one is one face on an orbit
// with room left on it.
//
// It draws the ASSIGNED mark for a member who never customized one (`assigned.ts`), so
// the faces in the chat are the faces the group's board shows.
const GROUP_MARK_PX = 120; // 12px a cell
// How many marks the orbit holds before it folds the rest into a `+N` tile.
const GROUP_MARKS_SHOWN = 6;
const GROUP_NAME_MAX_SIZE = 64;
// The chip's own width: up to 15 capitals keep the full size, the 20-glyph cap sets at 49 —
// and smaller still where a tile of the orbit would touch it (a group of three's lower pair).
const GROUP_NAME_WIDTH = 680;
const GROUP_NAME_CLEAR = 12; // the least room between the chip and a tile
const ORBIT_RX = 440;
const ORBIT_RY = 180;
const ORBIT_CELL = 4;
const ORBIT_DENSITY = 0.72;
const ORBIT_STROKE = 2.6; // cells across
const ORBIT_CLEAR = 16; // the knock-out around a tile and the chip
const ORBIT_MIN_PIECE = 14; // a scrap under this many cells reads as a stray dot: dropped
const SLATE = '#4a5578';
const SURFACE = '#14151c';

export interface GroupCardData {
  name: string;
  // The members' STORED profiles, in the group's own order; the card draws at most
  // `GROUP_MARKS_SHOWN` and folds the rest into a count.
  members: readonly CardFace[];
}

export function renderGroupCardSvg({ name, members }: GroupCardData): string {
  const cx = CARD_WIDTH / 2;
  const cy = Math.round(ROOM_CY);
  // The tiles on the orbit, clockwise from the top: the first members, then a `+N` tile in
  // the last place when the group is larger than the orbit holds. An even count turns
  // half a step, so no face stands right over or under the name.
  const overflow = members.length > GROUP_MARKS_SHOWN ? members.length - (GROUP_MARKS_SHOWN - 1) : 0;
  const drawn = overflow > 0 ? members.slice(0, GROUP_MARKS_SHOWN - 1) : members;
  const count = drawn.length + (overflow > 0 ? 1 : 0);
  const place = (k: number) => {
    const deg = -90 + (k * 360) / Math.max(1, count) + (count % 2 === 0 ? 180 / count : 0);
    const a = (deg * Math.PI) / 180;
    return {
      x: Math.round(cx + ORBIT_RX * Math.cos(a) - GROUP_MARK_PX / 2),
      y: Math.round(cy + ORBIT_RY * Math.sin(a) - GROUP_MARK_PX / 2),
    };
  };
  const spots = Array.from({ length: count }, (_, k) => place(k));

  // The name in the chrome's capitals, on one line always — the name is the thing the card
  // is about, and a wrapped one reads as two: the size is what fits the chip's width, and
  // keeps the chip clear of every tile.
  const shown = name.toUpperCase();
  const glyphs = Math.max(1, Array.from(shown).length);
  const perGlyph = UI_ADVANCE_EM + CHIP_TRACKING;
  let nameSize = Math.min(
    GROUP_NAME_MAX_SIZE,
    Math.max(1, Math.floor(GROUP_NAME_WIDTH / (glyphs * perGlyph + 2 * CHIP_PAD_X))),
  );
  const touches = (box: { x: number; y: number; w: number; h: number }) =>
    spots.some(
      ({ x, y }) =>
        x < box.x + box.w + GROUP_NAME_CLEAR &&
        box.x < x + GROUP_MARK_PX + GROUP_NAME_CLEAR &&
        y < box.y + box.h + GROUP_NAME_CLEAR &&
        box.y < y + GROUP_MARK_PX + GROUP_NAME_CLEAR,
    );
  let title = chip(shown, nameSize, cx, cy);
  while (nameSize > 1 && touches(title)) {
    nameSize -= 1;
    title = chip(shown, nameSize, cx, cy);
  }

  const marks = drawn.map((member, k) =>
    markTile(`member${k}`, member.publicId, member.avatar, spots[k].x, spots[k].y, GROUP_MARK_PX),
  );
  if (overflow > 0) {
    // `+N`: faces not shown yet — the slate in a checker of the marks' own cells, the count
    // on a cut-out of the ground.
    const { x, y } = spots[count - 1];
    const cell = GROUP_MARK_PX / AVATAR_SIZE;
    const label = `+${overflow}`;
    const size = label.length > 2 ? 32 : 40; // `+45` (the members' cap) holds the tile too
    const lw = label.length * size;
    marks.push(
      `<rect x="${x}" y="${y}" width="${GROUP_MARK_PX}" height="${GROUP_MARK_PX}" rx="${TILE_RADIUS}" fill="${SURFACE}"/>` +
        `<path d="${cellsPath(AVATAR_SIZE, AVATAR_SIZE, (i, j) => (i + j) % 2 === 0, cell, x, y)}" fill="${SLATE}" shape-rendering="crispEdges"/>` +
        `<rect x="${Math.round(x + GROUP_MARK_PX / 2 - lw / 2 - 8)}" y="${Math.round(y + GROUP_MARK_PX / 2 - size / 2 - 8)}" width="${lw + 16}" height="${size + 16}" fill="${BG}"/>` +
        `<text x="${Math.round(x + GROUP_MARK_PX / 2 - lw / 2)}" y="${pixelBaseline(y + GROUP_MARK_PX / 2, size)}" font-family="${PIXEL_FONT}" font-size="${size}" fill="${FG}">${label}</text>`,
    );
  }

  // The orbit: a stroke of whole cells on the 4px grid, dithered, knocked out around every tile
  // and the chip, its scraps dropped.
  const cols = Math.ceil(CARD_WIDTH / ORBIT_CELL);
  const rows = Math.ceil(CARD_HEIGHT / ORBIT_CELL);
  const clear = [
    ...spots.map(({ x, y }) => [x, y, GROUP_MARK_PX, GROUP_MARK_PX]),
    [title.x, title.y, title.w, title.h],
  ].map(([x, y, w, h]) => [x - ORBIT_CLEAR, y - ORBIT_CLEAR, x + w + ORBIT_CLEAR, y + h + ORBIT_CLEAR]);
  const ink = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const px = x * ORBIT_CELL + ORBIT_CELL / 2 - cx;
      const py = y * ORBIT_CELL + ORBIT_CELL / 2 - cy;
      // The distance to the ellipse, to first order: its implicit function over its gradient.
      const k = Math.hypot(px / ORBIT_RX, py / ORBIT_RY);
      const g = Math.hypot(px / (ORBIT_RX * ORBIT_RX), py / (ORBIT_RY * ORBIT_RY)) || 1;
      if (Math.abs(k - 1) * (k / g) >= (ORBIT_CELL * ORBIT_STROKE) / 2 || ORBIT_DENSITY <= bayerThreshold(x, y)) continue;
      const cxp = x * ORBIT_CELL + ORBIT_CELL / 2;
      const cyp = y * ORBIT_CELL + ORBIT_CELL / 2;
      if (clear.some(([l, t, r, b]) => cxp >= l && cxp <= r && cyp >= t && cyp <= b)) continue;
      ink[y * cols + x] = 1;
    }
  }
  dropScraps(ink, cols, rows, ORBIT_MIN_PIECE);
  const orbit = `<path d="${cellsPath(cols, rows, (x, y) => ink[y * cols + x] === 1, ORBIT_CELL, 0, 0)}" fill="${SLATE}" shape-rendering="crispEdges"/>`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${BG}"/>`,
    brackets(),
    orbit,
    title.svg,
    ...marks,
    lockup(),
    `</svg>`,
  ].join('');
}

// An orbit's knock-outs leave scraps: a piece of fewer than `min` cells (connected across
// a one-cell gap, the dither's) reads as a stray dot, not an orbit.
function dropScraps(ink: Uint8Array, cols: number, rows: number, min: number): void {
  const seen = new Uint8Array(ink.length);
  for (let i = 0; i < ink.length; i += 1) {
    if (!ink[i] || seen[i]) continue;
    const piece = [i];
    seen[i] = 1;
    for (let q = 0; q < piece.length; q += 1) {
      const x = piece[q] % cols;
      const y = (piece[q] / cols) | 0;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const j = ny * cols + nx;
          if (ink[j] && !seen[j]) {
            seen[j] = 1;
            piece.push(j);
          }
        }
      }
    }
    if (piece.length < min) for (const j of piece) ink[j] = 0;
  }
}


// ── The RESULT card ───────────────────────────────────────────────────────────────────
//
// The solved screen's CARD (web `SolvedCard`) laid down at the share's size — the screen is
// this card stood up, so the two wear the same furniture on the same bare ground: the device
// frame's corner brackets; the top row (the lockup, the EDITION number after it in the pixel
// face's smallest size, muted, and the day at the right in the accent: its calendar date, or
// BONUS); the COUNT over its unit as the subject; the run's HEAT rising off the RULER under it.
//
// THE COUNT IS THE SUBJECT (user-decided 2026-10-02), drawn as the screen draws it: cell by cell
// on the pixel face's own glyph pixels (`countCells.ts`), at the largest whole font pixel up to
// COUNT_FPX_MAX that fits the column, in the DITHERED HOLO FOIL (`foil.ts`) — the screen's one
// shiny material, at the instant its still count holds (COUNT_STILL_S, its seed: a glint
// standing in full on a cap-line corner). A round that ENDED UNSOLVED (the v6 capped flag:
// given up, or capped) wears no shine: a plain white `∞` on the count's own pixel grid.
//
// THE RUN'S HEAT (`runHeat.ts`, the screen's own field): the ruler's inks rising off the bar as
// an ordered dither, each column as tall as that try's reconstruction got, with a CLEARING of
// bare ground round each digit's ink and round the unit (`heatKeepOut`).
//
// THE RULER is the screen's (web `RunRuler`): one cell per counted try on the shared HEAT ramp
// (`progressHeatColor`) at the shared whole-pixel edges (`runEdges`), a white tick where each
// secret dropped and that hole's sentence index (1..3) in the pixel face under it.
//
// Everything is drawn on CARD_CELL px cells — the house's 2px at CARD_SCALE — so the dither
// reads as pixels in a chat's preview, and in its thumbnail the foil averages to its inks while
// the count, the largest thing on the card, still reads at a glance.
const CARD_CELL = 4;
const CARD_SCALE = CARD_CELL / FOIL_CELL_PX;
const BAR_X = 64;
const BAR_W = CARD_WIDTH - 2 * BAR_X;
// The ruler, bottom up: the indices' ink ends at INDEX_BOTTOM; NUM_GAP over them the ticks'
// feet; the bar BAR_H tall, the ticks TICK_W wide overhanging it TICK_OVERHANG either side.
const INDEX_BOTTOM = 562;
const NUM_SIZE = 32;
const NUM_GAP = 14;
const NUM_MIN_GAP = 12; // two indices set side by side never touch
const TICK_W = 8;
const TICK_OVERHANG = 12;
const BAR_H = 24;
const BAR_Y = INDEX_BOTTOM - inkHeight(NUM_SIZE) - NUM_GAP - TICK_OVERHANG - BAR_H;
// The unit over the bar, the count over the unit — the screen's spacing at the card's scale.
const UNIT_SIZE = 28;
const UNIT_TRACKING = 0.16;
const UNIT_TO_BAR = 50; // the unit's baseline to the bar's top
const UNIT_GAP = 38; // the count's ink to the unit's capitals
const UNIT_BASELINE = BAR_Y - UNIT_TO_BAR;
const UNIT_CAP_TOP = UNIT_BASELINE - Math.round(UI_CAP_EM * UNIT_SIZE);
const COUNT_BOTTOM = UNIT_CAP_TOP - UNIT_GAP;
// The count's font pixel at most (256px type): a multiple of the cell, so the foil's cells
// tile the glyphs' pixels exactly.
const COUNT_FPX_MAX = 32;
const FOIL_SEED = 5; // the screen's count's
const GLINT_CELL = COUNT_GLINT_CELL_PX * CARD_SCALE;
// The heat's field: from the bar's top up HEAT_ROWS cells — the count's band and 60px of the
// screen's over it, as the screen sizes its own.
const HEAT_ROWS = (COUNT_ROWS * COUNT_FPX_MAX + 60 * (COUNT_FPX_MAX / 20)) / CARD_CELL;
// The top row: the edition number in the pixel face's smallest whole size (a multiple of 8),
// muted, EDITION_GAP after the lockup's name; the day in the accent at the right.
const EDITION_SIZE = 16;
const EDITION_GAP = 28;
const DAY_SIZE = 24;
const MUTED = '#a6adb8';

// THE RUN'S CELL EDGES: where each of `n` tries' cells starts across a bar `width` whole
// pixels wide, plus the bar's end — integer boundaries tiling [0, width] exactly, so adjacent
// cells share an edge (no hairline seam under crispEdges) and the row never spills past the
// bar. A solve's tick stands on the edge after its try. ONE spelling for the card and the
// solved screen's ruler (web `RunRuler`), so the two draw the same cells and the same ticks.
export function runEdges(n: number, width: number): number[] {
  return Array.from({ length: n + 1 }, (_, i) => Math.round((i * width) / n));
}

// A puzzle's name in a shared result's HEADLINE: the day as its calendar date, or — a BONUS
// puzzle is no day (`bonus.ts`) — "BONUS" and its id.
export function cardPuzzleLabel({ dayNumber, bonusId }: Pick<CardData, 'dayNumber' | 'bonusId'>): string {
  return bonusId !== undefined ? `BONUS ${bonusId}` : dateForDayNumber(dayNumber ?? 0);
}

// A shared result's HEADLINE: the first line of the plain text a player shares, and the
// preview page's title. ONE spelling for the web (which composes the message), the backend
// (which titles the page) and the WhatsApp bot (which has to recognize the line to drop it
// from what it remembers). The caller localizes the UNIT; the shape of the line is here.
//
// The day is named by its CALENDAR DATE, not the internal day index: a
// reader can date the puzzle, and it is the same string the card draws and the shared link
// resolves to. `dateForDayNumber` is `dayNumber`'s exact inverse, so this is still the
// SERVER-owned game day, never the sharer's local date.
// `score` is a number on every ordinary result and the literal `∞` on a sentence round
// that ended unsolved (given up, or capped) — plain text has no font to be missing the glyph, so the character itself
// is right here (the CARD and the on-screen result draw the shared path data instead,
// because Press Start 2P has no such glyph).
//
// A BONUS puzzle (`bonus.ts`) is no day: it is named "BONUS <id>", the card's own label.
export function shareHeadline(
  ref: Pick<CardData, 'dayNumber' | 'bonusId'>,
  score: number | string,
  unit: string,
): string {
  return `Whippin AI ${cardPuzzleLabel(ref)} — ${score} ${unit}`;
}

// Cells on a grid (whole-cell coordinates, as a flat x, y list) as ONE path of row runs,
// `cell` px a cell from (ox, oy): a few thousand cells of one ink cost one element.
function runsPath(cells: readonly number[], cell: number, ox: number, oy: number): string {
  const rows = new Map<number, number[]>();
  for (let k = 0; k < cells.length; k += 2) {
    const row = rows.get(cells[k + 1]);
    if (row) row.push(cells[k]);
    else rows.set(cells[k + 1], [cells[k]]);
  }
  const runs: string[] = [];
  for (const y of [...rows.keys()].sort((a, b) => a - b)) {
    const xs = rows.get(y)!.sort((a, b) => a - b);
    for (let i = 0; i < xs.length; ) {
      let j = i + 1;
      while (j < xs.length && xs[j] === xs[j - 1] + 1) j += 1;
      runs.push(`M${ox + xs[i] * cell} ${oy + y * cell}h${(j - i) * cell}v${cell}h${-(j - i) * cell}z`);
      i = j;
    }
  }
  return runs.join(' ');
}

// One path per fill, in the order the fills were first met.
function fillPaths(byFill: Map<string, number[]>, cell: number, ox: number, oy: number): string {
  return [...byFill].map(([fill, cells]) => `<path d="${runsPath(cells, cell, ox, oy)}" fill="${fill}"/>`).join('');
}
const pushCell = (byFill: Map<string, number[]>, fill: string, x: number, y: number) => {
  const cells = byFill.get(fill);
  if (cells) cells.push(x, y);
  else byFill.set(fill, [x, y]);
};
const hex = ([r, g, b]: readonly number[]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

// A box the heat clears round.
type Box = { x: number; y: number; w: number; h: number };

// THE COUNT: where it stands and what it is — its font pixel, its ink box, and (a solved
// round) its digits.
interface CountLayout {
  text: string | null; // null: the round ended unsolved (`∞`)
  fpx: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
function countLayout(score: number, capped: boolean, centreX: number): CountLayout {
  const text = capped ? null : String(score);
  const ems = text === null ? INFINITY_GLYPH.width / COUNT_EM : inkEms(text.length);
  const fpx = Math.max(
    CARD_CELL,
    Math.min(COUNT_FPX_MAX, Math.floor(BAR_W / (ems * COUNT_EM) / CARD_CELL) * CARD_CELL),
  );
  const w = Math.round(ems * COUNT_EM * fpx);
  const h = COUNT_ROWS * fpx;
  return { text, fpx, x: Math.round(centreX - w / 2), y: COUNT_BOTTOM - h, w, h };
}

// The count in the FOIL: its cells in their inks, the glitter kept to its ink, the glints over
// all and across its edge — or the white `∞`, centred in the digits' band on the same grid.
function countSvg({ text, fpx, x, y, w, h }: CountLayout): string {
  if (text === null) {
    const iy = y + Math.round((h - INFINITY_GLYPH.height * fpx) / 2 / fpx) * fpx;
    return (
      `<g class="infinity" transform="translate(${x} ${iy}) scale(${fpx})" shape-rendering="crispEdges">` +
      `<path d="${INFINITY_GLYPH.path}" fill="${FG}"/></g>`
    );
  }
  const ink = countInk(DIGIT_MASKS, text);
  const inside = (px: number, py: number) => ink(Math.floor(px / fpx), Math.floor(py / fpx));
  const byFill = new Map<string, number[]>();
  foilCells(w, h, COUNT_STILL_S, FOIL_SEED, 0, inside, CARD_CELL, (k, cx, cy) =>
    pushCell(byFill, k === FOIL_WHITE ? FG : hex(foilInkRgb(k)), cx / CARD_CELL, cy / CARD_CELL),
  );
  const rect = (rx: number, ry: number, rw: number, rh: number) => `M${x + rx} ${y + ry}h${rw}v${rh}h${-rw}z`;
  const glitter: string[] = [];
  foilGlitter(w, h, COUNT_STILL_S, FOIL_SEED, inside, COUNT_SPARKLE, CARD_CELL, (...r) => glitter.push(rect(...r)));
  const glints: string[] = [];
  countGlints(capCorners(ink, 0, text.length, fpx, GLINT_CELL), w, COUNT_STILL_S, FOIL_SEED, GLINT_CELL, (...r) =>
    glints.push(rect(...r)),
  );
  const inkCells: number[] = [];
  for (let gy = 0; gy < COUNT_ROWS; gy += 1) {
    for (let gx = 0; gx < text.length * COUNT_EM; gx += 1) if (ink(gx, gy)) inkCells.push(gx, gy);
  }
  return (
    `<g class="count" data-count="${text}" shape-rendering="crispEdges">` +
    `<clipPath id="count-ink"><path d="${runsPath(inkCells, fpx, x, y)}"/></clipPath>` +
    fillPaths(byFill, CARD_CELL, x, y) +
    (glitter.length ? `<g clip-path="url(#count-ink)"><path d="${glitter.join(' ')}" fill="${FG}"/></g>` : '') +
    (glints.length ? `<path class="glints" d="${glints.join(' ')}" fill="${FG}"/>` : '') +
    `</g>`
  );
}

// What the heat clears round the count: each digit's ink box, or the `∞`'s whole band.
function countKeeps({ text, fpx, x, y, w, h }: CountLayout): HeatKeep[] {
  const clear = HEAT_CLEAR_PX * CARD_SCALE;
  if (text === null) return [{ x, y, w, h, clear, ramp: fpx }];
  return glyphBoxes(DIGIT_MASKS, text).map(({ x0, x1 }) => ({ x: x + x0 * fpx, y, w: (x1 - x0) * fpx, h, clear, ramp: fpx }));
}
// What the heat clears round a line of the mono, as the screen clears its unit.
const textKeep = (box: Box): HeatKeep => ({
  ...box,
  clear: HEAT_UNIT_CLEAR_PX * CARD_SCALE,
  ramp: HEAT_UNIT_RAMP_PX * CARD_SCALE,
});
// A line of the mono's box: its advance across, its em down round its capitals.
function textBox(left: number, baseline: number, glyphs: number, size: number, tracking: number): Box {
  const cap = Math.round(UI_CAP_EM * size);
  return { x: left, y: baseline - cap - Math.round((size - cap) / 2), w: Math.round(uiWidth(glyphs, size, tracking)), h: size };
}

// THE RUN'S HEAT over the bar, cleared round `keeps`: one path per ink.
function heatSvg(trajectory: readonly number[], keeps: readonly HeatKeep[]): string {
  const byFill = new Map<string, number[]>();
  heatCells(
    {
      cols: BAR_W / CARD_CELL,
      rows: HEAT_ROWS,
      width: BAR_W,
      cell: CARD_CELL,
      trajectory,
      shown: trajectory.length,
      rise: () => 1,
      lift: 0,
      clear: (cx, cy) => heatKeepOut(keeps, BAR_X + (cx + 0.5) * CARD_CELL, BAR_Y - (cy + 0.5) * CARD_CELL),
    },
    (color, cx, cy) => pushCell(byFill, color, cx, HEAT_ROWS - 1 - cy),
  );
  return `<g class="heat" shape-rendering="crispEdges">${fillPaths(byFill, CARD_CELL, BAR_X, BAR_Y - HEAT_ROWS * CARD_CELL)}</g>`;
}

// THE RULER: the run's cells, the ticks, the indices under them — set side by side when two
// solves stand closer than an index is wide, and kept inside the frame.
function rulerSvg(trajectory: readonly number[], solvedAt: readonly (number | null)[]): string {
  const n = Math.max(1, trajectory.length);
  // Solve moments: one tick per solved secret, on the RIGHT edge of the cell of the try that
  // solved it (the state AFTER the guess), the hole's sentence index under it.
  const ticks = solvedAt
    .map((at, i) => (at == null ? null : { at, hole: i + 1 }))
    .filter((tick): tick is { at: number; hole: number } => tick !== null)
    .sort((a, b) => a.at - b.at);
  // Integer cell boundaries so adjacent cells share an edge EXACTLY — no hairline seams
  // under crispEdges — and, because the boundaries tile [BAR_X, BAR_X + BAR_W) exactly,
  // the row can never spill past the bar's right edge.
  const edges = runEdges(n, BAR_W);
  const edge = (i: number) => BAR_X + edges[i];
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
      return `<rect x="${x}" y="${BAR_Y}" width="${w}" height="${BAR_H}" fill="${progressHeatColor(pct)}"/>`;
    })
    .join('');
  // The indices' lefts: centred under their ticks, then pushed apart left to right and pulled
  // back inside the frame from the right.
  const xs = ticks.map(({ at }) => edge(Math.min(at, n)));
  const lefts = xs.map((x) => x - NUM_SIZE / 2);
  for (let k = 1; k < lefts.length; k += 1) lefts[k] = Math.max(lefts[k], lefts[k - 1] + NUM_SIZE + NUM_MIN_GAP);
  const right = BAR_X + BAR_W + NUM_SIZE / 2;
  for (let k = lefts.length - 1; k >= 0; k -= 1) {
    const limit = k === lefts.length - 1 ? right - NUM_SIZE : lefts[k + 1] - NUM_SIZE - NUM_MIN_GAP;
    lefts[k] = Math.min(lefts[k], limit);
  }
  const numBaseline = INDEX_BOTTOM + Math.round(PIXEL_INK_LIFT_EM * NUM_SIZE);
  const marks = ticks
    .map(
      ({ hole }, k) =>
        `<rect x="${xs[k] - TICK_W / 2}" y="${BAR_Y - TICK_OVERHANG}" width="${TICK_W}" height="${BAR_H + 2 * TICK_OVERHANG}" fill="${FG}"/>` +
        `<text x="${lefts[k]}" y="${numBaseline}" font-family="${PIXEL_FONT}" font-size="${NUM_SIZE}" fill="${FG}">${hole}</text>`,
    )
    .join('');
  return `<g class="run" shape-rendering="crispEdges">${cells}${marks}</g>`;
}

// ── The SIGNATURE (a signed share, user-decided 2026-09-05) ───────────────────────────
// The player as a quiet SIGNATURE, never a co-subject — the score is what the card is about,
// and the page's title already names them: the mark small, at one card cell a mark cell, and
// the name beside it, standing on the top row just before the day, `right` its right edge —
// the card's own furniture, read like a byline.
const SIGN_MARK_PX = 40;
const SIGN_NAME_SIZE = 22;
const SIGN_NAME_TRACKING = 0.02;
const SIGN_MARK_GAP = 14; // the mark to the name
const SIGN_GAP = 40; // the name to the day

interface Signed {
  svg: string;
  // What the heat clears round it (nothing, on the top row).
  keeps: HeatKeep[];
}

function signature(by: CardFace, right: number): Signed {
  const name = by.name || anonName(by.publicId);
  const nameW = Math.round(uiWidth(Array.from(name).length, SIGN_NAME_SIZE, SIGN_NAME_TRACKING));
  const nameLeft = right - SIGN_GAP - nameW;
  const markX = nameLeft - SIGN_MARK_GAP - SIGN_MARK_PX;
  return {
    svg:
      markTile('sign', by.publicId, by.avatar, markX, Math.round(TOP_ROW_CY - SIGN_MARK_PX / 2), SIGN_MARK_PX) +
      uiText(escapeSvgText(name), nameLeft, onRow(SIGN_NAME_SIZE), SIGN_NAME_SIZE, SIGN_NAME_TRACKING, FG),
    keeps: [],
  };
}

export function renderCardSvg(
  { lang, dayNumber, bonusId, score, trajectory, solvedAt, capped = false }: CardData,
  by: CardFace | null = null,
): string {
  const unit = UNITS[lang] ?? UNITS.en;
  const count = countLayout(score, capped, CARD_WIDTH / 2);

  // The unit centred under the count's ink. A capped round has no count to name, so the unit
  // is always plural.
  const word = !capped && score === 1 ? unit.one : unit.many;
  const wordW = Math.round(uiWidth(word.length, UNIT_SIZE, UNIT_TRACKING));
  const wordLeft = Math.round(count.x + count.w / 2 - wordW / 2);

  // The top row, as the screen's: the edition number (the day's, or the bonus's id) after the
  // lockup, muted; the day itself at the right in the accent — its calendar date, or BONUS.
  const bonus = bonusId !== undefined;
  const number = `N.${bonus ? bonusId : (dayNumber ?? 0)}`;
  const numberLeft = Math.round(
    LOCKUP_X + MARK_GLYPH.width * LOCKUP_SCALE + LOCKUP_GAP + uiWidth(APP_NAME.length, LOCKUP_SIZE, LOCKUP_TRACKING) + EDITION_GAP,
  );
  const day = bonus ? 'BONUS' : dateForDayNumber(dayNumber ?? 0);
  const dayLeft = CARD_WIDTH - LOCKUP_X - day.length * DAY_SIZE;

  const signed = by ? signature(by, dayLeft) : null;
  const keeps = [
    ...countKeeps(count),
    textKeep(textBox(wordLeft, UNIT_BASELINE, word.length, UNIT_SIZE, UNIT_TRACKING)),
    ...(signed?.keeps ?? []),
  ];

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${BG}"/>`,
    brackets(),
    lockup(),
    `<text class="edition" x="${numberLeft}" y="${pixelBaseline(TOP_ROW_CY, EDITION_SIZE)}" font-family="${PIXEL_FONT}" font-size="${EDITION_SIZE}" fill="${MUTED}">${number}</text>`,
    `<text class="day" x="${dayLeft}" y="${pixelBaseline(TOP_ROW_CY, DAY_SIZE)}" font-family="${PIXEL_FONT}" font-size="${DAY_SIZE}" fill="${ACCENT}">${day}</text>`,
    heatSvg(trajectory, keeps),
    rulerSvg(trajectory, solvedAt),
    // The count, not "SCORE N": naming the unit is what tells a stranger seeing the card
    // that lower is better. Localized by the token's lang (#59). A capped round draws `∞`
    // instead — same band, same unit, no number (#214).
    countSvg(count),
    uiText(word, wordLeft, UNIT_BASELINE, UNIT_SIZE, UNIT_TRACKING, FG),
    signed?.svg ?? '',
    `</svg>`,
  ].join('');
}

// The pixel face's ink height at a size: its cap height, on whole pixels.
function inkHeight(size: number): number {
  return Math.round(INFINITY_EM_HEIGHT * size);
}
