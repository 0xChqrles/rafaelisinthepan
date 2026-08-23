// Pixel-art glyphs the game DRAWS rather than sets in type (#214).
//
// The app's number face is Press Start 2P, and it has no `∞` — nor does anything else the
// OG card could fall back on, since the rasterizer runs with `loadSystemFonts: false` and
// the only font in the bundle is that one. So the capped round's headline ships as PATH
// DATA, drawn identically by `cardSvg.ts` (the share card) and by the web result in place
// of `.solved-score-num`. ONE path and ONE view box, here, is what keeps the two surfaces
// showing the same glyph.

// The ∞ on an 11×5 pixel grid: two hollow loops sharing a wall, outer corners clipped —
// the pixel font's own idiom (its `O` clips the same four cells), so the glyph reads as a
// character of the face beside it rather than as an icon dropped into the line.
//
//   .####.####.
//   #....#....#
//   #....#....#
//   #....#....#
//   .####.####.
//
// Emitted as one path of seven rectangular subpaths (four bars, three walls), all wound
// the same way so any fill rule unions them.
export const INFINITY_GLYPH = {
  viewBox: '0 0 11 5',
  width: 11,
  height: 5,
  path:
    'M1 0h4v1h-4z M6 0h4v1h-4z M1 4h4v1h-4z M6 4h4v1h-4z ' +
    'M0 1h1v3h-1z M5 1h1v3h-1z M10 1h1v3h-1z',
} as const;

// How tall the glyph is drawn, as a fraction of the font size it stands in for — Press
// Start 2P's cap height, so the ∞ fills exactly the band the digits it replaces would
// have. Stated ONCE because both surfaces have to agree: the card lays the headline out
// arithmetically (the face advances 1em per glyph, so a lockup's width is a sum of ems)
// and the web sizes the inline SVG in `em` off the same number.
export const INFINITY_EM_HEIGHT = 0.625;

// Its width in ems at that height — the aspect ratio applied, so a caller centring a
// lockup never restates the grid's proportions.
export const INFINITY_EM_WIDTH =
  (INFINITY_EM_HEIGHT * INFINITY_GLYPH.width) / INFINITY_GLYPH.height;
