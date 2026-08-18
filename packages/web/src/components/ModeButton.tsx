import { navigate } from '../routing';
import { MODE_SELECT_PATH } from '../langs';
import { t } from '../i18n';
import Logo from '../assets/logo.svg?react';

// The game-mode control, first in the header's action group: the Whippin mark, opening the
// mode chooser (/mode). The twin of `LangButton` — same shape, same kind of question, the
// other axis — and it replaced the header TOGGLE the same way the globe replaced the flag
// (2026-08-06): a toggle had to show the mode you were NOT in, which is a thing to decode
// rather than read, and it could only ever flip between exactly two.
//
// It leads the group, ahead of the globe: which GAME you are playing is the larger choice,
// and the mark is the app's own logo, so the header opens on its identity.
export default function ModeButton({ lang }: { lang: string }) {
  return (
    <button
      type="button"
      className="home-btn"
      onClick={() => navigate(MODE_SELECT_PATH)}
      aria-label={t(lang, 'ariaChangeMode')}
    >
      {/* The mark (user-drawn SVG, 2026-08-18, replacing the header's last pixel
          artifact): its own cobalt ink + a soft glow, so the logo stays the one lit
          object in the icon row; the .home-btn opacity/brightness hover carries its
          affordance. */}
      <Logo className="mode-icon" aria-hidden />
    </button>
  );
}
