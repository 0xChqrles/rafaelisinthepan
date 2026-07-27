// CONTRACT: the route model (#117, packages/web/src/game/route.ts), asserted against the
// agreed design:
//   - a hole's neighborhood is a journey along the dq axis (#115), not a guess list: every
//     stop keeps its group's REAL position and lane;
//   - a group is one stop however many of its aliases were typed (#104), named by its
//     canonical accented form;
//   - the departure (the given start word) and "you are here" (the hole's current word) are
//     marked, EVERY near-field group the player has not reached stays censored (so each road
//     shows its real length), roads are named only by what the player DISCOVERED on them, and a
//     guess with no rank at all falls off the map;
//   - the near field IS the road zone, and nothing here re-bounds it: generation ends the roads
//     at the DEPARTURE (#115's road_zone), which rides one of them, so the censored stations end
//     just inside it for free;
//   - a puzzle published before #115 carries no dq and gets NO map (and so no entry point).

import { describe, it, expect } from 'vitest';
import { buildRoute, hasRoute, routeGeometry, APPROACH_TOP, DQ_MAX } from './route';
import type { RankEntry, RuntimeHole } from '@whippin/shared';

// A hand-built rank map with real geometry: `n` groups, dq falling linearly from 255 to 0,
// roads on the first `roadTop` groups (round-robin over `roadCount` lanes, but always with
// rank 1 on lane 0 so the ids stay numbered by closest member like generation's).
//
// `roadTop` is a generated puzzle's DEPARTURE — generation cuts the roads from the start word in
// to the secret, that word included — so a fixture played from w100 carries roads out to rank 100.
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
  const map = mkMap(300, { roadTop: 100, roadCount: 3 });

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

  it('puts the DEPARTURE on a lane — the player is put down on a road, not short of it', () => {
    const model = route(map, [], hole(100))!;
    expect(model.stops.find((s) => s.start)!.road).toBe(map.w100.road);
    expect(map.w100.road).not.toBeUndefined();
  });

  it('forks where the data says: the dq of the farthest group that still has a road', () => {
    const model = route(map, [], hole(100))!;
    // The departure is the farthest station on a lane, so the fork lands just before it.
    expect(model.forkDq).toBe(map.w100.dq);
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
  const map = mkMap(300, { roadTop: 100, roadCount: 2 });

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

  it('takes "you are here" from the HOLE, not from the guess log', () => {
    // The log is not a complete record of how the player got here: a guess deduped as a
    // canonical duplicate never enters `tried` (gameStore.recordGuess) yet can still improve
    // ANOTHER hole. So the current group can be one the history never mentions — and it is
    // still where the player stands.
    const model = route(map, ['w200'], hole(5))!;
    expect(model.stops.find((s) => s.best)!.rank).toBe(5);
    expect(model.stops.filter((s) => s.best)).toHaveLength(1);
    // It is a place they have been, so it is a STOP like any other — carrying its group's own
    // geometry — and never a censored station: the map cannot hide the word the sentence shows.
    const here = model.stops.find((s) => s.rank === 5)!;
    expect(here).toMatchObject({ word: map.w5.word, dq: map.w5.dq, road: map.w5.road });
    expect(model.hidden.some((h) => h.rank === 5)).toBe(false);
  });

  it('finds that position even with no near field to read it from (--no-roads)', () => {
    const noRoads = mkMap(300);
    const model = route(noRoads, [], hole(42))!;
    expect(model.stops.find((s) => s.best)).toMatchObject({ rank: 42, dq: noRoads.w42.dq });
  });

  it('marks nothing rather than the wrong station when the position has no entry', () => {
    // Defensive: a rank the map cannot account for is not a reason to promote the closest
    // logged stop — that is exactly the marker landing on a word the player has moved past.
    const model = route(map, ['w200'], hole(7000))!;
    expect(model.stops.some((s) => s.best)).toBe(false);
  });
});

describe('the censored near field — every group on the roads', () => {
  const map = mkMap(300, { roadTop: 100, roadCount: 2 });

  it('hides EVERY near-field group not yet found, with its real position and lane', () => {
    const model = route(map, ['w3'], hole(3))!;
    // The near field runs from the DEPARTURE (w100) in, minus the ones already reached: the
    // guess w3 and the start itself.
    expect(model.hidden.map((h) => h.rank)).toEqual(
      Array.from({ length: 100 }, (_, i) => i + 1).filter((r) => r !== 3 && r !== 100),
    );
    for (const h of model.hidden) {
      expect(h.dq).toBe(map[`w${h.rank}`].dq);
      expect(h.road).toBe(map[`w${h.rank}`].road);
    }
  });

  it('ends where the roads end — at the departure, wherever generation put it', () => {
    // Nothing here clips the zone: the map for a hole started at rank 60 simply carries roads
    // out to 60, and the departure is a STOP, so the farthest censored one sits just inside it.
    for (const startRank of [60, 140]) {
      const own = mkMap(300, { roadTop: startRank, roadCount: 2 });
      const model = route(own, [], hole(startRank), `w${startRank}`)!;
      expect(model.hidden.every((h) => h.rank < startRank)).toBe(true);
      expect(model.hidden.at(-1)!.rank).toBe(startRank - 1);
    }
    // A guess FARTHER than the departure is still a stop — it just rides the trunk, where the
    // departure itself is on a lane.
    const far = mkMap(300, { roadTop: 60, roadCount: 2 });
    const model = route(far, ['w130'], hole(60), 'w60')!;
    expect(model.stops.map((s) => s.rank)).toEqual([60, 130]);
    expect(model.stops.find((s) => s.rank === 130)!.road).toBeNull();
    expect(model.stops.find((s) => s.rank === 60)!.road).toBe(far.w60.road);
    expect(model.hidden.at(-1)!.rank).toBe(59);
  });

  it('takes its extent from the DATA, not from a constant', () => {
    // A road zone that stops short of the departure (a start hand-picked past ROAD_TOP) bounds
    // the censored stations at ITS end instead — whichever comes first wins.
    const short = mkMap(300, { roadTop: 40, roadCount: 2 });
    expect(route(short, [], hole(100))!.hidden.at(-1)!.rank).toBe(40);
    expect(route(map, [], hole(100))!.hidden.at(-1)!.rank).toBe(99);
  });

  it('never lists a group the player has reached', () => {
    const model = route(map, ['w7', 'w80', 'w200'], hole(7))!;
    const hiddenRanks = new Set(model.hidden.map((h) => h.rank));
    for (const stop of model.stops) expect(hiddenRanks.has(stop.rank)).toBe(false);
    // Three of the four stops are inside the near field (7, 80, the start 100); w200 is past the
    // roads, so it is a stop on the trunk and takes nothing out of the near field.
    expect(model.stops.map((s) => s.rank)).toEqual([7, 80, 100, 200]);
    expect(model.hidden).toHaveLength(100 - 3);
  });

  it('withholds every censored word while the round is live', () => {
    const model = route(map, ['w3'], hole(3))!;
    expect(model.hidden.every((h) => h.word === null)).toBe(true);
  });

  it('reveals every censored word once the hole is solved', () => {
    const model = route(map, ['w2', 'secret'], hole(0))!;
    expect(model.hidden.map((h) => h.rank).slice(0, 4)).toEqual([1, 3, 4, 5]);
    // Everything from the departure in, but the guess w2 and the start w100.
    expect(model.hidden).toHaveLength(98);
    // Each one carries its group's canonical form, not a placeholder.
    for (const h of model.hidden) expect(h.word).toBe(map[`w${h.rank}`].word);
  });

  it('falls back to the APPROACH_TOP floor when the map carries no roads at all', () => {
    // --no-roads (or any pre-#115 day that still has dq): no near field to bound, so the closest
    // few are still censored rather than the map showing none.
    const noRoads = mkMap(300);
    expect(route(noRoads, ['w200'], hole(100), 'w100')!.hidden.map((h) => h.rank)).toEqual(
      Array.from({ length: APPROACH_TOP }, (_, i) => i + 1),
    );
  });
});

describe('roads are named by DISCOVERY, never by what is on them', () => {
  const map = mkMap(300, { roadTop: 100, roadCount: 3 });

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
    // w200 is past the departure, so it carries no road and names nothing. The start is the
    // one lane station here, and it titles only its own.
    const model = route(map, ['w200'], hole(100))!;
    expect(model.roads.filter((r) => r.label !== null)).toHaveLength(1);
    expect(model.roads[map.w100.road!].label).toBe('w100');
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
    // Generation's mandatory fallback: every group of the zone carries road 0.
    const map = mkMap(300, { roadTop: 100, roadCount: 1 });
    for (let rank = 1; rank <= 100; rank += 1) map[`w${rank}`].road = 0;
    const model = route(map, ['w4', 'w200'], hole(4))!;
    expect(model.roads).toHaveLength(1);
    expect(model.roads[0].label).toBe('w4');
    expect(model.forkDq).toBe(map.w100.dq);
  });

  it('also handles a map generated with no road field at all (--no-roads)', () => {
    const map = mkMap(300, { roadTop: 100, roadCount: 1 });
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
    const map = mkMap(200, { roadTop: 100, roadCount: 4 });
    expect(routeGeometry(map)).toBe(routeGeometry(map));
    expect(routeGeometry(map).lanes.size).toBe(4);
  });
});

describe('lanes cost what the DATA holds, never what an id claims', () => {
  it('allocates one lane per DISTINCT road, in ascending id order', () => {
    // A road id is a number off the network. Sizing the lane array by `max id + 1` handed it
    // the allocation: `road: 4294967295` is a well-formed non-negative integer and threw
    // RangeError, while smaller hostile values just ate memory. The parse layer caps the value
    // (api.ts MAX_ROAD); the model additionally never lets an id BE a length.
    const map = mkMap(300, { roadTop: 100, roadCount: 2 });
    for (let rank = 1; rank <= 100; rank += 1) map[`w${rank}`].road = rank % 2 === 1 ? 0 : 4294967295;
    const model = route(map, ['w4'], hole(4))!;
    expect(model.roads).toHaveLength(2);
    // Ascending, so generation's own ordering survives: the road holding rank 1 stays lane 0.
    expect(model.stops.find((s) => s.rank === 1 || s.rank === 3)?.road ?? 0).toBe(0);
    expect(model.stops.find((s) => s.rank === 4)!.road).toBe(1);
    expect(model.roads[1].label).toBe('w4');
  });

  it('leaves a generated map untouched — contiguous ids already ARE their lanes', () => {
    const map = mkMap(300, { roadTop: 100, roadCount: 3 });
    const model = route(map, ['w4', 'w5', 'w6'], hole(4))!;
    for (const stop of model.stops) {
      expect(stop.road).toBe(map[`w${stop.rank}`].road ?? null);
    }
    for (const h of model.hidden) expect(h.road).toBe(map[`w${h.rank}`].road);
  });
});
