import Button from './Button';
import { t } from '../i18n';

// Shared error+retry surface for a failed load — the day's puzzle (App) or the
// language vocabulary (Game). Both use it so the two failures look and behave the
// same (issue #14): a transient/unexpected failure shows the message plus a RETRY
// that re-runs the fetch, so an error never dead-ends in a blank / infinite LOADING…
// screen. (A 404 missing puzzle is NOT an error — NoPuzzle owns that state.)
// `message` arrives already localized; `lang` localizes the RETRY label.
export default function LoadError({
  message,
  lang,
  onRetry,
}: {
  message: string;
  lang: string;
  onRetry: () => void;
}) {
  return (
    <div className="load-error">
      <p className="status error">{message}</p>
      <Button variant="secondary" onClick={onRetry}>
        {t(lang, 'retry')}
      </Button>
    </div>
  );
}
