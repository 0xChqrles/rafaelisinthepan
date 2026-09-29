import LangTitle from '../components/LangTitle';
import { HeaderLeft } from '../components/TopBar';
import { useGameStore } from '../state/gameStore';
import { t } from '../i18n';
import { pathForLearn, pathForLesson, type LangCode } from '../langs';
import { navigate } from '../routing';
import LevelArt from './art/LevelArt';
import { LEVELS, PLAY_LEVEL, formatDuration, isReady } from './levels';

// THE TUTORIAL PAGE (#269; re-dressed 2026-09-29): the levels as CARDS, each wearing its
// illustration (art/) edge to edge — the page has nothing else to show, so the pictures fill
// it. Level 1, the game played, is the wide card on top; the four articles follow, two by two
// where the screen is wide enough, one under the other on a phone. A card reads like a track
// on the article's page: its number, how long it takes, its title and what it is about. The
// level to do NEXT wears the invitation's highlight box on its title; a done level trades its
// duration for the done mark; a level not ready in this language holds a still, grey picture
// and says SOON — the road ahead, not a target. No gating between cards: any ready level can
// be opened, done or not.
const pad2 = (n: number) => String(n).padStart(2, '0');
// The card's foot, under its title and subtitle, where the picture dithers out.
const FOOT_PX = 92;

export default function Learn({ lang }: { lang: LangCode }) {
  const done = useGameStore((s) => s.lessonsDone);
  const next = LEVELS.find((l) => isReady(l, lang) && !done.includes(l.level));
  return (
    <div className="learn pixel-scroll">
      <HeaderLeft>
        <LangTitle lang={lang} title={t(lang, 'learnTitle')} to={pathForLearn} />
      </HeaderLeft>
      <ol className="learn-grid arrive">
        {LEVELS.map((level) => {
          const ready = isReady(level, lang);
          const isDone = done.includes(level.level);
          const seconds = level.duration[lang];
          const state = !ready ? 'soon' : isDone ? 'done' : level === next ? 'next' : 'todo';
          return (
            <li key={level.level} className={`learn-cell${level.level === PLAY_LEVEL ? ' hero' : ''}`}>
              <button
                type="button"
                className={`learn-card ${state}`}
                disabled={!ready}
                onClick={() => navigate(pathForLesson(lang, level.level))}
              >
                <LevelArt name={level.art} still={!ready} foot={FOOT_PX} className="learn-art" />
                <span className="learn-card-top">
                  <span className="learn-no">{pad2(level.level)}</span>
                  {!ready ? (
                    <span className="learn-meta">{t(lang, 'levelSoon')}</span>
                  ) : isDone ? (
                    <span className="learn-meta">
                      <span className="learn-mark" aria-hidden="true" />
                      {t(lang, 'levelDone')}
                    </span>
                  ) : (
                    seconds !== undefined && <span className="learn-meta">{formatDuration(seconds)}</span>
                  )}
                </span>
                <span className="learn-card-foot">
                  <span className="learn-title">
                    <span className="learn-title-text">{t(lang, level.titleKey)}</span>
                  </span>
                  <span className="learn-sub">{t(lang, level.subKey)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
