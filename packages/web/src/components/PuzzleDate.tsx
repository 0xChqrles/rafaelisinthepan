import { dateForDayNumber } from '@whippin/shared';
import { navigate } from '../routing';
import { pathForArchive, type Mode } from '../langs';
import { t } from '../i18n';

// WHICH DAY you are playing, in the header's left slot — and since 2026-08-18 it IS
// the ARCHIVE ENTRY: tap the day to change the day (the standalone calendar icon left
// the header with it). The date is already the archive's own vocabulary — the same
// `2026-08-16` spelling as the calendar, the share card, the OG title and the archive
// URL, always the SERVER-owned game day via `dateForDayNumber` — so the chip finally
// earns the width it takes. The small ▾ carries the discoverability.
export default function PuzzleDate({
  dayNumber,
  lang,
  mode = 'sentence',
}: {
  dayNumber: number;
  lang: string;
  mode?: Mode;
}) {
  const date = dateForDayNumber(dayNumber);
  return (
    <button
      type="button"
      className="puzzle-date"
      /* The date IS the button's state, so it stays in the accessible name (review
         2026-08-18: a bare "Past puzzles" label hid which day is open). */
      aria-label={`${date} — ${t(lang, 'ariaArchive')}`}
      onClick={() => navigate(pathForArchive(lang, mode))}
    >
      <time dateTime={date}>{date}</time>
      <span className="pd-tick" aria-hidden="true">
        ▾
      </span>
    </button>
  );
}
