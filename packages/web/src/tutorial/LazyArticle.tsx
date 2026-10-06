import type { ComponentProps, CSSProperties } from 'react';
import type ArticleLevel from './ArticleLevel';
import LangTitle from '../components/LangTitle';
import { HeaderLeft } from '../components/TopBar';
import { t } from '../i18n';
import { pathForLesson } from '../langs';
import { lazyChunk } from '../hooks/lazyChunk';
import ArticleHead from './ArticleHead';
import { levelOf } from './levels';
// Imported for its listener: it must be listening before the key that opens an article.
import './keyboardLast';

type ArticleProps = ComponentProps<typeof ArticleLevel>;

// Keep the article levels — their prose and figures — out of the
// startup bundle. A lost chunk hands the reader back (`onUnavailable`).
const chunk = lazyChunk<ArticleProps>(() => import('./ArticleLevel'));

// The paragraphs' rails while the text is on its way: two paragraphs of the article's own line
// pitch, the last line of each short. Their widths, in percent of the measure.
const RAILS = [[96, 100, 91, 98, 62], [100, 94, 97, 41]];

export default function LazyArticle({ onUnavailable, ...props }: ArticleProps & { onUnavailable: () => void }) {
  const Loaded = chunk.useLoaded(onUnavailable);
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
        // the paragraphs' rails in the slate stipple, coming in once the skeleton's wait is over.
        <div className="article-screen article-hold" aria-busy="true">
          <span className="sr-only">{t(props.lang, 'loading')}</span>
          <ArticleHead lang={props.lang} level={props.level} />
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
      )}
    </>
  );
}
