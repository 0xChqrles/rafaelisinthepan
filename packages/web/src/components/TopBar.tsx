import type { ReactNode } from 'react';
import FlagButton from './FlagButton';

// The floating app header (redesigned 2026-07-21: no band, no border — corner chips
// over the playfield, arcade-HUD style). The LEFT corner is the status spot: a screen
// passes its title (and any inline stat, e.g. the tutorial's progress counter) via
// `left`; the loaded games pass their live progress/standing there too, so both header
// corners belong to this actual <header>.
// The RIGHT corner is the one action group: the language flag, then the screen's
// contextual controls (archive/help, skip, close). The streak stat lives on the
// ARCHIVE page (moved back 2026-07-21 — it is the player-history screen), not here.
export default function TopBar({
  lang,
  left,
  right,
}: {
  lang: string;
  left?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        {left && <div className="topbar-left">{left}</div>}
        <div className="topbar-right">
          <FlagButton lang={lang} />
          {right}
        </div>
      </div>
    </header>
  );
}
