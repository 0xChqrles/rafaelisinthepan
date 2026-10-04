import { addMonths, compareYearMonth, isoMonth, type YearMonth } from '../../calendar';
import type { BoardTabItem } from '../BoardTabs';

// THE MONTHS AS TABS: the archive's month is a SELECTION among months, so it turns through the
// boards' one control (`BoardTabs`) — every month from the language's first to the active one,
// oldest on the left, and no other. The clamp the old pager enforced is now which tabs exist.
//
// Each name is the locale's SHORT month in capitals (fr `AOÛT · SEPT · OCT`, en `AUG · SEP`),
// its abbreviation's dot dropped — a tab row reads as names, not as a sentence. The year is
// said only where the row spans two calendar years, and then only where it changes hands — on
// the first tab and on each January — and on the pinned month, which stands apart from the
// months scrolling under it. A reader hears the whole month and year (`ariaLabel`). The
// ACTIVE month is pinned at the row's end: the way back to now stays one tap away when a year
// of months scrolls under it. There is always a tab: a client whose day falls before the
// language's first puzzle has the first month alone.

// A month as its first day, the Date the formats read.
const firstOf = (ym: YearMonth) => new Date(Date.UTC(ym.year, ym.month - 1, 1));

export function monthTabs(lang: string, first: YearMonth, activeMonth: YearMonth): BoardTabItem[] {
  const active = compareYearMonth(activeMonth, first) < 0 ? first : activeMonth;
  const short = new Intl.DateTimeFormat(lang, { month: 'short', timeZone: 'UTC' });
  const long = new Intl.DateTimeFormat(lang, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const spansYears = first.year !== active.year;
  const tabs: BoardTabItem[] = [];
  for (let ym = first; compareYearMonth(ym, active) <= 0; ym = addMonths(ym, 1)) {
    const name = short.format(firstOf(ym)).replace(/\.$/, '').toLocaleUpperCase(lang);
    const pinned = compareYearMonth(ym, active) === 0;
    const yearShown = spansYears && (tabs.length === 0 || ym.month === 1 || pinned);
    tabs.push({
      key: isoMonth(ym),
      label: yearShown ? `${name} ${ym.year}` : name,
      ariaLabel: long.format(firstOf(ym)),
      ...(pinned ? { pinned: true } : {}),
    });
  }
  return tabs;
}
