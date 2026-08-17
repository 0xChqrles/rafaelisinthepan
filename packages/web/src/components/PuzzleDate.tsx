import { dateForDayNumber } from '@whippin/shared';

// WHICH DAY you are playing, in the header's left status spot — the sentence game's chip
// since 2026-08-16, replacing the reconstruction-% counter that stood there (user-decided:
// the percentage is still computed, but it now speaks only through the run ruler's colours
// at the end of the round).
//
// It is the day's CALENDAR DATE, formatted exactly as every other surface that names a day
// spells it (the share card, the OG title, the shared text, the archive URL) — `2026-08-16`,
// always the SERVER-owned game day via `dateForDayNumber`, never the reader's local date.
// So an archived day is legible as the day it is, from the moment it loads.
//
// Chrome, not a stat: muted and small like `.topbar-title`, with none of the counter's live
// colour. A <time> element, so the date is machine-readable as well as legible.
export default function PuzzleDate({ dayNumber }: { dayNumber: number }) {
  const date = dateForDayNumber(dayNumber);
  return (
    <time className="puzzle-date" dateTime={date}>
      {date}
    </time>
  );
}
