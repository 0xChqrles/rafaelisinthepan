// CONTRACT: the /<lang> deep-link routing (packages/web/src/langs.ts). A language is
// one path segment; /select is the picker; / (or any unknown path) is a `home`
// redirect to the user's language. langFromPath/pathForLang round-trip so a shared link
// or refresh lands in the right language.

import { describe, it, expect } from 'vitest';
import {
  isLang,
  langFromPath,
  pathForLang,
  pathForArchive,
  pathForDay,
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

describe('parseRoute — archive + past-day deep links (#55)', () => {
  // A wide, deterministic range so the shape/range logic is tested independently of the
  // launch FIRST_PUZZLE_DATE const.
  const bounds = { firstDate: '2026-01-01', activeDate: '2026-06-30' };

  it('routes /<lang>/archive to the calendar', () => {
    expect(parseRoute('/fr/archive')).toEqual({ view: 'archive', lang: 'fr' });
    expect(parseRoute('/en/archive/')).toEqual({ view: 'archive', lang: 'en' });
  });

  it('routes /<lang>/<YYYY-MM-DD> in range to that day’s game', () => {
    expect(parseRoute('/fr/2026-06-12', bounds)).toEqual({
      view: 'game',
      lang: 'fr',
      date: '2026-06-12',
    });
    // The active day itself is a valid (shareable) dated URL.
    expect(parseRoute('/en/2026-06-30', bounds)).toEqual({
      view: 'game',
      lang: 'en',
      date: '2026-06-30',
    });
  });

  it('treats malformed / impossible dates as unknown -> home', () => {
    expect(parseRoute('/fr/2026-13-40', bounds)).toEqual({ view: 'home' }); // no month 13
    expect(parseRoute('/fr/2026-02-30', bounds)).toEqual({ view: 'home' }); // no Feb 30
    expect(parseRoute('/fr/2026-6-1', bounds)).toEqual({ view: 'game', lang: 'fr' }); // not \d{4}-\d{2}-\d{2}: tolerated -> today
  });

  it('treats a real date outside [firstDate, activeDate] as unknown -> home', () => {
    expect(parseRoute('/fr/2025-12-31', bounds)).toEqual({ view: 'home' }); // before first
    expect(parseRoute('/fr/2026-07-01', bounds)).toEqual({ view: 'home' }); // after active day
  });

  it('skips the future bound when no activeDate is supplied', () => {
    expect(parseRoute('/fr/2999-01-01', { firstDate: '2026-01-01' })).toEqual({
      view: 'game',
      lang: 'fr',
      date: '2999-01-01',
    });
  });

  it('keeps /<lang> (no second segment) as today’s game', () => {
    expect(parseRoute('/fr', bounds)).toEqual({ view: 'game', lang: 'fr' });
  });
});

describe('pathForArchive / pathForDay', () => {
  it('builds the archive + dated paths, / for an unknown lang', () => {
    expect(pathForArchive('fr')).toBe('/fr/archive');
    expect(pathForArchive('de')).toBe('/');
    expect(pathForDay('en', '2026-06-12')).toBe('/en/2026-06-12');
    expect(pathForDay(null, '2026-06-12')).toBe('/');
  });
  it('pathForDay round-trips through parseRoute for an in-range date', () => {
    const bounds = { firstDate: '2026-01-01', activeDate: '2026-12-31' };
    expect(parseRoute(pathForDay('fr', '2026-06-12'), bounds)).toEqual({
      view: 'game',
      lang: 'fr',
      date: '2026-06-12',
    });
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
