import { describe, expect, it } from 'vitest';
import { roundOnScreen, type RoundOnScreen } from './roundOnScreen';

type Shown = RoundOnScreen<{ revision: string }, object, { guesses: string[] }>;

const puzzle = { revision: 'r1' };
const vocab = {};
const shown = (over: Partial<Shown> = {}): Shown => ({
  roundKey: 'd:1:fr',
  puzzle,
  vocab,
  server: { guesses: ['mer'] },
  ...over,
});

describe('roundOnScreen (the round in play is never taken off the screen by a read)', () => {
  it('draws the round from the three reads once they are in', () => {
    const live = shown();
    expect(roundOnScreen(null, live, live.roundKey)).toBe(live);
  });

  it('shows nothing while a first read is out', () => {
    expect(roundOnScreen(null, null, 'd:1:fr')).toBeNull();
  });

  it('keeps the same object while nothing changed (no render loop)', () => {
    const kept = shown();
    expect(roundOnScreen(kept, { ...kept }, kept.roundKey)).toBe(kept);
  });

  it('takes every new answer', () => {
    const kept = shown();
    const next = shown({ server: { guesses: ['mer', 'océan'] } });
    expect(roundOnScreen(kept, next, kept.roundKey)).toBe(next);
  });

  it('keeps the round standing while its read is re-armed (an identity adopted from another tab)', () => {
    const kept = shown();
    expect(roundOnScreen(kept, null, kept.roundKey)).toBe(kept);
  });

  it('keeps the round standing through a republish restart until the new version answers', () => {
    const kept = shown();
    expect(roundOnScreen(kept, null, kept.roundKey)).toBe(kept);
    const republished = shown({ puzzle: { revision: 'r2' }, server: { guesses: [] } });
    expect(roundOnScreen(kept, republished, kept.roundKey)).toBe(republished);
  });

  it('lets another round start over, and never brings the old one back', () => {
    const kept = shown();
    const away = roundOnScreen(kept, null, 'd:2:fr');
    expect(away).toBeNull();
    // Back on the first round's key with its read out again: nothing to resurrect.
    expect(roundOnScreen(away, null, kept.roundKey)).toBeNull();
  });
});
