import { useCallback, useEffect, useState } from 'react';
import { MARK_GLYPH } from '@whippin/shared';
import Button from '../components/Button';
import { prefersReducedMotion } from '../hooks/useScramble';
import { t } from '../i18n';
import type { LangCode } from '../langs';
import InviteDemo from './InviteDemo';
import { preloadLevelOne } from './LazyLevelOne';

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

// The question's highlight is the screen's one emphasis gesture, and the demo's held word
// wears the same white chip: the box waits until the chip leaves the found word, so the two
// never stand at once. A deadline stands behind the demo's signal, counted from the show's
// START (its word inks about 6.5s after it), so a lost report can only make the box late,
// never missing — and a slow face or a hidden tab never lights it under a chip still held.
const MARK_DEADLINE_MS = 8_000;

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

  // Lit at once where nothing is passed on: under reduced motion (the demo is a run of cuts,
  // with no chip leaving to hand the gesture over), or in a tab opened hidden (the demo
  // waits to be seen, and the question is what the tab opens on).
  const [lit, setLit] = useState(() => prefersReducedMotion() || document.visibilityState !== 'visible');
  const light = useCallback(() => setLit(true), []);
  const [started, setStarted] = useState(false);
  const start = useCallback(() => setStarted(true), []);
  useEffect(() => {
    if (lit || !started) return undefined;
    const id = window.setTimeout(light, MARK_DEADLINE_MS);
    return () => window.clearTimeout(id);
  }, [lit, started, light]);

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
        <InviteDemo key={lang} lang={lang} onStart={start} onDone={light} />
      </div>

      <div className="tray tray-gate">
        <div className="rules-gate">
          <h1 id="tutorial-invite-title" className="invite-title">
            {(() => {
              const [head, mark] = splitHighlight(t(lang, 'inviteTitle'));
              // The words stand from the first frame; the box is laid over them as a second,
              // inverted copy and drawn across once lit, so the title never reads with a gap.
              return (
                <>
                  {head}
                  <span className={`invite-mark${lit ? ' lit' : ''}`}>
                    {mark}
                    <span className="invite-mark-box" aria-hidden="true">
                      {mark}
                    </span>
                  </span>
                </>
              );
            })()}
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
