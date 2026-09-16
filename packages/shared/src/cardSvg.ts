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
import {
  INFINITY_EM_HEIGHT,
  INFINITY_EM_WIDTH,
  INFINITY_GLYPH,
  PIXEL_INK_LIFT_EM,
} from './glyphs';
import { progressHeatColor } from './heat';
import type { ShareResult } from './shareCard';

// Standard OG image size (Twitter/Slack/Discord `summary_large_image`).
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

// Palette — mirrors :root in web/src/index.css (the 2026-09-01 rebrand: white fg on a
// near-black ground).
const BG = '#050507';
const FG = '#ffffff';
const MUTED = '#a6adb8';

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

// What the card draws IS what the token carries, so the renderer takes the codec's own
// result type rather than a second declaration of the same five fields.
export type CardData = ShareResult;

function escapeSvgText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── The GROUP invite link's card (#271, replacing #189's player card) ─────────────────
//
// What a `/g/<groupId>` link unfurls into in a chat: the group's NAME, its members'
// MARKS in a row, and the APP NAME. Nothing else — no call to action, no daily. The link
// is already sent by a person to their people, so the message around it says what it is;
// the card only has to say WHICH group, and who is already in it.
//
// It draws the ASSIGNED mark for a member who never customized one (`assigned.ts`), so
// the faces in the chat are the faces the group's board shows.
const GROUP_MARK_PX = 128;
const GROUP_MARK_GAP = 28;
const GROUP_MARKS_Y = 118;
// How many marks the row draws before it folds the rest into a `+N` tile: six marks
// with their gaps run 908 of the 1020 the margins leave.
const GROUP_MARKS_SHOWN = 6;
const GROUP_NAME_Y = 410; // baseline
const GROUP_NAME_MAX_SIZE = 60;
// The name's own column, well inside the card's margins (the player card's rule): a
// 16-character name set at the max size runs 960 of the 1020 the margins leave, which
// reads as the name wearing the card. Held to this box, everything up to 12 glyphs keeps
// the full size and only a genuinely long name steps down.
const GROUP_NAME_WIDTH = 720;
const GROUP_APP_Y = 528; // baseline
const GROUP_APP_SIZE = 28;
const APP_NAME = 'WHIPPIN AI';

// The mark is the app's ONE avatar drawing: the palette's ground, the union outline of
// the filled cells on top, and only the tile's outer corners rounded (the web's `Avatar`,
// whose renderer this shares). A stored string that will not decode falls back to the
// assigned mark rather than leaving a hole — a card must always draw a face, and the store
// only ever holds validated avatars anyway. Drawn by the group card's member row and by a
// SIGNED result card's strip; `id` names the clip, which must be unique within one SVG.
function markTile(
  id: string,
  publicId: string,
  avatar: string | null,
  x: number,
  y: number,
  px: number,
): string {
  const cell = px / AVATAR_SIZE;
  let drawing: { bg: string; fg: string; outline: string };
  try {
    const { palette, cells } = decodeAvatar(avatar ?? defaultAvatar(publicId));
    drawing = { ...AVATAR_PALETTES[palette], outline: avatarOutlinePath(cells, cell) };
  } catch {
    const { palette, cells } = decodeAvatar(defaultAvatar(publicId));
    drawing = { ...AVATAR_PALETTES[palette], outline: avatarOutlinePath(cells, cell) };
  }
  const radius = Math.round(px * 0.036); // the web tile's proportion
  return (
    `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${px}" height="${px}" rx="${radius}"/></clipPath>` +
    // The clip sits on an UNtransformed group, in the same absolute space its rect is
    // written in, and the translate goes on a group inside it: whether a rasterizer
    // resolves a clip path before or after the referencing element's own transform is
    // exactly the kind of thing renderers disagree about, and this nesting has no
    // opinion to disagree with.
    `<g clip-path="url(#${id})"><g transform="translate(${x} ${y})">` +
    `<rect width="${px}" height="${px}" fill="${drawing.bg}"/>` +
    (drawing.outline ? `<path d="${drawing.outline}" fill="${drawing.fg}"/>` : '') +
    `</g></g>`
  );
}

// A SIGNED result card's strip (user-decided 2026-09-05): the player's mark and name as
// one centred lockup above the result. The name is set small and held to the profile's
// own 16-glyph cap, so the widest signature still clears the margins; the RESULT stays the
// card's subject. Absent on a plain (unsigned) share.
//
// SPACING (user feedback the same day, "improve the spacing on the og preview when the
// user infos are on"): the strip is not pinned to the top edge with the result left where
// it was — that read as a face floating over a card. Each card names where its strip sits
// and how far its RESULT moves down to make room, so strip + gap + result is ONE block
// centred on the card, top and bottom margins alike. The plain card is untouched (shift 0).
const SIGN_AVATAR_PX = 64;
const SIGN_GAP = 22;
const SIGN_NAME_SIZE = 28;
// The ruler's tick tops start at BAR_Y − TICK_OVERHANG = 171 and the date sits at 500;
// moved down 30 the result runs 201..538, and the strip at 97..161 leaves 40 to the ticks —
// 97 above, 92 below.
const SIGN_Y = 97;
const SIGN_SHIFT = 30;

function signatureStrip({ publicId, name, avatar }: CardFace, y: number): string {
  const shown = name || anonName(publicId);
  const glyphs = Math.max(1, Array.from(shown).length);
  const width = SIGN_AVATAR_PX + SIGN_GAP + glyphs * SIGN_NAME_SIZE;
  const x = Math.round(CARD_WIDTH / 2 - width / 2);
  const nameX = x + SIGN_AVATAR_PX + SIGN_GAP;
  const cy = y + SIGN_AVATAR_PX / 2;
  return (
    markTile('sign', publicId, avatar, x, y, SIGN_AVATAR_PX) +
    `<text x="${nameX}" y="${cy}" dy="0.16em" dominant-baseline="middle" font-family="${CARD_FONT}" font-size="${SIGN_NAME_SIZE}" font-variant-ligatures="none" fill="${FG}">${escapeSvgText(shown)}</text>`
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

export interface GroupCardData {
  name: string;
  // The members' STORED profiles, in the group's own order; the card draws at most
  // `GROUP_MARKS_SHOWN` and folds the rest into a count.
  members: readonly CardFace[];
}

export function renderGroupCardSvg({ name, members }: GroupCardData): string {
  const cx = CARD_WIDTH / 2;
  // Press Start 2P advances exactly 1em per glyph, so the name fits its column at
  // `size = width / glyphs` — one line always, since the name is the thing the card is
  // about and a wrapped one reads as two.
  const glyphs = Math.max(1, Array.from(name).length);
  const nameSize = Math.min(
    GROUP_NAME_MAX_SIZE,
    Math.max(1, Math.floor(GROUP_NAME_WIDTH / glyphs)),
  );

  // The marks, centred as one row: the first members, then a `+N` tile standing where
  // the seventh mark would when the group is larger than the row.
  const overflow = members.length > GROUP_MARKS_SHOWN ? members.length - (GROUP_MARKS_SHOWN - 1) : 0;
  const shown = overflow > 0 ? members.slice(0, GROUP_MARKS_SHOWN - 1) : members;
  const tiles = shown.length + (overflow > 0 ? 1 : 0);
  const rowWidth = tiles * GROUP_MARK_PX + Math.max(0, tiles - 1) * GROUP_MARK_GAP;
  const rowX = Math.round(cx - rowWidth / 2);
  const tileX = (index: number) => rowX + index * (GROUP_MARK_PX + GROUP_MARK_GAP);
  const marks = shown.map((member, index) =>
    markTile(`member${index}`, member.publicId, member.avatar, tileX(index), GROUP_MARKS_Y, GROUP_MARK_PX),
  );
  if (overflow > 0) {
    const x = tileX(shown.length);
    const radius = Math.round(GROUP_MARK_PX * 0.036);
    marks.push(
      `<rect x="${x}" y="${GROUP_MARKS_Y}" width="${GROUP_MARK_PX}" height="${GROUP_MARK_PX}" rx="${radius}" fill="none" stroke="${MUTED}" stroke-width="3"/>` +
        `<text x="${x + GROUP_MARK_PX / 2}" y="${GROUP_MARKS_Y + GROUP_MARK_PX / 2}" dy="0.16em" dominant-baseline="middle" text-anchor="middle" font-family="${CARD_FONT}" font-size="${GROUP_APP_SIZE}" fill="${MUTED}">+${overflow}</text>`,
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${BG}"/>`,
    ...marks,
    `<text x="${cx}" y="${GROUP_NAME_Y}" text-anchor="middle" font-family="${CARD_FONT}" font-size="${nameSize}" font-variant-ligatures="none" fill="${FG}">${escapeSvgText(name)}</text>`,
    `<text x="${cx}" y="${GROUP_APP_Y}" text-anchor="middle" font-family="${CARD_FONT}" font-size="${GROUP_APP_SIZE}" fill="${MUTED}">${APP_NAME}</text>`,
    `</svg>`,
  ].join('');
}

// The headline's own band: `<n> TRIES`, or `∞ TRIES` for a #214 capped round.
// Press Start 2P advances exactly 1em per glyph, so a lockup's width is a SUM OF EMS and a
// centred one needs no measuring — which is what lets the ∞ (a path, since the face has no
// such glyph and the rasterizer loads no other font) sit on the line as if it were type.
const SCORE_BASELINE = 430;
const SCORE_SIZE = 76;

function scoreLockup(score: number, capped: boolean, unit: { one: string; many: string }): string {
  const cx = CARD_WIDTH / 2;
  if (!capped) {
    const label = `${score} ${score === 1 ? unit.one : unit.many}`;
    return `<text x="${cx}" y="${SCORE_BASELINE}" text-anchor="middle" font-family="${CARD_FONT}" font-size="${SCORE_SIZE}" fill="${FG}">${label}</text>`;
  }
  // A capped round has no count to name, so the unit is always plural. The glyph stands in
  // the digits' own band (cap height, `INFINITY_EM_HEIGHT`) and the space between it and
  // the word costs the face's one em, exactly as it would in the uncapped string. Its ink
  // bottom lands where the FACE's does — `PIXEL_INK_LIFT_EM` above the nominal baseline,
  // since Press Start 2P reserves descender room under every glyph.
  const glyphW = INFINITY_EM_WIDTH * SCORE_SIZE;
  const glyphH = INFINITY_EM_HEIGHT * SCORE_SIZE;
  const total = glyphW + (1 + unit.many.length) * SCORE_SIZE;
  const x = cx - total / 2;
  const y = SCORE_BASELINE - PIXEL_INK_LIFT_EM * SCORE_SIZE - glyphH;
  const scale = glyphH / INFINITY_GLYPH.height;
  return (
    `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(4)})" shape-rendering="crispEdges">` +
    `<path d="${INFINITY_GLYPH.path}" fill="${FG}"/></g>` +
    `<text x="${(x + glyphW + SCORE_SIZE).toFixed(2)}" y="${SCORE_BASELINE}" font-family="${CARD_FONT}" font-size="${SCORE_SIZE}" fill="${FG}">${unit.many}</text>`
  );
}

export function renderCardSvg(
  { lang, dayNumber, score, trajectory, solvedAt, capped = false }: CardData,
  by: CardFace | null = null,
): string {
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
      return `<rect x="${x}" y="${BAR_Y}" width="${w}" height="${BAR_H}" fill="${progressHeatColor(pct)}"/>`;
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
    by ? signatureStrip(by, SIGN_Y) : '',
    `<g transform="translate(0 ${by ? SIGN_SHIFT : 0})">`,
    `<g shape-rendering="crispEdges">${cells}</g>`,
    marks,
    // "N TRIES", not "SCORE N": naming the unit is what tells a stranger seeing the
    // card that lower is better. Localized by the token's lang (#59). A capped round
    // draws `∞ TRIES` instead — same band, same unit, no number (#214).
    scoreLockup(score, capped, unit),
    `<text x="${cx}" y="500" text-anchor="middle" font-family="${CARD_FONT}" font-size="30" fill="${MUTED}">${dateForDayNumber(dayNumber)}</text>`,
    `</g>`,
    `</svg>`,
  ].join('');
}
