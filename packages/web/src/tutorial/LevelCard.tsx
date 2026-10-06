import type { ReactNode } from 'react';
import { t } from '../i18n';
import type { LangCode } from '../langs';
import LevelArt from './art/LevelArt';
import Duration from './Duration';
import type { Level } from './levels';

// ONE LEVEL'S CARD, its inside: the illustration edge to edge, the number and an article's
// reading time (or the done mark, or SOON) on top, the title and what it is about at the foot, where
// the picture dithers out. The list wraps it in a button; level 1's finale draws the same card
// on its own, cleared (`LessonBoard`) — one card, so the two can never disagree.
export type LevelCardState = 'soon' | 'done' | 'next' | 'todo';

const pad2 = (n: number) => String(n).padStart(2, '0');
// The card's foot, under its title and subtitle, where the picture dithers out.
const FOOT_PX = 80;

export default function LevelCard({
  level,
  lang,
  state,
  from,
  titleMark,
}: {
  level: Level;
  lang: LangCode;
  state: LevelCardState;
  // The picture's own clock from this scene time (the finale opens the page typing itself in).
  from?: number;
  // Laid over the title: the finale's selection box, wiped off as the level turns done.
  titleMark?: ReactNode;
}) {
  const seconds = level.duration[lang];
  return (
    <>
      <LevelArt name={level.art} still={state === 'soon'} foot={FOOT_PX} from={from} className="learn-art" />
      <span className="learn-card-top">
        <span className="learn-no">{pad2(level.level)}</span>
        {state === 'soon' ? (
          <span className="learn-meta">{t(lang, 'levelSoon')}</span>
        ) : state === 'done' ? (
          <span className="learn-meta">
            <span className="learn-mark" aria-hidden="true" />
            {t(lang, 'levelDone')}
          </span>
        ) : (
          // Level 1 is untimed (null): its corner stays empty until DONE stamps in, and the row
          // holds the chip's height (`.learn-card-top`), so the number does not move then.
          seconds != null && (
            <span className="learn-meta">
              <Duration lang={lang} seconds={seconds} />
            </span>
          )
        )}
      </span>
      <span className="learn-card-foot">
        <span className="learn-title">
          <span className="learn-title-text">{t(lang, level.titleKey)}</span>
          {titleMark}
        </span>
        <span className="learn-sub">{t(lang, level.subKey)}</span>
      </span>
    </>
  );
}
