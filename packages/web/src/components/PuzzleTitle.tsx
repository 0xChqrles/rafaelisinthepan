// WHICH PUZZLE YOU ARE ON, in the header's left slot (user-decided 2026-08-30).
//
// The row's LEFT slot says what you are looking at and its RIGHT group where you are. On a
// play surface — the game, the archive calendar, the leaderboard — what you are looking at
// is THE GAME in one language, so the title is the APP'S MARK in the accent with the
// language's CODE beside it (user-decided 2026-09-16): ▲ FR, ▲ EN. The selection behind it
// turns that one axis, and its drum names each language in full (`LANGS[].native`); a reader
// hears the full name too (the `aria-label` below).
//
// The DAY is not in it: a calendar is a PLACE, and the places are keys in the right group,
// so it keeps its own door there rather than owning a second one here. The DATE is not
// dropped either — on today it is absent, because today is the default and the screen IS
// the day's game; on an ARCHIVE day it joins the title, so the abnormal state is the one
// that is always labelled.
//
// What hangs off it is a fullscreen selection in the hole wheel's dress (`PuzzleSelect`), not
// a dropdown. The code wears no chip: the mark is the title's one emphasis, and a white chip
// beside it would be a second one. (A screen that is not a puzzle keeps its NAME in the chip
// and the code as a quiet tag — `LangTitle`.)
import { dateForDayNumber } from '@whippin/shared';
import { useState } from 'react';
import ChevronDownIcon from '../assets/icons/chevron-down.svg?react';
import Logo from '../assets/logo.svg?react';
import PuzzleSelect from './PuzzleSelect';
import { t } from '../i18n';
import { LANGS, pathForArchive, pathForBoard, pathForGame, type LangCode } from '../langs';
import { navigate } from '../routing';

// WHICH KIND OF SCREEN the title sits on — and so where a pick lands. A selection changes
// what you are LOOKING AT, so it keeps you on the same kind of screen: another language's
// puzzle from a game, its CALENDAR from the archive, its BOARD from the leaderboard.
type TitleSurface = 'game' | 'archive' | 'board';

const PATH_FOR: Record<TitleSurface, (lang: LangCode) => string> = {
  game: pathForGame,
  archive: pathForArchive,
  board: pathForBoard,
};

// "29/08" — DD/MM (user-decided 2026-09-11, replacing the locale's "29 AUG" / "29 AOÛT"),
// and only ever shown on a day that is not today. The same digits in every language, read
// straight off the date label — no locale formatter, so no locale can reorder them.
function shortDay(dayNumber: number): string {
  const [, month, day] = dateForDayNumber(dayNumber).split('-');
  return `${day}/${month}`;
}

export default function PuzzleTitle({
  lang,
  // Present only on an archive route: the day being played, or null on today.
  dayNumber = null,
  surface = 'game',
}: {
  lang: LangCode;
  dayNumber?: number | null;
  surface?: TitleSurface;
}) {
  const [open, setOpen] = useState(false);
  const name = (LANGS.find((l) => l.code === lang)?.native ?? lang).toUpperCase();
  const day = dayNumber === null ? null : shortDay(dayNumber);
  return (
    <>
      <button
        type="button"
        className="puzzle-title app-title"
        // The language's NAME first, then what the control does: an `aria-label` REPLACES
        // the content, so labelling it "Change language" alone would take the language —
        // and, on an archive route, the day — away from a reader entirely.
        aria-label={`${day === null ? name : `${name} ${day}`}, ${t(lang, 'langMenu')}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Logo className="app-title-mark" aria-hidden />
        <span className="app-title-lang">{lang.toUpperCase()}</span>
        {day !== null && <span className="title-tag">{day}</span>}
        <ChevronDownIcon className="ui-icon" aria-hidden />
      </button>
      {open && (
        <PuzzleSelect
          lang={lang}
          onLang={(picked) => navigate(PATH_FOR[surface](picked))}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
