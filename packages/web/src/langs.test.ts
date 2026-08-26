// CONTRACT: the /<lang> deep-link routing (packages/web/src/langs.ts). A language is
// one path segment; /select is the picker; / (or any unknown path) is a `home`
// redirect to the user's language. parseRoute and the pathFor* builders round-trip, so a
// shared link or a refresh lands in the right language AND the right mode.

import { describe, it, expect } from 'vitest';
import { inviteLandingPath } from '@whippin/shared';
import {
  ACCOUNT_EMAIL_PATH,
  ACCOUNT_PATH,
  PROFILE_PATH,
  isLang,
  pathForMode,
  pathForArchive,
  pathForBoard,
  pathForDay,
  pathForInvite,
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

describe('parseRoute', () => {
  it('routes /<lang> to the game for that language', () => {
    expect(parseRoute('/fr')).toEqual({ view: 'game', lang: 'fr', mode: 'sentence' });
    expect(parseRoute('/en')).toEqual({ view: 'game', lang: 'en', mode: 'sentence' });
    expect(parseRoute('/fr/')).toEqual({ view: 'game', lang: 'fr', mode: 'sentence' });
  });
  it('routes /select to the language picker', () => {
    expect(parseRoute('/select')).toEqual({ view: 'select' });
    expect(parseRoute('/select/')).toEqual({ view: 'select' });
  });
  // The #189 invite link is a bearer "add me" token in a path segment, so the id is
  // validated HERE: a mistyped or truncated link must go home rather than send the
  // server an id nobody can hold.
  //
  // The SHARED link stays `/i/<publicId>` and is served by the BACKEND (it renders the
  // preview and bounces here), so what the SPA routes is the LANDING `/join/<publicId>`.
  // The two spellings live in `shared/invite.ts` precisely because this file and the
  // backend's redirect have to name the same path.
  it('routes /join/<publicId> to the invite landing, and a broken one home', () => {
    const id = 'abcdefghij234567';
    expect(pathForInvite(id)).toBe(`/i/${id}`);
    expect(inviteLandingPath(id)).toBe(`/join/${id}`);
    expect(parseRoute(inviteLandingPath(id))).toEqual({ view: 'invite', publicId: id });
    expect(parseRoute(`/join/${id}/`)).toEqual({ view: 'invite', publicId: id });
    expect(parseRoute('/join')).toEqual({ view: 'home' });
    expect(parseRoute('/join/nope')).toEqual({ view: 'home' });
    // base32 has no 0/1/8/9, and the id is exactly 16 characters.
    expect(parseRoute('/join/abcdefghij234560')).toEqual({ view: 'home' });
    expect(parseRoute(`/join/${id}x`)).toEqual({ view: 'home' });
    // The shared link itself never reaches the SPA in production (CloudFront hands
    // `/i/*` to the API), and it must not be a second spelling of the landing here.
    expect(parseRoute(pathForInvite(id))).toEqual({ view: 'home' });
  });
  // The two choosers sit ABOVE /<lang>: neither is language- or mode-scoped, and /mode
  // must never be read as a language segment or shadow Word mode's /<lang>/word.
  it('routes /mode to the game-mode picker, without touching the mode grammar', () => {
    // The /mode chooser was retired 2026-08-18 for the header's mode tabs: the old
    // route is an unknown path now, and unknown paths go home.
    expect(parseRoute('/mode')).toEqual({ view: 'home' });
    expect(parseRoute('/mode/')).toEqual({ view: 'home' });
    expect(parseRoute('/fr/word')).toEqual({ view: 'game', lang: 'fr', mode: 'word' });
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
    expect(parseRoute('/fr/archive')).toEqual({ view: 'archive', lang: 'fr', mode: 'sentence' });
    expect(parseRoute('/en/archive/')).toEqual({ view: 'archive', lang: 'en', mode: 'sentence' });
  });

  it('routes /<lang>/<YYYY-MM-DD> in range to that day’s game', () => {
    expect(parseRoute('/fr/2026-06-12', bounds)).toEqual({
      view: 'game',
      lang: 'fr',
      mode: 'sentence',
      date: '2026-06-12',
    });
    // The active day itself is a valid (shareable) dated URL.
    expect(parseRoute('/en/2026-06-30', bounds)).toEqual({
      view: 'game',
      lang: 'en',
      mode: 'sentence',
      date: '2026-06-30',
    });
  });

  it('treats malformed / impossible dates as unknown -> home', () => {
    expect(parseRoute('/fr/2026-13-40', bounds)).toEqual({ view: 'home' }); // no month 13
    expect(parseRoute('/fr/2026-02-30', bounds)).toEqual({ view: 'home' }); // no Feb 30
    expect(parseRoute('/fr/2026-6-1', bounds)).toEqual({ view: 'game', lang: 'fr', mode: 'sentence' }); // not \d{4}-\d{2}-\d{2}: tolerated -> today
  });

  it('treats a real date outside [firstDate, activeDate] as unknown -> home', () => {
    expect(parseRoute('/fr/2025-12-31', bounds)).toEqual({ view: 'home' }); // before first
    expect(parseRoute('/fr/2026-07-01', bounds)).toEqual({ view: 'home' }); // after active day
  });

  it('skips the future bound when no activeDate is supplied', () => {
    expect(parseRoute('/fr/2999-01-01', { firstDate: '2026-01-01' })).toEqual({
      view: 'game',
      lang: 'fr',
      mode: 'sentence',
      date: '2999-01-01',
    });
  });

  it('keeps /<lang> (no second segment) as today’s game', () => {
    expect(parseRoute('/fr', bounds)).toEqual({ view: 'game', lang: 'fr', mode: 'sentence' });
  });
});

describe('parseRoute — Word mode grammar (#156): /<lang>/word[/…]', () => {
  const bounds = { firstDate: '2026-01-01', activeDate: '2026-06-30' };

  it('routes /<lang>/word to today\'s word game', () => {
    expect(parseRoute('/fr/word')).toEqual({ view: 'game', lang: 'fr', mode: 'word' });
    expect(parseRoute('/en/word/')).toEqual({ view: 'game', lang: 'en', mode: 'word' });
  });

  it('routes /<lang>/word/archive to the word-mode calendar', () => {
    expect(parseRoute('/fr/word/archive')).toEqual({ view: 'archive', lang: 'fr', mode: 'word' });
  });

  it('routes /<lang>/word/<date> in range to that day\'s word game', () => {
    expect(parseRoute('/fr/word/2026-06-12', bounds)).toEqual({
      view: 'game',
      lang: 'fr',
      mode: 'word',
      date: '2026-06-12',
    });
  });

  it('applies the SAME date rules as the sentence grammar', () => {
    expect(parseRoute('/fr/word/2026-02-30', bounds)).toEqual({ view: 'home' }); // no Feb 30
    expect(parseRoute('/fr/word/2025-12-31', bounds)).toEqual({ view: 'home' }); // before first
    expect(parseRoute('/fr/word/2026-07-01', bounds)).toEqual({ view: 'home' }); // after active
    // Non-date third segment keeps the tolerance -> today's word.
    expect(parseRoute('/fr/word/xyz', bounds)).toEqual({ view: 'game', lang: 'fr', mode: 'word' });
  });
});

describe('pathForArchive / pathForDay', () => {
  it('builds the archive + dated paths, / for an unknown lang', () => {
    expect(pathForArchive('fr')).toBe('/fr/archive');
    expect(pathForArchive('de')).toBe('/');
    expect(pathForDay('en', '2026-06-12')).toBe('/en/2026-06-12');
    expect(pathForDay(null, '2026-06-12')).toBe('/');
  });
  it('builds the Word mode paths (#156), round-tripping through parseRoute', () => {
    expect(pathForMode('fr', 'word')).toBe('/fr/word');
    expect(pathForMode('fr', 'sentence')).toBe('/fr');
    expect(pathForArchive('fr', 'word')).toBe('/fr/word/archive');
    expect(pathForDay('fr', '2026-06-12', 'word')).toBe('/fr/word/2026-06-12');
    const bounds = { firstDate: '2026-01-01', activeDate: '2026-12-31' };
    expect(parseRoute(pathForDay('fr', '2026-06-12', 'word'), bounds)).toEqual({
      view: 'game',
      lang: 'fr',
      mode: 'word',
      date: '2026-06-12',
    });
    expect(parseRoute(pathForMode('en', 'word'))).toEqual({
      view: 'game',
      lang: 'en',
      mode: 'word',
    });
  });
  it('pathForDay round-trips through parseRoute for an in-range date', () => {
    const bounds = { firstDate: '2026-01-01', activeDate: '2026-12-31' };
    expect(parseRoute(pathForDay('fr', '2026-06-12'), bounds)).toEqual({
      view: 'game',
      lang: 'fr',
      mode: 'sentence',
      date: '2026-06-12',
    });
  });
});

describe('leaderboard routes (#190)', () => {
  it('routes /<lang>/board and /<lang>/word/board to that daily\'s leaderboard', () => {
    expect(parseRoute('/fr/board')).toEqual({ view: 'board', lang: 'fr', mode: 'sentence' });
    expect(parseRoute('/en/board/')).toEqual({ view: 'board', lang: 'en', mode: 'sentence' });
    expect(parseRoute('/fr/word/board')).toEqual({ view: 'board', lang: 'fr', mode: 'word' });
  });
  it('pathForBoard round-trips through parseRoute, / for an unknown lang', () => {
    expect(pathForBoard('fr')).toBe('/fr/board');
    expect(pathForBoard('en', 'word')).toBe('/en/word/board');
    expect(pathForBoard('de')).toBe('/');
    expect(parseRoute(pathForBoard('en', 'word'))).toEqual({
      view: 'board',
      lang: 'en',
      mode: 'word',
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

// CONTRACT (#204's UX rework): the ACCOUNT AREA is three global routes, because it answers
// three different questions and one screen may only answer one. They sit above /<lang> like
// /select — an identity is not language-scoped — and the email step is one segment deeper
// than the account itself, which is what makes RECONNECT able to land straight on it.
describe('account routes (#204)', () => {
  it('parses the account screen and its email step as distinct global routes', () => {
    expect(parseRoute('/account')).toEqual({ view: 'account' });
    expect(parseRoute('/account/email')).toEqual({ view: 'accountEmail' });
    // The editor keeps its own route: it answers "how do others see me", which is neither.
    expect(parseRoute('/profile')).toEqual({ view: 'profile' });
  });

  it('keeps the game routes\' tolerance for an unknown step', () => {
    // The area's own entry, never a bounce home — the same treatment /<lang>/xyz gets.
    expect(parseRoute('/account/nonsense')).toEqual({ view: 'account' });
    expect(parseRoute('/account/')).toEqual({ view: 'account' });
  });

  it('is not language-scoped — a lang prefix is a GAME route, not an account one', () => {
    expect(parseRoute('/fr/account')).toEqual({ view: 'game', lang: 'fr', mode: 'sentence' });
  });

  it('states its paths once, so every caller navigates to the same place', () => {
    expect(parseRoute(ACCOUNT_PATH)).toEqual({ view: 'account' });
    expect(parseRoute(ACCOUNT_EMAIL_PATH)).toEqual({ view: 'accountEmail' });
    expect(parseRoute(PROFILE_PATH)).toEqual({ view: 'profile' });
  });
});
