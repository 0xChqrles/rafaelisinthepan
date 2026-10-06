import { t } from '../i18n';
import type { LangCode } from '../langs';
import LevelArt from './art/LevelArt';
import Duration from './Duration';
import { LEVELS, levelOf } from './levels';

// AN ARTICLE'S HEAD: its sleeve (the level's illustration, large, on the bare ground), the track
// number in the accent's pixel figures and the title, the credits line (how long, which level of
// how many). Everything in it is known before the article's own chunk has landed — so the
// article's hold (`LazyArticle`) stands the very head the article then shows, and nothing in it
// moves when the text arrives.
const pad2 = (n: number) => String(n).padStart(2, '0');

export default function ArticleHead({ lang, level }: { lang: LangCode; level: number }) {
  const meta = levelOf(level);
  if (!meta) return null;
  const seconds = meta.duration[lang];
  return (
    <header className="article-head">
      <div className="article-sleeve">
        <LevelArt name={meta.art} />
      </div>
      <div className="article-title-row">
        <span className="article-no" aria-hidden="true">
          {pad2(level)}
        </span>
        <h1 id="article-title" className="article-title">
          {t(lang, meta.subKey)}
        </h1>
      </div>
      <ul className="article-credits">
        {seconds != null && (
          <li>
            <Duration lang={lang} seconds={seconds} />
          </li>
        )}
        <li>{t(lang, 'levelOf').replace('{n}', String(level)).replace('{total}', String(LEVELS.length))}</li>
      </ul>
    </header>
  );
}
