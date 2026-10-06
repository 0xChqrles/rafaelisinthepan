import { useEffect } from 'react';
import { MARK_GLYPH } from '@whippin/shared';
import Button from '../components/Button';
import { t } from '../i18n';
import type { LangCode } from '../langs';
import InviteDemo from './InviteDemo';
import { preloadLevelOne } from './LazyLevelOne';

// The title's LAST WORD wears the inverted highlight box (the /inspiration/modern board's
// selection-box gesture), STILL: drawn from the first frame, never animated, waiting on
// nothing. Split on the final space — pulling one more token in when the tail is bare
// punctuation (French sets a space before `?`, and a highlighted lone question mark reads as
// a typo). Pure string surgery on the localized copy, so a new language needs nothing.
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
// behind it). It SHOWS the game once (`InviteDemo`), then asks — TUTORIAL starts the
// guided round, SKIP goes straight to the puzzle; both work from the first frame. It
// promises no time. Either answer sets `onboarded`, so the question is never asked
// again; the header's book remains the way back for a skipper who regrets. A veteran on
// a new device is one SKIP away from playing.
//
// IT IS LAID OUT AS THE GAME SCREEN IT OPENS ONTO, on the game's own zones (`.game`,
// `.play`, `.tray`): the lockup where the header's title holds the mark, the demo where the
// day's sentence and prompt stand, and the question with its two answers in the tray, where
// the gate's PLAY and LEARN then stand (TUTORIAL is the gate's own button, in its place). So
// SKIP reads as continuity — the mark stays put, the sentence area stays, the tray becomes
// the game's.
export default function Invite({
  lang,
  onAccept,
  onSkip,
}: {
  lang: LangCode;
  onAccept: () => void;
  onSkip: () => void;
}) {
  // The tutorial chunk fetches while the player reads the question, so TUTORIAL opens
  // without a network pause (see LazyTutorial).
  useEffect(() => {
    preloadLevelOne();
  }, []);

  const [head, mark] = splitHighlight(t(lang, 'inviteTitle'));

  return (
    <main className="invite game arrive" aria-labelledby="tutorial-invite-title">
      {/* The header row, in the header's own geometry: the pixel mark exactly where the
          game's title draws it, the app's name beside it where the language will stand. */}
      <div className="topbar" aria-hidden="true">
        <div className="topbar-inner">
          <div className="topbar-left">
            <span className="invite-lockup">
              <svg viewBox={`0 0 ${MARK_GLYPH.width} ${MARK_GLYPH.height}`} shapeRendering="crispEdges">
                <path d={MARK_GLYPH.path} fill="currentColor" />
              </svg>
              <span>WHIPPIN AI</span>
            </span>
          </div>
        </div>
      </div>

      <div className="play">
        <InviteDemo key={lang} lang={lang} />
      </div>

      <div className="tray tray-gate">
        <div className="rules-gate">
          <h1 id="tutorial-invite-title" className="invite-title">
            {head}
            <span className="invite-mark">{mark}</span>
          </h1>
          <button type="button" className="mix-btn" onClick={onAccept}>
            {t(lang, 'inviteTutorial')}
          </button>
          <Button variant="secondary" onClick={onSkip}>
            {t(lang, 'inviteSkip')}
          </Button>
        </div>
      </div>
    </main>
  );
}
