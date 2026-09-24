// CONTRACT: the /<lang> deep-link routing (packages/web/src/langs.ts). A language is
// one path segment; / (or any unknown path) is a `home`
// redirect to the user's language. parseRoute and the pathFor* builders round-trip, so a
// shared link or a refresh lands in the right language.

import { describe, it, expect } from 'vitest';
import { groupLandingPath } from '@whippin/shared';
import {
  ACCOUNT_EMAIL_PATH,
  ACCOUNT_PATH,
  ACCOUNT_SIGNIN_PATH,
  PRIVACY_PATH,
  PROFILE_PATH,
  isLang,
  pathForGame,
  pathForArchive,
  pathForBoard,
  pathForDay,
  pathForGroupInvite,
  langFromSearch,
  parseRoute,
  resolveHomeLang,
  resolveUiLang,
  LANGS,
  pathForLearn,
  pathForLesson,
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
    expect(parseRoute('/fr')).toEqual({ view: 'game', lang: 'fr' });
    expect(parseRoute('/en')).toEqual({ view: 'game', lang: 'en' });
    expect(parseRoute('/fr/')).toEqual({ view: 'game', lang: 'fr' });
  });
  // The language chooser SCREEN was retired 2026-09-05 (the header's selection drums open
  // on every page), the way `/mode` was: an old link is a home redirect, never a screen.
  it('treats the retired /select like /mode: a home redirect', () => {
    expect(parseRoute('/select')).toEqual({ view: 'home' });
    expect(parseRoute('/select/')).toEqual({ view: 'home' });
  });
  // The #271 group invite link is a bearer "join us" token in a path segment, so the id is
  // validated HERE: a mistyped or truncated link must go home rather than send the
  // server an id nobody can hold.
  //
  // The SHARED link is `/g/<groupId>` and is served by the BACKEND (it renders the
  // preview and bounces here), so what the SPA routes is the LANDING `/join/g/<groupId>`.
  // The two spellings live in `shared/invite.ts` precisely because this file and the
  // backend's redirect have to name the same path.
  it('routes /join/g/<groupId> to the group landing, and a broken one home', () => {
    const id = 'abcdefghij234567';
    expect(pathForGroupInvite(id)).toBe(`/g/${id}`);
    expect(groupLandingPath(id)).toBe(`/join/g/${id}`);
    expect(parseRoute(groupLandingPath(id))).toEqual({ view: 'groupInvite', groupId: id });
    expect(parseRoute(`/join/g/${id}/`)).toEqual({ view: 'groupInvite', groupId: id });
    expect(parseRoute('/join')).toEqual({ view: 'home' });
    expect(parseRoute('/join/g')).toEqual({ view: 'home' });
    expect(parseRoute('/join/g/nope')).toEqual({ view: 'home' });
    // The retired player landing (`/join/<publicId>`) is a home redirect, not a screen.
    expect(parseRoute(`/join/${id}`)).toEqual({ view: 'home' });
    // base32 has no 0/1/8/9, and the id is exactly 16 characters.
    expect(parseRoute('/join/g/abcdefghij234560')).toEqual({ view: 'home' });
    expect(parseRoute(`/join/g/${id}x`)).toEqual({ view: 'home' });
    // The shared link itself never reaches the SPA in production (CloudFront hands
    // `/g/*` to the API), and it must not be a second spelling of the landing here.
    expect(parseRoute(pathForGroupInvite(id))).toEqual({ view: 'home' });
  });
  // The retired /mode chooser is an unknown path, and unknown paths go home.
  it('treats the retired /mode like any unknown path: a home redirect', () => {
    expect(parseRoute('/mode')).toEqual({ view: 'home' });
    expect(parseRoute('/mode/')).toEqual({ view: 'home' });
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
    expect(parseRoute('/fr/2026-07-02', bounds)).toEqual({ view: 'home' }); // two days past the active day
  });

  it('reaches ONE day past the active day — tomorrow\'s sentence, started tonight (#273)', () => {
    expect(parseRoute('/fr/2026-07-01', bounds)).toEqual({
      view: 'game',
      lang: 'fr',
      date: '2026-07-01',
    });
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

describe('parseRoute — a bonus puzzle (/<lang>/bonus/<id>)', () => {
  it('plays the bonus its seven-digit id names', () => {
    expect(parseRoute('/fr/bonus/1234567')).toEqual({ view: 'game', lang: 'fr', bonusId: 1234567 });
    expect(parseRoute('/en/bonus/9999999/')).toEqual({ view: 'game', lang: 'en', bonusId: 9999999 });
  });

  it('sends a broken bonus link home', () => {
    expect(parseRoute('/fr/bonus')).toEqual({ view: 'home' });
    expect(parseRoute('/fr/bonus/0123456')).toEqual({ view: 'home' });
    expect(parseRoute('/fr/bonus/123')).toEqual({ view: 'home' });
  });
});

describe('pathForArchive / pathForDay', () => {
  it('builds the archive + dated paths, / for an unknown lang', () => {
    expect(pathForArchive('fr')).toBe('/fr/archive');
    expect(pathForArchive('de')).toBe('/');
    expect(pathForDay('en', '2026-06-12')).toBe('/en/2026-06-12');
    expect(pathForDay(null, '2026-06-12')).toBe('/');
  });
  it('builds today\'s game path, round-tripping through parseRoute', () => {
    expect(pathForGame('fr')).toBe('/fr');
    expect(pathForGame('de')).toBe('/');
    expect(parseRoute(pathForGame('en'))).toEqual({ view: 'game', lang: 'en' });
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

describe('leaderboard routes (#190)', () => {
  it('routes /<lang>/board to the day\'s leaderboard', () => {
    expect(parseRoute('/fr/board')).toEqual({ view: 'board', lang: 'fr' });
    expect(parseRoute('/en/board/')).toEqual({ view: 'board', lang: 'en' });
  });
  it('pathForBoard round-trips through parseRoute, / for an unknown lang', () => {
    expect(pathForBoard('fr')).toBe('/fr/board');
    expect(pathForBoard('de')).toBe('/');
    expect(parseRoute(pathForBoard('en'))).toEqual({ view: 'board', lang: 'en' });
  });
});

describe('tutorial routes (#269)', () => {
  it('routes /<lang>/learn to the list and /<lang>/learn/<built level> to its lesson', () => {
    expect(parseRoute('/fr/learn')).toEqual({ view: 'learn', lang: 'fr' });
    expect(parseRoute('/en/learn/')).toEqual({ view: 'learn', lang: 'en' });
    expect(parseRoute('/en/learn/1')).toEqual({ view: 'lesson', lang: 'en', level: 1 });
  });
  it('lands a level that is not built, or not a level, on the list', () => {
    expect(parseRoute('/en/learn/2')).toEqual({ view: 'learn', lang: 'en' });
    expect(parseRoute('/en/learn/99')).toEqual({ view: 'learn', lang: 'en' });
    expect(parseRoute('/en/learn/x')).toEqual({ view: 'learn', lang: 'en' });
  });
  it('pathForLearn / pathForLesson round-trip through parseRoute, / for an unknown lang', () => {
    expect(pathForLearn('fr')).toBe('/fr/learn');
    expect(pathForLesson('fr', 1)).toBe('/fr/learn/1');
    expect(pathForLearn('de')).toBe('/');
    expect(pathForLesson('de', 1)).toBe('/');
    expect(parseRoute(pathForLesson('en', 1))).toEqual({ view: 'lesson', lang: 'en', level: 1 });
  });
});

// CONTRACT (2026-09-03): the chrome language of a screen whose URL does not name one has
// THREE sources, in order — the LINK's own `?lang=`, the stored preference, the browser.
// The parameter exists so a page can be SENT in a chosen language ("send the privacy policy
// in a specific language"), and it is app-wide rather than that page's alone.
describe('resolveUiLang', () => {
  it('lets the LINK speak first — over a stored preference and over the browser', () => {
    expect(resolveUiLang('?lang=en', 'fr', 'fr-FR')).toBe('en');
    expect(resolveUiLang('?lang=fr', 'en', 'en-US')).toBe('fr');
    // With other parameters beside it, and with none of its own.
    expect(resolveUiLang('?tutorial=1&lang=fr', 'en', 'en-US')).toBe('fr');
  });

  it('falls through to the stored preference, then the browser, then English', () => {
    expect(resolveUiLang('', 'fr', 'en-US')).toBe('fr');
    expect(resolveUiLang('', null, 'fr-FR')).toBe('fr');
    expect(resolveUiLang('', null, 'de-DE')).toBe('en');
  });

  it('ignores a parameter that names no supported language', () => {
    // A typo must not silently become English when the player has a stored French: it is
    // not a language this game has, so it says nothing at all.
    expect(resolveUiLang('?lang=de', 'fr', 'en-US')).toBe('fr');
    expect(resolveUiLang('?lang=', 'fr', 'en-US')).toBe('fr');
    expect(resolveUiLang('?lang=FR', 'en', 'en-US')).toBe('en');
  });
});

describe('langFromSearch', () => {
  it('reads only a supported language, and nothing else', () => {
    expect(langFromSearch('?lang=fr')).toBe('fr');
    expect(langFromSearch('?lang=en')).toBe('en');
    expect(langFromSearch('?lang=de')).toBe(null);
    expect(langFromSearch('')).toBe(null);
    expect(langFromSearch('?other=fr')).toBe(null);
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

// CONTRACT (#204's UX rework): the ACCOUNT AREA is FOUR global routes, because it answers
// four different questions and one screen may only answer one. They sit above /<lang> like
// /profile — an identity is not language-scoped — and the flow's steps are one segment deeper
// than the account itself, which is what makes RECONNECT able to land straight on one.
//
// TWO DOORS ONTO ONE ENGINE (vol. 2): `/account/email` SAVES the account this device holds
// and `/account/signin` gets ANOTHER one back. They mount the same screen and send the same
// requests — the server may not branch before the code is verified — so what the path
// carries is the player's declared INTENTION, which dresses the flow and routes nothing.
describe('account routes (#204)', () => {
  it('parses the account screen and its flow steps as distinct global routes', () => {
    expect(parseRoute('/account')).toEqual({ view: 'account' });
    expect(parseRoute('/account/email')).toEqual({ view: 'accountEmail', intent: 'save' });
    expect(parseRoute('/account/signin')).toEqual({ view: 'accountEmail', intent: 'return' });
    // The editor keeps its own route: it answers "how do others see me", which is neither.
    expect(parseRoute('/profile')).toEqual({ view: 'profile' });
  });

  it('declares the intention in the PATH, so the two doors are one screen', () => {
    const save = parseRoute(ACCOUNT_EMAIL_PATH);
    const back = parseRoute(ACCOUNT_SIGNIN_PATH);
    // Same screen...
    expect(save.view).toBe('accountEmail');
    expect(back.view).toBe('accountEmail');
    // ...opposite declarations. Nothing else in the route differs, because nothing else
    // about the two acts differs until the server answers.
    expect(save).not.toEqual(back);
  });

  it('keeps the game routes\' tolerance for an unknown step', () => {
    // The area's own entry, never a bounce home — the same treatment /<lang>/xyz gets.
    expect(parseRoute('/account/nonsense')).toEqual({ view: 'account' });
    expect(parseRoute('/account/')).toEqual({ view: 'account' });
  });

  it('is not language-scoped — a lang prefix is a GAME route, not an account one', () => {
    expect(parseRoute('/fr/account')).toEqual({ view: 'game', lang: 'fr' });
  });

  it('states its paths once, so every caller navigates to the same place', () => {
    expect(parseRoute(ACCOUNT_PATH)).toEqual({ view: 'account' });
    expect(parseRoute(ACCOUNT_EMAIL_PATH)).toEqual({ view: 'accountEmail', intent: 'save' });
    expect(parseRoute(ACCOUNT_SIGNIN_PATH)).toEqual({ view: 'accountEmail', intent: 'return' });
    expect(parseRoute(PROFILE_PATH)).toEqual({ view: 'profile' });
  });
});

// CONTRACT (#229): the PRIVACY NOTICE is a global route of its own. It has to be LINKABLE —
// the SES production-access review opens the URL, and "where is that written?" deserves an
// answer that can be pasted into a message — so it is a real path rather than a dialog, and
// it is not language-scoped for the account area's reason: what the game stores is a fact
// about the game, not about one language's daily.
describe('privacy route (#229)', () => {
  it('parses /privacy as a global route, and states its path once', () => {
    expect(parseRoute('/privacy')).toEqual({ view: 'privacy' });
    expect(parseRoute('/privacy/')).toEqual({ view: 'privacy' });
    expect(parseRoute(PRIVACY_PATH)).toEqual({ view: 'privacy' });
  });

  it('is not language-scoped — a lang prefix is a GAME route', () => {
    expect(parseRoute('/fr/privacy')).toEqual({ view: 'game', lang: 'fr' });
  });
});
