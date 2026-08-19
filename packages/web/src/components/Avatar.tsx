import { useId, useMemo } from 'react';
import { AVATAR_PALETTES, AVATAR_SIZE, decodeAvatar } from '@whippin/shared';
import { avatarOutlinePath } from './avatarOutline';

// The #188 avatar, rendered from its encoded string as SVG: two colours only, the
// palette's background and its foreground, the pixels drawn CONTIGUOUS (user-decided
// 2026-08-19) as ONE traced union-outline path (user-decided 2026-08-19, superseding
// a rect per cell with a sub-unit bleed): shapes meeting on an edge can antialias a
// hairline seam between them at fractional device scales, and an outline has no
// interior edges, so there is nothing left to bleed or pixel-snap. Only the tile's
// outer corners round (via clipPath); a `<path>` rather than `<polygon>`s because a
// polygon cannot carry a hole, and a ring drawing must show ground in its centre.
// One renderer for every surface that shows a player (the editor's live preview, and
// the #190 board rows).
//
// Decorative by default — a board row's accessible name is the player's NAME; the
// drawing is theirs to read visually.

const CELL = 10; // viewBox units per cell
const RADIUS = 3.6; // outer corner rounding only — cells themselves are square

export default function Avatar({ avatar, size = 40 }: { avatar: string; size?: number }) {
  const clipId = useId();
  const decoded = useMemo(() => {
    try {
      return decodeAvatar(avatar);
    } catch {
      return null;
    }
  }, [avatar]);
  const outline = useMemo(
    () => (decoded ? avatarOutlinePath(decoded.cells, CELL) : ''),
    [decoded],
  );
  if (!decoded) return null;
  const palette = AVATAR_PALETTES[decoded.palette];
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
        {outline && <path d={outline} fill={palette.fg} />}
      </g>
    </svg>
  );
}
