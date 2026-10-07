import { BOARD_PERIODS, type BoardPeriod } from '@whippin/shared';
import BracketSwitch from './BracketSwitch';
import { t } from '../i18n';
import type { LangCode } from '../langs';

// A GROUP'S THREE BOARDS — TODAY, WEEK, MONTH — on the house's bracketed switch
// (`BracketSwitch`: three equal cells in resting corner brackets, the shown one under the white
// frame that travels to the word turned to). A board's period is the CURRENT one, in its own
// navigation landmark.
const LABEL = { day: 'periodDay', week: 'periodWeek', month: 'periodMonth' } as const;

export default function PeriodSwitch({
  lang,
  period,
  onChange,
}: {
  lang: LangCode;
  period: BoardPeriod;
  onChange: (period: BoardPeriod) => void;
}) {
  return (
    <nav className="period-switch" aria-label={t(lang, 'boardPeriods')}>
      <BracketSwitch
        labels={BOARD_PERIODS.map((view) => t(lang, LABEL[view]))}
        shown={BOARD_PERIODS.indexOf(period)}
        onPick={(i) => onChange(BOARD_PERIODS[i])}
      />
    </nav>
  );
}
