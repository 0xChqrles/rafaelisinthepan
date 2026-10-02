// Pixel-art glyphs the game DRAWS rather than sets in type (#214).
//
// The app's number face is Press Start 2P, and it has no `∞` — nor does anything else the
// OG card could fall back on, since the rasterizer runs with `loadSystemFonts: false` and
// the bundle's other face, Azeret Mono's bold, has none either. So the capped round's
// headline ships as PATH DATA, drawn identically by `cardSvg.ts` (the share card) and by
// the web result in place of `.solved-score-num`. ONE path and ONE view box, here, is what keeps the two surfaces
// showing the same glyph.

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

// THE ULTRA STAR (`web/src/assets/hits/ultra-slash.png`, the exact hit's sheet): its peak frame,
// the white-cored burst, as one path per ink — drawn by the result card on the solve that
// ended the round. Authored in colour, so it is drawn as it is (the sheet is an IMAGE, not
// a mask; `web/src/components/strikeArt.ts`). Traced from the PNG's second frame, its
// 59×51 ink box; a redrawn sheet is traced again.
export const ULTRA_STAR = {
  width: 59,
  height: 51,
  inks: [
    {
      fill: '#c834ff',
      path:
        'M26 0h1v1h-1z M26 1h1v1h-1z M26 2h1v1h-1z M26 3h1v1h-1z M26 4h1v1h-1z M26 5h1v1h-1z ' +
        'M25 6h2v1h-2z M25 7h2v1h-2z M25 8h3v1h-3z M25 9h3v1h-3z M53 9h6v1h-6z M25 10h4v1h-4z ' +
        'M50 10h6v1h-6z M24 11h5v1h-5z M46 11h8v1h-8z M24 12h6v1h-6z M42 12h9v1h-9z ' +
        'M24 13h7v1h-7z M39 13h11v1h-11z M24 14h10v1h-10z M37 14h11v1h-11z M23 15h23v1h-23z ' +
        'M22 16h5v1h-5z M28 16h17v1h-17z M22 17h4v1h-4z M29 17h14v1h-14z M20 18h5v1h-5z ' +
        'M30 18h12v1h-12z M35 19h6v1h-6z M37 20h3v1h-3z M38 21h2v1h-2z M38 22h2v1h-2z ' +
        'M39 23h2v1h-2z M18 25h2v1h-2z M18 26h3v1h-3z M19 27h3v1h-3z M19 28h3v1h-3z ' +
        'M19 29h3v1h-3z M19 30h4v1h-4z M35 30h5v1h-5z M19 31h5v1h-5z M34 31h4v1h-4z ' +
        'M18 32h8v1h-8z M33 32h5v1h-5z M18 33h19v1h-19z M17 34h8v1h-8z M28 34h9v1h-9z ' +
        'M16 35h6v1h-6z M30 35h7v1h-7z M16 36h5v1h-5z M31 36h5v1h-5z M15 37h5v1h-5z ' +
        'M31 37h5v1h-5z M14 38h5v1h-5z M32 38h4v1h-4z M14 39h3v1h-3z M32 39h4v1h-4z ' +
        'M13 40h3v1h-3z M33 40h3v1h-3z M12 41h3v1h-3z M33 41h2v1h-2z M11 42h3v1h-3z ' +
        'M33 42h2v1h-2z M11 43h2v1h-2z M33 43h2v1h-2z M10 44h2v1h-2z M33 44h2v1h-2z ' +
        'M9 45h2v1h-2z M34 45h1v1h-1z M8 46h2v1h-2z M34 46h1v1h-1z M8 47h1v1h-1z M34 47h1v1h-1z ' +
        'M34 48h1v1h-1z M34 49h1v1h-1z M34 50h1v1h-1z',
    },
    {
      fill: '#ff61f4',
      path:
        'M27 16h1v1h-1z M0 17h5v1h-5z M26 17h3v1h-3z M4 18h9v1h-9z M25 18h5v1h-5z ' +
        'M8 19h27v1h-27z M11 20h14v1h-14z M27 20h2v1h-2z M32 20h5v1h-5z M13 21h11v1h-11z ' +
        'M27 21h1v1h-1z M33 21h5v1h-5z M14 22h9v1h-9z M26 22h2v1h-2z M34 22h4v1h-4z ' +
        'M16 23h11v1h-11z M35 23h4v1h-4z M17 24h6v1h-6z M26 24h2v1h-2z M36 24h5v1h-5z ' +
        'M20 25h3v1h-3z M27 25h2v1h-2z M37 25h5v1h-5z M21 26h3v1h-3z M28 26h2v1h-2z ' +
        'M36 26h7v1h-7z M22 27h2v1h-2z M29 27h2v1h-2z M36 27h8v1h-8z M22 28h2v1h-2z ' +
        'M30 28h2v1h-2z M35 28h11v1h-11z M22 29h2v1h-2z M31 29h16v1h-16z M23 30h2v1h-2z ' +
        'M32 30h3v1h-3z M40 30h9v1h-9z M24 31h3v1h-3z M31 31h3v1h-3z M42 31h9v1h-9z ' +
        'M26 32h7v1h-7z M45 32h8v1h-8z M50 33h5v1h-5z M52 34h4v1h-4z M54 35h2v1h-2z',
    },
    {
      fill: '#ffffff',
      path:
        'M45 1h3v1h-3z M44 2h4v1h-4z M43 3h5v1h-5z M43 4h4v1h-4z M44 5h2v1h-2z M17 11h2v1h-2z ' +
        'M17 12h2v1h-2z M17 13h3v1h-3z M17 14h5v1h-5z M18 15h4v1h-4z M19 16h3v1h-3z ' +
        'M20 17h2v1h-2z M25 20h2v1h-2z M29 20h3v1h-3z M24 21h3v1h-3z M28 21h5v1h-5z ' +
        'M23 22h3v1h-3z M28 22h6v1h-6z M27 23h8v1h-8z M23 24h3v1h-3z M28 24h8v1h-8z ' +
        'M23 25h4v1h-4z M29 25h8v1h-8z M24 26h4v1h-4z M30 26h6v1h-6z M24 27h5v1h-5z ' +
        'M31 27h5v1h-5z M24 28h6v1h-6z M32 28h3v1h-3z M24 29h7v1h-7z M10 30h3v1h-3z ' +
        'M25 30h7v1h-7z M10 31h2v1h-2z M27 31h4v1h-4z M37 35h1v1h-1z M36 36h2v1h-2z ' +
        'M36 37h3v1h-3z M36 38h4v1h-4z M36 39h5v1h-5z M26 40h1v1h-1z M28 40h1v1h-1z ' +
        'M37 40h4v1h-4z M26 41h3v1h-3z M38 41h3v1h-3z M26 42h3v1h-3z M39 42h3v1h-3z ' +
        'M27 43h1v1h-1z M39 43h4v1h-4z M40 44h4v1h-4z M41 45h3v1h-3z M42 46h2v1h-2z',
    },
    {
      fill: '#33fcff',
      path:
        'M45 0h1v1h-1z M44 1h1v1h-1z M42 2h2v1h-2z M41 3h2v1h-2z M40 4h3v1h-3z M39 5h5v1h-5z ' +
        'M46 5h1v1h-1z M40 6h2v1h-2z M43 6h4v1h-4z M13 7h3v1h-3z M40 7h1v1h-1z M42 7h4v1h-4z ' +
        'M13 8h4v1h-4z M41 8h2v1h-2z M44 8h1v1h-1z M13 9h5v1h-5z M41 9h1v1h-1z M14 10h5v1h-5z ' +
        'M15 11h2v1h-2z M19 11h1v1h-1z M16 12h1v1h-1z M19 12h1v1h-1z M16 13h1v1h-1z ' +
        'M20 13h1v1h-1z M22 15h1v1h-1z M19 17h1v1h-1z M13 27h1v1h-1z M12 28h3v1h-3z ' +
        'M10 29h5v1h-5z M13 30h2v1h-2z M12 31h2v1h-2z M11 32h1v1h-1z M38 36h1v1h-1z ' +
        'M26 37h1v1h-1z M28 37h1v1h-1z M26 38h3v1h-3z M25 39h5v1h-5z M25 40h1v1h-1z ' +
        'M27 40h1v1h-1z M29 40h1v1h-1z M41 40h1v1h-1z M25 41h1v1h-1z M29 41h1v1h-1z ' +
        'M41 41h1v1h-1z M29 42h1v1h-1z M38 42h1v1h-1z M42 42h1v1h-1z M43 43h1v1h-1z ' +
        'M44 44h1v1h-1z M44 45h1v1h-1z M41 46h1v1h-1z M44 46h2v1h-2z M42 47h5v1h-5z ' +
        'M43 48h5v1h-5z M44 49h4v1h-4z M45 50h3v1h-3z',
    },
    {
      fill: '#2f7bff',
      path:
        'M46 0h3v1h-3z M48 1h1v1h-1z M48 2h1v1h-1z M48 3h1v1h-1z M47 4h1v1h-1z M47 5h1v1h-1z ' +
        'M38 6h2v1h-2z M42 6h1v1h-1z M39 7h1v1h-1z M41 7h1v1h-1z M43 8h1v1h-1z M40 9h1v1h-1z ' +
        'M42 9h2v1h-2z M39 10h3v1h-3z M39 11h1v1h-1z M15 26h1v1h-1z M14 27h1v1h-1z ' +
        'M17 28h1v1h-1z M15 29h2v1h-2z M9 30h1v1h-1z M15 30h1v1h-1z M9 31h1v1h-1z M9 32h2v1h-2z ' +
        'M26 35h1v1h-1z M25 36h2v1h-2z M28 36h1v1h-1z M25 37h1v1h-1z M29 37h1v1h-1z ' +
        'M25 38h1v1h-1z M29 38h1v1h-1z M25 42h1v1h-1z M26 43h1v1h-1z M28 43h1v1h-1z ' +
        'M27 44h1v1h-1z',
    },
  ],
} as const;

// How far ABOVE its nominal baseline the pixel face's ink actually sits, as a fraction of
// the font size — also measured off the rasterized card (10px at font-size 76). The face
// reserves descender room under every glyph, so a shape placed with its bottom ON the
// baseline sits visibly low against the type beside it. A caller aligning the glyph to a
// text baseline subtracts this; the web needs none, because nothing there shares a baseline
// with it.
export const PIXEL_INK_LIFT_EM = 0.13;
