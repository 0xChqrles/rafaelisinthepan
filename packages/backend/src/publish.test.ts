// CONTRACT (issue #4 / #17): publishing a generated puzzle ROUTES it to the store by
// (game day, lang). Asserts the SPEC, not the implementation:
// - the store key is `storeKey(day, lang)` — byte-identical to the key the readers
//   (fsStore/s3Store) GET, so a published puzzle is the one served;
// - the game day defaults to the active 22:00-ET day (`activeDate`), `--day` overrides;
// - the destination is LOCAL by default (no AWS creds), S3 ONLY with `--s3`, which
//   REQUIRES the bucket name (resolved from the deployed stack output, passed in) — never
//   a silent local fallback;
// - an invalid `--day` is rejected.
// The stack-output lookup itself is impure (AWS) and lives outside this pure function.

import { describe, it, expect } from 'vitest';
import { mintBonusId, planPublish, puzzleLang, puzzleRevision } from './publish';
import { activeDate, VOCAB_BUILDS, type Puzzle, type WordPuzzle } from '@whippin/shared';
import { sliceKey, storeKey } from './layout';
import { PUZZLE_TAG_SHAPE } from './roundStore';

// Noon UTC = mid-morning in New York, well before the 22:00-ET active-day reset.
const NOON_UTC = new Date('2026-06-29T12:00:00Z');

describe('planPublish — (day, lang) -> store key + destination', () => {
  it('defaults to LOCAL and the active 22:00-ET day, keyed like the readers', () => {
    const plan = planPublish({ s3: false }, 'fr', NOON_UTC);
    expect(plan.target).toEqual({ kind: 'local' });
    expect(plan.day).toBe(activeDate(NOON_UTC));
    expect(plan.key).toBe(storeKey(activeDate(NOON_UTC), 'fr'));
  });

  it('--day overrides the active day; the key follows the override', () => {
    const plan = planPublish({ s3: false, day: '2026-07-01' }, 'en', NOON_UTC);
    expect(plan.day).toBe('2026-07-01');
    expect(plan.key).toBe('2026-07-01.en.json');
    expect(plan.key).toBe(storeKey('2026-07-01', 'en'));
  });

  it('rejects an invalid --day', () => {
    expect(() => planPublish({ s3: false, day: '2026-13-40' }, 'fr', NOON_UTC)).toThrow();
    expect(() => planPublish({ s3: false, day: 'today' }, 'fr', NOON_UTC)).toThrow();
  });

  it('--s3 routes to S3 with the deployed bucket and the SAME key a reader GETs', () => {
    const plan = planPublish({ s3: true, day: '2026-07-01' }, 'fr', NOON_UTC, 'deployed-bucket');
    expect(plan.target).toEqual({ kind: 's3', bucket: 'deployed-bucket' });
    expect(plan.key).toBe(storeKey('2026-07-01', 'fr'));
  });

  it('--s3 with no resolved bucket is rejected (no silent local fallback)', () => {
    expect(() => planPublish({ s3: true }, 'fr', NOON_UTC)).toThrow(/bucket/i);
  });
});

// CONTRACT (#203): a publish also places the derivation slice the round route
// reads. It is part of the same publish rather than a follow-up, because the backend has
// NO fallback — a day whose slice is missing answers the day-addressed 404 — and it is
// keyed exactly like the puzzle so the two describe one daily by construction.
describe('planPublish — the derivation slice beside the puzzle (#203)', () => {
  it('plans a slice, keyed like the readers ask for it', () => {
    const plan = planPublish({ s3: false, day: '2026-07-01' }, 'fr', NOON_UTC);
    expect(plan.slice).toBe(sliceKey('2026-07-01', 'fr'));
    // Same day, same lang — one publish cannot leave the two describing different dailies.
    expect(plan.key).toBe(storeKey('2026-07-01', 'fr'));
  });

  it('carries the slice to S3 too, so a deployed day is never published half-way', () => {
    const plan = planPublish({ s3: true, day: '2026-07-01' }, 'fr', NOON_UTC, 'deployed-bucket');
    expect(plan.target).toEqual({ kind: 's3', bucket: 'deployed-bucket' });
    expect(plan.slice).toBe(sliceKey('2026-07-01', 'fr'));
  });
});

// CONTRACT (bonus puzzles, 2026-09-24): `--bonus` publishes a test puzzle OUTSIDE the
// calendar, keyed by its address `bonus/<id>` through the same key functions the readers
// use; it is exclusive with `--day`, and a minted id is never one the store already holds.
describe('planPublish — a bonus puzzle', () => {
  it('keys the puzzle and its slice by the bonus address, locally and on S3', () => {
    const local = planPublish({ s3: false, bonusId: '1234567' }, 'fr', NOON_UTC);
    expect(local.bonusId).toBe('1234567');
    expect(local.key).toBe('bonus/1234567.fr.json');
    expect(local.slice).toBe('bonus/1234567.fr.slice.json.gz');
    const s3 = planPublish({ s3: true, bonusId: '1234567' }, 'fr', NOON_UTC, 'deployed-bucket');
    expect(s3.target).toEqual({ kind: 's3', bucket: 'deployed-bucket' });
    expect(s3.key).toBe(storeKey('bonus/1234567', 'fr'));
  });

  it('refuses a bonus that is also a day, or a malformed id', () => {
    expect(() => planPublish({ s3: false, day: '2026-07-01', bonusId: '1234567' }, 'fr', NOON_UTC)).toThrow(/exclusive/);
    expect(() => planPublish({ s3: false, bonusId: '0123456' }, 'fr', NOON_UTC)).toThrow();
  });

  it('rejects an id held in another language before minting a fresh one', async () => {
    const langs = Object.keys(VOCAB_BUILDS);
    const otherLang = langs.at(-1)!;
    const seen: { id: string; lang: string }[] = [];
    const id = await mintBonusId(async (candidate, lang) => {
      seen.push({ id: candidate, lang });
      return seen.length <= langs.length && lang === otherLang; // only the first draw is taken
    });
    expect(id).toMatch(/^[1-9][0-9]{6}$/);
    expect(seen).toHaveLength(2 * langs.length);
    expect(new Set(seen.slice(0, langs.length).map(({ lang }) => lang))).toEqual(new Set(langs));
    expect(new Set(seen.slice(langs.length).map(({ lang }) => lang))).toEqual(new Set(langs));
    await expect(mintBonusId(async () => true)).rejects.toThrow(/could not mint/);
  });
});

// A sentence puzzle as generation writes it: no `revision` — publish is what stamps one.
const SENTENCE: Omit<Puzzle, 'revision'> = {
  lang: 'fr',
  words: ['le', 'phare', 'de', 'nuit'],
  holes: [
    { pos: 1, secret: { word: 'phare', slug: 'phare' }, start: { word: 'quai', slug: 'quai' }, start_rank: 2 },
  ],
  ranks: {
    phare: {
      phare: { word: 'phare', rank: 0 },
      mer: { word: 'mer', rank: 1, dq: 255 },
      quai: { word: 'quai', rank: 2, dq: 0 },
    },
  },
};

// CONTRACT (#203, root AGENTS.md `revision`): the stamp is a hash of the COMPLETE content,
// rank maps included. An identical republish is the same value, so nobody's round is
// disturbed; any correction mints a new one, which restarts the rounds playing the old.
describe('puzzleRevision — which published version this is', () => {
  it('is the same value for the same content', () => {
    expect(puzzleRevision(SENTENCE)).toBe(puzzleRevision(structuredClone(SENTENCE)));
  });

  it('ignores a stamp already on the input, so a puzzle read back out of the store republishes as itself', () => {
    const stamped = { ...SENTENCE, revision: puzzleRevision(SENTENCE) };
    expect(puzzleRevision(stamped)).toBe(stamped.revision);
  });

  it('changes when a rank map alone changes, no hole touched', () => {
    // Rank 0 is a GROUP: a correction that only adds an alias decides whether a guess solves.
    const corrected = structuredClone(SENTENCE);
    corrected.ranks.phare.phares = { word: 'phare', rank: 0 };
    expect(corrected.holes).toEqual(SENTENCE.holes);
    expect(puzzleRevision(corrected)).not.toBe(puzzleRevision(SENTENCE));
  });

  it('is a tag the round route accepts', () => {
    // A stamp outside this shape would 400 every /round call for the day.
    expect(puzzleRevision(SENTENCE)).toMatch(PUZZLE_TAG_SHAPE);
  });
});

// CONTRACT (root AGENTS.md, single-word artifact): a #154 artifact is never published or
// served — `puzzle:publish` refuses it, along with anything it cannot name a language for.
describe('puzzleLang — only a sentence puzzle is published', () => {
  it('names the language of a sentence puzzle', () => {
    expect(puzzleLang(SENTENCE, 'a.json')).toBe('fr');
  });

  it('refuses a single-word artifact, which has no holes', () => {
    const word: WordPuzzle = {
      lang: 'fr',
      word: { word: 'phare', slug: 'phare' },
      ranks: { phare: { word: 'phare', rank: 0 }, mer: { word: 'mer', rank: 1, dq: 255 } },
    };
    expect(() => puzzleLang(word, 'phare.json')).toThrow(/phare\.json: not a sentence puzzle/);
    expect(() => puzzleLang({ ...SENTENCE, holes: [] }, 'a.json')).toThrow(/not a sentence puzzle/);
  });

  it('refuses a missing or malformed lang', () => {
    const { lang: _lang, ...unnamed } = SENTENCE;
    expect(() => puzzleLang(unnamed, 'a.json')).toThrow(/a\.json: missing\/invalid "lang"/);
    expect(() => puzzleLang({ ...SENTENCE, lang: 'FR' }, 'a.json')).toThrow(/lang/);
    expect(() => puzzleLang({ ...SENTENCE, lang: 'fra' }, 'a.json')).toThrow(/lang/);
    expect(() => puzzleLang(null, 'a.json')).toThrow(/lang/);
  });
});
