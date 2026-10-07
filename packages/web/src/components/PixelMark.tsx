import { MARK_GLYPH } from '@whippin/shared';

// THE APP'S MARK, drawn — `@whippin/shared`'s `MARK_GLYPH`, the cards' and the icons' own,
// inline, so it paints in the same frame as the text beside it (an image or a mask arrives a
// request later). `crispEdges` and a box at a whole multiple of its 22 cells (`.pixel-mark`:
// 22px, 44px where a surface draws it at 2x) keep every cell on whole pixels. Its ink is
// `currentColor`, the accent by default. Decorative wherever it stands: what it names is said
// by the text beside it or the control around it.
export default function PixelMark({ className }: { className?: string }) {
  return (
    <svg
      className={className === undefined ? 'pixel-mark' : `pixel-mark ${className}`}
      viewBox={`0 0 ${MARK_GLYPH.width} ${MARK_GLYPH.height}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <path d={MARK_GLYPH.path} fill="currentColor" />
    </svg>
  );
}
