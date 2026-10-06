// CONTRACT: what a shared link unfurls as (src/linkPreviews.ts). The tutorial's list and every
// level ready in a language are built as pages of their own (vite.config.ts) and served under
// their routes (infra web-stack.ts); each wears its own card, title and words. A level not
// ready in a language has no page — its route lands on the list, and so does its preview.

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LANGS, pathForLearn, pathForLesson } from './langs';
import { HOME_PREVIEW, SITE_ORIGIN, pagePreviews, previewTags } from './linkPreviews';
import { LEVELS, isReady } from './tutorial/levels';

const pages = pagePreviews();
const at = (path: string) => pages.find((page) => page.path === path);
const pictureExists = (image: string) => existsSync(new URL(`./assets/previews/${image}`, import.meta.url));

describe('link previews', () => {
  it('gives the tutorial list its own page in every language', () => {
    for (const { code } of LANGS) {
      expect(at(pathForLearn(code)), code).toMatchObject({ lang: code, image: `learn-${code}.png` });
    }
  });

  it('gives a page to every level ready in a language, and none to a level that is not', () => {
    for (const { code } of LANGS) {
      for (const level of LEVELS) {
        const page = at(pathForLesson(code, level.level));
        if (isReady(level, code)) {
          expect(page, `${code} ${level.level}`).toMatchObject({ lang: code, image: `learn-${code}-${level.level}.png` });
        } else {
          expect(page, `${code} ${level.level}`).toBeUndefined();
        }
      }
    }
  });

  it("names a level in its own words: its title, what it is about, its place, and an article's length", () => {
    expect(at('/fr/learn/2')).toMatchObject({
      title: 'La distance — Whippin AI',
      description: 'Des mots en coordonnées. Niveau 2 sur 5 · 3′40″',
    });
    // The played level is untimed: no length, never a NaN′NaN″ printed off its null.
    expect(at('/en/learn/1')).toMatchObject({ description: 'Guess the secret words. Level 1 of 5' });
    expect(at('/fr/learn/1')).toMatchObject({ description: 'Deviner les mots secrets. Niveau 1 sur 5' });
    expect(at('/fr/learn')).toMatchObject({
      title: 'Tutoriel — Whippin AI',
      description: 'Le jeu · La distance · Plusieurs sens · L’attention · Le juge',
    });
  });

  // Committed for EVERY level in every language, ready or not, so a level becoming ready in a
  // language already has its card — the build fails on a page whose picture is missing.
  it('has a picture for the home, every list and every level in every language', () => {
    expect(pictureExists(HOME_PREVIEW.image)).toBe(true);
    for (const { code } of LANGS) {
      expect(pictureExists(`learn-${code}.png`), code).toBe(true);
      for (const level of LEVELS) {
        expect(pictureExists(`learn-${code}-${level.level}.png`), `${code} ${level.level}`).toBe(true);
      }
    }
    for (const page of pages) expect(pictureExists(page.image), page.path).toBe(true);
  });

  it('writes each tag once, with absolute URLs and escaped values', () => {
    const image = `${SITE_ORIGIN}/assets/x.png`;
    const tags = previewTags({ ...at('/fr/learn/2')!, title: 'A "quoted" & <odd> title' }, image);
    for (const key of [
      'name="description"',
      'rel="canonical"',
      'property="og:title"',
      'property="og:description"',
      'property="og:image"',
      'property="og:image:alt"',
      'property="og:url"',
      'property="og:locale"',
      'name="twitter:card"',
      'name="twitter:title"',
      'name="twitter:image"',
    ]) {
      expect(tags.split(`${key} `).length - 1, key).toBe(1);
    }
    expect(tags).toContain(`<meta property="og:image" content="${image}" />`);
    expect(tags).toContain('<meta property="og:url" content="https://whippin.ai/fr/learn/2" />');
    expect(tags).toContain('<meta property="og:locale" content="fr_FR" />');
    expect(tags).toContain('content="A &quot;quoted&quot; &amp; &lt;odd> title"');
    expect(previewTags(HOME_PREVIEW, image)).toContain('<link rel="canonical" href="https://whippin.ai/" />');
  });
});
