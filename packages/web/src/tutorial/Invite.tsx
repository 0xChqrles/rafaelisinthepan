import { useEffect } from 'react';
import Button from '../components/Button';
import { t } from '../i18n';
import logo from '../assets/logo-blue.png';
import { preloadTutorial } from './LazyTutorial';

// The tutorial invitation (#51): the tutorial NEVER starts without an action. On a
// first visit this screen stands where LOADING would (the day's puzzle keeps loading
// behind it) and offers the choice once — TUTORIAL starts the guided round, SKIP
// goes straight to the puzzle. Either answer sets `onboarded`, so the question is
// never asked again; the header's "?" remains the way back for a skipper who
// regrets. A veteran on a new device is one SKIP away from playing.
export default function Invite({
  lang,
  onAccept,
  onSkip,
}: {
  lang: string;
  onAccept: () => void;
  onSkip: () => void;
}) {
  // The tutorial chunk fetches while the player reads the question, so TUTORIAL opens
  // without a network pause (see LazyTutorial).
  useEffect(() => {
    preloadTutorial();
  }, []);

  return (
    <main className="invite" aria-labelledby="tutorial-invite-title">
      <img className="invite-logo" src={logo} alt="" draggable="false" />
      <h1 id="tutorial-invite-title" className="invite-title">
        {t(lang, 'inviteTitle')}
      </h1>
      <p className="invite-text">{t(lang, 'inviteText')}</p>

      <div className="invite-actions">
        <Button variant="primary" onClick={onAccept}>
          {t(lang, 'inviteTutorial')}
        </Button>
        <Button variant="secondary" onClick={onSkip}>
          {t(lang, 'inviteSkip')}
        </Button>
      </div>
    </main>
  );
}
