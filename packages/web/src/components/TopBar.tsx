import type { ReactNode } from 'react';
import FlagButton from './FlagButton';

// The app header: the language flag on the left, a centered title, and a right-hand
// control — separated from the app by a thin bottom border. Shared by the game (flag
// / #dayNumber / "?") and the tutorial (flag / "TUTORIAL" / skip), so the header
// "just stays in place" across both and is the single extension point for whatever
// chrome comes later (streaks, stats, …). The center title is ABSOLUTELY centered
// (out of flex flow) so it never drifts with the side controls' widths.
export default function TopBar({
  lang,
  onFlag,
  center,
  right,
}: {
  lang: string;
  onFlag?: () => void; // overrides the flag's default (open the language selector)
  center?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <FlagButton lang={lang} onPress={onFlag} />
        {center}
        {right}
      </div>
    </header>
  );
}
