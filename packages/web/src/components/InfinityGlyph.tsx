import { INFINITY_EM_HEIGHT, INFINITY_EM_WIDTH, INFINITY_GLYPH } from '@whippin/shared';

// THE `∞` of a round that ENDED UNSOLVED (given up, or capped). Press Start 2P has no such
// glyph, so it is drawn from the shared path data — the same path, at the same fraction of
// the font size, that the OG card draws, so no two surfaces can show two different marks.
// Sized in `em`, so it stands in for the digits of whatever line it sits in. Decorative:
// the caller says `∞` to a screen reader beside it.
export default function InfinityGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox={INFINITY_GLYPH.viewBox}
      style={{ height: `${INFINITY_EM_HEIGHT}em`, width: `${INFINITY_EM_WIDTH}em` }}
      aria-hidden="true"
      focusable="false"
    >
      <path d={INFINITY_GLYPH.path} fill="currentColor" />
    </svg>
  );
}
