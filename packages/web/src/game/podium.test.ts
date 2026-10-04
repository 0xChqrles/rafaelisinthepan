import { describe, expect, it } from 'vitest';
import { dayPodium, periodPodium, stepTier } from './podium';

// The podium's pick decides who is drawn where: a row it dropped, or drew twice, would be a
// player missing from (or doubled on) their own group's board.
const day = (ranks: number[], scores: number[]) =>
  ranks.map((rank, i) => ({ publicId: `p${i}`, rank, score: scores[i] }));

describe('dayPodium', () => {
  it('stands the first three rows on the podium and keeps every other row a line, in order', () => {
    const rows = day([1, 2, 3, 4, 5], [8, 14, 34, 36, 40]);
    const { places, lines } = dayPodium(rows);
    expect(places.map((p) => p?.row.publicId)).toEqual(['p0', 'p1', 'p2']);
    expect(lines.map((r) => r.publicId)).toEqual(['p3', 'p4']);
    expect(places.map((p) => p?.value)).toEqual([8, 14, 34]);
  });

  it('keeps the server ranks — a tie for first is two rank-1 places, never re-ranked', () => {
    const { places } = dayPodium(day([1, 1, 3], [8, 8, 12]));
    expect(places.map((p) => p?.rank)).toEqual([1, 1, 3]);
    expect(places.map((p) => stepTier(p?.rank ?? 99))).toEqual([0, 0, 2]);
  });

  it('leaves the places nobody holds empty', () => {
    expect(dayPodium(day([1], [8])).places.map((p) => p?.row.publicId ?? null)).toEqual(['p0', null, null]);
    expect(dayPodium([]).places).toEqual([null, null, null]);
    expect(dayPodium([]).lines).toEqual([]);
  });

  it('reads how close each place is to the best: the best is 100, fewer tries nearer', () => {
    const { places } = dayPodium(day([1, 2, 3], [8, 16, 32]));
    expect(places.map((p) => p?.near)).toEqual([100, 50, 25]);
  });
});

describe('periodPodium', () => {
  it('carries the points, nearness as a share of the best points', () => {
    const rows = [
      { publicId: 'a', rank: 1, points: 6 },
      { publicId: 'b', rank: 2, points: 3 },
      { publicId: 'c', rank: 3, points: 0 },
      { publicId: 'd', rank: 4, points: 0 },
    ];
    const { places, lines } = periodPodium(rows);
    expect(places.map((p) => p?.value)).toEqual([6, 3, 0]);
    expect(places.map((p) => p?.near)).toEqual([100, 50, 0]);
    expect(lines.map((r) => r.publicId)).toEqual(['d']);
  });
});
