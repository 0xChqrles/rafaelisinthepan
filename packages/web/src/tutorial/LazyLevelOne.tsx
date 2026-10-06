import type { ComponentProps } from 'react';
import type LevelOne from './LevelOne';
import LangTitle from '../components/LangTitle';
import QuietFailure from '../components/QuietFailure';
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
// they are, the coach's box and the board's word in the slate stipple, CONTINUE's slot as the
// game's hold draws PLAY's (after the skeleton's wait, then breathing; the lesson's own
// CONTINUE lands on it). The step counter's room is kept, unseen. A chunk
// LOST holds it STILL at once, its note and RETRY in the prompt's row — and, on the first
// visit, the way on to the game beside RETRY (`onSkip`).
function LevelOneHold({
  lang,
  failed,
  onRetry,
  onSkip,
}: {
  lang: LevelOneProps['lang'];
  failed: boolean;
  onRetry: () => void;
  onSkip?: () => void;
}) {
  const slot = `stat-slot${failed ? '' : ' breathing'}`;
  return (
    <div className={`game tutorial tutorial--word l1-hold${failed ? ' failed' : ''}`} aria-busy={failed ? undefined : true}>
      {!failed && <span className="sr-only">{t(lang, 'loading')}</span>}
      <div className="l1-band">
        <span className={`l1-bot-hold ${slot}`} aria-hidden="true" />
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
      <div className="play">
        <figure className="phrase-anchor l1-fig" aria-hidden="true">
          <p className="phrase">
            <span className={`l1-word-hold ${slot}`} />
          </p>
        </figure>
        <div className="input-area retired" aria-hidden="true">
          <div className="word-input">
            <span className="wi-prompt">&gt;</span>
          </div>
          <p className="hint"> </p>
        </div>
        {failed && (
          <div className="lesson-failure">
            <QuietFailure className="start" lang={lang} line={t(lang, 'failedPage')} onRetry={onRetry}>
              {onSkip && (
                <button type="button" className="quiet-btn" onClick={onSkip}>
                  {t(lang, 'inviteSkip')}
                </button>
              )}
            </QuietFailure>
          </div>
        )}
      </div>
      {/* CONTINUE's slot, drawn as the game's hold draws PLAY's: its box as its slate
          hairline, its word a bar of the stipple where it will print. */}
      <div className="tray" aria-hidden="true">
        <span className={`mix-btn gate-slot tray-hold${failed ? ' still' : ''}`}>
          <span className="gate-word">{t(lang, 'tutContinue')}</span>
        </span>
      </div>
    </div>
  );
}

export default function LazyLevelOne({
  onSkip,
  beforeReload,
  ...props
}: LevelOneProps & {
  onSkip?: () => void;
  // What must outlive RETRY's reload (the lesson's way back, `lessonReturn`).
  beforeReload?: () => void;
}) {
  // A lost chunk must never strand the player on a blank screen: the hold stands still and
  // says so, RETRY asks again — a new document — and the first visit keeps its way on to the
  // game (`onSkip`).
  const { Loaded, failed, retry } = chunk.useLoaded();

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
      {Loaded ? (
        <Loaded {...props} />
      ) : (
        <LevelOneHold
          lang={props.lang}
          failed={failed}
          onRetry={() => {
            beforeReload?.();
            retry();
          }}
          onSkip={onSkip}
        />
      )}
    </>
  );
}
