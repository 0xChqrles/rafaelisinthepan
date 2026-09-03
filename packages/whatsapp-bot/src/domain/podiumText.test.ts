import { describe, expect, it } from 'vitest';
import { dayNumber } from '@whippin/shared';
import { dayLabel, joinNames, renderPodium } from './podiumText';

const podium = {
  dayNumber: dayNumber('2026-09-01'),
  lines: [
    { position: 1, score: 3, players: [{ jid: 'a', name: 'Gab' }] },
    {
      position: 2,
      score: 4,
      players: [
        { jid: 'b', name: 'Delphine' },
        { jid: 'c', name: 'Zou' },
      ],
    },
    { position: 3, score: 7, players: [{ jid: 'd', name: 'Cami' }] },
  ],
  capped: [{ jid: 'e', name: 'Max' }],
};

describe('podium rendering (#236)', () => {
  it('prints the group\'s hand format, one line per distinct score, ∞ runs last', () => {
    expect(renderPodium(podium, 'fr')).toBe(
      [
        '🏆 Podium Whippin du 1er septembre 2026',
        '',
        '1 — Gab — 3',
        '2 — Delphine et Zou — 4',
        '3 — Cami — 7',
        '∞ — Max',
      ].join('\n'),
    );
  });

  it('places a model comment under its own line and nowhere else', () => {
    const text = renderPodium(
      podium,
      'fr',
      new Map([
        ['3', 'La brigade antidopage est en route.'],
        ['99', 'orphan'],
      ]),
    );
    expect(text).toContain('1 — Gab — 3\n_La brigade antidopage est en route._\n2 —');
    expect(text).not.toContain('orphan');
  });

  it('speaks the group language', () => {
    expect(renderPodium({ ...podium, capped: [] }, 'en')).toContain(
      '🏆 Whippin podium, September 1, 2026\n\n1 — Gab — 3\n2 — Delphine and Zou — 4',
    );
    expect(dayLabel(dayNumber('2026-03-12'), 'fr')).toBe('12 mars 2026');
    expect(joinNames(['a', 'b', 'c'], 'en')).toBe('a, b and c');
  });
});
