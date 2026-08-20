// CONTRACT (#200): the generated vocab metadata describes the COMMITTED existence sets.
//
// Generation writes both in one call, so they leave the pipeline in agreement — this is
// the alarm for the other direction: a set committed without its metadata (an old
// generation script, a hand-edit, a half-applied merge) would leave the backend bounding
// scores and guesses by a vocabulary that is no longer the one the client loads.
import { describe, expect, it } from 'vitest';
import enVocab from '../../web/public/vocab/en.json';
import frVocab from '../../web/public/vocab/fr.json';
import { VOCAB_BUILDS } from './vocab';

const SETS: Record<string, string[]> = { en: enVocab, fr: frVocab };

describe('vocab metadata (#200)', () => {
  it('covers exactly the languages that ship an existence set', () => {
    expect(Object.keys(VOCAB_BUILDS).sort()).toEqual(Object.keys(SETS).sort());
  });

  for (const [lang, set] of Object.entries(SETS)) {
    it(`measures the committed ${lang} set`, () => {
      const build = VOCAB_BUILDS[lang];
      expect(build.vocabSize).toBe(set.length);
      // Folded, not spread: a 128k-argument Math.max blows the call stack.
      expect(build.maxSlugLength).toBe(set.reduce((max, s) => Math.max(max, s.length), 0));
    });
  }

  it('names the corpus build each set came from', () => {
    // Not "the file": the raw source and its _reduced output answer the same name, so the
    // record cannot depend on which command last refreshed the set.
    expect(VOCAB_BUILDS.en.embedding).toBe('glove.6B.300d');
    expect(VOCAB_BUILDS.fr.embedding).toBe('cc.fr.300');
    for (const build of Object.values(VOCAB_BUILDS)) {
      expect(build.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
