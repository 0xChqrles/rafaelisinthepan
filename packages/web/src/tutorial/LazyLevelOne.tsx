import type { ComponentProps } from 'react';
import type LevelOne from './LevelOne';
import LangTitle from '../components/LangTitle';
import { HeaderLeft } from '../components/TopBar';
import { t } from '../i18n';
import { pathForLesson } from '../langs';
import { lazyChunk } from '../hooks/lazyChunk';
import { LEVELS, PLAY_LEVEL } from './levels';

type LevelOneProps = ComponentProps<typeof LevelOne>;

// Keep the lesson — its components AND the embedded word maps — out of the startup bundle:
// most sessions never render it, but the invitation preloads it while the first-visit player
// reads the question, so accepting still opens without a network pause.
const chunk = lazyChunk<LevelOneProps>(() => import('./LevelOne'));

export function preloadLevelOne(): void {
  chunk.preload();
}

const levelOne = LEVELS.find((l) => l.level === PLAY_LEVEL)!;

// The lesson's first screen, HELD while its chunk is on its way (`.l1-hold`): its own layout,
// so nothing that lands moves — the byline with the level's number and line as the real text
// they are, the coach's box, the board's word and CONTINUE's slot in the slate stipple (after
// the skeleton's wait, then breathing). The step counter's room is kept, unseen.
function LevelOneHold({ lang }: { lang: LevelOneProps['lang'] }) {
  return (
    <div className="game tutorial tutorial--word l1-hold" aria-busy="true">
      <span className="sr-only">{t(lang, 'loading')}</span>
      <div className="l1-band">
        <span className="l1-bot-hold stat-slot breathing" aria-hidden="true" />
        <div className="l1-byline">
          <h1 className="l1-title-row">
            <span className="l1-no" aria-hidden="true">
              {String(PLAY_LEVEL).padStart(2, '0')}
            </span>
            <span className="l1-title">{t(lang, levelOne.subKey)}</span>
          </h1>
          <span className="l1-step" aria-hidden="true">
            0/0
          </span>
        </div>
      </div>
      <div className="l1-voice" />
      <div className="play" aria-hidden="true">
        <figure className="phrase-anchor l1-fig">
          <p className="phrase">
            <span className="l1-word-hold stat-slot breathing" />
          </p>
        </figure>
        <div className="input-area retired">
          <div className="word-input">
            <span className="wi-prompt">&gt;</span>
          </div>
          <p className="hint"> </p>
        </div>
      </div>
      <div className="tray" aria-hidden="true">
        <span className="l1-call-hold stat-slot breathing" />
      </div>
    </div>
  );
}

export default function LazyLevelOne({ onUnavailable, ...props }: LevelOneProps & { onUnavailable: () => void }) {
  // A lost chunk must never strand the player on a blank screen: skip the lesson and land
  // in the game — the header's book remains the way back once the network does.
  const Loaded = chunk.useLoaded(onUnavailable);

  return (
    <>
      {/* The header's title is published HERE, held across the chunk's wait, so the header
          never blanks: the level's name and the language it is taught in — a pick NAVIGATES to
          the same lesson in that language, and App keys the screen on it. */}
      <HeaderLeft>
        <LangTitle
          lang={props.lang}
          title={t(props.lang, levelOne.titleKey)}
          to={(picked) => pathForLesson(picked, PLAY_LEVEL)}
        />
      </HeaderLeft>
      {Loaded ? <Loaded {...props} /> : <LevelOneHold lang={props.lang} />}
    </>
  );
}
