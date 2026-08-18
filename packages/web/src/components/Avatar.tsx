import { useMemo } from 'react';
import { AVATAR_PALETTES, AVATAR_SIZE, decodeAvatar } from '@whippin/shared';

// The #188 avatar, rendered from its encoded string as SVG — the moodboard's grid of
// rounded squares over the palette's own ground: two colours only, the palette's
// background and its foreground, soft gaps between the cells. One renderer for every
// surface that shows a player (the editor's preview, and the #190 board rows).
//
// Decorative by default — a board row's accessible name is the player's NAME; the
// drawing is theirs to read visually.

const CELL = 10; // viewBox units per cell
const GAP = 1.6;
const RADIUS = 1.8;

export default function Avatar({ avatar, size = 40 }: { avatar: string; size?: number }) {
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
      <rect width={span} height={span} fill={palette.bg} rx={RADIUS * 2} />
      {decoded.cells.map((value, i) => {
        if (value === 0) return null;
        const x = (i % AVATAR_SIZE) * CELL;
        const y = Math.floor(i / AVATAR_SIZE) * CELL;
        return (
          <rect
            // Position IS the identity of a cell.
            // eslint-disable-next-line react/no-array-index-key
            key={i}
            x={x + GAP / 2}
            y={y + GAP / 2}
            width={CELL - GAP}
            height={CELL - GAP}
            rx={RADIUS}
            fill={palette.fg}
          />
        );
      })}
    </svg>
  );
}
