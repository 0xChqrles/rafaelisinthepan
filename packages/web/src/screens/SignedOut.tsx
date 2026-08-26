// This device has been signed out (#216).
//
// It renders on ONE signal and nothing else: the server answered `unknown_device`, meaning
// the device item this token names is gone — someone signed it out from another device. A
// 5xx, a dropped connection or any other refusal must never land here; those are hiccups
// with retries, and treating one as a sign-out would take a player's account away over a
// bad connection.
//
// **The copy says what is being left behind.** A vanished streak and an empty friends list
// read as a bug rather than as the sign-out that caused them, so the screen names them
// before the player taps anything.
//
// RECONNECT — signing back into the account by email — is #204's flow, and it does not
// exist yet. The prop is how it arrives: one wire, no stub button in the meantime. A button
// that does nothing is worse than a screen that only offers what it can actually do.

import Button from '../components/Button';
import { startFreshDevice } from '../identity';
import { t } from '../i18n';

export default function SignedOut({
  lang,
  onReconnect,
}: {
  lang: string;
  // #204's email link flow, when it lands. Absent today, so only SKIP is offered.
  onReconnect?: () => void;
}) {
  return (
    <div className="load-error">
      <p className="status error">{t(lang, 'signedOut')}</p>
      <p className="no-puzzle-note">{t(lang, 'signedOutNote')}</p>
      {onReconnect && (
        <Button variant="primary" onClick={onReconnect}>
          {t(lang, 'signedOutReconnect')}
        </Button>
      )}
      <Button variant="secondary" onClick={startFreshDevice}>
        {t(lang, 'signedOutSkip')}
      </Button>
    </div>
  );
}
