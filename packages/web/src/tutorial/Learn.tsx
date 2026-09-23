import LangTitle from '../components/LangTitle';
import { HeaderLeft } from '../components/TopBar';
import ChevronRightIcon from '../assets/icons/chevron-right.svg?react';
import { useGameStore } from '../state/gameStore';
import { t } from '../i18n';
import { pathForLearn, pathForLesson, type LangCode } from '../langs';
import { navigate } from '../routing';
import { LEVELS } from './levels';

// THE TUTORIAL PAGE (#269): a LIST of levels, one row each, in the device list's dress. A
// done level wears its mark; a built one leads into its lesson (the chevron says so); one not
// built yet is greyed and says SOON. Not a graph, no gating between rows: replaying a done
// level is allowed, and the road ahead is simply shown.
export default function Learn({ lang }: { lang: LangCode }) {
  const done = useGameStore((s) => s.lessonsDone);
  return (
    <div className="learn">
      <HeaderLeft>
        <LangTitle lang={lang} title={t(lang, 'learnTitle')} to={pathForLearn} />
      </HeaderLeft>
      <ul className="learn-list arrive">
        {LEVELS.map((level) => {
          const isDone = done.includes(level.level);
          return (
            <li key={level.level}>
              <button
                type="button"
                className={`learn-row${isDone ? ' done' : ''}`}
                disabled={!level.built}
                onClick={() => navigate(pathForLesson(lang, level.level))}
              >
                <span className="learn-num" aria-hidden="true">
                  {level.level}
                </span>
                <span className="learn-info">
                  <span className="learn-name">{t(lang, level.titleKey)}</span>
                  <span className="learn-sub">{t(lang, level.built ? level.subKey : 'levelSoon')}</span>
                </span>
                {isDone ? (
                  <span className="learn-mark" role="img" aria-label={t(lang, 'levelDone')} />
                ) : level.built ? (
                  <ChevronRightIcon className="ui-icon" aria-hidden />
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
