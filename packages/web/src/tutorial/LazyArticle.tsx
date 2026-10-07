import type { ComponentProps, CSSProperties } from 'react';
import type ArticleLevel from './ArticleLevel';
import LangTitle from '../components/LangTitle';
import QuietFailure from '../components/QuietFailure';
import { HeaderLeft } from '../components/TopBar';
import { t } from '../i18n';
import { pathForLesson } from '../langs';
import { lazyChunk } from '../hooks/lazyChunk';
import ArticleHead from './ArticleHead';
import { levelOf } from './levels';
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

  return (
    <>
      {/* The header's title is published HERE, held across the chunk's wait, so the header
          never blanks: the level's name and the language — a pick NAVIGATES to the same level
          in that language. */}
      {meta && (
        <HeaderLeft>
          <LangTitle
            lang={props.lang}
            title={t(props.lang, meta.titleKey)}
            to={(picked) => pathForLesson(picked, props.level)}
          />
        </HeaderLeft>
      )}
      {Loaded ? (
        <Loaded {...props} />
      ) : (
        // THE ARTICLE'S HOLD: the very head the article shows — its sleeve (holding as its own
        // picture does), its number, its title and its credits as the real text they are — then
        // the paragraphs' rails at the prose's pitch; breathing while the chunk is out, STILL
        // once it is lost, its note and RETRY where the text would start — laid over the first
        // lines' rails, out of their flow, so saying it moves no rail.
        <div className={`article-screen article-hold${failed ? ' failed' : ''}`} aria-busy={failed ? undefined : true}>
          {!failed && <span className="sr-only">{t(props.lang, 'loading')}</span>}
          <ArticleHead lang={props.lang} level={props.level} />
          <div className="article-text-hold">
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
            {failed && (
              <QuietFailure className="start article-failure" lang={props.lang} line={t(props.lang, 'failedPage')} onRetry={retry} />
            )}
          </div>
        </div>
      )}
    </>
  );
}
