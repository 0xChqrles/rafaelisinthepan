import { describe, expect, it } from 'vitest';
import type { Declaration } from './declarations';
import { buildPodium } from './podium';

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
  it('groups equal scores on one line and numbers distinct scores densely', () => {
    const podium = buildPodium(20700, [
      row('Cami', 7),
      row('Zou', 4),
      row('Gab', 3),
      row('Delphine', 4),
    ]);
    expect(
      podium.lines.map((l) => [l.position, l.score, l.players.map((p) => p.name)]),
    ).toEqual([
      [1, 3, ['Gab']],
      [2, 4, ['Delphine', 'Zou']],
      [3, 7, ['Cami']],
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
    expect(podium.lines[0].players[0].name).toBe('Gab');
  });

  it('an empty day is an empty podium', () => {
    expect(buildPodium(20700, [])).toEqual({ dayNumber: 20700, lines: [], capped: [] });
  });
});
