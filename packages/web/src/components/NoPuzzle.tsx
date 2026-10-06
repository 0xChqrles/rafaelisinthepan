import { useState } from 'react';
import Button from './Button';
import PuzzleSelect from './PuzzleSelect';
import './bayerTiles';
import { navigate } from '../routing';
import { pathForArchive, pathForGame, type LangCode } from '../langs';
import { t } from '../i18n';

// Shown when the backend has no puzzle for the requested day in this language (404 ->
// noPuzzle). That 404 is UNDIFFERENTIATED — never published and out-of-window look the
// same from here — so the ROUTE is what tells the states apart, which is all the signal
// this needs:
//
//   undated route (today's puzzle) — ABNORMAL. A daily puzzle is the product's promise,
//     so reaching here means a publish did not happen. The wording owns that ("is
//     missing", "not supposed to happen") instead of reading like a scheduled day off.
//   dated route (an archive day, #55) — usually NORMAL. A pre-launch date, or a language
//     backfilled later, simply was never published; apologizing for it would be a lie.
//     It says so plainly and sends the player back to the calendar they came from. The
//     calendar's TODAY cell opens a dated route too, so a missing today reached from there
//     gets this wording, not the one above.
//   a BONUS link (bonus puzzles, 2026-09-24) — a mistyped id or the other language's link:
//     it says so, and offers the language.
//
// THE BOARD'S EMPTY STATE, on the game's own zones: the sad ghost over ONE title in the
// foreground (no accent, no danger: the ghost already says it) and ONE muted sentence in
// the play area; ONE call where the gate's PLAY stands (`.tray-gate`'s `.mix-btn`), the
// other way out as THE WORD under it. On an archive day the header names the day
// (`EN 01/10`), so the screen does not say the date again; on a bonus it tags `BONUS`. On
// TODAY the header names no day (`EN` alone): the undated route's title is what says
// TODAY, and the calendar's dated today names no day anywhere. None of them is a failure
// to RETRY (nothing transient to re-fetch), so every way out is navigation. CHANGE
// LANGUAGE opens the header's own selection drum (`PuzzleSelect`, folding onto today's
// puzzle in the picked language).
export default function NoPuzzle({
  lang,
  date,
  bonus = false,
}: {
  lang: LangCode;
  date?: string;
  bonus?: boolean;
}) {
  const [selecting, setSelecting] = useState(false);
  const archiveDay = !bonus && date != null;
  const changeLanguage = () => setSelecting(true);

  return (
    <div className="game no-puzzle">
      <div className="play">
        <div className="no-puzzle-say">
          <span className="board-ghost no-puzzle-ghost" aria-hidden="true" />
          <p className="no-puzzle-title">
            {t(lang, archiveDay ? 'noPuzzleDay' : bonus ? 'noBonus' : 'noPuzzle')}
          </p>
          <p className="no-puzzle-note">
            {t(lang, archiveDay ? 'noPuzzleDayNote' : bonus ? 'noBonusNote' : 'noPuzzleNote')}
          </p>
        </div>
      </div>
      <div className="tray tray-gate">
        <div className="rules-gate">
          {archiveDay ? (
            <>
              <button type="button" className="mix-btn" onClick={() => navigate(pathForArchive(lang))}>
                {t(lang, 'backToArchive')}
              </button>
              <Button variant="secondary" onClick={changeLanguage}>
                {t(lang, 'changeLanguage')}
              </Button>
            </>
          ) : (
            <button type="button" className="mix-btn" onClick={changeLanguage}>
              {t(lang, 'changeLanguage')}
            </button>
          )}
        </div>
      </div>
      {selecting && (
        <PuzzleSelect
          lang={lang}
          onLang={(picked) => navigate(pathForGame(picked))}
          onClose={() => setSelecting(false)}
        />
      )}
    </div>
  );
}
