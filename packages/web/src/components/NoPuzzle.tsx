import Button from './Button';
import { navigate } from '../routing';
import { SELECT_PATH, LANGS } from '../langs';

// Shown when the backend has no puzzle for today in this language (404 -> noPuzzle).
// Unlike LoadError this is NOT a failure to retry — there simply is no puzzle today, so
// the only offered action is to try another language. It renders WITHOUT the HUD (no
// flag/progress header): the message + a CHANGE LANGUAGE button (mirroring LoadError's
// message+button layout via the shared .load-error surface) are the whole screen.
export default function NoPuzzle({ lang }: { lang: string }) {
  const label = LANGS.find((l) => l.code === lang)?.label ?? lang;
  return (
    <div className="load-error">
      <p className="status error">NO {label.toUpperCase()} PUZZLE TODAY</p>
      <Button variant="secondary" onClick={() => navigate(SELECT_PATH)}>
        CHANGE LANGUAGE
      </Button>
    </div>
  );
}
