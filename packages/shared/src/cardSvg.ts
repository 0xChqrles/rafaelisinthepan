// Share-card SVG (issue #8): a pure, dependency-free renderer for the OG cards the backend
// draws per link — a shared RESULT and a GROUP invite. The backend rasterizes this SVG to a
// PNG (with the pixel face and the chrome's mono) for the link's OG image. Pure +
// deterministic, so it is fully unit-testable without any AWS/rasterizer.
//
// Both wear the FRAME of the site's own link previews (web `linkPreviews.ts`, the cards in
// `assets/previews/`): the flat ground, the device frame's corner brackets, and the lockup —
// the app's mark in the accent beside its name in the chrome's mono. A result is the solved
// screen's result set on the ground: the count in the pixel face, its unit under it, the run
// ruler; a group is its name in the title chip, its members' marks on an orbit around it — as
// the home card holds its hidden word.
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
// the raw run): one cell per counted try on the shared HEAT ramp (progressHeatColor, so the
// card matches the on-screen bar exactly — and since 2026-08-16 that is the game's one ramp,
// each try's % read straight as heat), a tick where each secret dropped, and that hole's
// sentence index (1..3) under it. The share TEXT's emoji row
// summarises this same bar into a bounded 3..18 cells on the same ramp (it has to fit a text
// message); the card draws every try AND the ticks, so it stays the richer view.
//
// Result-card strings are numeric fields plus fixed units. The one free text a card draws is
// a NAME (a signed share's signer, a group card's group), XML-escaped before interpolation.

import { anonName, defaultAvatar } from './assigned';
import { AVATAR_PALETTES, AVATAR_SIZE, decodeAvatar } from './avatar';
import { avatarOutlinePath } from './avatarOutline';
import { dateForDayNumber } from './day';
import { bayerThreshold } from './bayer';
import { INFINITY_EM_HEIGHT, INFINITY_GLYPH, MARK_GLYPH, PIXEL_INK_LIFT_EM } from './glyphs';
import { progressHeatColor } from './heat';
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
// The solved screen's result (web `SolvedScreen`'s score block), set straight on the ground
// as the site's previews set their subject: the count in the pixel face, its unit under it
// in the mono, and the run ruler across the card's whole column. The day is the top row's
// EDITION, opposite the lockup: its calendar date (or BONUS and its id).
// A SIGNED share (user-decided 2026-09-05) sets the player's mark beside the count as a
// portrait, its name in the title chip under it; a plain share's count stands alone.
const SCORE_SIZE = 160; // 20px a pixel of the face
const UNIT_SIZE = 32;
const UNIT_TRACKING = 0.16;
const UNIT_GAP = 24; // the count's ink to the unit's capitals
// Ruler geometry: the on-screen ruler (web `RunRuler`: a 16px bar across the result's column,
// 4px ticks overhanging 8px, 16px indices) drawn across the card's column, its ticks and
// indices heavier than one scale would make them so they still read in a chat's thumbnail.
const BAR_X = 64;
const BAR_W = CARD_WIDTH - 2 * BAR_X;
const BAR_H = 48;
const TICK_W = 8;
const TICK_OVERHANG = 16;
const NUM_SIZE = 32;
const NUM_GAP = 14; // the tick's foot to the index's ink
const HERO_GAP = 40; // the hero's foot to the ticks' tops
// The signed card's portrait: the mark at 16px a cell, its name chip under it.
const PORTRAIT_PX = 160;
const PORTRAIT_NAME_SIZE = 28;
const PORTRAIT_NAME_GAP = 16;
const PORTRAIT_GAP = 72; // the portrait column to the count's
// The edition, on the top row: the day's own label in the pixel face's accent.
const EDITION_SIZE = 24;

// THE RUN'S CELL EDGES: where each of `n` tries' cells starts across a bar `width` whole
// pixels wide, plus the bar's end — integer boundaries tiling [0, width] exactly, so adjacent
// cells share an edge (no hairline seam under crispEdges) and the row never spills past the
// bar. A solve's tick stands on the edge after its try. ONE spelling for the card and the
// solved screen's ruler (web `RunRuler`), so the two draw the same cells and the same ticks.
export function runEdges(n: number, width: number): number[] {
  return Array.from({ length: n + 1 }, (_, i) => Math.round((i * width) / n));
}

// The headline: the count, or `∞` for a round that ended unsolved (the v6 capped flag:
// given up, or capped), over its unit. Press Start 2P
// advances exactly 1em per glyph, so nothing is measured. The ∞ (a path, since the face has
// no such glyph) fills the digits' own band on WHOLE cells — the band's height in five rows
// of the glyph's grid — its ink bottom where the digits' is.
function scoreLockup(
  score: number,
  capped: boolean,
  unit: { one: string; many: string },
  centreX: number,
  top: number,
): string {
  const inkH = Math.round(INFINITY_EM_HEIGHT * SCORE_SIZE);
  const baseline = Math.round(top + inkH + PIXEL_INK_LIFT_EM * SCORE_SIZE);
  // A capped round has no count to name, so the unit is always plural.
  const word = !capped && score === 1 ? unit.one : unit.many;
  const unitLine = uiText(word, centreX, Math.round(top + inkH + UNIT_GAP + UI_CAP_EM * UNIT_SIZE), UNIT_SIZE, UNIT_TRACKING, FG, 'middle');
  if (!capped) {
    const label = String(score);
    const x = Math.round(centreX - (label.length * SCORE_SIZE) / 2);
    return `<text x="${x}" y="${baseline}" font-family="${PIXEL_FONT}" font-size="${SCORE_SIZE}" fill="${FG}">${label}</text>` + unitLine;
  }
  const cell = Math.round(inkH / INFINITY_GLYPH.height);
  const w = cell * INFINITY_GLYPH.width;
  const h = cell * INFINITY_GLYPH.height;
  const x = Math.round(centreX - w / 2);
  const y = top + inkH - h;
  return (
    `<g class="infinity" transform="translate(${x} ${y}) scale(${cell})" shape-rendering="crispEdges">` +
    `<path d="${INFINITY_GLYPH.path}" fill="${FG}"/></g>` +
    unitLine
  );
}

// How wide the headline column is: the count (or the ∞) and the unit under it.
function scoreWidth(score: number, capped: boolean, unit: { one: string; many: string }): number {
  const inkH = Math.round(INFINITY_EM_HEIGHT * SCORE_SIZE);
  const head = capped ? Math.round(inkH / INFINITY_GLYPH.height) * INFINITY_GLYPH.width : String(score).length * SCORE_SIZE;
  const word = !capped && score === 1 ? unit.one : unit.many;
  return Math.max(head, uiWidth(word.length, UNIT_SIZE, UNIT_TRACKING));
}

// The card's edition: the day as its calendar date, or — a BONUS puzzle is no day
// (`bonus.ts`) — "BONUS" and its id.
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

export function renderCardSvg(
  { lang, dayNumber, bonusId, score, trajectory, solvedAt, capped = false }: CardData,
  by: CardFace | null = null,
): string {
  const n = Math.max(1, trajectory.length);
  const unit = UNITS[lang] ?? UNITS.en;

  // Solve moments: one tick per solved secret, on the RIGHT edge of the cell of the try that
  // solved it (the state AFTER the guess), the hole's sentence index under it. The secrets
  // are distinct words, so no try solves two: every tick holds one index.
  const ticks = solvedAt
    .map((at, i) => (at == null ? null : { at, hole: i + 1 }))
    .filter((tick): tick is { at: number; hole: number } => tick !== null)
    .sort((a, b) => a.at - b.at);

  // The hero (the count, beside the portrait on a signed card), the ruler under it, and the
  // row of indices — none on a capped round, which has no tick. The block is centred in the
  // room under the top row.
  const inkH = Math.round(INFINITY_EM_HEIGHT * SCORE_SIZE);
  const countH = inkH + UNIT_GAP + Math.round(UI_CAP_EM * UNIT_SIZE);
  const signer = by ? by.name || anonName(by.publicId) : '';
  const nameChipH = Math.round(CHIP_HEIGHT * PORTRAIT_NAME_SIZE);
  const heroH = by ? Math.max(countH, PORTRAIT_PX + PORTRAIT_NAME_GAP + nameChipH) : countH;
  const numH = ticks.length ? NUM_GAP + inkHeight(NUM_SIZE) : 0;
  const blockH = heroH + HERO_GAP + 2 * TICK_OVERHANG + BAR_H + numH;
  const top = Math.round(ROOM_CY - blockH / 2);
  const barY = top + heroH + HERO_GAP + TICK_OVERHANG;

  // The hero row: the count alone, or the portrait column and the count's side by side.
  const countW = scoreWidth(score, capped, unit);
  let hero: string;
  if (by) {
    const nameW = Math.round(uiWidth(Array.from(signer).length, PORTRAIT_NAME_SIZE, CHIP_TRACKING) + 2 * CHIP_PAD_X * PORTRAIT_NAME_SIZE);
    const portraitW = Math.max(PORTRAIT_PX, nameW);
    const left = Math.round(CARD_WIDTH / 2 - (portraitW + PORTRAIT_GAP + countW) / 2);
    const pcx = left + portraitW / 2;
    const portraitTop = top + Math.round((heroH - (PORTRAIT_PX + PORTRAIT_NAME_GAP + nameChipH)) / 2);
    hero =
      markTile('sign', by.publicId, by.avatar, Math.round(pcx - PORTRAIT_PX / 2), portraitTop, PORTRAIT_PX) +
      chip(signer, PORTRAIT_NAME_SIZE, pcx, portraitTop + PORTRAIT_PX + PORTRAIT_NAME_GAP + nameChipH / 2).svg +
      scoreLockup(score, capped, unit, left + portraitW + PORTRAIT_GAP + countW / 2, top + Math.round((heroH - countH) / 2));
  } else {
    hero = scoreLockup(score, capped, unit, CARD_WIDTH / 2, top);
  }

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
      return `<rect x="${x}" y="${barY}" width="${w}" height="${BAR_H}" fill="${progressHeatColor(pct)}"/>`;
    })
    .join('');

  // The ticks on whole pixels, their indices centred under them.
  const tickX = (at: number) => edge(Math.min(at, n));
  const numBaseline = barY + BAR_H + TICK_OVERHANG + NUM_GAP + inkHeight(NUM_SIZE) + Math.round(PIXEL_INK_LIFT_EM * NUM_SIZE);
  const marks = ticks
    .map(({ at, hole }) => {
      const x = tickX(at);
      return (
        `<rect x="${x - TICK_W / 2}" y="${barY - TICK_OVERHANG}" width="${TICK_W}" height="${BAR_H + 2 * TICK_OVERHANG}" fill="${FG}"/>` +
        `<text x="${x - NUM_SIZE / 2}" y="${numBaseline}" font-family="${PIXEL_FONT}" font-size="${NUM_SIZE}" fill="${FG}">${hole}</text>`
      );
    })
    .join('');

  // The edition, right-aligned on the top row: the date, or BONUS and its id.
  const edition = cardPuzzleLabel({ dayNumber, bonusId });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${BG}"/>`,
    brackets(),
    lockup(),
    `<text x="${CARD_WIDTH - LOCKUP_X - edition.length * EDITION_SIZE}" y="${pixelBaseline(TOP_ROW_CY, EDITION_SIZE)}" font-family="${PIXEL_FONT}" font-size="${EDITION_SIZE}" fill="${ACCENT}">${edition}</text>`,
    // The count, not "SCORE N": naming the unit is what tells a stranger seeing the card
    // that lower is better. Localized by the token's lang (#59). A capped round draws `∞`
    // instead — same band, same unit, no number (#214).
    hero,
    `<g class="run" shape-rendering="crispEdges">${cells}${marks}</g>`,
    `</svg>`,
  ].join('');
}

// The pixel face's ink height at a size: its cap height, on whole pixels.
function inkHeight(size: number): number {
  return Math.round(INFINITY_EM_HEIGHT * size);
}
