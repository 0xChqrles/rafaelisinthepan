import { MARK_GLYPH } from '@whippin/shared';

// THE FULL-SCREEN MOMENT'S FRAME: the streak celebration's furniture standing still — the
// WHIPPIN AI lockup top left (the mark in the accent, the name beside it) and the four corner
// brackets of the device frame. A screen with NO HEADER wears it so it reads as the app's own
// screen, never an error page: the signed-out screen, the error screen and the confirmation.
// The corners are the one place brackets frame something that is not tapped — the frame of the
// whole moment, as on the cards. Decorative.
export default function ScreenFrame() {
  return (
    <div className="screen-frame" aria-hidden="true">
      <div className="streak-lockup">
        <svg viewBox={`0 0 ${MARK_GLYPH.width} ${MARK_GLYPH.height}`} shapeRendering="crispEdges">
          <path d={MARK_GLYPH.path} fill="currentColor" />
        </svg>
        <span>WHIPPIN AI</span>
      </div>
      {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => (
        <span key={corner} className={`streak-corner ${corner}`} />
      ))}
    </div>
  );
}
