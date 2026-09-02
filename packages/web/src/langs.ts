import { INVITE_LANDING_SEGMENT, PUBLIC_ID_PATTERN } from '@whippin/shared';
import { FIRST_PUZZLE_DATE } from './config';

// Supported game languages — the single source for the picker and the /<lang> URL
// routing. A language is deep-linkable: /fr and /en map to the game in that language,
// / is the picker. `native` is the name in the language ITSELF — a language picker
// must be readable by the person who needs that language, so the list never
// translates the names.
export const LANGS = [
  { code: 'en', native: 'English' },
  { code: 'fr', native: 'Français' },
] as const;

export type LangCode = (typeof LANGS)[number]['code'];

const CODES: readonly string[] = LANGS.map((l) => l.code);

export function isLang(value: string | null | undefined): value is LangCode {
  return value != null && CODES.includes(value);
}

// The two daily games (#156): the sentence puzzle, and Word mode — one word, claim its
// neighborhood against a countdown. One app, two faces: the mode is part of every identity
// (URL, round key, share token), and the URL grammar gives Word mode its own segment —
// sentence keeps /<lang> and /<lang>/<date>, Word mode lives under /<lang>/word.
export type Mode = 'sentence' | 'word';
const WORD_SEGMENT = 'word';

// A mode's home for a language: /<lang> (sentence) or /<lang>/word.
export function pathForMode(lang: string | null, mode: Mode): string {
  if (!isLang(lang)) return '/';
  return mode === 'word' ? `/${lang}/${WORD_SEGMENT}` : `/${lang}`;
}

// The archive calendar for a language (and mode): /<lang>/archive or /<lang>/word/archive.
export function pathForArchive(lang: string | null, mode: Mode = 'sentence'): string {
  if (!isLang(lang)) return '/';
  return mode === 'word' ? `/${lang}/${WORD_SEGMENT}/archive` : `/${lang}/archive`;
}

// A past day's game, deep-linkable/shareable: /<lang>/<YYYY-MM-DD>, or Word mode's
// /<lang>/word/<YYYY-MM-DD>. The caller supplies a valid ISO date; range validation
// happens in parseRoute on the way back in.
export function pathForDay(lang: string | null, date: string, mode: Mode = 'sentence'): string {
  if (!isLang(lang)) return '/';
  return mode === 'word' ? `/${lang}/${WORD_SEGMENT}/${date}` : `/${lang}/${date}`;
}

// The leaderboard screen (#190): each daily's boards for the active day —
// /<lang>/board and /<lang>/word/board, the archive's own grammar. Language-scoped
// because a board is addressed per (day, lang, mode) like everything else.
const BOARD_SEGMENT = 'board';

export function pathForBoard(lang: string | null, mode: Mode = 'sentence'): string {
  if (!isLang(lang)) return '/';
  return mode === 'word' ? `/${lang}/${WORD_SEGMENT}/${BOARD_SEGMENT}` : `/${lang}/${BOARD_SEGMENT}`;
}

// The language chooser lives at its own route (not a modal), opened by the header's
// language chip. It sits above /<lang> since it is not language-scoped. (The /mode
// chooser was RETIRED 2026-08-18 for the header's segmented mode tabs.)
export const SELECT_PATH = '/select';

// The ACCOUNT area (#204's UX rework, 2026-08-26). FOUR routes, because they answer four
// different questions and one screen may only answer one:
//
//   /account         is this account mine, and safe?  — who it is, whether it is saved,
//                                                       where it is signed in
//   /profile         how do others see me?            — the editor, and nothing else
//   /account/email   SAVE this account                — one input per step
//   /account/signin  GET ANOTHER ONE BACK             — the same steps, the opposite act
//
// **TWO DOORS ONTO ONE ENGINE** (#204's UX rework vol. 2, 2026-08-27). The last two paths
// mount the SAME screen and send the SAME requests: the server may not branch before the
// code is verified — telling somebody "we know this address" ahead of proof is account
// enumeration — so nothing here is detected, nothing is routed, and every ending stays
// reachable from either door. What the path declares is the player's own INTENTION, and it
// buys the one thing the server's discretion cost: a flow that can be dressed for the act
// being performed. Saving is additive; signing in may delete the account this device is on.
// Those took the same taps, in the same words, and diverged only in the last half-second.
//
// The rule the split runs on: *the declaration shapes the journey; the server shapes the
// destination; the ending always tells the truth about what actually happened.* A player who
// picks the "wrong" door is never blocked and never lied to — they get an ending that names
// the turn.
//
// All four are GLOBAL, like /select: an identity is not language-scoped. The leaderboard's
// identity strip is the ONE door into the area (a player's own face is the natural handle
// for "my account"), and the signed-out screen's RECONNECT lands straight on `/account/signin`
// — a player who has just been signed out is a RETURNING player by definition, and landing
// them on a screen whose lead verb is "save" asks them to read past their own intention.
export const ACCOUNT_PATH = '/account';
export const ACCOUNT_EMAIL_PATH = '/account/email';
export const ACCOUNT_SIGNIN_PATH = '/account/signin';
export const PROFILE_PATH = '/profile';

// THE PRIVACY NOTICE (#229): what the game keeps about a player, why, and how to be rid of
// it. GLOBAL like the four above — what is stored is a fact about the whole game, not about
// one language's daily — and a STEP rather than a place: it is reached from `/account` and
// from the email flow's address field, which are the two screens where a person is deciding
// whether to hand over an address, and it goes back to whichever one asked.
//
// It is a real route rather than a dialog because a legal notice has to be LINKABLE: the SES
// production-access form asks for a URL and a reviewer opens it, and « où est-ce écrit ? »
// deserves an answer that can be pasted into a message.
export const PRIVACY_PATH = '/privacy';

// Which act the email flow is dressing. It never reaches the server.
export type LinkIntent = 'save' | 'return';

// The #189 INVITE LINK: `/i/<publicId>`, the sender's own id in the path. Global — an
// identity is not language-scoped. Since 2026-08-20 the LINK ITSELF is served by the
// backend, so it unfurls in a chat as the sender's own mark and name (`shared/invite.ts`
// holds the three paths, since infra, the backend and this file all have to agree on
// them); it renders that preview and bounces a human into the LANDING below, which is
// where the click still does its one job. So the shared link is unchanged and every one
// already in the wild simply gained a preview.
//
// `/join/<publicId>` is that landing: it records the mutual edge with the CLICKER's key
// and continues into the game, which is why one link is both "add me" and "come play".
// The id is validated here, so a mistyped link is an unknown path, not a request.
export { invitePath as pathForInvite } from '@whippin/shared';

// A parsed route. The game IS the home: /<lang> plays today's puzzle, /<lang>/<date>
// plays a past day (archive, #55), /<lang>/archive is the calendar, /select is the
// language picker, /privacy is the data notice, and anything else (/, unknown paths) is
// a `home` redirect that bounces to the user's language (see resolveHomeLang). Word
// mode (#156) mirrors the whole grammar under /<lang>/word: today's word,
// /word/<date>, /word/archive.
export type Route =
  | { view: 'game'; lang: LangCode; mode: Mode; date?: string }
  | { view: 'archive'; lang: LangCode; mode: Mode }
  | { view: 'board'; lang: LangCode; mode: Mode }
  | { view: 'select' }
  | { view: 'account' }
  | { view: 'accountEmail'; intent: LinkIntent }
  | { view: 'profile' }
  | { view: 'privacy' }
  | { view: 'invite'; publicId: string }
  | { view: 'home' };

// A strict "YYYY-MM-DD" that is ALSO a real calendar date (so 2026-13-40 is rejected):
// the shape guards the format, the round-trip re-formats the parsed value and requires
// it to match, which weeds out impossible days (Feb 30) and normalized overflow.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isCalendarDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

// Range bounds for date deep-links, injected so parsing stays pure/testable. `firstDate`
// defaults to the launch const; `activeDate` is the client's active game day (the caller
// passes it) — omitted, the future bound is not enforced (used by shape-only tests).
export interface RouteBounds {
  firstDate?: string;
  activeDate?: string;
}

export function parseRoute(pathname: string, bounds: RouteBounds = {}): Route {
  const firstDate = bounds.firstDate ?? FIRST_PUZZLE_DATE;
  const segs = pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  const [seg, second, third] = segs;
  if (seg === 'select') return { view: 'select' };
  if (seg === 'profile') return { view: 'profile' };
  if (seg === 'privacy') return { view: 'privacy' };
  // `/account` and its one step deeper. An unknown third form keeps the game routes'
  // tolerance and lands on the area's own entry rather than bouncing home.
  if (seg === 'account') {
    if (second === 'email') return { view: 'accountEmail', intent: 'save' };
    if (second === 'signin') return { view: 'accountEmail', intent: 'return' };
    return { view: 'account' };
  }
  // A broken invite link falls through to `home` rather than asking the server about an id
  // that cannot exist — the same treatment a broken date deep-link gets.
  if (seg === INVITE_LANDING_SEGMENT) {
    return second && PUBLIC_ID_PATTERN.test(second)
      ? { view: 'invite', publicId: second }
      : { view: 'home' };
  }
  if (!isLang(seg)) return { view: 'home' };

  // A dated deep link is honored only when it is a real calendar date within range; a
  // date-SHAPED segment that is malformed OR out of range is treated as unknown -> home
  // (a clearly date-like deep link that is broken should not silently fall through to
  // today). Shared by both modes, so the two grammars cannot drift.
  const dateOf = (s: string): string | 'home' | null => {
    if (!DATE_RE.test(s)) return null; // not date-shaped at all
    if (!isCalendarDate(s)) return 'home';
    if (s < firstDate) return 'home';
    if (bounds.activeDate && s > bounds.activeDate) return 'home';
    return s;
  };

  // /<lang>/word[/...] — Word mode (#156), the same grammar one segment deeper.
  if (second === WORD_SEGMENT) {
    if (!third) return { view: 'game', lang: seg, mode: 'word' };
    if (third === 'archive') return { view: 'archive', lang: seg, mode: 'word' };
    if (third === BOARD_SEGMENT) return { view: 'board', lang: seg, mode: 'word' };
    const date = dateOf(third);
    if (date === 'home') return { view: 'home' };
    if (date) return { view: 'game', lang: seg, mode: 'word', date };
    // Non-date, non-archive third segment: today's word, same tolerance as the sentence.
    return { view: 'game', lang: seg, mode: 'word' };
  }

  // /<lang> — today's game.
  if (!second) return { view: 'game', lang: seg, mode: 'sentence' };
  // /<lang>/archive — the calendar.
  if (second === 'archive') return { view: 'archive', lang: seg, mode: 'sentence' };
  // /<lang>/board — the day's leaderboard (#190).
  if (second === BOARD_SEGMENT) return { view: 'board', lang: seg, mode: 'sentence' };
  // /<lang>/<YYYY-MM-DD> — a past day.
  const date = dateOf(second);
  if (date === 'home') return { view: 'home' };
  if (date) return { view: 'game', lang: seg, mode: 'sentence', date };
  // Any other non-date, non-archive segment keeps today's tolerance: /<lang>/xyz plays
  // today's game (unchanged behavior, so old links never break).
  return { view: 'game', lang: seg, mode: 'sentence' };
}

// Where `/` (and any unknown path) should land: the persisted last-played language if
// valid, else the browser's preferred language (fr* -> fr), else English. Pure so it
// can be unit-tested — the caller passes navigator.language.
export function resolveHomeLang(
  persisted: string | null | undefined,
  navigatorLang?: string,
): LangCode {
  if (isLang(persisted)) return persisted;
  if (navigatorLang && navigatorLang.toLowerCase().startsWith('fr')) return 'fr';
  return 'en';
}
