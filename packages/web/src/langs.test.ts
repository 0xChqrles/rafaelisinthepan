// CONTRACT: the /<lang> deep-link routing (packages/web/src/langs.ts). A language is
// one path segment; / (or any unknown path) is the picker. langFromPath/pathForLang
// round-trip so a shared link or refresh lands in the right language.

import { describe, it, expect } from 'vitest';
import { isLang, langFromPath, pathForLang, LANGS } from './langs';

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
