import type { ComponentProps, CSSProperties } from 'react';
import type ArticleLevel from './ArticleLevel';
import LangTitle from '../components/LangTitle';
import QuietFailure from '../components/QuietFailure';
import { HeaderLeft } from '../components/TopBar';
import { t } from '../i18n';
import { pathForLesson } from '../langs';
import { lazyChunk } from '../hooks/lazyChunk';
import Duration from './Duration';
import { LEVELS, levelOf } from './levels';
// Imported for its listener: it must be listening before the key that opens an article.
import './keyboardLast';

type ArticleProps = ComponentProps<typeof ArticleLevel>;

// Keep the article levels — their prose and figures — out of the startup bundle.
const chunk = lazyChunk<ArticleProps>(() => import('./ArticleLevel'));

// The paragraphs' rails while the text is on its way: two paragraphs of the article's own line
// pitch, the last line of each short. Their widths, in percent of the measure.
const RAILS = [
  [96, 100, 91, 98, 62],
  [100, 94, 97, 41],
];

export default function LazyArticle(props: ArticleProps) {
  // A lost chunk never strands the reader: the page's hold stands still and says so, and
  // RETRY asks again; the header's keys are the way elsewhere.
  const { Loaded, failed, retry } = chunk.useLoaded();
  const meta = levelOf(props.level);

  if (Loaded) return <Loaded {...props} />;
  if (!meta) return null;
  const seconds = meta.duration[props.lang];
  return (
    <>
      {/* The header's title while the chunk is out (the article publishes its own once in). */}
      <HeaderLeft>
        <LangTitle
          lang={props.lang}
          title={t(props.lang, meta.titleKey)}
          to={(picked) => pathForLesson(picked, props.level)}
        />
      </HeaderLeft>
      {/* THE ARTICLE'S HOLD: its head as the article prints it — the sleeve held as the slate
          stipple, its number, title and credits as the real text they are — then the
          paragraphs' rails at the prose's pitch; breathing while the chunk is out, STILL once
          it is lost, its note and RETRY where the text would start. */}
      <div className={`article-screen article-hold${failed ? ' failed' : ''}`} aria-busy={failed ? undefined : true}>
        {!failed && <span className="sr-only">{t(props.lang, 'loading')}</span>}
        <header className="article-head">
          <div className="article-sleeve" aria-hidden="true">
            <span className={`stat-slot${failed ? '' : ' breathing'}`} />
          </div>
          <div className="article-title-row">
            <span className="article-no" aria-hidden="true">
              {String(props.level).padStart(2, '0')}
            </span>
            <h1 className="article-title">{t(props.lang, meta.subKey)}</h1>
          </div>
          <ul className="article-credits">
            {seconds != null && (
              <li>
                <Duration lang={props.lang} seconds={seconds} />
              </li>
            )}
            <li>
              {t(props.lang, 'levelOf').replace('{n}', String(props.level)).replace('{total}', String(LEVELS.length))}
            </li>
          </ul>
        </header>
        {failed && (
          <QuietFailure className="start article-failure" lang={props.lang} line={t(props.lang, 'failedPage')} onRetry={retry} />
        )}
        <div className="article-rails" aria-hidden="true">
          {RAILS.map((lines, p) => (
            // Static: the index is a stable key.
            <div key={p} className="article-rail-p">
              {lines.map((w, i) => (
                <span key={i} className="article-rail" style={{ '--w': `${w}%` } as CSSProperties} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
