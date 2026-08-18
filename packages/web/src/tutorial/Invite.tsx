import { useEffect } from 'react';
import Button from '../components/Button';
import { t } from '../i18n';
import Logo from '../assets/logo.svg?react';
import { preloadTutorial } from './LazyTutorial';

// The title's LAST WORD wears the inverted highlight box (2026-08-18, the
// /inspiration/modern board's selection-box gesture). Split on the final space —
// pulling one more token in when the tail is bare punctuation (French sets a space
// before `?`, and a highlighted lone question mark reads as a typo). Pure string
// surgery on the localized copy, so a new language needs nothing.
function splitHighlight(title: string): [string, string] {
  const words = title.split(' ');
  if (words.length < 2) return ['', title];
  let take = 1;
  if (/^[^\p{L}\p{N}]+$/u.test(words[words.length - 1]) && words.length > 2) take = 2;
  return [
    words.slice(0, words.length - take).join(' ') + ' ',
    words.slice(words.length - take).join(' '),
  ];
}

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
      <Logo className="invite-logo" aria-hidden />
      <h1 id="tutorial-invite-title" className="invite-title">
        {(() => {
          const [head, mark] = splitHighlight(t(lang, 'inviteTitle'));
          return (
            <>
              {head}
              <span className="invite-mark">{mark}</span>
            </>
          );
        })()}
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
