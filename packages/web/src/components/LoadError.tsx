import Button from './Button';
import { t } from '../i18n';

// Shared error+action surface for a failed load — the day's puzzle (App) or the
// language vocabulary (Game). Both use it so the two failures look and behave the
// same (issue #14): a transient/unexpected failure shows the message plus a RETRY
// that re-runs the fetch, so an error never dead-ends in a blank / infinite LOADING…
// screen. (A 404 missing puzzle is NOT an error — NoPuzzle owns that state.)
// `message` arrives already localized; `lang` localizes the default RETRY label.
//
// `actionLabel` overrides that label for the one case where asking again cannot help:
// the #189 invite landing's full friend list is a state, not a hiccup, so its button
// says PLAY and carries the player on. The surface stays the same — a dead end with
// one way out is the thing this component exists to prevent.
export default function LoadError({
  message,
  lang,
  onRetry,
  actionLabel,
}: {
  message: string;
  lang: string;
  onRetry: () => void;
  actionLabel?: string;
}) {
  return (
    <div className="load-error">
      <p className="status error">{message}</p>
      <Button variant="secondary" onClick={onRetry}>
        {actionLabel ?? t(lang, 'retry')}
      </Button>
    </div>
  );
}
