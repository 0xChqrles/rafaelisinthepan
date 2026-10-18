import { describe, expect, it } from 'vitest';
import { letterRuns, revealsSentence, secretsOf } from './spoilers';

const puzzle = {
  words: ['je', 'marche', 'seul', 'dans', 'la', 'nuit,', "t'attends", 'rien'],
  holes: [
    { pos: 2, secret: { word: 'seul' } },
    { pos: 6, secret: { word: 'attends' }, prefix: "t'" },
  ],
};
const secrets = secretsOf(puzzle);

describe("today's sentence, as the guard reads it (v22)", () => {
  it('reads every text as folded letter runs, whatever the punctuation', () => {
    expect(letterRuns("Peut-être, t’Attends… l'Été")).toEqual(['peut', 'etre', 't', 'attends', 'l', 'ete']);
    expect(letterRuns('{"words":["je","marche"]}')).toEqual(['words', 'je', 'marche']);
    expect(letterRuns('dans\\, la\\. nuit')).toEqual(['dans', 'la', 'nuit']);
  });

  it("hides the secret's own runs, never the elision glued to it", () => {
    expect(secrets?.words).toEqual(['je', 'marche', 'seul', 'dans', 'la', 'nuit', 't', 'attends', 'rien']);
    expect(secrets?.hidden).toEqual([false, false, true, false, false, false, false, true, false]);
    expect(secretsOf(null)).toBeNull();
    expect(secretsOf({ words: ['a'], holes: [] })).toBeNull();
  });

  it('catches the line quoted across a hole: lyrics, a page, the puzzle JSON itself', () => {
    expect(revealsSentence('Paroles : « Je marche seul dans la nuit »', secrets)).toBe(true);
    expect(revealsSentence('dans la nuit, t’attends rien', secrets)).toBe(true);
    expect(revealsSentence('{"words":["je","marche","seul","dans"]}', secrets)).toBe(true);
  });

  it('lets through a hidden word alone, and the visible words alone', () => {
    expect(revealsSentence('Je suis seul ce soir, tu attends qui ?', secrets)).toBe(false);
    expect(revealsSentence('je marche ... dans la nuit', secrets)).toBe(false);
    expect(revealsSentence('anything', null)).toBe(false);
  });
});
