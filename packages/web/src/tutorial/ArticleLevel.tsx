import { useEffect, useRef } from 'react';
import Button from '../components/Button';
import LangTitle from '../components/LangTitle';
import { HeaderLeft } from '../components/TopBar';
import { useGameStore } from '../state/gameStore';
import { t } from '../i18n';
import { pathForGame, pathForLesson, type LangCode } from '../langs';
import { navigate } from '../routing';
import LevelArt from './art/LevelArt';
import { articleFor } from './articles';
import { ArticleLang } from './articles/lang';
import Rich from './articles/Rich';
import FigureBody from './articles/figures/Figure';
import useSeen from './articles/figures/useSeen';
import type { Block } from './articles/types';
import Duration from './Duration';
import { keyboardLast } from './keyboardLast';
import { LEVELS, levelOf, nextReady } from './levels';

// AN ARTICLE LEVEL (levels 2+, 2026-09-29): the level read, not played — set like the
// author's article page. Its sleeve (the level's illustration, large), the track number and
// the title, the credits line (how long, which level of how many), the standfirst; then the
// sections, each opened by its numbered cue, the figures numbered through the level. Reading
// it to its END records it as done on this device; the end leads on to the next level ready
// in this language, and always to the game.
const pad2 = (n: number) => String(n).padStart(2, '0');

function BlockView({ block, lang, figNo }: { block: Block; lang: string; figNo: number }) {
  if ('p' in block) {
    return (
      <p className="article-p">
        <Rich text={block.p} />
      </p>
    );
  }
  if ('quote' in block) {
    return (
      <blockquote className="article-quote">
        <p>
          <Rich text={block.quote} />
        </p>
      </blockquote>
    );
  }
  if ('sentence' in block) {
    return (
      <div className="article-sentence ar-sentence">
        {block.sentence.map((line) => (
          <p key={line}>
            <Rich text={line} mode="sentence" />
          </p>
        ))}
      </div>
    );
  }
  if ('code' in block) {
    return (
      <pre className="article-code">
        <code>{block.code.join('\n')}</code>
      </pre>
    );
  }
  if ('terms' in block) {
    return (
      <dl className="article-terms">
        {block.terms.map(([term, text]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>
              <Rich text={text} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  if ('steps' in block) {
    return (
      <ol className="article-steps">
        {block.steps.map((step) => (
          <li key={step}>
            <Rich text={step} />
          </li>
        ))}
      </ol>
    );
  }
  return (
    <figure className="ar-fig">
      <div className="ar-fig-body">
        <FigureBody lang={lang} fig={block.fig} />
      </div>
      <figcaption className="ar-fig-caption">
        <span className="ar-fig-no">{`${t(lang, 'levelFigure')} ${pad2(figNo)}`}</span>{' '}
        <Rich text={block.caption} />
      </figcaption>
    </figure>
  );
}

export default function ArticleLevel({ lang, level }: { lang: LangCode; level: number }) {
  const meta = levelOf(level);
  const article = articleFor(lang, level);
  const markLessonDone = useGameStore((s) => s.markLessonDone);
  const scroller = useRef<HTMLElement>(null);
  const end = useRef<HTMLElement>(null);
  const read = useSeen(end, '0px');

  useEffect(() => {
    if (read) markLessonDone(level);
  }, [read, level, markLessonDone]);
  // A new level opens at its top: the phone's page scrolls as a whole, and navigating keeps
  // its offset otherwise (routing.ts resets nothing). The article is a focusable scroller (a
  // wide screen scrolls it, not the page), and a player who came by the KEYBOARD — a card or
  // NEXT LEVEL pressed with Enter — lands in it, so the arrows scroll the text at once.
  useEffect(() => {
    window.scrollTo(0, 0);
    scroller.current?.scrollTo(0, 0);
    if (keyboardLast()) scroller.current?.focus({ preventScroll: true });
  }, [level]);

  if (!meta || !article) return null;
  const seconds = meta.duration[lang];
  const next = nextReady(level, lang);
  let figures = 0;
  let cues = 0;

  return (
    <>
      <HeaderLeft>
        <LangTitle lang={lang} title={t(lang, meta.titleKey)} to={(picked) => pathForLesson(picked, level)} />
      </HeaderLeft>
      <ArticleLang.Provider value={lang}>
      <article
        ref={scroller}
        className="article-screen pixel-scroll"
        tabIndex={0}
        aria-labelledby="article-title"
      >
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
            {seconds !== undefined && (
              <li>
                <Duration lang={lang} seconds={seconds} />
              </li>
            )}
            <li>{t(lang, 'levelOf').replace('{n}', String(level)).replace('{total}', String(LEVELS.length))}</li>
          </ul>
          <p className="article-lead">
            <Rich text={article.lead} />
          </p>
        </header>
        {article.sections.map((section, i) => (
          // eslint-disable-next-line react/no-array-index-key -- static per article
          <section key={i} className="article-section">
            {section.heading && (
              <h2 className="article-heading">
                <span className="article-cue" aria-hidden="true">
                  {pad2((cues += 1))}
                </span>
                {section.heading}
              </h2>
            )}
            {section.blocks.map((block, j) => (
              // eslint-disable-next-line react/no-array-index-key -- static per article
              <BlockView key={j} block={block} lang={lang} figNo={'fig' in block ? (figures += 1) : 0} />
            ))}
          </section>
        ))}
        <footer ref={end} className="article-end">
          {next && (
            <button type="button" className="article-next" onClick={() => navigate(pathForLesson(lang, next.level))}>
              <LevelArt name={next.art} className="article-next-art" />
              <span className="article-next-text">
                <span className="article-next-label">{t(lang, 'levelNext')}</span>
                <span className="article-next-title">
                  <span className="article-next-no">{pad2(next.level)}</span>
                  {t(lang, next.titleKey)}
                </span>
                <span className="article-next-sub">{t(lang, next.subKey)}</span>
              </span>
            </button>
          )}
          <Button variant={next ? 'secondary' : 'primary'} className="article-play" onClick={() => navigate(pathForGame(lang))}>
            {t(lang, 'tutPlay')}
          </Button>
          {article.source && (
            <p className="article-source">
              <span className="article-source-label">{t(lang, 'levelSource')}</span>
              <a href={article.source.href} target="_blank" rel="noopener noreferrer">
                {article.source.text}
              </a>
            </p>
          )}
        </footer>
      </article>
      </ArticleLang.Provider>
    </>
  );
}
