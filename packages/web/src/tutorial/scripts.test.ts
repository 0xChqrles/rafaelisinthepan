// CONTRACT: the level-1 lesson scripts (#51, #155, remade by #269). The lesson is
// data-driven — two boards per language in scripts/<lang>.ts over REAL generated
// neighborhoods (scripts/<lang>.<word>.json, pruned #154 artifacts) — and both are meant to
// be edited, so these tests guard what an edit must not break:
//
//   - THE REVEAL is ONE hole whose clue is THE CLOSEST WORD, rank 1 (user-decided
//     2026-09-16: the secret is shown, then hidden behind its synonym, and typed back);
//   - THE WORD is ONE hole, a different word, its clue a dozen ranks out (2–20): a real
//     search that stays easy, the near field under it real (a word at every rank down to 1);
//   - THE SENTENCE is TWO holes with start words in generation's own 50–150 band — the
//     game's difficulty, one new thing at a time — each secret sitting in `words[]` at its
//     `pos` with its affixes, and every hole carrying its own hint copy;
//   - every board stays byte-compatible with the real per-puzzle schema (parsePuzzle-valid —
//     they feed the REAL game components), rank 0 is the secret, every key folds to itself
//     (the free typing lands on them), and the start words are READ OFF the maps.

import { describe, it, expect } from 'vitest';
import { fold } from '@whippin/shared';
import { parsePuzzle } from '../api';
import { scriptFor } from './scripts';
import type { LessonStage } from './script';
import { t } from '../i18n';


function checkBoard(stage: LessonStage) {
  const { puzzle } = stage;
  it('passes the real schema check (parsePuzzle) and keys every hole to its own map', () => {
    expect(() => parsePuzzle(JSON.parse(JSON.stringify(puzzle)))).not.toThrow();
    expect(Object.keys(puzzle.ranks).sort()).toEqual(
      puzzle.holes.map((h) => h.secret.slug).sort(),
    );
    expect(stage.hints).toHaveLength(puzzle.holes.length);
    for (const key of stage.hints) expect(t(puzzle.lang, key).length).toBeGreaterThan(0);
  });
  it('reads each start word off the map, the secret at rank 0, and every key fold-stable', () => {
    for (const hole of puzzle.holes) {
      const map = puzzle.ranks[hole.secret.slug];
      expect(map[hole.secret.slug].rank).toBe(0);
      expect(map[hole.start.slug].rank).toBe(hole.start_rank);
      expect(map[hole.start.slug].word).toBe(hole.start.word);
      expect(fold(hole.secret.slug)).toBe(hole.secret.slug);
      for (const key of Object.keys(map)) expect(fold(key)).toBe(key);
      // A real near field: a group at EVERY rank up to the start word, so the number the
      // player reads is a rung on a ladder that exists.
      const ranks = new Set(Object.values(map).map((e) => e.rank));
      for (let r = 1; r <= hole.start_rank; r += 1) expect(ranks.has(r), `rank ${r}`).toBe(true);
    }
  });
  it('places each secret in words[] at its pos, its affixes around it', () => {
    for (const hole of puzzle.holes) {
      const token = puzzle.words[hole.pos];
      expect(token).toBe(`${hole.prefix ?? ''}${hole.secret.word}${hole.suffix ?? ''}`);
    }
    const positions = puzzle.holes.map((h) => h.pos);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
}

const SEARCH_START_MAX = 20;

for (const lang of ['en', 'fr'] as const) {
  describe(`lesson script (${lang})`, () => {
    const script = scriptFor(lang);
    const [reveal, word, sentence] = script.stages;

    it('plays the reveal, then a word, then the sentence', () => {
      expect(script.stages.map((s) => s.kind)).toEqual(['reveal', 'word', 'sentence']);
    });

    describe('the reveal: one word, hidden behind its closest word', () => {
      checkBoard(reveal);
      it('is one word whose clue is rank 1', () => {
        expect(reveal.puzzle.words).toHaveLength(1);
        expect(reveal.puzzle.holes).toHaveLength(1);
        expect(reveal.puzzle.holes[0].pos).toBe(0);
        expect(reveal.puzzle.holes[0].start_rank).toBe(1);
      });
    });

    describe('the word: one word, a real search', () => {
      checkBoard(word);
      it('is another word, its clue a dozen ranks out', () => {
        expect(word.puzzle.words).toHaveLength(1);
        expect(word.puzzle.holes).toHaveLength(1);
        const [hole] = word.puzzle.holes;
        expect(hole.secret.slug).not.toBe(reveal.puzzle.holes[0].secret.slug);
        expect(hole.start_rank).toBeGreaterThan(1);
        expect(hole.start_rank).toBeLessThanOrEqual(SEARCH_START_MAX);
      });
    });

    describe('the sentence: two holes, the game’s own start band', () => {
      checkBoard(sentence);
      it('is a short sentence with two distinct secrets started in the 50–150 band', () => {
        const { puzzle } = sentence;
        expect(puzzle.holes).toHaveLength(2);
        expect(puzzle.words.length).toBeLessThanOrEqual(8);
        expect(new Set(puzzle.holes.map((h) => h.secret.slug)).size).toBe(2);
        for (const hole of puzzle.holes) {
          expect(hole.start_rank).toBeGreaterThanOrEqual(50);
          expect(hole.start_rank).toBeLessThanOrEqual(150);
        }
      });
      it('uses words the single-word stages did not', () => {
        const used = [reveal, word].map((s) => s.puzzle.holes[0].secret.slug);
        for (const hole of sentence.puzzle.holes) expect(used).not.toContain(hole.secret.slug);
      });
    });
  });
}
