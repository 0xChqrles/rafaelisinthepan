import type { ComponentProps } from 'react';
import type ArticleLevel from './ArticleLevel';
import { t } from '../i18n';
import LoadingWave from '../components/LoadingWave';
import { lazyChunk } from '../hooks/lazyChunk';
// Imported for its listener: it must be listening before the key that opens an article.
import './keyboardLast';

type ArticleProps = ComponentProps<typeof ArticleLevel>;

// Keep the article levels — their prose, figures and the board they quote — out of the
// startup bundle. A lost chunk hands the reader back (`onUnavailable`).
const chunk = lazyChunk<ArticleProps>(() => import('./ArticleLevel'));

export default function LazyArticle({ onUnavailable, ...props }: ArticleProps & { onUnavailable: () => void }) {
  const Loaded = chunk.useLoaded(onUnavailable);

  return Loaded ? (
    <Loaded {...props} />
  ) : (
    <p className="status">
      <LoadingWave text={t(props.lang, 'loading')} />
    </p>
  );
}
