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
// Sentence-card strings are numeric fields plus fixed units. Word mode additionally carries
// the day's accented display word in its token; that one value is XML-escaped before it is
// interpolated into the SVG.

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
import type { ShareResult, WordShareResult } from './shareCard';

// Standard OG image size (Twitter/Slack/Discord `summary_large_image`).
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

// Palette — mirrors :root in web/src/index.css (the 2026-09-01 rebrand: white fg on a
// near-black ground, and the SOLVE ink — the blue every solved word wears, the card's
// day word included).
const BG = '#050507';
const FG = '#ffffff';
const MUTED = '#a6adb8';
const SOLVE = '#4a6aff';

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

// Word mode's card (#156): the run has no trajectory to draw — the result is the claim
// count and, since the v5 token (2026-08-11), its PER-RARITY breakdown — so the card is
// the day's word in the game's accent, the count with its unit named ("12 WORDS":
// higher is better here), the breakdown as a row of grade-coloured chips, and the day.
// **The word is the WORD ALONE, centred — no node square** (user-decided 2026-08-11,
// superseding the terminus lockup): the in-game square marks the end of a LINE, and this
// card draws no line, so it was a station badge with nothing to be a station of. The
// colour already says the word is the solved target, and dropping the square hands the
// full column back to the type — a 25-letter French word now sets at 40px where the
// lockup left it 36.
const WORD_UNITS: Record<string, { one: string; many: string }> = {
  en: { one: 'WORD', many: 'WORDS' },
  fr: { one: 'MOT', many: 'MOTS' },
};

// The rarity chip colours, commonest first (COMMON..ARCANE) — PINNED COPIES of the web's
// RARITY_COLORS (web/src/components/rarity.ts), the same one-way copy the BG/FG/MUTED/
// SOLVE palette above makes of :root. The web's rarity.test.ts asserts the two stay
// identical, so a grade retune fails there instead of the card silently wearing a stale
// ladder. A FIXED table of constants (never interpolated input), so the renderer's "no
// text to escape" guarantee holds for the chip row.
export const WORD_RARITY_COLORS: readonly string[] = [
  '#97a3c9', // COMMON
  '#4fd2e8', // UNCOMMON
  '#64a0ff', // RARE
  '#bd68ff', // OBSCURE
  '#ff5ce0', // ARCANE
];

export type WordCardData = WordShareResult;

const WORD_ROW_Y = 175;
const WORD_MAX_SIZE = 76;
const WORD_SCORE_Y = 355;
// The breakdown row: a colour square + its count per claimed grade. Sized as ONE unit —
// every measure is a multiple of the chip size (Press Start 2P advances exactly 1em per
// glyph), so the whole row shrinks together when a forged token's counts would overflow.
const CHIP_ROW_Y = 458;
const CHIP_MAX_SIZE = 44;
const CHIP_TEXT_GAP = 0.45; // square -> count, in chip sizes
const CHIP_SPACING = 1.5; // between chips, in chip sizes
const WORD_DATE_Y = 555;

function escapeSvgText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── The invite link's card (#189, user-decided 2026-08-20) ───────────────────────────
//
// What a `/i/<publicId>` link unfurls into in a chat: the player's MARK, their NAME, and
// the APP NAME. Nothing else — no "friend invite" banner, no call to action, no daily.
// The link is already sent by a person to a person, so the message around it says what
// it is; the card only has to say WHO. Anything more would be the sender's own message
// repeated back at them in a picture.
//
// It draws the ASSIGNED identity for a player who never customized one (`assigned.ts`),
// so the face in the chat is the same face their friends' boards show — which is the
// whole reason those two functions moved into this package.
const INVITE_AVATAR_PX = 260;
const INVITE_AVATAR_Y = 96;
const INVITE_NAME_Y = 448; // baseline
const INVITE_NAME_MAX_SIZE = 60;
// The name's own column, well inside the card's margins: a 16-character name set at the
// max size runs 960 of the 1020 the margins leave, which reads as the name wearing the
// card rather than the player wearing the name. Held to this box instead, everything up
// to 12 glyphs keeps the full size and only a genuinely long name steps down.
const INVITE_NAME_WIDTH = 720;
const INVITE_APP_Y = 528; // baseline
const INVITE_APP_SIZE = 28;
const APP_NAME = 'WHIPPIN AI';

export interface InviteCardData {
  publicId: string;
  // The STORED profile: '' / null when the player never customized one. The card
  // resolves the assigned fallbacks itself, so "the card shows what a board shows"
  // is a property of one function rather than of every caller.
  name: string;
  avatar: string | null;
}

export function renderInviteCardSvg({ publicId, name, avatar }: InviteCardData): string {
  const cx = CARD_WIDTH / 2;
  const shown = name || anonName(publicId);
  // Press Start 2P advances exactly 1em per glyph, so the name fits its column at
  // `size = width / glyphs` — one line always, since the name is the thing the card is
  // about and a wrapped one reads as two.
  const glyphs = Math.max(1, Array.from(shown).length);
  const nameSize = Math.min(
    INVITE_NAME_MAX_SIZE,
    Math.max(1, Math.floor(INVITE_NAME_WIDTH / glyphs)),
  );

  // The mark is the app's ONE avatar drawing: the palette's ground, the union outline of
  // the filled cells on top, and only the tile's outer corners rounded (the web's
  // `Avatar`, whose renderer this shares). A stored string that will not decode falls
  // back to the assigned mark rather than leaving a hole — the card must always draw a
  // face, and the store only ever holds validated avatars anyway.
  const cell = INVITE_AVATAR_PX / AVATAR_SIZE;
  const x = Math.round(cx - INVITE_AVATAR_PX / 2);
  let drawing: { bg: string; fg: string; outline: string };
  try {
    const { palette, cells } = decodeAvatar(avatar ?? defaultAvatar(publicId));
    drawing = { ...AVATAR_PALETTES[palette], outline: avatarOutlinePath(cells, cell) };
  } catch {
    const { palette, cells } = decodeAvatar(defaultAvatar(publicId));
    drawing = { ...AVATAR_PALETTES[palette], outline: avatarOutlinePath(cells, cell) };
  }
  const radius = Math.round(INVITE_AVATAR_PX * 0.036); // the web tile's proportion

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${BG}"/>`,
    `<clipPath id="mark"><rect x="${x}" y="${INVITE_AVATAR_Y}" width="${INVITE_AVATAR_PX}" height="${INVITE_AVATAR_PX}" rx="${radius}"/></clipPath>`,
    // The clip sits on an UNtransformed group, in the same absolute space its rect is
    // written in, and the translate goes on a group inside it: whether a rasterizer
    // resolves a clip path before or after the referencing element's own transform is
    // exactly the kind of thing renderers disagree about, and this nesting has no
    // opinion to disagree with.
    `<g clip-path="url(#mark)"><g transform="translate(${x} ${INVITE_AVATAR_Y})">`,
    `<rect width="${INVITE_AVATAR_PX}" height="${INVITE_AVATAR_PX}" fill="${drawing.bg}"/>`,
    drawing.outline ? `<path d="${drawing.outline}" fill="${drawing.fg}"/>` : '',
    `</g></g>`,
    `<text x="${cx}" y="${INVITE_NAME_Y}" text-anchor="middle" font-family="${CARD_FONT}" font-size="${nameSize}" font-variant-ligatures="none" fill="${FG}">${escapeSvgText(shown)}</text>`,
    `<text x="${cx}" y="${INVITE_APP_Y}" text-anchor="middle" font-family="${CARD_FONT}" font-size="${INVITE_APP_SIZE}" fill="${MUTED}">${APP_NAME}</text>`,
    `</svg>`,
  ].join('');
}

export function renderWordCardSvg({ lang, dayNumber, counts, word }: WordCardData): string {
  const unit = WORD_UNITS[lang] ?? WORD_UNITS.en;
  const score = counts.reduce((sum, n) => sum + n, 0);
  const cx = CARD_WIDTH / 2;
  // Press Start 2P advances exactly 1em per glyph once ligatures are disabled, so the word
  // fits the column at `size = width / glyphs`. Keep the complete word on ONE line — it is
  // the thing the card is about, and a wrapped one reads as two.
  const glyphs = Math.max(1, Array.from(word).length);
  const wordSize = Math.min(
    WORD_MAX_SIZE,
    Math.max(1, Math.floor((CARD_WIDTH - 2 * MARGIN) / glyphs)),
  );

  // One chip per grade the run actually claimed, commonest first, zero grades omitted —
  // the same row the share text's beads make. The whole row is centered as one lockup;
  // positions are rounded so the crisp-edged squares land on whole pixels.
  const chips = counts
    .map((count, step) => ({ count, color: WORD_RARITY_COLORS[step] ?? MUTED }))
    .filter((chip) => chip.count > 0);
  let chipRow = '';
  if (chips.length > 0) {
    const units =
      chips.reduce((sum, chip) => sum + 1 + CHIP_TEXT_GAP + String(chip.count).length, 0) +
      CHIP_SPACING * (chips.length - 1);
    const size = Math.min(CHIP_MAX_SIZE, Math.max(1, Math.floor((CARD_WIDTH - 2 * MARGIN) / units)));
    let x = (CARD_WIDTH - units * size) / 2;
    chipRow = chips
      .map((chip) => {
        const squareX = Math.round(x);
        const countX = Math.round(x + size * (1 + CHIP_TEXT_GAP));
        x += size * (1 + CHIP_TEXT_GAP + String(chip.count).length + CHIP_SPACING);
        return (
          `<rect x="${squareX}" y="${Math.round(CHIP_ROW_Y - size / 2)}" width="${size}" height="${size}" fill="${chip.color}" shape-rendering="crispEdges"/>` +
          `<text x="${countX}" y="${CHIP_ROW_Y}" dy="0.16em" dominant-baseline="middle" font-family="${CARD_FONT}" font-size="${size}" fill="${chip.color}">${chip.count}</text>`
        );
      })
      .join('');
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${BG}"/>`,
    `<text x="${cx}" y="${WORD_ROW_Y}" dy="0.16em" dominant-baseline="middle" text-anchor="middle" font-family="${CARD_FONT}" font-size="${wordSize}" font-variant-ligatures="none" fill="${SOLVE}">${escapeSvgText(word)}</text>`,
    `<text x="${cx}" y="${WORD_SCORE_Y}" text-anchor="middle" font-family="${CARD_FONT}" font-size="76" fill="${FG}">${score} ${score === 1 ? unit.one : unit.many}</text>`,
    chipRow,
    `<text x="${cx}" y="${WORD_DATE_Y}" text-anchor="middle" font-family="${CARD_FONT}" font-size="30" fill="${MUTED}">${dateForDayNumber(dayNumber)}</text>`,
    `</svg>`,
  ].join('');
}

// The sentence headline's own band: `<n> TRIES`, or `∞ TRIES` for a #214 capped round.
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

export function renderCardSvg({
  lang,
  dayNumber,
  score,
  trajectory,
  solvedAt,
  capped = false,
}: CardData): string {
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
    `<g shape-rendering="crispEdges">${cells}</g>`,
    marks,
    // "N TRIES", not "SCORE N": naming the unit is what tells a stranger seeing the
    // card that lower is better. Localized by the token's lang (#59). A capped round
    // draws `∞ TRIES` instead — same band, same unit, no number (#214).
    scoreLockup(score, capped, unit),
    `<text x="${cx}" y="500" text-anchor="middle" font-family="${CARD_FONT}" font-size="30" fill="${MUTED}">${dateForDayNumber(dayNumber)}</text>`,
    `</svg>`,
  ].join('');
}
