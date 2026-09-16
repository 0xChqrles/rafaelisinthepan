// WHICH PUZZLE YOU ARE ON, in the header's left slot (user-decided 2026-08-30).
//
// The row's LEFT slot says what you are looking at and its RIGHT group where you are. On a
// play surface — the game, the archive calendar, the leaderboard — what you are looking at
// is ONE language's daily, so the title NAMES THE LANGUAGE, in the language itself (the
// drum's own labels, `LANGS[].native`): FRANÇAIS, ENGLISH. The selection behind it turns
// that one axis.
//
// The DAY is not in it: a calendar is a PLACE, and the places are keys in the right group,
// so it keeps its own door there rather than owning a second one here. The DATE is not
// dropped either — on today it is absent, because today is the default and the screen IS
// the day's game; on an ARCHIVE day it joins the title, so the abnormal state is the one
// that is always labelled.
//
// THE TITLE IS A HELD WORD (user-decided 2026-09-02: "a --fg background, like on the hole
// words"): the name wears the sentence chip — `--fg` ground, `--bg` ink — and what hangs off
// it is a fullscreen selection in the hole wheel's dress (`PuzzleSelect`), not a dropdown.
// The day and the chevron stand OUTSIDE the chip, the way a hole's exponent does: the chip
// is exactly the word.
import { dateForDayNumber } from '@whippin/shared';
import { useState } from 'react';
import ChevronDownIcon from '../assets/icons/chevron-down.svg?react';
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
        className="puzzle-title"
        // The NAME first, then what the control does: an `aria-label` REPLACES the
        // content, so labelling it "Change language" alone would take the language — and,
        // on an archive route, the day — away from a reader entirely.
        aria-label={`${day === null ? name : `${name} ${day}`}, ${t(lang, 'langMenu')}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className="topbar-title">{name}</span>
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
