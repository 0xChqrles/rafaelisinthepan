import { t } from './i18n';
import { LANGS, pathForLearn, pathForLesson } from './langs';
import { LEVELS, formatDuration, isReady } from './tutorial/levels';

// WHAT A SHARED LINK UNFURLS AS. A chat app reads a link's preview off the page's own HTML and
// runs no JavaScript, so every page that has a preview of its own is BUILT as one: the build
// (vite.config.ts) writes the shell once per page below, each with its own head block, and
// the CDN serves a route the nearest page built at or above it (infra web-stack.ts). Every
// route with none is the one shell, wearing the HOME preview.
//
// The pages with their own preview are the TUTORIAL's: its list, and each level ready in a
// language — a level is a thing worth sending somebody, and the game's general card says
// nothing about it. Their words are the app's own strings (the levels' titles and what they
// are about, an article's reading time), nothing written for a preview alone; HOME keeps the
// site's own sentence.
//
// The pictures are committed PNGs in `assets/previews/`, 1200×630, drawn from the app's own
// scenes, inks and fonts. The build emits them as HASHED assets, so a redrawn picture is a new
// URL — chat apps cache a preview image by its URL, and would otherwise keep the old one.
export const SITE_ORIGIN = 'https://whippin.ai';
export const SITE_NAME = 'Whippin AI';

export interface LinkPreview {
  path: string;
  lang: string;
  title: string;
  description: string;
  // The picture's file name in `src/assets/previews/`.
  image: string;
  alt: string;
}

// A title in sentence case: the chrome's ALL-CAPS strings, as a sentence reads them.
function sentence(text: string, lang: string): string {
  const lower = text.toLocaleLowerCase(lang);
  return lower.charAt(0).toLocaleUpperCase(lang) + lower.slice(1);
}

const titled = (title: string) => `${title} — ${SITE_NAME}`;

export const HOME_PREVIEW: LinkPreview = {
  path: '/',
  lang: 'en',
  title: SITE_NAME,
  description: 'One sentence a day, three words missing. Every guess tells you how close you are.',
  image: 'whippin.png',
  alt: `${SITE_NAME}: a sentence with a hidden word, and guesses placed around it by how close they are`,
};

// The pages built with a preview of their own: the tutorial's list in every language, and
// every level ready in it.
export function pagePreviews(): LinkPreview[] {
  return LANGS.flatMap(({ code: lang }) => {
    const titles = LEVELS.map((level) => sentence(t(lang, level.titleKey), lang)).join(' · ');
    const list: LinkPreview = {
      path: pathForLearn(lang),
      lang,
      title: titled(sentence(t(lang, 'learnTitle'), lang)),
      description: titles,
      image: `learn-${lang}.png`,
      alt: `${t(lang, 'learnTitle')} — ${titles}`,
    };
    const levels = LEVELS.filter((level) => isReady(level, lang)).map((level): LinkPreview => {
      const of = t(lang, 'levelOf').replace('{n}', String(level.level)).replace('{total}', String(LEVELS.length));
      const sub = t(lang, level.subKey);
      // An article's reading time, when it has one: the played level is untimed (null), and a
      // `!` here would let that null through as NaN′NaN″ — it strips null too.
      const seconds = level.duration[lang];
      return {
        path: pathForLesson(lang, level.level),
        lang,
        title: titled(sentence(t(lang, level.titleKey), lang)),
        description:
          seconds == null
            ? `${sub}. ${sentence(of, lang)}`
            : `${sub}. ${sentence(of, lang)} · ${formatDuration(seconds)}`,
        image: `learn-${lang}-${level.level}.png`,
        alt: `${t(lang, level.titleKey)} — ${sub}`,
      };
    });
    return [list, ...levels];
  });
}

const OG_LOCALE: Record<string, string> = { en: 'en_US', fr: 'fr_FR' };

const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// The head block a page wears: its description, its canonical URL and its card for every
// reader that unfurls a link (Open Graph, and Twitter's own names). `imageUrl` is absolute —
// a crawler resolves nothing.
export function previewTags(preview: LinkPreview, imageUrl: string): string {
  const url = `${SITE_ORIGIN}${preview.path}`;
  const meta = (key: 'name' | 'property', name: string, content: string) =>
    `<meta ${key}="${name}" content="${attr(content)}" />`;
  return [
    meta('name', 'description', preview.description),
    `<link rel="canonical" href="${attr(url)}" />`,
    meta('property', 'og:title', preview.title),
    meta('property', 'og:description', preview.description),
    meta('property', 'og:image', imageUrl),
    meta('property', 'og:image:type', 'image/png'),
    meta('property', 'og:image:width', '1200'),
    meta('property', 'og:image:height', '630'),
    meta('property', 'og:image:alt', preview.alt),
    meta('property', 'og:url', url),
    meta('property', 'og:type', 'website'),
    meta('property', 'og:site_name', SITE_NAME),
    meta('property', 'og:locale', OG_LOCALE[preview.lang]),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:title', preview.title),
    meta('name', 'twitter:description', preview.description),
    meta('name', 'twitter:image', imageUrl),
    meta('name', 'twitter:image:alt', preview.alt),
  ].join('\n    ');
}
