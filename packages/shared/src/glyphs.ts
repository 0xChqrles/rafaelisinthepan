// Pixel-art glyphs the game DRAWS rather than sets in type (#214).
//
// The app's number face is Press Start 2P, and it has no `∞` — nor does anything else the
// OG card could fall back on, since the rasterizer runs with `loadSystemFonts: false` and
// the bundle's other face, Azeret Mono's bold, has none either. So the headline of a round
// that ENDED UNSOLVED (given up, or capped) ships as PATH DATA, drawn identically by
// `cardSvg.ts` (the share card) and the web result (`SolvedCard`) — both on the count's own
// grid, a cell per font pixel — and by a group board's ended row in place of its try count.
// ONE path and ONE view box, here, is what keeps the surfaces showing the same glyph.

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

// How tall the glyph is drawn BESIDE TYPE, as a fraction of the font size it stands in for:
// Press Start 2P's CAP HEIGHT, MEASURED off the rasterized card (67px of ink at font-size 76),
// so an inline ∞ (the web's `InfinityGlyph`, sized in `em`) fills exactly the band the digits
// it replaces would have. The card reads the same number as the face's ink height, to stand
// its small pixel type on a line.
export const INFINITY_EM_HEIGHT = 0.88;

// Its width in ems at that height — the aspect ratio applied, so a caller centring a
// lockup never restates the grid's proportions.
export const INFINITY_EM_WIDTH =
  (INFINITY_EM_HEIGHT * INFINITY_GLYPH.width) / INFINITY_GLYPH.height;

// THE APP'S MARK (22×22, one ink), as path data: its ONE drawing. The web draws it inline
// (`PixelMark`), the cards from here (the rasterizer loads fonts and nothing else), and the
// site's icons (`web/public/favicon.svg`, `favicon.ico`, `apple-touch-icon.png`) are it at
// whole scales — a redrawn mark redraws them. One rectangle per run of a row, all wound the
// same way.
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

// THE PIXEL FACE'S DIGITS as cells: Press Start 2P's own 0–9 on their 7-row ink band, each
// trimmed to its ink columns (the 1 is six wide, the rest seven) — what every surface that
// draws a number as BLOCKS reads: the result's count (web `SolvedCard`, through `countCells.ts`)
// and the share card's (`cardSvg.ts`), the score watermark (web `CellDigits`), the streak
// celebration. Every glyph's ink starts on its first column, so a mask's column x is also the
// face's column x: a number set on the face's 8-pixel advance draws exactly the type's glyphs.
// Traced from the face — a redrawn face is traced again.
export const GLYPH_ROWS = 7;
// One glyph pixel of spacing between digits set tight (the watermark, the streak).
export const GLYPH_GAP = 1;

export type DigitMask = { readonly w: number; readonly rows: Uint8Array };

// prettier-ignore
const DIGIT_ART: readonly (readonly string[])[] = [
  ['..###..', '.#..##.', '##...##', '##...##', '##...##', '.##..#.', '..###..'], // 0
  ['..##..', '.###..', '..##..', '..##..', '..##..', '..##..', '######'], // 1
  ['.#####.', '##...##', '....###', '..####.', '.####..', '###....', '#######'], // 2
  ['.######', '....##.', '...##..', '..####.', '.....##', '##...##', '.#####.'], // 3
  ['...###.', '..####.', '.##.##.', '##..##.', '#######', '....##.', '....##.'], // 4
  ['######.', '##.....', '######.', '.....##', '.....##', '##...##', '.#####.'], // 5
  ['..####.', '.##....', '##.....', '######.', '##...##', '##...##', '.#####.'], // 6
  ['#######', '##...##', '....##.', '...##..', '..##...', '..##...', '..##...'], // 7
  ['.####..', '##...#.', '###..#.', '.####..', '#..####', '#....##', '.#####.'], // 8
  ['.#####.', '##...##', '##...##', '.######', '.....##', '....##.', '.####..'], // 9
];

// Indexed by the digit's value.
export const DIGIT_MASKS: readonly DigitMask[] = DIGIT_ART.map((art) => ({
  w: art[0].length,
  rows: Uint8Array.from(art.join(''), (c) => (c === '#' ? 1 : 0)),
}));
