// CONTRACT: the route model (#117, packages/web/src/game/route.ts), asserted against the
// agreed design:
//   - a hole's neighborhood is a journey along the dq axis (#115), not a guess list: every
//     stop keeps its group's REAL position and lane;
//   - a group is one stop however many of its aliases were typed (#104), named by its
//     canonical accented form;
//   - the departure (the given start word) and "you are here" (the hole's current word) are
//     marked, the unfound final approach stays censored, roads are named only by what the
//     player DISCOVERED on them, and a guess with no rank at all falls off the map;
//   - a puzzle published before #115 carries no dq and gets NO map (and so no entry point).

import { describe, it, expect } from 'vitest';
import { buildRoute, hasRoute, routeGeometry, APPROACH_TOP, DQ_MAX } from './route';
import type { RankEntry, RuntimeHole } from '@whippin/shared';

// A hand-built rank map with real geometry: `n` groups, dq falling linearly from 255 to 0,
// roads on the first `roadTop` groups (round-robin over `roadCount` lanes, but always with
// rank 1 on lane 0 so the ids stay numbered by closest member like generation's).
function mkMap(
  n: number,
  { roadTop = 0, roadCount = 1 }: { roadTop?: number; roadCount?: number } = {},
): Record<string, RankEntry> {
  const map: Record<string, RankEntry> = { secret: { word: 'secret', rank: 0 } };
  for (let rank = 1; rank <= n; rank += 1) {
    const dq = Math.round((DQ_MAX * (n - rank)) / (n - 1));
    const entry: RankEntry = { word: `w${rank}`, rank, dq };
    if (rank <= roadTop && roadCount > 1) entry.road = (rank - 1) % roadCount;
    map[`w${rank}`] = entry;
  }
  return map;
}

function hole(rank: number, startRank = 100): RuntimeHole {
  return { pos: 0, secret: 'secret', word: `w${rank}`, rank, startRank };
}

function route(
  map: Record<string, RankEntry>,
  tried: string[],
  h: RuntimeHole,
  startSlug = 'w100',
) {
  return buildRoute({
    rankMap: map,
    tried,
    hole: h,
    startSlug,
    secretWord: 'secret',
    number: 2,
  });
}

describe('placement — every stop keeps its group geometry', () => {
  const map = mkMap(300, { roadTop: 150, roadCount: 3 });

  it('carries each stop dq and lane straight from its entry, closest-first', () => {
    const model = route(map, ['w200', 'w5', 'w40'], hole(5))!;
    expect(model.stops.map((s) => s.rank)).toEqual([5, 40, 100, 200]);
    for (const stop of model.stops) expect(stop.dq).toBe(map[`w${stop.rank}`].dq);
    expect(model.stops.find((s) => s.rank === 5)!.road).toBe(map.w5.road);
    expect(model.stops.find((s) => s.rank === 40)!.road).toBe(map.w40.road);
  });

  it('puts a group below the fork on the trunk — no lane', () => {
    const model = route(map, ['w200'], hole(100))!;
    expect(model.stops.find((s) => s.rank === 200)!.road).toBeNull();
  });

  it('forks where the data says: the dq of the farthest group that still has a road', () => {
    const model = route(map, [], hole(100))!;
    expect(model.forkDq).toBe(map.w150.dq);
    expect(model.roads).toHaveLength(3);
  });

  it('names the destination only once the hole is solved', () => {
    expect(route(map, ['w5'], hole(5))!.secret).toBeNull();
    const solved = route(map, ['w5', 'secret'], hole(0))!;
    expect(solved.secret).toBe('secret');
    expect(solved.solved).toBe(true);
    // The secret is the terminus, off the dq scale — never a stop on the axis.
    expect(solved.stops.some((s) => s.rank === 0)).toBe(false);
  });
});

describe('canonical dedupe — one GROUP is one stop (#104)', () => {
  it('collapses aliases of one group, keeping the canonical form', () => {
    const map = mkMap(50);
    map.privees = { word: 'privé', rank: 7, dq: map.w7.dq };
    map.privee = { word: 'privé', rank: 7, dq: map.w7.dq };
    const model = route(map, ['privees', 'privee'], hole(7), 'w40')!;
    const seven = model.stops.filter((s) => s.rank === 7);
    expect(seven).toHaveLength(1);
    expect(seven[0].word).toBe('privé');
  });

  it('keeps the departure marker when the start is re-typed as an alias', () => {
    const map = mkMap(50);
    map.startbis = { word: map.w40.word, rank: 40, dq: map.w40.dq };
    const model = route(map, ['startbis'], hole(40), 'w40')!;
    const stop = model.stops.filter((s) => s.rank === 40);
    expect(stop).toHaveLength(1);
    expect(stop[0].start).toBe(true);
  });
});

describe('markers — departure and "you are here"', () => {
  const map = mkMap(300, { roadTop: 150, roadCount: 2 });

  it('always plots the given start word, marked as the departure', () => {
    const model = route(map, [], hole(100))!;
    expect(model.stops).toHaveLength(1);
    expect(model.stops[0]).toMatchObject({ rank: 100, start: true, best: true });
  });

  it('moves "you are here" to the hole current rank, leaving the departure where it is', () => {
    const model = route(map, ['w200', 'w12'], hole(12))!;
    expect(model.stops.find((s) => s.best)!.rank).toBe(12);
    expect(model.stops.find((s) => s.start)!.rank).toBe(100);
    expect(model.stops.filter((s) => s.best)).toHaveLength(1);
  });

  it('drops "you are here" entirely on a solved hole — the terminus is where you are', () => {
    const model = route(map, ['w12', 'secret'], hole(0))!;
    expect(model.stops.some((s) => s.best)).toBe(false);
  });
});

describe('the censored final approach', () => {
  const map = mkMap(300, { roadTop: 150, roadCount: 2 });

  it('hides exactly the closest groups not yet found, with their real positions', () => {
    const model = route(map, ['w3'], hole(3))!;
    expect(model.hidden.map((h) => h.rank)).toEqual([1, 2, 4, 5]);
    expect(model.hidden).toHaveLength(APPROACH_TOP - 1);
    for (const h of model.hidden) {
      expect(h.dq).toBe(map[`w${h.rank}`].dq);
      expect(h.road).toBe(map[`w${h.rank}`].road);
    }
  });

  it('hides all of them before the player gets close', () => {
    expect(route(map, ['w200'], hole(100))!.hidden.map((h) => h.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps hiding the ones still unfound after the solve', () => {
    const model = route(map, ['w2', 'secret'], hole(0))!;
    expect(model.hidden.map((h) => h.rank)).toEqual([1, 3, 4, 5]);
  });
});

describe('roads are named by DISCOVERY, never by what is on them', () => {
  const map = mkMap(300, { roadTop: 150, roadCount: 3 });

  it('titles a lane with the best word the player found there', () => {
    // w4 and w7 share lane 0 (ranks 1,4,7,… round-robin over 3 lanes); w4 is closer.
    const model = route(map, ['w7', 'w4'], hole(4))!;
    expect(map.w4.road).toBe(0);
    expect(map.w7.road).toBe(0);
    expect(model.roads[0].label).toBe('w4');
  });

  it('leaves an unexplored lane censored', () => {
    const model = route(map, ['w4'], hole(4))!;
    expect(model.roads[0].label).toBe('w4');
    expect(model.roads[1].label).toBeNull();
    expect(model.roads[2].label).toBeNull();
  });

  it('lets the given start word title its own lane (it is already on screen)', () => {
    const model = route(map, [], hole(100))!;
    expect(model.roads[map.w100.road!].label).toBe('w100');
  });

  it('never lets a trunk guess title a lane', () => {
    const model = route(map, ['w200'], hole(100), 'w151')!;
    expect(model.roads.every((r) => r.label === null)).toBe(true);
  });
});

describe('the MISS shelf — off the map', () => {
  it('partitions guesses with no rank at all, in try order', () => {
    const map = mkMap(50);
    const model = route(map, ['pizza', 'w20', 'tarte', 'w7'], hole(7), 'w40')!;
    expect(model.misses).toEqual(['pizza', 'tarte']);
    expect(model.stops.map((s) => s.rank)).toEqual([7, 20, 40]);
  });
});

describe('one road ⇒ no fork', () => {
  it('collapses to a single lane when the neighborhood has no honest split', () => {
    // Generation's mandatory fallback: every near group carries road 0.
    const map = mkMap(300, { roadTop: 150, roadCount: 1 });
    for (let rank = 1; rank <= 150; rank += 1) map[`w${rank}`].road = 0;
    const model = route(map, ['w4', 'w200'], hole(4))!;
    expect(model.roads).toHaveLength(1);
    expect(model.roads[0].label).toBe('w4');
    expect(model.forkDq).toBe(map.w150.dq);
  });

  it('also handles a map generated with no road field at all (--no-roads)', () => {
    const map = mkMap(300, { roadTop: 150, roadCount: 1 });
    const model = route(map, ['w4', 'w200'], hole(4))!;
    expect(model.roads).toHaveLength(1);
    expect(model.stops.every((s) => s.road === null)).toBe(true);
  });
});

describe('a puzzle without dq has no map at all', () => {
  const legacy: Record<string, RankEntry> = {
    secret: { word: 'secret', rank: 0 },
    w1: { word: 'w1', rank: 1 },
    w40: { word: 'w40', rank: 40 },
  };

  it('reports no route, so the hole gets no entry point', () => {
    expect(hasRoute(legacy)).toBe(false);
    expect(hasRoute(undefined)).toBe(false);
    expect(hasRoute(mkMap(20))).toBe(true);
  });

  it('builds nothing rather than a degraded list', () => {
    expect(route(legacy, ['w1'], hole(1), 'w40')).toBeNull();
  });
});

describe('geometry is read once per rank map', () => {
  it('caches per map object (the maps are immutable for a puzzle lifetime)', () => {
    const map = mkMap(200, { roadTop: 150, roadCount: 4 });
    expect(routeGeometry(map)).toBe(routeGeometry(map));
    expect(routeGeometry(map).roadCount).toBe(4);
  });
});
