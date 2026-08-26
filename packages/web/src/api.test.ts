// CONTRACT: date->puzzle routing (issue #6). The CLIENT computes the active 22:00-ET
// game day (shared day.ts) and requests the DATE-addressed puzzle URL in one fetch;
// the server validates the date against its clock-skew window and serves exactly that
// day. A 404 from the backend is the graceful "no puzzle today" state, not an error.

import { describe, it, expect } from 'vitest';
import {
  apiBase,
  boardUrl,
  devicesUrl,
  friendsUrl,
  parseBoard,
  parseDeviceIdentity,
  puzzleUrl,
  wordPuzzleUrl,
  puzzleOutcome,
  parseFriends,
  parsePuzzle,
  parseProfile,
  parseRound,
  parseScoreHistogram,
  parseWordPuzzle,
  profileUrl,
  roundUrl,
  scoresUrl,
} from './api';

describe('apiBase', () => {
  it('reads VITE_API_BASE_URL and trims trailing slashes', () => {
    expect(apiBase({ VITE_API_BASE_URL: 'https://api.example' } as ImportMetaEnv)).toBe(
      'https://api.example',
    );
    expect(apiBase({ VITE_API_BASE_URL: 'https://api.example///' } as ImportMetaEnv)).toBe(
      'https://api.example',
    );
  });

  it('is empty when unset (no backend configured)', () => {
    expect(apiBase({} as ImportMetaEnv)).toBe('');
  });
});

describe('backend routing URLs', () => {
  const base = 'https://api.example';

  it('puzzleUrl is date-addressed: it always carries the required game day', () => {
    expect(puzzleUrl('fr', '2026-07-05', base)).toBe('https://api.example/?lang=fr&date=2026-07-05');
    expect(puzzleUrl('en', '2026-07-06', base)).toBe('https://api.example/?lang=en&date=2026-07-06');
  });

  it('puzzleUrl encodes the lang and date query values', () => {
    expect(puzzleUrl('a b', 'x/y"', base)).toBe('https://api.example/?lang=a%20b&date=x%2Fy%22');
  });

  it('fails loudly when the backend base is unset instead of using the web origin', () => {
    expect(() => puzzleUrl('fr', '2026-07-05', '')).toThrow(/VITE_API_BASE_URL/);
  });

  // Word mode names its daily with `mode=word` (#156) — a DISTINCT URL, which is the whole
  // reason the CDN can hold the two dailies as separate entries. The parameter has to be in
  // the CloudFront cache policy's allowList for that to be true (see infra/backend-stack).
  it('wordPuzzleUrl is the same date-addressed URL, selected by mode=word', () => {
    expect(wordPuzzleUrl('fr', '2026-07-05', base)).toBe(
      'https://api.example/?lang=fr&date=2026-07-05&mode=word',
    );
    expect(wordPuzzleUrl('fr', '2026-07-05', base)).not.toBe(puzzleUrl('fr', '2026-07-05', base));
  });
});

describe('puzzleOutcome (graceful 404)', () => {
  it('200/2xx -> a puzzle to load', () => {
    expect(puzzleOutcome(200)).toBe('puzzle');
    expect(puzzleOutcome(204)).toBe('puzzle');
  });

  it('404 -> missing (the NO PUZZLE TODAY state, not an error)', () => {
    expect(puzzleOutcome(404)).toBe('missing');
  });

  it('any other status -> a real error', () => {
    expect(puzzleOutcome(500)).toBe('error');
    expect(puzzleOutcome(403)).toBe('error');
  });
});

// CONTRACT: the per-puzzle JSON schema (issue #14). A fetched puzzle of the wrong
// shape (truncated body, store/CDN mishap) must surface as
// an ERROR — parsePuzzle throws — rather than crash Game mid-render. Assert against the
// schema in AGENTS.md, not the implementation: lang, words[], each hole's {secret,start}
// {word,slug} + start_rank, and a ranks map with an entry for every secret slug.
describe('parsePuzzle (shape validation)', () => {
  // A minimal well-formed puzzle per the schema (accents kept in words/display forms).
  const valid = () => ({
    lang: 'fr',
    // WHICH PUBLISHED VERSION (#203) — stamped by `puzzle:publish`, and the round's identity
    // on the wire, so a puzzle without one cannot be played.
    revision: 'a1b2c3d4e5f60718',
    words: ['la', 'forêt', 'ancienne'],
    holes: [
      {
        pos: 1,
        secret: { word: 'forêt', slug: 'foret' },
        start: { word: 'bois', slug: 'bois' },
        start_rank: 87,
      },
    ],
    ranks: {
      foret: { bois: { word: 'bois', rank: 87 } },
    },
  });

  it('accepts and returns a well-formed puzzle unchanged', () => {
    const p = valid();
    expect(parsePuzzle(p)).toEqual(p);
  });

  it('refuses a puzzle with no published version — there is nothing to key its round on', () => {
    const { revision: _none, ...unstamped } = valid();
    expect(() => parsePuzzle(unstamped)).toThrow(/revision/);
    expect(() => parsePuzzle({ ...valid(), revision: '' })).toThrow(/revision/);
  });

  it('accepts repeated hole occurrences that share one secret rank map', () => {
    const p = valid();
    p.words = ['la', 'forêt,', 'traverse', 'la', 'forêt'];
    p.holes.push({ ...p.holes[0], pos: 4 });
    Object.assign(p.holes[0], { pos: 1, suffix: ',' });

    expect(parsePuzzle(p)).toEqual(p);
    expect(parsePuzzle(p).holes).toHaveLength(2);
    expect(Object.keys(parsePuzzle(p).ranks)).toEqual(['foret']);
  });

  // Optional source metadata (#5): not load-bearing, so a puzzle is valid WITH or
  // WITHOUT it, and when present it must survive to the front (consumed by the solved
  // screen, #8) rather than being stripped.
  it('is valid without a source (optional end-to-end)', () => {
    const p = valid();
    expect('source' in p).toBe(false);
    expect(parsePuzzle(p)).toEqual(p);
  });

  it('passes an optional source (kind/author/work) through unchanged', () => {
    const p = {
      ...valid(),
      source: { kind: 'book', author: 'Victor Hugo', work: 'Les Misérables' },
    };
    expect(parsePuzzle(p).source).toEqual(p.source);
  });

  // The optional distance annotation (#115): `dq` is a group property generation adds to
  // every ranked entry. The secret's own entry (rank 0) carries none, so ABSENT stays
  // valid; a PRESENT one must be a well-formed number.
  it('accepts rank entries with and without dq', () => {
    const p = valid();
    expect('dq' in p.ranks.foret.bois).toBe(false);
    expect(parsePuzzle(p)).toEqual(p);

    const annotated = valid();
    annotated.ranks = {
      foret: {
        bois: { word: 'bois', rank: 87, dq: 231 },
        arbre: { word: 'arbre', rank: 3, dq: 250 },
        foret: { word: 'forêt', rank: 0 }, // the secret: terminus, no annotations
      },
    } as typeof annotated.ranks;
    expect(parsePuzzle(annotated)).toEqual(annotated);
  });

  it('rejects an out-of-range or non-numeric dq', () => {
    const bad = (entry: Record<string, unknown>) => ({
      ...valid(),
      ranks: { foret: { bois: { word: 'bois', rank: 87, ...entry } } },
    });
    expect(() => parsePuzzle(bad({ dq: 300 }))).toThrow(/dq/);
    expect(() => parsePuzzle(bad({ dq: -1 }))).toThrow(/dq/);
    expect(() => parsePuzzle(bad({ dq: 12.5 }))).toThrow(/dq/);
    expect(() => parsePuzzle(bad({ dq: 'x' }))).toThrow(/dq/);
  });

  // `rank` is NOT optional: scoring and guess feedback read it as a number, and it is a
  // component of the counted-try identity (guessKey), whose "unknown" sentinel is -1 — so a
  // missing, negative, or non-integer rank must be rejected, never shipped into the game.
  it('rejects a rank entry whose rank is missing, negative, or non-integer', () => {
    const bad = (rank: unknown) => ({
      ...valid(),
      ranks: { foret: { bois: { word: 'bois', rank } } },
    });
    expect(() => parsePuzzle(bad(undefined))).toThrow(/rank/);
    expect(() => parsePuzzle(bad(-1))).toThrow(/rank/);
    expect(() => parsePuzzle(bad(12.5))).toThrow(/rank/);
    expect(() => parsePuzzle(bad('87'))).toThrow(/rank/);
    expect(parsePuzzle(bad(0))).toBeTruthy(); // the secret's own entry is rank 0
  });

  // Optional hole affixes: display-only text around the blank (leading clitic /
  // punctuation). Not load-bearing, so a hole is valid with or without them, and when
  // present they must survive to the front (Phrase renders them around the blank).
  it('passes optional hole prefix/suffix through unchanged', () => {
    const p = valid();
    Object.assign(p.holes[0], { prefix: "t'", suffix: ',' });
    const parsed = parsePuzzle(p);
    expect(parsed.holes[0].prefix).toBe("t'");
    expect(parsed.holes[0].suffix).toBe(',');
  });

  it('rejects non-objects (null, array, primitive)', () => {
    expect(() => parsePuzzle(null)).toThrow(/malformed puzzle/);
    expect(() => parsePuzzle([])).toThrow(/malformed puzzle/);
    expect(() => parsePuzzle('nope')).toThrow(/malformed puzzle/);
  });

  it('rejects a missing or non-string lang', () => {
    const p = valid() as Record<string, unknown>;
    delete p.lang;
    expect(() => parsePuzzle(p)).toThrow(/lang/);
  });

  it('rejects words that are not an array of strings', () => {
    const p = valid();
    (p as { words: unknown }).words = ['ok', 3];
    expect(() => parsePuzzle(p)).toThrow(/words/);
  });

  it('rejects holes that are not an array', () => {
    const p = valid();
    (p as { holes: unknown }).holes = {};
    expect(() => parsePuzzle(p)).toThrow(/holes/);
  });

  it('rejects a hole missing a {word,slug} secret/start or a numeric start_rank', () => {
    const noSlug = valid();
    (noSlug.holes[0].secret as { slug?: string }).slug = undefined;
    expect(() => parsePuzzle(noSlug)).toThrow(/holes/);

    const badRank = valid();
    (badRank.holes[0] as { start_rank: unknown }).start_rank = '87';
    expect(() => parsePuzzle(badRank)).toThrow(/holes/);
  });

  it('rejects a ranks map missing an entry for a secret slug', () => {
    const p = valid();
    (p as { ranks: Record<string, unknown> }).ranks = {}; // no "foret" key
    expect(() => parsePuzzle(p)).toThrow(/ranks/);
  });

  it('rejects a non-object ranks', () => {
    const p = valid();
    (p as { ranks: unknown }).ranks = [];
    expect(() => parsePuzzle(p)).toThrow(/ranks/);
  });
});

// Word mode's artifact (#154/#156) gets the same guard as the sentence puzzle, for the same
// reason: a truncated or wrong-shaped body must surface as the error state, never crash the
// board mid-render. It is also the ONE thing standing between the network and the numbers the
// drawing sizes itself by — and the failure that motivated it is real: with `mode` missing from
// the CDN cache key the word route was served the day's SENTENCE puzzle, and this is what
// turned that into a clean "failed to load" instead of a blank screen.
describe('parseWordPuzzle (shape validation)', () => {
  const valid = () => ({
    lang: 'fr',
    word: { word: 'forêt', slug: 'foret' },
    ranks: {
      foret: { word: 'forêt', rank: 0, freq: 812 },
      bois: { word: 'bois', rank: 1, dq: 255, freq: 64 },
      arbre: { word: 'arbre', rank: 2, dq: 240, freq: 230 },
    },
  });

  it('accepts a well-formed artifact unchanged', () => {
    const p = valid();
    expect(parseWordPuzzle(p)).toBe(p);
  });

  it('rejects a non-object / a missing lang / a bad word', () => {
    expect(() => parseWordPuzzle(null)).toThrow(/word puzzle/);
    expect(() => parseWordPuzzle([])).toThrow(/word puzzle/);
    const noLang = valid();
    delete (noLang as { lang?: unknown }).lang;
    expect(() => parseWordPuzzle(noLang)).toThrow(/lang/);
    const badWord = valid();
    (badWord as { word: unknown }).word = { word: 'forêt' }; // no slug
    expect(() => parseWordPuzzle(badWord)).toThrow(/word/);
  });

  // The flat map has to hold the day's own word at rank 0 — that entry is what the board
  // draws as its terminus and what makes typing the word itself free rather than a strike.
  it('rejects a ranks map that does not hold the word itself at rank 0', () => {
    const missing = valid();
    delete (missing.ranks as Record<string, unknown>).foret;
    expect(() => parseWordPuzzle(missing)).toThrow(/rank 0/);
    const notZero = valid();
    (notZero.ranks.foret as { rank: number }).rank = 3;
    expect(() => parseWordPuzzle(notZero)).toThrow(/rank 0/);
  });

  it('rejects a malformed rank / dq / freq on any entry', () => {
    const badRank = valid();
    (badRank.ranks.bois as { rank: unknown }).rank = -1;
    expect(() => parseWordPuzzle(badRank)).toThrow(/rank/);
    const badDq = valid();
    (badDq.ranks.bois as { dq: unknown }).dq = 256;
    expect(() => parseWordPuzzle(badDq)).toThrow(/dq/);
    // freq is 1-based on purpose: a 0 is indistinguishable from absent to a truthiness test.
    const badFreq = valid();
    (badFreq.ranks.bois as { freq: unknown }).freq = 0;
    expect(() => parseWordPuzzle(badFreq)).toThrow(/freq/);
  });

  // dq/freq are optional PER ENTRY (rank 0 has no dq; a borrowed-vector group has no
  // corpus position) — only a PRESENT one is checked, as long as freq appears SOMEWHERE.
  it('accepts entries with no distance annotations', () => {
    const bare = {
      lang: 'en',
      word: { word: 'ocean', slug: 'ocean' },
      ranks: { ocean: { word: 'ocean', rank: 0 }, sea: { word: 'sea', rank: 1, freq: 3 } },
    };
    expect(() => parseWordPuzzle(bare)).not.toThrow();
  });

  // A map with NO freq anywhere is a pre-#163 artifact: every claim would grade at the
  // COMMON floor and silently halve the economy. The no-back-compat rule says a stale
  // artifact is republished, never limped on — so it must fail loudly at load.
  it('rejects an artifact with no freq on any entry (pre-#163)', () => {
    const stale = valid();
    for (const entry of Object.values(stale.ranks)) {
      delete (entry as { freq?: unknown }).freq;
    }
    expect(() => parseWordPuzzle(stale)).toThrow(/freq/);
  });

  // The two dailies' bodies must not pass for each other: this is exactly what a cache-key
  // collision or a mis-published file delivers.
  it('rejects a SENTENCE puzzle body', () => {
    const sentence = {
      lang: 'fr',
      words: ['la', 'forêt'],
      holes: [{ pos: 1, secret: { word: 'forêt', slug: 'foret' }, start: { word: 'bois', slug: 'bois' }, start_rank: 87 }],
      ranks: { foret: { bois: { word: 'bois', rank: 12 } } },
    };
    expect(() => parseWordPuzzle(sentence)).toThrow(/word puzzle/);
  });
});

// The live score endpoint (#169/#170): mode is REQUIRED on this route, and the response
// is validated the way puzzles are — a wrong-shaped body must surface as a (silent)
// failure, never as NaN bars on the solved screen.
describe('scoresUrl', () => {
  it('addresses the /scores route with lang, date and the REQUIRED mode', () => {
    expect(scoresUrl('fr', '2026-08-14', 'sentence', undefined, 'https://api.example')).toBe(
      'https://api.example/scores?lang=fr&date=2026-08-14&mode=sentence',
    );
    expect(scoresUrl('en', '2026-08-14', 'word', undefined, 'https://api.example')).toBe(
      'https://api.example/scores?lang=en&date=2026-08-14&mode=word',
    );
  });

  it('names the CALLER with their public id, which is what makes `bucket` theirs (#203)', () => {
    // Matching a local count against the bands only ever says "somebody scored this"; the
    // server locates the row that is actually this player's.
    expect(
      scoresUrl('fr', '2026-08-14', 'sentence', 'lfd5pqz5pa7zjm5u', 'https://api.example'),
    ).toBe('https://api.example/scores?lang=fr&date=2026-08-14&mode=sentence&id=lfd5pqz5pa7zjm5u');
  });

  it('throws without a configured base (never a silent same-origin fetch)', () => {
    expect(() => scoresUrl('fr', '2026-08-14', 'sentence', undefined, '')).toThrow(
      /VITE_API_BASE_URL/,
    );
  });
});

describe('parseScoreHistogram (shape validation)', () => {
  const valid = () => ({
    buckets: [
      { min: 1, max: 3, count: 2 },
      { min: 4, max: 5, count: 0 },
    ],
    total: 2,
    bucket: 0,
  });

  it('accepts the POST shape (bucket set) and the GET shape (bucket null)', () => {
    expect(parseScoreHistogram(valid()).total).toBe(2);
    expect(parseScoreHistogram({ ...valid(), bucket: null }).bucket).toBeNull();
  });

  it('accepts an EMPTY population — since #187 the bands are derived from the rows', () => {
    expect(parseScoreHistogram({ buckets: [], total: 0, bucket: null }).buckets).toEqual([]);
  });

  it('rejects non-objects, bad totals, bad buckets and bad bucket indexes', () => {
    expect(() => parseScoreHistogram(null)).toThrow(/histogram/);
    expect(() => parseScoreHistogram({ ...valid(), total: -1 })).toThrow(/total/);
    expect(() => parseScoreHistogram({ ...valid(), total: 1.5 })).toThrow(/total/);
    expect(() => parseScoreHistogram({ ...valid(), buckets: 'none' })).toThrow(/buckets/);
    expect(() => parseScoreHistogram({ ...valid(), buckets: [{ min: 1, max: 3, count: -1 }] }))
      .toThrow(/bucket/);
    expect(() => parseScoreHistogram({ ...valid(), bucket: 'zero' })).toThrow(/bucket/);
    expect(() => parseScoreHistogram({ ...valid(), bucket: -1 })).toThrow(/bucket/);
    expect(() => parseScoreHistogram({ ...valid(), bucket: 2 })).toThrow(/bucket/);
  });
});

describe('profileUrl + parseProfile (#188)', () => {
  it('addresses the /profile route, with the id query only on reads', () => {
    expect(profileUrl(undefined, 'https://api.example')).toBe('https://api.example/profile');
    expect(profileUrl('abcdefghij234567', 'https://api.example')).toBe(
      'https://api.example/profile?id=abcdefghij234567',
    );
    expect(() => profileUrl(undefined, '')).toThrow(/VITE_API_BASE_URL/);
  });

  it('validates the profile shape and rejects a corrupt one', async () => {
    const { blankAvatar } = await import('@whippin/shared');
    const valid = {
      publicId: 'abcdefghij234567',
      name: 'Chqrles',
      avatar: blankAvatar(),
    };
    expect(parseProfile(valid)).toEqual(valid);
    expect(() => parseProfile(null)).toThrow(/not an object/);
    expect(() => parseProfile({ ...valid, publicId: 'NOPE' })).toThrow(/publicId/);
    expect(() => parseProfile({ ...valid, name: 3 })).toThrow(/name/);
    expect(() => parseProfile({ ...valid, avatar: 'garbage' })).toThrow(/avatar/);
    // The stored EMPTY avatar is "no custom mark" (PR-219 round-2 review), normalized to
    // null — the board rows' convention — so ONE fallback rule serves every consumer and
    // '' can never reach a decoder.
    expect(parseProfile({ ...valid, avatar: '' })).toEqual({ ...valid, avatar: null });
    expect(parseProfile({ ...valid, avatar: null })).toEqual({ ...valid, avatar: null });
  });
});

describe('devicesUrl + parseDeviceIdentity (#216)', () => {
  const valid = () => ({
    accountId: 'abcdefghij234567',
    deviceId: 'zyxwvutsrq765432',
    devices: [
      {
        revokeKey: 'a'.repeat(64),
        deviceId: 'zyxwvutsrq765432',
        device: 'iPhone',
        os: 'iOS 17',
        browser: 'Safari',
        createdAt: '2026-08-23T00:00:00.000Z',
        lastSeenAt: '2026-08-24T00:00:00.000Z',
        current: true,
      },
    ],
  });

  it('addresses the POST-only route with no query and validates its full listing', () => {
    expect(devicesUrl('https://api.example')).toBe('https://api.example/devices');
    const body = valid();
    expect(parseDeviceIdentity(body)).toBe(body);
  });

  it('rejects a missing/malformed revocation handle, but tolerates unparseable timestamps', () => {
    const missing = valid();
    delete (missing.devices[0] as { revokeKey?: string }).revokeKey;
    expect(() => parseDeviceIdentity(missing)).toThrow(/devices/);
    const badHandle = valid();
    badHandle.devices[0].revokeKey = 'A'.repeat(64);
    expect(() => parseDeviceIdentity(badHandle)).toThrow(/devices/);
    // The server's own row reader DEFAULTS an absent timestamp to '' — a legitimate
    // answer, and the screen renders an unparseable date as no date. Refusing the whole
    // list over a label would hide every other device behind one damaged row.
    const badDate = valid();
    badDate.devices[0].lastSeenAt = 'yesterday';
    expect(() => parseDeviceIdentity(badDate)).not.toThrow();
    const emptyDate = valid();
    emptyDate.devices[0].createdAt = '';
    expect(() => parseDeviceIdentity(emptyDate)).not.toThrow();
  });
});

describe('friendsUrl + parseFriends (#189)', () => {
  it('addresses the /friends route with NO query — the key authenticates in the body', () => {
    expect(friendsUrl('https://api.example')).toBe('https://api.example/friends');
    expect(() => friendsUrl('')).toThrow(/VITE_API_BASE_URL/);
  });

  it('validates the list shape and rejects a corrupt one', () => {
    expect(parseFriends({ friends: [] })).toEqual([]);
    expect(parseFriends({ friends: ['abcdefghij234567'] })).toEqual(['abcdefghij234567']);
    expect(() => parseFriends(null)).toThrow(/not an object/);
    expect(() => parseFriends({ friends: 'abcdefghij234567' })).toThrow(/friends/);
    expect(() => parseFriends({ friends: ['NOPE'] })).toThrow(/friends/);
  });
});

describe('boardUrl (#190)', () => {
  it('addresses the /board route with lang, date, mode and the optional public id', () => {
    expect(boardUrl('fr', '2026-08-19', 'sentence', undefined, 'https://api.example')).toBe(
      'https://api.example/board?lang=fr&date=2026-08-19&mode=sentence',
    );
    expect(boardUrl('en', '2026-08-19', 'word', 'abcdefghij234567', 'https://api.example')).toBe(
      'https://api.example/board?lang=en&date=2026-08-19&mode=word&id=abcdefghij234567',
    );
  });

  it('throws without a configured base (never a silent same-origin fetch)', () => {
    expect(() => boardUrl('fr', '2026-08-19', 'sentence', undefined, '')).toThrow(
      /VITE_API_BASE_URL/,
    );
  });
});

describe('parseBoard (shape validation, #190)', () => {
  const row = (over: Partial<Record<string, unknown>> = {}) => ({
    publicId: 'abcdefghij234567',
    name: 'Zoe',
    avatar: null,
    score: 7,
    rank: 1,
    ...over,
  });
  const valid = () => ({ rows: [row()], own: null, playing: [], waiting: [] });

  it('accepts a well-formed board, empty boards included', () => {
    expect(parseBoard(valid()).rows).toHaveLength(1);
    expect(parseBoard({ rows: [], own: null, playing: [], waiting: [] }).rows).toEqual([]);
    expect(parseBoard({ ...valid(), own: [row()] }).own).toHaveLength(1);
    // A friend with no score today is a PLAYER row — no score, no rank.
    expect(
      parseBoard({
        ...valid(),
        waiting: [{ publicId: 'abcdefghij234567', name: '', avatar: null }],
      }).waiting,
    ).toHaveLength(1);
  });

  // The #206 in-progress rows: a dressed player with the two live numbers — an exact
  // try count (positive integer) and a reconstruction percentage (real, 0..100).
  const playingRow = (over: Partial<Record<string, unknown>> = {}) => ({
    publicId: 'abcdefghij234567',
    name: '',
    avatar: null,
    tries: 12,
    progress: 62.5,
    ...over,
  });

  it('accepts playing rows, fractional progress included (#206)', () => {
    expect(parseBoard({ ...valid(), playing: [playingRow()] }).playing).toHaveLength(1);
    expect(parseBoard({ ...valid(), playing: [playingRow({ progress: 0 })] }).playing).toHaveLength(1);
    expect(parseBoard({ ...valid(), playing: [playingRow({ progress: 100 })] }).playing).toHaveLength(1);
  });

  it('rejects a malformed playing row (#206)', () => {
    expect(() => parseBoard({ ...valid(), playing: undefined })).toThrow(/playing/);
    expect(() => parseBoard({ ...valid(), playing: [playingRow({ publicId: 'NOPE' })] })).toThrow(/playing/);
    // A round with no guesses is no round: zero or fractional tries is a wrong shape.
    expect(() => parseBoard({ ...valid(), playing: [playingRow({ tries: 0 })] })).toThrow(/playing/);
    expect(() => parseBoard({ ...valid(), playing: [playingRow({ tries: 1.5 })] })).toThrow(/playing/);
    expect(() => parseBoard({ ...valid(), playing: [playingRow({ progress: -1 })] })).toThrow(/playing/);
    expect(() => parseBoard({ ...valid(), playing: [playingRow({ progress: 101 })] })).toThrow(/playing/);
    expect(() => parseBoard({ ...valid(), playing: [playingRow({ progress: '40' })] })).toThrow(/playing/);
  });

  it('rejects a wrong-shaped body (a failure, never NaN rows)', () => {
    expect(() => parseBoard(null)).toThrow(/board/);
    expect(() => parseBoard({ ...valid(), rows: 'none' })).toThrow(/rows/);
    expect(() => parseBoard({ ...valid(), rows: [row({ publicId: 'NOPE' })] })).toThrow(/rows/);
    expect(() => parseBoard({ ...valid(), rows: [row({ rank: 0 })] })).toThrow(/rows/);
    expect(() => parseBoard({ ...valid(), rows: [row({ score: 1.5 })] })).toThrow(/rows/);
    expect(() => parseBoard({ ...valid(), rows: [row({ avatar: 7 })] })).toThrow(/rows/);
    // A present avatar must DECODE (isValidAvatar): '' would slip past the nullish
    // `?? defaultAvatar` fallback, throw in decodeAvatar, and shift the row's grid.
    expect(() => parseBoard({ ...valid(), rows: [row({ avatar: '' })] })).toThrow(/rows/);
    expect(() => parseBoard({ ...valid(), rows: [row({ avatar: '!'.repeat(19) })] })).toThrow(/rows/);
    expect(() => parseBoard({ ...valid(), own: [row({ name: 3 })] })).toThrow(/own/);
    expect(() => parseBoard({ ...valid(), waiting: undefined })).toThrow(/waiting/);
    expect(() => parseBoard({ ...valid(), waiting: [{ publicId: 'NOPE' }] })).toThrow(/waiting/);
  });
});

describe('roundUrl + parseRound (#201/#202)', () => {
  const base = 'https://api.example';
  const valid = () => ({ guesses: ['bois'], createdAt: '2026-08-21T09:00:00.000Z', now: '2026-08-21T09:30:00.000Z' });

  it('is the day-addressed round route, mode included', () => {
    expect(roundUrl('fr', '2026-08-21', 'word', base)).toBe(
      'https://api.example/round?lang=fr&date=2026-08-21&mode=word',
    );
  });

  it('reads the stored state, with no start on a sentence round', () => {
    expect(parseRound(valid())).toEqual({
      ...valid(),
      startedAt: null,
      // Word mode's run OWNER (#217) — null exactly when the clock is, since one write
      // stamps both, and always null on a sentence round.
      startedBy: null,
      submittedAt: null,
      // The server's own reading of the log it stores (#203); absent means "not yet",
      // never "no longer", since it is only ever written true.
      solved: false,
      // Absent means nothing was earned — only the answer confirming an on-time solve
      // carries it (#211's one predicate, decided on the server's clock).
      credited: false,
    });
  });

  it('carries the SERVER\'s solve (#203), which is what says the score row exists', () => {
    expect(parseRound({ ...valid(), solved: true }).solved).toBe(true);
    expect(() => parseRound({ ...valid(), solved: 'yes' })).toThrow(/solved/);
  });

  it("carries Word mode's server-stamped clock and the DEVICE it belongs to", () => {
    // The id is what the screen reads against its own device; the parsed user-agent fields
    // are how it NAMES that device before offering to end its run (#217).
    const runner = { deviceId: 'd'.repeat(16), device: 'iPhone', os: 'iOS 17', browser: 'Safari' };
    const started = { ...valid(), startedAt: '2026-08-21T09:10:00.000Z', startedBy: runner };
    expect(parseRound(started).startedAt).toBe('2026-08-21T09:10:00.000Z');
    expect(parseRound(started).startedBy).toEqual(runner);
  });

  it('REFUSES a half-shaped run owner rather than guessing at a device', () => {
    // The phase this decides is whether the player may keep playing, so a stamp that does
    // not name a device is a malformed answer — the parse failure the sync engine treats as
    // a failed read, never a run silently attributed to nobody.
    const runner = { deviceId: 'd'.repeat(16), device: 'iPhone', os: 'iOS 17', browser: 'Safari' };
    expect(() => parseRound({ ...valid(), startedBy: { ...runner, deviceId: '' } })).toThrow(
      /startedBy/,
    );
    expect(() => parseRound({ ...valid(), startedBy: { deviceId: 'd'.repeat(16) } })).toThrow(
      /startedBy/,
    );
    expect(() => parseRound({ ...valid(), startedBy: 'iPhone' })).toThrow(/startedBy/);
  });

  it('carries the SUBMISSION\'s own marker, which a 0-claim run needs', () => {
    // An empty stored log is indistinguishable from an unsubmitted one, so the marker is
    // the attribute rather than the length.
    const done = { ...valid(), guesses: [], submittedAt: '2026-08-21T09:20:00.000Z' };
    expect(parseRound(done).submittedAt).toBe('2026-08-21T09:20:00.000Z');
    expect(parseRound(valid()).submittedAt).toBeNull();
  });

  it('rejects a wrong-shaped body (a silent sync failure, never garbage in the log)', () => {
    expect(() => parseRound(null)).toThrow(/round/);
    expect(() => parseRound({ ...valid(), guesses: 'bois' })).toThrow(/guesses/);
    expect(() => parseRound({ ...valid(), createdAt: 7 })).toThrow(/createdAt/);
    // Both instants feed the deadline arithmetic, where a NaN ends a run instantly or
    // never — so they are checked as PARSEABLE, not merely as strings.
    expect(() => parseRound({ guesses: [], createdAt: valid().createdAt })).toThrow(/now/);
    expect(() => parseRound({ ...valid(), now: 'whenever' })).toThrow(/now/);
    expect(() => parseRound({ ...valid(), startedAt: 'whenever' })).toThrow(/startedAt/);
    expect(() => parseRound({ ...valid(), submittedAt: 'whenever' })).toThrow(/submittedAt/);
  });
});
