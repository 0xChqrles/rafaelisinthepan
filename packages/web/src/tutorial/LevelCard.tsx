import type { ReactNode } from 'react';
import { t } from '../i18n';
import type { LangCode } from '../langs';
import LevelArt from './art/LevelArt';
import Duration from './Duration';
import type { Level } from './levels';

// ONE LEVEL'S CARD, its inside: the illustration on the bare ground, the number and an
// article's reading time (or SOON) on top, the title and what it is about at the foot, where the
// picture dithers out. The list wraps it in a button (in a tappable thing's corner brackets);
// level 1's finale draws the same card on its own, in the frame's corners (`LessonBoard`) — one
// card, so the two can never disagree.
//
// ITS STATE IS SAID IN ITS OWN MATERIAL, never in a word on it: the NUMBER is the accent's
// pixel figures on a level to read, WHITE on level 1 until it is played (its title in the white
// chip — the next thing to do), COBALT once DONE (the chip gone, the picture's held words inked
// in, found) and the quiet grey on a level not ready here (its picture printed in halftone, SOON
// in its corner).
export type LevelCardState = 'soon' | 'done' | 'next' | 'todo';

const pad2 = (n: number) => String(n).padStart(2, '0');
// The card's foot under the picture's stage — its title and what it is about, ONE height on
// every card so the titles of a row stand on one line — and the band the picture dithers out
// across (CSS: `.learn-card-foot`).
const FOOT_PX = 72;

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
  // Laid over the title: the finale's chip, wiped off as the level turns done.
  titleMark?: ReactNode;
}) {
  const seconds = level.duration[lang];
  return (
    <>
      <LevelArt
        name={level.art}
        still={state === 'soon'}
        halftone={state === 'soon'}
        solved={state === 'done'}
        foot={FOOT_PX}
        from={from}
        className="learn-art"
      />
      <span className="learn-card-top">
        <span className="learn-no">{pad2(level.level)}</span>
        {state === 'soon' ? (
          <span className="learn-meta">{t(lang, 'levelSoon')}</span>
        ) : (
          // Level 1 is untimed (null): its corner stays empty.
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
        {state === 'done' && <span className="sr-only">{t(lang, 'levelDone')}</span>}
      </span>
    </>
  );
}
