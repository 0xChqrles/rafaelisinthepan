// CONTRACT: the on-screen keyboard's live vocab validation (issue #36). The greyed-out
// state of every letter/dash is decided by a PREFIX SET built from the full vocabulary
// (public/vocab/<lang>.json), not by a puzzle's rank map. This asserts the SPEC:
//   - buildPrefixSet holds EVERY prefix of every word (full word included), never "";
//   - canExtend(prefixSet, input, char) = "can this char keep the input a real prefix?"
//     for the active / greyed / empty-input / dash cases;
//   - Enter validity is separate (exact vocabSet membership), NOT the prefix set;
//   - layout defaults follow the puzzle language and flip cleanly.

import { describe, it, expect } from 'vitest';
import {
  buildPrefixSet,
  canExtend,
  defaultLayoutForLang,
  otherLayout,
  LAYOUTS,
} from './keyboard';

// A small fixture vocab (folded slugs): a shared stem (chat/chien), a hyphenated word,
// and a ligature-derived word. Real vocab.json holds hundreds of thousands of these.
const VOCAB = ['chat', 'chien', 'arc-en-ciel', 'oeuf'];

describe('buildPrefixSet — every prefix of every word, "" excluded', () => {
  const prefixes = buildPrefixSet(VOCAB);

  it('includes every character-prefix, the full word included', () => {
    for (const p of ['c', 'ch', 'cha', 'chat', 'chi', 'chie', 'chien', 'o', 'oe', 'oeu', 'oeuf']) {
      expect(prefixes.has(p)).toBe(true);
    }
  });

  it('keeps a partial hyphenated word (trailing dash) as a real prefix', () => {
    // "arc-" is a prefix of "arc-en-ciel", so the dash stays typable mid-word.
    for (const p of ['a', 'ar', 'arc', 'arc-', 'arc-e', 'arc-en', 'arc-en-', 'arc-en-ciel']) {
      expect(prefixes.has(p)).toBe(true);
    }
  });

  it('never includes the empty string', () => {
    expect(prefixes.has('')).toBe(false);
  });

  it('excludes strings that no word starts with', () => {
    for (const p of ['cho', 'x', 'zz', 'chatt', 'oa']) {
      expect(prefixes.has(p)).toBe(false);
    }
  });
});

describe('canExtend — greyed vs active letters', () => {
  const prefixes = buildPrefixSet(VOCAB);

  it('empty input: only letters that start some word are active', () => {
    // active
    for (const c of ['c', 'a', 'o']) expect(canExtend(prefixes, '', c)).toBe(true);
    // greyed (no word starts with them)
    for (const c of ['b', 'z', 'x']) expect(canExtend(prefixes, '', c)).toBe(false);
  });

  it('after a shared stem, only real continuations are active', () => {
    // "ch" -> "cha" (chat) and "chi" (chien) are active; "che" is a dead end.
    expect(canExtend(prefixes, 'ch', 'a')).toBe(true);
    expect(canExtend(prefixes, 'ch', 'i')).toBe(true);
    expect(canExtend(prefixes, 'ch', 'e')).toBe(false);
    expect(canExtend(prefixes, 'ch', 'o')).toBe(false);
  });

  it('a completed word greys out every further letter', () => {
    // "chat" is complete and nothing extends it further.
    for (const c of ['s', 'a', 'e', '-']) expect(canExtend(prefixes, 'chat', c)).toBe(false);
  });

  it('dash is active only where a real word continues with a dash', () => {
    expect(canExtend(prefixes, 'arc', '-')).toBe(true); // arc-en-ciel
    expect(canExtend(prefixes, 'arc-en', '-')).toBe(true); // arc-en-ciel
    expect(canExtend(prefixes, 'chat', '-')).toBe(false);
    expect(canExtend(prefixes, '', '-')).toBe(false); // no word starts with a dash
  });
});

describe('layout selection', () => {
  it('defaults from the puzzle language (fr -> azerty, otherwise qwerty)', () => {
    expect(defaultLayoutForLang('fr')).toBe('azerty');
    expect(defaultLayoutForLang('en')).toBe('qwerty');
    expect(defaultLayoutForLang('de')).toBe('qwerty');
  });

  it('otherLayout flips', () => {
    expect(otherLayout('azerty')).toBe('qwerty');
    expect(otherLayout('qwerty')).toBe('azerty');
  });

  it('both layouts expose the full a–z (only order differs)', () => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz'.split('').sort();
    for (const layout of ['azerty', 'qwerty'] as const) {
      const letters = LAYOUTS[layout].flat().slice().sort();
      expect(letters).toEqual(alphabet);
    }
  });
});
