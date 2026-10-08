import { describe, expect, it } from 'vitest';
import { capitalize, capitals, sentenceStarts } from './sentenceCase';

describe('sentence case (a display rule over the lowercased words[])', () => {
  it('opens on the first token and after every sentence-final mark', () => {
    const words = ['il', 's’appliquait', 'aux', 'verbes.', 'sa', 'prose', 'était', 'nulle…', 'et', 'vraiment', '!', 'oui'];
    expect(sentenceStarts(words)).toEqual([
      true, false, false, false, true, false, false, false, true, false, false, true,
    ]);
  });

  it('passes the opening through a token with no letter, and reads a closing mark as the end', () => {
    // « and » are tokens of their own: neither can wear a capital, so it moves on.
    expect(sentenceStarts(['«', 'partez.', '»', 'elle', 'resta.', 'puis'])).toEqual([
      true, true, true, true, false, true,
    ]);
    expect(sentenceStarts(['(fini.)', 'donc'])).toEqual([true, true]);
    expect(sentenceStarts(['—', 'non.', 'jamais'])).toEqual([true, true, true]);
  });

  it('capitalizes the English pronoun I wherever it stands, and only in English', () => {
    const words = ['and', 'i', 'said', 'i’m', 'tired,', '"i', 'know', 'it', 'is', 'in', 'italy', 'i,'];
    expect(capitals(words, 'en')).toEqual([
      true, true, false, true, false, true, false, false, false, false, false, true,
    ]);
    expect(capitals(["i'd", 'go'], 'en')).toEqual([true, false]);
    // French's lone « i » is the letter: « les points sur les i ».
    expect(capitals(['les', 'points', 'sur', 'les', 'i.', 'puis'], 'fr')).toEqual(
      sentenceStarts(['les', 'points', 'sur', 'les', 'i.', 'puis']),
    );
    expect(['i', 'i’m', '"i', 'i,'].map(capitalize)).toEqual(['I', 'I’m', '"I', 'I,']);
  });

  it('lands the capital on the first letter, past an opening quote, with French accents', () => {
    expect(capitalize('ils')).toBe('Ils');
    expect(capitalize('été')).toBe('Été');
    expect(capitalize('«ils')).toBe('«Ils');
    expect(capitalize('"famille"')).toBe('"Famille"');
    expect(capitalize('t’')).toBe('T’');
    expect(capitalize('…')).toBe('…');
    expect(capitalize('')).toBe('');
  });
});
