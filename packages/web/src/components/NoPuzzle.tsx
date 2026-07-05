import Button from './Button';
import { navigate } from '../routing';
import { SELECT_PATH } from '../langs';
import { t } from '../i18n';

// Shown when the backend has no puzzle for today in this language (404 -> noPuzzle).
// This state is ABNORMAL — a daily puzzle is the product's promise, so reaching here
// means a publish did not happen. The wording owns that ("is missing", "not supposed
// to happen") instead of reading like a scheduled day off. Still NOT a failure to
// retry (nothing transient to re-fetch); the offered action is to try another
// language. Renders WITHOUT the HUD, on the shared .load-error surface.
export default function NoPuzzle({ lang }: { lang: string }) {
  return (
    <div className="load-error">
      <p className="status error">{t(lang, 'noPuzzle')}</p>
      <p className="no-puzzle-note">{t(lang, 'noPuzzleNote')}</p>
      <Button variant="secondary" onClick={() => navigate(SELECT_PATH)}>
        {t(lang, 'changeLanguage')}
      </Button>
    </div>
  );
}
