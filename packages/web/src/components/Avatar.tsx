import { useId, useMemo } from 'react';
import { AVATAR_PALETTES, AVATAR_SIZE, decodeAvatar } from '@whippin/shared';

// The #188 avatar, rendered from its encoded string as SVG: two colours only, the
// palette's background and its foreground, the pixels drawn CONTIGUOUS (user-decided
// 2026-08-19 — the editor's grid keeps its gaps as tap targets, but the rendered
// drawing reads as one solid pixel-art mark). One renderer for every surface that
// shows a player (the editor's live preview, and the #190 board rows).
//
// Decorative by default — a board row's accessible name is the player's NAME; the
// drawing is theirs to read visually.

const CELL = 10; // viewBox units per cell
const RADIUS = 3.6; // outer corner rounding only — cells themselves are square
// Adjacent same-colour rects antialias a hairline seam between them; a sub-unit bleed
// on every cell makes neighbours overlap (invisibly — same fill) while the drawing's
// outline stays smooth against the ground.
const BLEED = 0.3;

export default function Avatar({ avatar, size = 40 }: { avatar: string; size?: number }) {
  const clipId = useId();
  const decoded = useMemo(() => {
    try {
      return decodeAvatar(avatar);
    } catch {
      return null;
    }
  }, [avatar]);
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
        {decoded.cells.map((value, i) => {
          if (value === 0) return null;
          const x = (i % AVATAR_SIZE) * CELL;
          const y = Math.floor(i / AVATAR_SIZE) * CELL;
          return (
            <rect
              // Position IS the identity of a cell.
              // eslint-disable-next-line react/no-array-index-key
              key={i}
              x={x - BLEED}
              y={y - BLEED}
              width={CELL + BLEED * 2}
              height={CELL + BLEED * 2}
              fill={palette.fg}
            />
          );
        })}
      </g>
    </svg>
  );
}
