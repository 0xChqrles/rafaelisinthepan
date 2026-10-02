// Pixel-art glyphs the game DRAWS rather than sets in type (#214).
//
// The app's number face is Press Start 2P, and it has no `∞` — nor does anything else the
// OG card could fall back on, since the rasterizer runs with `loadSystemFonts: false` and
// the bundle's other face, Azeret Mono's bold, has none either. So the headline of a round
// that ENDED UNSOLVED (given up, or capped) ships as PATH DATA, drawn identically by
// `cardSvg.ts` (the share card), by the web result in place of `.solved-score-num`, and by a
// group board's ended row in place of its try count. ONE path and ONE view box, here, is
// what keeps the surfaces showing the same glyph.

// The ∞ on a 9×5 pixel grid — two loops that genuinely CROSS, with the outer corners
// clipped the way the pixel font clips its own `O`, so the glyph reads as a character of
// the face beside it rather than as an icon dropped into the line:
//
//   .##...##.
//   #..#.#..#
//   #...#...#
//   #..#.#..#
//   .##...##.
//
// The crossing is the whole thing. A first cut drew two hollow squares sharing a wall,
// which is trivially simpler and reads as `oo` at result size — an infinity sign is a
// LEMNISCATE, and the single cell where the two strokes meet is what says so.
//
// Emitted as one path of rectangular subpaths, all wound the same way so any fill rule
// unions them.
export const INFINITY_GLYPH = {
  viewBox: '0 0 9 5',
  width: 9,
  height: 5,
  path:
    'M1 0h2v1h-2z M6 0h2v1h-2z ' +
    'M0 1h1v3h-1z M8 1h1v3h-1z ' +
    'M3 1h1v1h-1z M5 1h1v1h-1z M4 2h1v1h-1z M3 3h1v1h-1z M5 3h1v1h-1z ' +
    'M1 4h2v1h-2z M6 4h2v1h-2z',
} as const;

// How tall the glyph is drawn, as a fraction of the font size it stands in for: Press Start
// 2P's CAP HEIGHT, MEASURED off the rasterized card (67px of ink at font-size 76), so the ∞
// fills exactly the band the digits it replaces would have. Stated ONCE because both
// surfaces have to agree — the card lays its headline out arithmetically (the face advances
// 1em per glyph, so a lockup's width is a sum of ems) and the web sizes an inline SVG in
// `em` off the same number.
export const INFINITY_EM_HEIGHT = 0.88;

// Its width in ems at that height — the aspect ratio applied, so a caller centring a
// lockup never restates the grid's proportions.
export const INFINITY_EM_WIDTH =
  (INFINITY_EM_HEIGHT * INFINITY_GLYPH.width) / INFINITY_GLYPH.height;

// THE APP'S MARK, the header's own (`web/public/logo.png`, 22×22, one ink), as path data so
// the cards can draw it: the rasterizer loads fonts and nothing else. One rectangle per
// run of a row, all wound the same way. Traced from the PNG — a redrawn mark is traced again.
export const MARK_GLYPH = {
  width: 22,
  height: 22,
  path:
    'M7 1h1v1h-1z M6 2h2v1h-2z M6 3h2v1h-2z M5 4h3v1h-3z M5 5h4v1h-4z M14 5h1v1h-1z ' +
    'M4 6h5v1h-5z M14 6h2v1h-2z M4 7h5v1h-5z M13 7h3v1h-3z M3 8h6v1h-6z M13 8h4v1h-4z ' +
    'M3 9h7v1h-7z M12 9h5v1h-5z M2 10h16v1h-16z M2 11h16v1h-16z M1 12h18v1h-18z ' +
    'M1 13h18v1h-18z M0 14h5v1h-5z M7 14h13v1h-13z M8 15h12v1h-12z M8 16h6v1h-6z ' +
    'M16 16h5v1h-5z M7 17h6v1h-6z M18 17h3v1h-3z M5 18h8v1h-8z M20 18h2v1h-2z ' +
    'M3 19h11v1h-11z M1 20h14v1h-14z M0 21h16v1h-16z',
} as const;

// How far ABOVE its nominal baseline the pixel face's ink actually sits, as a fraction of
// the font size — also measured off the rasterized card (10px at font-size 76). The face
// reserves descender room under every glyph, so a shape placed with its bottom ON the
// baseline sits visibly low against the type beside it. A caller aligning the glyph to a
// text baseline subtracts this; the web needs none, because nothing there shares a baseline
// with it.
export const PIXEL_INK_LIFT_EM = 0.13;
