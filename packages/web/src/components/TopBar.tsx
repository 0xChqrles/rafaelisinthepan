import type { ReactNode } from 'react';
import LangButton from './LangButton';
import ArrowLeftIcon from '../assets/icons/arrow-left.svg?react';

// The app header, finalized 2026-08-18 (superseding the floating corner chips): ONE
// GLASS BAND — the dialogs' own material as chrome, which is what keeps the controls
// legible over the busy ground without simplifying it. Mobile-first: full-bleed slim
// band with a hairline bottom edge; on desktop it floats capped and rounded just inside
// the device frame's brackets, a piece of the instrument.
//
// Three grid slots. LEFT is the status spot: the sentence game's DATE CHIP (which IS
// the archive entry since the redesign — tap the day to change the day), Word mode's
// clock, or a screen's title chip. CENTER is the segmented MODE SWITCHER wherever the
// route has a lang+mode context (`center`, built by the route so it owns where a tap
// lands). RIGHT is the small stuff: the language code chip (the one control the bar
// itself owns) then the screen's own controls (leaderboard, help, skip, close). The
// logo LEFT the header with the /mode chooser it used to open — brand lives on the
// frame rail and the hero screens now. The leaderboard enters HERE (issue #190's
// decided entry point, superseding the earlier standing-line note): it must be
// reachable BEFORE playing, since the screen is also the profile editor's and the
// invite link's home.
//
// **A TITLED SCREEN GOES BACK FROM ITS TITLE** (user-decided 2026-08-29). The account area
// left by a ✕ in the RIGHT group, which is the corner furthest from a thumb and reads as
// "dismiss this" — right for a modal, wrong for a page you navigated into. `back` turns the
// LEFT slot into one target: an arrow and the title together, where a back control belongs
// and where the eye already is when it reads what screen it is on. It replaces the title
// rather than sitting beside it, so the row's width budget is unchanged.
export default function TopBar({
  lang,
  left,
  back,
  center,
  right,
}: {
  lang: string;
  left?: ReactNode;
  // The screen's title, as the way OUT of it: rendered as the left slot's own button.
  back?: { title: string; label: string; onBack: () => void };
  center?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        {back && (
          <div className="topbar-left">
            <button type="button" className="topbar-back" aria-label={back.label} onClick={back.onBack}>
              <ArrowLeftIcon className="ui-icon" aria-hidden />
              <span className="topbar-title">{back.title}</span>
            </button>
          </div>
        )}
        {left && <div className="topbar-left">{left}</div>}
        {center && <div className="topbar-center">{center}</div>}
        <div className="topbar-right">
          <LangButton lang={lang} />
          {right}
        </div>
      </div>
    </header>
  );
}
