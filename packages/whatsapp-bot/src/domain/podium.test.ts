import { describe, expect, it } from 'vitest';
import type { Declaration } from './declarations';
import { buildPodium, otherLanguages } from './podium';

function row(name: string, score: number, capped = false): Declaration {
  return {
    group: 'g@g.us',
    dayNumber: 20700,
    sender: `${name.toLowerCase()}@s.whatsapp.net`,
    score,
    capped,
    token: 't',
    messageId: 'm',
    messageTs: 1,
    name,
    receivedAt: '',
    lang: 'fr',
  };
}

describe('dense podium (#236)', () => {
  it('gives every player a line of their own; equal scores share the place, densely numbered (2026-09-29)', () => {
    const podium = buildPodium(20700, [
      row('Cami', 7),
      row('Zou', 4),
      row('Gab', 3),
      row('Delphine', 4),
    ]);
    expect(podium.lines.map((l) => [l.position, l.score, l.player.name])).toEqual([
      [1, 3, 'Gab'],
      [2, 4, 'Delphine'],
      [2, 4, 'Zou'],
      [3, 7, 'Cami'],
    ]);
  });

  it('keeps ∞ runs off the positions and ignores rows of another day', () => {
    const podium = buildPodium(20700, [
      row('Gab', 3),
      row('Max', 500, true),
      { ...row('Old', 1), dayNumber: 20699 },
    ]);
    expect(podium.lines).toHaveLength(1);
    expect(podium.capped.map((p) => p.name)).toEqual(['Max']);
  });

  it('applies the caller\'s name resolution (operator overrides)', () => {
    const podium = buildPodium(20700, [row('Gabriel', 3)], (d) =>
      d.sender.startsWith('gabriel') ? 'Gab' : d.name,
    );
    expect(podium.lines[0].player.name).toBe('Gab');
  });

  it('an empty day is an empty podium', () => {
    expect(buildPodium(20700, [])).toEqual({ dayNumber: 20700, lines: [], capped: [] });
  });
});

describe("the other languages' results (2026-09-29)", () => {
  it('lists each other language apart, best first and ∞ last, never the group\'s own', () => {
    const en = (name: string, score: number, capped = false) => ({ ...row(name, score, capped), lang: 'en' });
    const rows = [row('Gab', 3), en('Zou', 9), en('Cami', 5), en('Max', 500, true), { ...en('Old', 1), dayNumber: 20699 }];
    expect(otherLanguages(20700, rows, 'fr')).toEqual([
      { lang: 'en', results: [{ name: 'Cami', score: 5 }, { name: 'Zou', score: 9 }, { name: 'Max', score: '∞' }] },
    ]);
    expect(otherLanguages(20700, [row('Gab', 3)], 'fr')).toEqual([]);
  });
});
