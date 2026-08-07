import type { ReactNode } from 'react';
import LangButton from './LangButton';
import ModeButton from './ModeButton';

// The floating app header (redesigned 2026-07-21: no band, no border — corner chips
// over the playfield, arcade-HUD style). The LEFT corner is the status spot: a screen
// passes its title (and any inline stat, e.g. the tutorial's progress counter) via
// `left`; the loaded games pass their live progress/standing there too, so both header
// corners belong to this actual <header>.
//
// The RIGHT corner is the one action group, in two halves: the CHOOSERS this bar owns —
// the Whippin mark (which daily) then the globe (which language), each opening its own
// picker route — followed by the screen's contextual controls via `right` (archive/help,
// skip, close). The mode chooser is opt-in (`modeChooser`) because only a game route is
// IN a mode; the archive and the tutorial show the globe alone. The streak stat lives on
// the ARCHIVE page (moved back 2026-07-21 — it is the player-history screen), not here.
export default function TopBar({
  lang,
  modeChooser = false,
  left,
  right,
}: {
  lang: string;
  modeChooser?: boolean;
  left?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        {left && <div className="topbar-left">{left}</div>}
        <div className="topbar-right">
          {modeChooser && <ModeButton lang={lang} />}
          <LangButton lang={lang} />
          {right}
        </div>
      </div>
    </header>
  );
}
