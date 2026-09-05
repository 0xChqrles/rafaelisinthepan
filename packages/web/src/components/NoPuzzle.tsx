import { useMemo, useState } from 'react';
import Button from './Button';
import PuzzleSelect from './PuzzleSelect';
import { navigate } from '../routing';
import { pathForArchive, type LangCode, type Mode } from '../langs';
import { t } from '../i18n';

// Shown when the backend has no puzzle for the requested day in this language (404 ->
// noPuzzle). That 404 is UNDIFFERENTIATED — never published and out-of-window look the
// same from here — so the ROUTE is what tells the two states apart, which is all the
// signal this needs:
//
//   undated route (today's puzzle) — ABNORMAL. A daily puzzle is the product's promise,
//     so reaching here means a publish did not happen. The wording owns that ("is
//     missing", "not supposed to happen") instead of reading like a scheduled day off.
//   dated route (an archive day, #55) — usually NORMAL. A pre-launch date, or a language
//     backfilled later, simply was never published; apologizing for it would be a lie.
//     It says so plainly and sends the player back to the calendar they came from.
//
// Neither is a failure to RETRY (nothing transient to re-fetch), so both offer only
// navigation. Renders WITHOUT the HUD, on the shared .load-error surface — which is why
// CHANGE LANGUAGE opens the header's own selection drums (`PuzzleSelect`, the daily and
// the language, folding onto the pick) right here: the `/select` screen it used to send
// the player to was retired 2026-09-05 (user-decided) for exactly that dialog.
export default function NoPuzzle({
  lang,
  mode,
  date,
}: {
  lang: LangCode;
  mode: Mode;
  date?: string;
}) {
  const [selecting, setSelecting] = useState(false);
  const select = selecting && (
    <PuzzleSelect lang={lang} mode={mode} onClose={() => setSelecting(false)} />
  );
  // The day is worth naming: nothing else on this screen says WHICH day is missing (the
  // header carries no date). `parseRoute` only ever yields a real calendar date, but the
  // prop is a plain string — an unparseable one drops the line rather than printing NaN.
  const longDate = useMemo(() => {
    if (date == null) return null;
    const day = new Date(`${date}T00:00:00Z`);
    return Number.isNaN(day.getTime())
      ? null
      : new Intl.DateTimeFormat(lang, { dateStyle: 'long', timeZone: 'UTC' }).format(day);
  }, [lang, date]);

  if (date == null) {
    return (
      <div className="load-error">
        <p className="status error">{t(lang, 'noPuzzle')}</p>
        <p className="no-puzzle-note">{t(lang, 'noPuzzleNote')}</p>
        <Button variant="secondary" onClick={() => setSelecting(true)}>
          {t(lang, 'changeLanguage')}
        </Button>
        {select}
      </div>
    );
  }

  // Not an error, so not the danger-colored `.status.error` title the today variant uses.
  return (
    <div className="load-error">
      <p className="status">{t(lang, 'noPuzzleDay')}</p>
      <p className="no-puzzle-note">
        {longDate !== null && (
          <>
            {longDate}
            <br />
          </>
        )}
        {t(lang, 'noPuzzleDayNote')}
      </p>
      <Button variant="secondary" onClick={() => navigate(pathForArchive(lang, mode))}>
        {t(lang, 'backToArchive')}
      </Button>
      <Button variant="secondary" onClick={() => setSelecting(true)}>
        {t(lang, 'changeLanguage')}
      </Button>
      {select}
    </div>
  );
}
