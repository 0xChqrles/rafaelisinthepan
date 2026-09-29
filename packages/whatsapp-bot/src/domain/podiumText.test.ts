import { describe, expect, it } from 'vitest';
import { dayNumber } from '@whippin/shared';
import { dayLabel, podiumRows, renderPodium, renderReminder } from './podiumText';

const podium = {
  dayNumber: dayNumber('2026-09-01'),
  lines: [
    { position: 1, score: 3, player: { jid: 'a', name: 'Gab' } },
    { position: 2, score: 4, player: { jid: 'b', name: 'Delphine' } },
    { position: 2, score: 4, player: { jid: 'c', name: 'Zou' } },
    { position: 3, score: 7, player: { jid: 'd', name: 'Cami' } },
  ],
  capped: [{ jid: 'e', name: 'Max' }],
};

describe('podium rendering (#236)', () => {
  it('prints the group\'s hand format, one player per line — a tie shares the place, never the line — ∞ runs last', () => {
    expect(renderPodium(podium, 'fr')).toBe(
      [
        '🏆 Podium Whippin du 1er septembre 2026',
        '',
        '1 — Gab — 3',
        '2 — Delphine — 4',
        '2 — Zou — 4',
        '3 — Cami — 7',
        '∞ — Max',
      ].join('\n'),
    );
  });

  it('ids every printed line by its number, never by a JID', () => {
    expect(podiumRows(podium).map((r) => [r.id, r.position, r.score, r.player.name])).toEqual([
      ['1', 1, 3, 'Gab'],
      ['2', 2, 4, 'Delphine'],
      ['3', 2, 4, 'Zou'],
      ['4', 3, 7, 'Cami'],
      ['5', 4, '∞', 'Max'],
    ]);
  });

  it('places a model comment under its own line and nowhere else', () => {
    const text = renderPodium(
      podium,
      'fr',
      new Map([
        ['1', 'La brigade antidopage est en route.'],
        ['3', 'Pile à côté de Delphine.'],
        ['99', 'orphan'],
      ]),
    );
    expect(text).toContain('1 — Gab — 3\n_La brigade antidopage est en route._\n2 — Delphine — 4\n2 — Zou — 4\n_Pile à côté de Delphine._\n3 —');
    expect(text).not.toContain('orphan');
  });

  it('speaks the group language', () => {
    expect(renderPodium({ ...podium, capped: [] }, 'en')).toContain(
      '🏆 Whippin podium, September 1, 2026\n\n1 — Gab — 3\n2 — Delphine — 4\n2 — Zou — 4',
    );
    expect(dayLabel(dayNumber('2026-03-12'), 'fr')).toBe('12 mars 2026');
  });

  it("closes with the other language's results on one line, in the group's language (2026-09-29)", () => {
    const others = [{ lang: 'en', results: [{ name: 'Charles', score: 7 }, { name: 'Marie', score: 15 }, { name: 'Max', score: '∞' as const }] }];
    expect(renderPodium(podium, 'fr', new Map(), others)).toMatch(/∞ — Max\n\nCôté anglais : Charles 7 · Marie 15 · Max ∞$/);
    expect(renderPodium(podium, 'en', new Map(), [{ lang: 'fr', results: [{ name: 'Gab', score: 12 }] }])).toMatch(/\n\nIn French: Gab 12$/);
    // Nobody shared another language: no closing line, and no trailing blank.
    expect(renderPodium(podium, 'fr', new Map(), [])).toBe(renderPodium(podium, 'fr'));
    expect(renderPodium(podium, 'fr', new Map(), [{ lang: 'en', results: [] }])).toBe(renderPodium(podium, 'fr'));
  });

  it('renders the morning line: what is up, what kind of thing it is, when the podium lands, the link', () => {
    expect(renderReminder('fr', 'https://whippin.ai', 'music', '22:30')).toBe(
      "Le Whippin du jour est en ligne, c'est une chanson aujourd'hui. Podium à 22h30.\nhttps://whippin.ai",
    );
    expect(renderReminder('en', 'https://whippin.ai', 'book', '22:30')).toBe(
      "Today's Whippin is up, it's a book today. Podium at 22:30.\nhttps://whippin.ai",
    );
    // No source kind, no podium: the line still says the one thing it exists to say.
    expect(renderReminder('fr', 'https://whippin.ai', null, null)).toBe('Le Whippin du jour est en ligne.\nhttps://whippin.ai');
    // An unknown kind (the set is open) is left unsaid rather than guessed at.
    expect(renderReminder('en', 'https://whippin.ai', 'podcast', null)).toBe("Today's Whippin is up.\nhttps://whippin.ai");
  });

  it('asks the group to join its Whippin group, with the invite link, when it has one (user-decided 2026-09-14)', () => {
    const invite = 'https://whippin.ai/g/abcdefghij234567?v=20711';
    expect(renderReminder('fr', 'https://whippin.ai', 'music', '22:30', invite)).toBe(
      `Le Whippin du jour est en ligne, c'est une chanson aujourd'hui. Podium à 22h30.\nhttps://whippin.ai\nRejoignez le groupe sur Whippin : ${invite}`,
    );
    expect(renderReminder('en', 'https://whippin.ai', null, null, invite)).toBe(
      `Today's Whippin is up.\nhttps://whippin.ai\nJoin the group on Whippin: ${invite}`,
    );
  });

  it('prints the ∞ line\'s comment like any other (PR-278 review)', () => {
    // It is printed under the places and read as one of them, so the one bare slot on a
    // mixed podium was read as a snub.
    const podium = {
      dayNumber: 20700,
      lines: [{ position: 1, score: 3, player: { jid: 'a', name: 'Gab' } }],
      capped: [{ jid: 'b', name: 'Claire' }],
    };
    const text = renderPodium(podium, 'fr', new Map([['1', 'Impeccable.'], ['2', 'Tu es allée au bout.']]));
    expect(text).toContain('1 — Gab — 3\n_Impeccable._');
    expect(text).toContain('∞ — Claire\n_Tu es allée au bout._');
    // No comment for it is still a complete podium.
    expect(renderPodium(podium, 'fr', new Map([['1', 'Impeccable.']]))).toContain('∞ — Claire');
  });
});
