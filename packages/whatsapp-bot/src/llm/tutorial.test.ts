import { TUTORIAL_LEVELS } from '@whippin/shared';
import { describe, expect, it } from 'vitest';
import { LEVEL_ANSWERS, tutorialSection, withTutorialLink } from './tutorial';

const SITE = 'https://whippin.ai';

describe("the tutorial's levels, as the conversation links them (2026-10-02)", () => {
  it('says what every level of the shared table answers', () => {
    for (const level of TUTORIAL_LEVELS) expect(LEVEL_ANSWERS[level.level], `level ${level.level}`).toBeTruthy();
  });

  it("links each level in the group's language, else where it is written, saying so", () => {
    const fr = tutorialSection(SITE, 'fr');
    for (const level of TUTORIAL_LEVELS) expect(fr).toContain(`${SITE}/fr/learn/${level.level}\n`);
    expect(fr).toContain(`${SITE}/fr/learn\n`);
    const en = tutorialSection(SITE, 'en');
    for (const level of TUTORIAL_LEVELS) expect(en).toContain(`${SITE}/en/learn/${level.level}\n`);
    expect(en).not.toContain('(in French)');
    expect(en).toContain(`${SITE}/en/learn\n`);
  });

  it('rewrites a typed link to the canonical URL, and the first names the card', () => {
    for (const typed of ['whippin.ai/fr/learn/3', 'https://whippin.ai/fr/learn/3/', 'www.whippin.ai/FR/learn/3', 'http://whippin.ai/fr/learn/3']) {
      expect(withTutorialLink(`Lis ça : ${typed}. Voilà.`, SITE)).toEqual({ text: `Lis ça : ${SITE}/fr/learn/3. Voilà.`, preview: `${SITE}/fr/learn/3` });
    }
    expect(withTutorialLink('whippin.ai/fr/learn puis whippin.ai/fr/learn/2', SITE)).toEqual({
      text: `${SITE}/fr/learn puis ${SITE}/fr/learn/2`,
      preview: `${SITE}/fr/learn`,
    });
  });

  it('leaves alone, with no card, a page the shared table does not hold and any other link', () => {
    for (const text of [
      'https://whippin.ai/fr/learn/9', // no such level
      'https://whippin.ai/de/learn', // no tutorial in German
      'https://whippin.ai/fr/learn/2/more', // a longer path
      'https://whippin.ai/fr/board',
      'https://evil.example/fr/learn/2',
      'Demande à Charles.',
    ]) {
      expect(withTutorialLink(text, SITE)).toEqual({ text });
    }
  });
});
