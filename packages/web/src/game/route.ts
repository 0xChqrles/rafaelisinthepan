// The ROUTE model (#117): one hole's neighborhood as a JOURNEY, not a guess list.
//
// Part 1 (#115) put the real geometry the uniform ranks erase into every rank map —
// `dq` (the quantized distance to the secret) and `road` (which cluster of the near
// neighborhood a group sits in). This module turns that, plus the round's own guesses,
// into the map the modal draws: a distance axis, the player's stops on it, the roads
// that fork before the destination, and the guesses that fell off the map entirely.
//
// Everything here is DERIVED — from (tried, ranks[secret], hole state) — so it survives
// a reload for free and nothing new is persisted. Rendering lives in RouteModal; this
// file is pure and tested.

import type { RankEntry, RuntimeHole } from '@whippin/shared';

// The dq scale (#115): the rank-1 group is pinned at 255, the farthest kept group at 0,
// per hole. The affine normalization is lossless for a consumer that only reads RATIOS,
// which is exactly what a position on the axis is.
export const DQ_MAX = 255;

// The censored NEAR FIELD: every group of the neighborhood that carries a road renders as a
// station with its word withheld until it is found — not just the handful closest to the word
// (decided 2026-07-26, superseding the top-5 band). So each road shows its REAL length and
// population, which is the thing a list of your own guesses can never say. No word is revealed
// either way: a censored station is a position and a lane.
//
// The extent is entirely the DATA's: generation cuts the roads at the DEPARTURE (#115's
// road_zone) because the line is a journey and it begins where the puzzle put you down — ON one
// of the roads, so the start word carries one too and the fork lands just before it. The
// road-carrying groups ARE the journey, and there is nothing left here to bound. (Until
// 2026-07-26 generation ran them out to a flat top-150 and this module clipped them back to the
// start word; the rule now has ONE owner — the side that also stops shipping the field.) The
// player's own guesses farther out are still stops; they simply ride the trunk.
//
// APPROACH_TOP survives only as the FLOOR, for a map generated with `--no-roads`, which has no
// near field to bound and would otherwise draw none at all.
export const APPROACH_TOP = 5;

// One place on the map the player has actually been: a ranked GROUP they typed (or the
// start word they were given). Aliases collapse here — a group reached through any of its
// inflections (#104) is ONE stop, at its canonical accented form.
export interface RouteStop {
  rank: number; // the group's rank — also its identity on this map
  word: string; // canonical accented display form (never a slug)
  dq: number; // position on the distance axis
  road: number | null; // its lane, or null when it sits below the fork (the trunk)
  start: boolean; // the departure marker: the start word the puzzle handed out
  best: boolean; // "you are here": the hole's current closest word
}

// A group of the near field the player has NOT reached: its position and lane are real, its word
// is withheld while the round is live.
export interface RouteHidden {
  rank: number;
  dq: number;
  road: number | null;
  // The canonical accented form — present ONLY once the hole is solved (decided 2026-07-26): the
  // map then becomes the post-mortem, and the whole neighborhood is public. `null` while the
  // round is live, where a censored station is a position and a lane and nothing else.
  word: string | null;
}

// One lane. `label` is the player's best DISCOVERED word on it — a road is named by what
// you found there, never by what is on it (the no-leak rule). An unexplored lane stays
// null and renders censored; how many roads there are, and how populated they look, IS
// the information the map is meant to give.
export interface RouteRoad {
  id: number;
  label: string | null;
}

export interface RouteModel {
  // The hole's 1-based sentence position among DISTINCT secrets — the same numbering the
  // run ruler's ticks and the share row's keycaps use.
  number: number;
  // The destination, revealed only once the hole is solved. Censored during play.
  secret: string | null;
  solved: boolean;
  roads: RouteRoad[]; // always at least one; one road ⇒ no fork, a single rail
  forkDq: number; // where the lanes separate: the dq of the farthest road-carrying group
  stops: RouteStop[]; // closest-first
  // Every NEAR-FIELD group not yet reached, closest-first, out to the DEPARTURE's rank. Words
  // withheld until the hole is solved.
  hidden: RouteHidden[];
  misses: string[]; // tried words with NO entry in this map, in try order
}

// What the map needs to know about a rank map that a single guess lookup can't tell it:
// how many roads there are, where they fork, and every near-field group's position. One pass
// over the (alias-expanded, tens of thousands of keys) map, cached per map object — the
// maps are immutable for a puzzle's lifetime, exactly like rankCount's cache in scoring.
interface RouteGeometry {
  // rank -> its group, for every group of the NEAR FIELD (one entry per rank, aliases collapse).
  // Bounded by the roads, so it holds the departure's rank worth of entries out of the map's
  // tens of thousands.
  near: Map<number, RankEntry>;
  roadCount: number; // max road id + 1 (0 when the map carries no roads at all)
  forkDq: number; // dq of the farthest group that still carries a road
  nearTop: number; // the farthest rank of the near field — from the DATA, floored at APPROACH_TOP
  plottable: boolean; // the rank-1 group carries dq -> this map can be drawn
}

const geometryCache = new WeakMap<Record<string, RankEntry>, RouteGeometry>();

export function routeGeometry(rankMap: Record<string, RankEntry>): RouteGeometry {
  const cached = geometryCache.get(rankMap);
  if (cached) return cached;
  const near = new Map<number, RankEntry>();
  let roadCount = 0;
  let forkRank = 0;
  let forkDq = DQ_MAX;
  for (const key in rankMap) {
    const entry = rankMap[key];
    if (entry.rank === 0) continue; // the secret is the terminus, not a group on the axis
    const onRoad = entry.road !== undefined && entry.dq !== undefined;
    // The near field is exactly the road-carrying groups; APPROACH_TOP only keeps a map with no
    // roads from having none at all. Aliases of one group carry identical values, so the first
    // key wins with no ambiguity.
    if ((onRoad || entry.rank <= APPROACH_TOP) && !near.has(entry.rank)) near.set(entry.rank, entry);
    if (!onRoad) continue;
    if (entry.road! + 1 > roadCount) roadCount = entry.road! + 1;
    if (entry.rank > forkRank) {
      forkRank = entry.rank;
      forkDq = entry.dq!;
    }
  }
  const rank1 = near.get(1);
  const geometry: RouteGeometry = {
    near,
    roadCount,
    forkDq,
    nearTop: Math.max(forkRank, APPROACH_TOP),
    plottable: rank1 !== undefined && rank1.dq !== undefined,
  };
  geometryCache.set(rankMap, geometry);
  return geometry;
}

// Can this secret be mapped at all? A puzzle published before #115 carries no dq, and the
// feature is the map or nothing: the hole then gets NO tap affordance (explicit decision).
export function hasRoute(rankMap: Record<string, RankEntry> | undefined): boolean {
  return rankMap !== undefined && routeGeometry(rankMap).plottable;
}

export function buildRoute({
  rankMap,
  tried,
  hole,
  startSlug,
  secretWord,
  number,
}: {
  rankMap: Record<string, RankEntry> | undefined;
  tried: string[]; // the round's counted guesses, folded, in try order
  hole: RuntimeHole; // live state: its current rank is what "you are here" means
  startSlug: string; // the departure: a ranked group like any other, just handed out
  secretWord: string; // the destination's accented form, shown only once solved
  number: number;
}): RouteModel | null {
  if (!rankMap) return null;
  const geometry = routeGeometry(rankMap);
  if (!geometry.plottable) return null;

  const solved = hole.rank === 0;
  const byRank = new Map<number, RouteStop>();
  const misses: string[] = [];

  // One stop per GROUP: an alias typed twice, or two different inflections of one word,
  // land on the same rank and collapse into the one canonical stop (#104).
  const visit = (entry: RankEntry, start: boolean) => {
    // rank 0 is the secret itself — the terminus, off the dq scale by construction.
    if (entry.rank === 0 || entry.dq === undefined) return;
    const seen = byRank.get(entry.rank);
    if (seen) {
      if (start) seen.start = true;
      return;
    }
    byRank.set(entry.rank, {
      rank: entry.rank,
      word: entry.word,
      dq: entry.dq,
      road: entry.road ?? null,
      start,
      best: false,
    });
  };

  const startEntry = rankMap[startSlug];
  if (startEntry) visit(startEntry, true);
  for (const typed of tried) {
    const entry = rankMap[typed];
    if (!entry) {
      misses.push(typed); // no rank at all: literally off the map
      continue;
    }
    visit(entry, false);
  }

  const stops = [...byRank.values()].sort((a, b) => a.rank - b.rank);
  // "You are here" is the hole's own current word. A solved hole has reached the terminus,
  // so no stop carries the marker.
  if (!solved) {
    const here = byRank.get(hole.rank) ?? stops[0];
    if (here) here.best = true;
  }

  // Roads are named by DISCOVERY: stops are closest-first, so the first one on a lane is
  // the best word the player has found there. A lane nobody reached stays censored.
  const roads: RouteRoad[] = Array.from({ length: Math.max(geometry.roadCount, 1) }, (_, id) => ({
    id,
    label: null,
  }));
  for (const stop of stops) {
    if (stop.road === null) continue;
    const road = roads[stop.road];
    if (road && road.label === null) road.label = stop.word;
  }

  // Every near-field group the player has NOT reached, so the roads show their real length and
  // population. A group they HAVE reached is already a stop; it is never listed twice — which is
  // what keeps the departure itself out of this list. The extent is the road zone, which
  // generation already ends at that departure (see APPROACH_TOP).
  const hidden: RouteHidden[] = [];
  for (let rank = 1; rank <= geometry.nearTop; rank += 1) {
    if (byRank.has(rank)) continue;
    const entry = geometry.near.get(rank);
    if (!entry || entry.dq === undefined) continue;
    // Solved: the round is over, so the whole neighborhood gives up its words.
    hidden.push({
      rank,
      dq: entry.dq,
      road: entry.road ?? null,
      word: solved ? entry.word : null,
    });
  }

  return {
    number,
    secret: solved ? secretWord : null,
    solved,
    roads,
    forkDq: geometry.forkDq,
    stops,
    hidden,
    misses,
  };
}
