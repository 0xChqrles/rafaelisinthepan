import Flag from './Flag';
import { navigate } from '../routing';
import { SELECT_PATH } from '../langs';
import { t } from '../i18n';

// The current puzzle's language flag sits at the left of the app header (TopBar) and
// opens the language screen — a route, not a modal, and the ONE language-switching
// gesture everywhere (game and tutorial alike; the tutorial's transient open-state
// survives the round-trip). WHICH flag it shows is the caller's business: the game
// passes the LOADED puzzle's lang, so a deep link to /en shows the EN flag regardless
// of the persisted preference.
export default function FlagButton({ lang }: { lang: string }) {
  return (
    <button
      type="button"
      className="home-btn"
      onClick={() => navigate(SELECT_PATH)}
      aria-label={t(lang, 'ariaChangeLanguage')}
    >
      <Flag code={lang} className="hud-flag" />
    </button>
  );
}
