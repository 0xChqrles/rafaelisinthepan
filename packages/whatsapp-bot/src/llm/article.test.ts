import { describe, expect, it } from 'vitest';
import { ARTICLE_URL, articleSection, withArticleLink } from './article';

describe("the maker's article is the bot's bible, and its link gets its card (2026-09-27)", () => {
  it('rewrites the link in any spelling a model types to the one URL, and names it as the card', () => {
    for (const typed of ['https://chqrles.me/cemantix/', 'https://chqrles.me/cemantix', 'chqrles.me/cemantix', 'http://www.chqrles.me/cemantix/', 'HTTPS://CHQRLES.ME/cemantix']) {
      expect(withArticleLink(`Lis ça : ${typed}. Tout y est.`)).toEqual({ text: `Lis ça : ${ARTICLE_URL}. Tout y est.`, preview: ARTICLE_URL });
    }
  });

  it('gives no card to a reply without it, nor to another page of the site', () => {
    expect(withArticleLink('Demande à Charles.')).toEqual({ text: 'Demande à Charles.' });
    expect(withArticleLink('https://chqrles.me/cemantix/autre')).toEqual({ text: 'https://chqrles.me/cemantix/autre' });
    expect(withArticleLink('https://chqrles.me/')).toEqual({ text: 'https://chqrles.me/' });
  });

  it('carries the whole text and the link the card is built for', () => {
    const section = articleSection();
    expect(section).toContain(ARTICLE_URL);
    expect(section).toContain('Alors merci Cémantix.'); // the last line: the text is whole
  });
});
