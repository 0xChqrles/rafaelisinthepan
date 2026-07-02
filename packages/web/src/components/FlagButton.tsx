import Flag from './Flag';
import { navigate } from '../routing';
import { SELECT_PATH } from '../langs';

// The current puzzle's language flag sits at the left of the HUD (where the logo used
// to) and opens the language selector — a route, not a modal. WHICH flag it shows is
// the caller's business: the game passes the LOADED puzzle's lang, so a deep link to
// /en shows the EN flag regardless of the persisted preference.
export default function FlagButton({ lang }: { lang: string }) {
  return (
    <button
      type="button"
      className="home-btn"
      onClick={() => navigate(SELECT_PATH)}
      aria-label="Change language"
    >
      <Flag code={lang} className="hud-flag" />
    </button>
  );
}
