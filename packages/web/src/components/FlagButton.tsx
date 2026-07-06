import Flag from './Flag';
import { navigate } from '../routing';
import { SELECT_PATH } from '../langs';
import { t } from '../i18n';

// The current puzzle's language flag sits at the left of the app header (TopBar).
// WHICH flag it shows is the caller's business: the game passes the LOADED puzzle's
// lang, so a deep link to /en shows the EN flag regardless of the persisted
// preference. By default a tap opens the language selector (a route, not a modal);
// `onPress` overrides that — the tutorial passes its own handler that toggles the
// tutorial's language directly (no picker, no route change out of the tutorial).
export default function FlagButton({ lang, onPress }: { lang: string; onPress?: () => void }) {
  return (
    <button
      type="button"
      className="home-btn"
      onClick={onPress ?? (() => navigate(SELECT_PATH))}
      aria-label={t(lang, 'ariaChangeLanguage')}
    >
      <Flag code={lang} className="hud-flag" />
    </button>
  );
}
