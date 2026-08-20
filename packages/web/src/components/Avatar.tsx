import { useId, useMemo } from 'react';
import { AVATAR_PALETTES, AVATAR_SIZE, avatarOutlinePath, decodeAvatar } from '@whippin/shared';

// The #188 avatar, rendered from its encoded string as SVG: two colours only, the
// palette's background and its foreground, the pixels drawn CONTIGUOUS (user-decided
// 2026-08-19) as ONE traced union-outline path (user-decided 2026-08-19, superseding
// a rect per cell with a sub-unit bleed): shapes meeting on an edge can antialias a
// hairline seam between them at fractional device scales, and an outline has no
// interior edges, so there is nothing left to bleed or pixel-snap. Only the tile's
// outer corners round (via clipPath); a `<path>` rather than `<polygon>`s because a
// polygon cannot carry a hole, and a ring drawing must show ground in its centre.
//
// KEEP THE TRACER (user-decided 2026-08-19): the two cheaper answers — one `<path>`
// with a rect subpath per cell, and `shape-rendering="crispEdges"` (the technique the
// OG card uses) — were both weighed, and neither renders the same on every browser.
// The outline is the one shape with nothing left for a rasterizer to disagree about.
//
// One renderer for every surface that shows a player (the editor's live preview, and
// the #190 board rows).
//
// Decorative by default — a board row's accessible name is the player's NAME; the
// drawing is theirs to read visually.

const CELL = 10; // viewBox units per cell
const RADIUS = 3.6; // outer corner rounding only — cells themselves are square

export default function Avatar({ avatar, size = 40 }: { avatar: string; size?: number }) {
  const clipId = useId();
  // Decoding and tracing are ONE guarded step: both read the same stored string, and a
  // renderer that throws on a malformed one takes the whole tree with it — a board of
  // #190 rows draws every player's avatar, so this has to fail as "no mark", never as
  // a blank screen.
  const drawing = useMemo(() => {
    try {
      const { palette, cells } = decodeAvatar(avatar);
      return { palette: AVATAR_PALETTES[palette], outline: avatarOutlinePath(cells, CELL) };
    } catch {
      return null;
    }
  }, [avatar]);
  if (!drawing) return null;
  const { palette, outline } = drawing;
  const span = AVATAR_SIZE * CELL;
  return (
    <svg
      className="avatar"
      width={size}
      height={size}
      viewBox={`0 0 ${span} ${span}`}
      aria-hidden="true"
    >
      <clipPath id={clipId}>
        <rect width={span} height={span} rx={RADIUS} />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>
        <rect width={span} height={span} fill={palette.bg} />
        {outline ? <path d={outline} fill={palette.fg} /> : null}
      </g>
    </svg>
  );
}
