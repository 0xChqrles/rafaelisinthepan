// WHICH PUZZLE YOU ARE ON, in the header's left slot (user-decided 2026-08-30).
//
// It replaces two controls and frees a third slot. Before this the row carried the DAY as a
// left-hand chip, the DAILY as a centred segmented switcher, and the LANGUAGE as a right-hand
// chip — three axes in three places, which is why the row had no room left: measured at
// 320px the grid was `98.6 | 118.8 | 98.6` and the centre's right edge landed at 219 while
// the right group began at 218. A one-pixel collision. It is why the leaderboard could not
// carry a back control and its own title, and why the account area could never have a door
// in the header.
//
// The three axes are ONE QUESTION — "which puzzle am I playing" — so they are one control:
// this title names the daily and the sheet behind it holds the language and the daily. The
// DAY is not in it: a calendar is a PLACE, and the places are keys in the right group, so it
// keeps its own door there rather than owning a second one here. Measured after the change,
// at the tightest case (320px, English, SENTENCE): the title takes 122px, the right-hand keys
// 100px, and 94px of centre is left over.
//
// The DATE is not dropped — it is promoted to where it means something. On today it is
// absent, because today is the default and the screen IS the day's game; on an ARCHIVE day
// it joins the title, so the abnormal state is the one that is always labelled. That inverts
// the old chip, which spent the slot stating the normal case.
//
// A CHEVRON, not tabs. The segmented switcher showed both dailies at once, which is what the
// retired 2026-08-06 icon toggle lacked — but a title names the current mode, which the
// toggle never did, and switching dailies is a once-a-day act rather than a flip. The wheel
// costs one tap for a choice nobody makes twice in a session.
//
// THE TITLE IS A HELD WORD (user-decided 2026-09-02: "a --fg background, like on the hole
// words"): the daily's name wears the sentence chip — `--fg` ground, `--bg` ink — and what
// hangs off it is a fullscreen selection in the hole wheel's dress (`PuzzleSelect`), not a
// dropdown. The day and the chevron stand OUTSIDE the chip, the way a hole's exponent does:
// the chip is exactly the word.
import { dateForDayNumber } from '@whippin/shared';
import { useState } from 'react';
import ChevronDownIcon from '../assets/icons/chevron-down.svg?react';
import PuzzleSelect, { type SelectSurface } from './PuzzleSelect';
import { t } from '../i18n';
import type { LangCode, Mode } from '../langs';

// "29 AUG" — short, in the reader's locale, and only ever shown on a day that is not today.
function shortDay(dayNumber: number, lang: string): string {
  const at = Date.parse(`${dateForDayNumber(dayNumber)}T12:00:00Z`);
  if (!Number.isFinite(at)) return '';
  return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(at))
    .toUpperCase();
}

export default function PuzzleTitle({
  lang,
  mode,
  // Present only on an archive route: the day being played, or null on today.
  dayNumber = null,
  // WHICH KIND OF SCREEN this title sits on, and so where a pick lands: the other daily
  // means that daily's puzzle from a game, its CALENDAR from the archive, and its BOARD
  // from the leaderboard. A selection changes what you are looking AT.
  surface = 'game',
}: {
  lang: LangCode;
  mode: Mode;
  dayNumber?: number | null;
  surface?: SelectSurface;
}) {
  const [open, setOpen] = useState(false);
  const name = t(lang, mode === 'word' ? 'modeWord' : 'modeSentence').toUpperCase();
  const day = dayNumber === null ? null : shortDay(dayNumber, lang);
  return (
    <>
      <button
        type="button"
        className="puzzle-title"
        // The NAME first, then what the control does: an `aria-label` REPLACES the
        // content, so labelling it "Change puzzle" alone would take the daily — and, on
        // an archive route, the day — away from a reader entirely.
        aria-label={`${day === null ? name : `${name} ${day}`}, ${t(lang, 'puzzleMenu')}`}
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
          mode={mode}
          surface={surface}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
