// CONTRACT: the /<lang> deep-link routing (packages/web/src/langs.ts). A language is
// one path segment; /select is the picker; / (or any unknown path) is a `home`
// redirect to the user's language. langFromPath/pathForLang round-trip so a shared link
// or refresh lands in the right language.

import { describe, it, expect } from 'vitest';
import {
  isLang,
  langFromPath,
  pathForLang,
  parseRoute,
  resolveHomeLang,
  LANGS,
} from './langs';

describe('isLang', () => {
  it('accepts supported codes, rejects everything else', () => {
    expect(isLang('fr')).toBe(true);
    expect(isLang('en')).toBe(true);
    expect(isLang('de')).toBe(false);
    expect(isLang('')).toBe(false);
    expect(isLang(null)).toBe(false);
    expect(isLang(undefined)).toBe(false);
  });
});

describe('langFromPath', () => {
  it('reads the language from the first path segment', () => {
    expect(langFromPath('/fr')).toBe('fr');
    expect(langFromPath('/en')).toBe('en');
  });
  it('tolerates trailing slashes and extra segments', () => {
    expect(langFromPath('/fr/')).toBe('fr');
    expect(langFromPath('/en/whatever')).toBe('en');
  });
  it('returns null for the root and unknown languages', () => {
    expect(langFromPath('/')).toBeNull();
    expect(langFromPath('')).toBeNull();
    expect(langFromPath('/de')).toBeNull();
    expect(langFromPath('/vocab')).toBeNull();
  });
});

describe('pathForLang', () => {
  it('maps a language to /<lang> and the picker to /', () => {
    expect(pathForLang('fr')).toBe('/fr');
    expect(pathForLang('en')).toBe('/en');
    expect(pathForLang(null)).toBe('/');
    expect(pathForLang('de')).toBe('/'); // unknown -> picker
  });
  it('round-trips every supported language', () => {
    for (const { code } of LANGS) {
      expect(langFromPath(pathForLang(code))).toBe(code);
    }
  });
});

describe('parseRoute', () => {
  it('routes /<lang> to the game for that language', () => {
    expect(parseRoute('/fr')).toEqual({ view: 'game', lang: 'fr' });
    expect(parseRoute('/en')).toEqual({ view: 'game', lang: 'en' });
    expect(parseRoute('/fr/')).toEqual({ view: 'game', lang: 'fr' });
  });
  it('routes /select to the language picker', () => {
    expect(parseRoute('/select')).toEqual({ view: 'select' });
    expect(parseRoute('/select/')).toEqual({ view: 'select' });
  });
  it('treats / and unknown paths as a home redirect', () => {
    expect(parseRoute('/')).toEqual({ view: 'home' });
    expect(parseRoute('')).toEqual({ view: 'home' });
    expect(parseRoute('/de')).toEqual({ view: 'home' });
    expect(parseRoute('/vocab')).toEqual({ view: 'home' });
  });
});

describe('resolveHomeLang', () => {
  it('prefers a valid persisted language over the browser language', () => {
    expect(resolveHomeLang('fr', 'en-US')).toBe('fr');
    expect(resolveHomeLang('en', 'fr-FR')).toBe('en');
  });
  it('falls back to the browser language (fr* -> fr) when none is persisted', () => {
    expect(resolveHomeLang(null, 'fr-FR')).toBe('fr');
    expect(resolveHomeLang(null, 'FR')).toBe('fr');
    expect(resolveHomeLang(undefined, 'fr')).toBe('fr');
  });
  it('defaults to English for a non-fr browser or no signal', () => {
    expect(resolveHomeLang(null, 'en-GB')).toBe('en');
    expect(resolveHomeLang(null, 'de-DE')).toBe('en');
    expect(resolveHomeLang(null, undefined)).toBe('en');
    expect(resolveHomeLang('de', 'de-DE')).toBe('en'); // invalid persisted -> ignored
  });
});
