import { describe, expect, it } from 'vitest';
import { capitalize, sentenceStarts } from './sentenceCase';

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
