import Button from './Button';
import { t } from '../i18n';

// The group invite landing's error+action surface (its one consumer): the message plus a
// button that re-runs the read, so the landing never dead-ends. Every other read that fails
// is said in place, over its own loading picture held still (`QuietFailure`); this goes with
// the landing's own redesign. `message` arrives already localized; `lang` localizes the
// default RETRY label.
//
// `actionLabel` overrides that label for the one case where asking again cannot help:
// the #271 invite landing's full group is a state, not a hiccup, so its button
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
    <div className="load-error arrive">
      <p className="status error">{message}</p>
      <Button variant="secondary" onClick={onRetry}>
        {actionLabel ?? t(lang, 'retry')}
      </Button>
    </div>
  );
}
