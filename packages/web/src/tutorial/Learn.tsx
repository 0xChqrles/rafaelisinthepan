import { useEffect, type CSSProperties } from 'react';
import LangTitle from '../components/LangTitle';
// (For its side effect: the root's Bayer tiles the cards come in through.)
import '../components/bayerTiles';
import { HeaderLeft } from '../components/TopBar';
import { useGameStore } from '../state/gameStore';
import { t } from '../i18n';
import { pathForLearn, pathForLesson, type LangCode } from '../langs';
import { navigate } from '../routing';
import LevelCard from './LevelCard';
import { LEVELS, PLAY_LEVEL, isReady } from './levels';

// THE TUTORIAL PAGE (#269; re-dressed 2026-09-29, set on the bare ground 2026-10-06): the
// levels as CARDS, each its illustration (art/) on the ground inside a tappable thing's corner
// brackets — the page has nothing else to show, so the pictures fill it. Level 1, the game
// played, is the wide card on top; the four articles follow, two by two where the screen is
// wide enough, one under the other on a phone. A card reads like a track on the article's
// page: its number, an article's reading time, its title and what it is about. Level 1,
// played, is untimed: it is the one with a done state, said in the card's own material
// (`LevelCard`). The articles are simply there to read. A level not ready in this language is
// printed in halftone and says SOON — the road ahead, not a target, so it wears no brackets.
// No gating between cards: any ready level can be opened. The cards come in through the
// board's dither, one after the other.
export default function Learn({ lang }: { lang: LangCode }) {
  const playedOne = useGameStore((s) => s.lessonsDone.includes(PLAY_LEVEL));
  // The list opens at its top: on a phone the page scrolls as a whole, and coming back from
  // an article (navigating resets nothing) would otherwise land on its last cards.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);
  return (
    <div className="learn pixel-scroll">
      <HeaderLeft>
        <LangTitle lang={lang} title={t(lang, 'learnTitle')} to={pathForLearn} />
      </HeaderLeft>
      <ol className="learn-grid">
        {LEVELS.map((level, i) => {
          const ready = isReady(level, lang);
          const state = !ready
            ? 'soon'
            : level.level !== PLAY_LEVEL
              ? 'todo'
              : playedOne
                ? 'done'
                : 'next';
          return (
            <li
              key={level.level}
              className={`learn-cell${level.level === PLAY_LEVEL ? ' hero' : ''}`}
              style={{ '--i': i } as CSSProperties}
            >
              <button
                type="button"
                className={`learn-card ${state}`}
                disabled={!ready}
                onClick={() => navigate(pathForLesson(lang, level.level))}
              >
                <LevelCard level={level} lang={lang} state={state} />
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
