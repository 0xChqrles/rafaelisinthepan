import Button from '../components/Button';
import { t } from '../i18n';

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
  return (
    <div className="invite">
      <p className="invite-text">{t(lang, 'inviteTitle')}</p>
      <div className="invite-actions">
        <Button variant="primary" onClick={onAccept}>
          {t(lang, 'inviteTutorial')}
        </Button>
        <Button variant="secondary" onClick={onSkip}>
          {t(lang, 'inviteSkip')}
        </Button>
      </div>
    </div>
  );
}
