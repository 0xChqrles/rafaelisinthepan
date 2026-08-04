import type { CSSProperties } from 'react';
import { LANE_COLORS } from '../components/RouteModal';
import ChevronUp from '../assets/icons/chevron-up.svg?react';

// The onboarding's CLOSE (#155, findings 2026-08-04): after the theme clouds, an abstract
// glimpse of the ROUTE MAP the game will offer on every word — the themes' colored lines,
// one per road, with two chevrons on the left saying "this scrolls". No words on it: the
// clouds just named what the colors mean, and the word itself would only repeat what the
// player has been staring at. It is a signpost to the real map, not the map — which is why
// it is decorative (aria-hidden) and the coach's general principle carries the meaning.
export default function RoutesTeaser({ lanes }: { lanes: number }) {
  return (
    <div className="routes-teaser" aria-hidden="true">
      <span className="teaser-arrows">
        <ChevronUp className="pixel-icon" />
        <ChevronUp className="pixel-icon" style={{ transform: 'scaleY(-1)' }} />
      </span>
      <span className="teaser-lanes">
        {Array.from({ length: lanes }, (_, road) => (
          <i
            key={road}
            style={{ background: LANE_COLORS[road % LANE_COLORS.length] } as CSSProperties}
          />
        ))}
      </span>
    </div>
  );
}
