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
  // Its LANE: the group's road as an index into `RouteModel.roads`, or null when it sits below
  // the fork (the trunk). Generation numbers roads contiguously from the closest member's rank,
  // so on a generated map the lane index IS the road id — see `RouteGeometry.lanes` for why it
  // is looked up rather than used raw.
  road: number | null;
  start: boolean; // the departure marker: the start word the puzzle handed out
  best: boolean; // "you are here": the hole's current closest word
}

// A group of the near field the player has NOT reached: its position and lane are real, its word
// is withheld while the round is live.
export interface RouteHidden {
  rank: number;
  dq: number;
  road: number | null; // its lane, like RouteStop.road
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
  stops: RouteStop[]; // closest-first
  // Every NEAR-FIELD group not yet reached, closest-first, out to the DEPARTURE's rank. Words
  // withheld until the hole is solved.
  hidden: RouteHidden[];
  // Tried words with NO entry in this map, in try order. These are the ONLY words on the map
  // rendered from `tried` rather than from a rank entry's canonical `word` — which looks like a
  // breach of "never display a slug", and isn't: on this game the player CANNOT type an accent.
  // Both input paths produce folded slug characters only — the on-screen keyboard has no accent
  // keys, and WordInput folds every physical keystroke through `slugChars` — so `foret` is
  // literally what was typed, not a slugged `forêt`. There is no canonical form to prefer here
  // either: a word in no rank map has none, and the vocab file is slugs. (Flagged in review
  // 2026-07-27 and checked; if the input ever accepts accents, this becomes a real bug.)
  misses: string[];
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
  // The DISTINCT road ids this map ships, ascending, each mapped to its LANE INDEX. Generation
  // numbers roads contiguously from the closest member's rank, so on a generated map the two are
  // the same number and this is an identity. It exists for the map that ISN'T generated: a road
  // id is a number off the network, and sizing the lane array by `max id + 1` handed it the
  // allocation — a well-formed `road: 4294967295` threw RangeError, and smaller hostile values
  // just ate memory. Lanes now cost what the DATA holds (one per road actually present, bounded
  // by the near field) rather than what an id VALUE claims.
  lanes: Map<number, number>;
  nearTop: number; // the farthest rank of the near field — from the DATA, floored at APPROACH_TOP
  plottable: boolean; // the rank-1 group carries dq -> this map can be drawn
  // Memo for the ONE lookup the near field cannot answer (see entryAtRank): a rank off a
  // `--no-roads` map, which has no near field to speak of and so costs a walk of the whole
  // alias-expanded map. Mutable, and deliberately part of the geometry rather than local to a
  // build: `buildRoute` re-runs on every guess while the map is open, so a per-build memo would
  // pay that walk again for the same rank each time. Holds a MISS as `undefined` too — hence
  // `has` rather than `get` at the call site — so an absent rank cannot be rescanned forever.
  resolved: Map<number, RankEntry | undefined>;
}

const geometryCache = new WeakMap<Record<string, RankEntry>, RouteGeometry>();

export function routeGeometry(rankMap: Record<string, RankEntry>): RouteGeometry {
  const cached = geometryCache.get(rankMap);
  if (cached) return cached;
  const near = new Map<number, RankEntry>();
  const roadIds = new Set<number>();
  let forkRank = 0;
  for (const key in rankMap) {
    const entry = rankMap[key];
    if (entry.rank === 0) continue; // the secret is the terminus, not a group on the axis
    const onRoad = entry.road !== undefined && entry.dq !== undefined;
    // The near field is exactly the road-carrying groups; APPROACH_TOP only keeps a map with no
    // roads from having none at all. Aliases of one group carry identical values, so the first
    // key wins with no ambiguity.
    if ((onRoad || entry.rank <= APPROACH_TOP) && !near.has(entry.rank)) near.set(entry.rank, entry);
    if (!onRoad) continue;
    roadIds.add(entry.road!);
    if (entry.rank > forkRank) forkRank = entry.rank;
  }
  // Ascending, so the lanes keep generation's own ordering: road 0 holds rank 1, and lane 0 is
  // the one the destination's own cluster runs on.
  const lanes = new Map<number, number>();
  for (const id of [...roadIds].sort((a, b) => a - b)) lanes.set(id, lanes.size);
  const rank1 = near.get(1);
  const geometry: RouteGeometry = {
    near,
    lanes,
    nearTop: Math.max(forkRank, APPROACH_TOP),
    plottable: rank1 !== undefined && rank1.dq !== undefined,
    resolved: new Map(),
  };
  geometryCache.set(rankMap, geometry);
  return geometry;
}

// Can this secret be mapped at all? A puzzle published before #115 carries no dq, and the
// feature is the map or nothing: the hole then gets NO tap affordance (explicit decision).
//
// Asked for EVERY hole on the first render of every round, whether or not a map is ever
// opened, so it must not pay for the geometry: `routeGeometry` walks the whole alias-expanded
// map (~39k keys per secret on a real fr puzzle, three of them) to build a near field and a
// lane table nobody has asked for yet. The question is only "does the rank-1 group carry dq",
// and rank 1 is at the FRONT of a generated map — the keys are written closest-first — so
// stopping at it answers the same question in a handful of iterations. It has to be the same
// answer, and it is by construction: both take the FIRST key found at rank 1, and aliases of a
// group carry identical values. A map already opened has its geometry cached, so reuse that
// rather than scanning twice.
export function hasRoute(rankMap: Record<string, RankEntry> | undefined): boolean {
  if (rankMap === undefined) return false;
  const cached = geometryCache.get(rankMap);
  if (cached) return cached.plottable;
  for (const key in rankMap) {
    if (rankMap[key].rank === 1) return rankMap[key].dq !== undefined;
  }
  return false;
}

// The one-time self-demonstration (#129): the FIRST hole a player ever solves opens its own
// finished journey — departure, every station they visited, arrival — at a proud moment, with
// their own data. It explains the map by being it; nothing is worded.
//
// Which hole, or null for "not now". Three conditions, and the third is the subtle one:
//   - `routeSeen` false. Set the moment ANY map opens, so a player who found the feature by
//     tapping is never interrupted by it.
//   - this guess solved at least one MAPPABLE hole (the caller filters out a hole whose
//     secret carries no #115 geometry — it has no map to open).
//   - the round is NOT finished by it. The final solve belongs to the solved sequence
//     (streak -> exits -> leaderboard -> source), which must not gain a competing modal;
//     those players meet the map on a later round's mid-round solve, or through the wave.
// A guess can drop several holes at once: the FIRST in sentence order gets the map.
export function shouldAutoOpenRoute(
  routeSeen: boolean,
  newlySolvedIndices: number[],
  allSolved: boolean,
): number | null {
  if (routeSeen || allSolved || newlySolvedIndices.length === 0) return null;
  return Math.min(...newlySolvedIndices);
}

export function buildRoute({
  rankMap,
  tried,
  hole,
  startRank,
  secretWord,
  number,
}: {
  rankMap: Record<string, RankEntry> | undefined;
  tried: string[]; // the round's counted guesses, folded, in try order
  hole: RuntimeHole; // live state: its current rank is what "you are here" means
  // The departure: a ranked group like any other, just handed out. Identified by its RANK,
  // which the puzzle states outright (`hole.start_rank`) — never by the start word's slug.
  // A slug is not an identity: `fold` drops accents, so `côté` and `coté` share the key
  // `cote`, and the rank map gives a shared key to the CLOSER group. When the hole prints an
  // agreed form whose slug a closer group already owns, generation deliberately declines to
  // re-key it (typing it really is the closer distance — that call is right, and it stays),
  // so the slug resolves to a group the player was never put down on. Looking the departure
  // up that way drew it at that closer group's rank AND named the word there, lifting it out
  // of the censored near field on a board where nothing had been guessed yet. The rank is
  // stated, unambiguous, and already what the sentence, the exponent and the score all use.
  startRank: number;
  secretWord: string; // the destination's accented form, shown only once solved
  number: number;
}): RouteModel | null {
  if (!rankMap) return null;
  const geometry = routeGeometry(rankMap);
  if (!geometry.plottable) return null;

  const solved = hole.rank === 0;
  const byRank = new Map<number, RouteStop>();
  const misses: string[] = [];

  // A group's road as a LANE index (see RouteGeometry.lanes). Null below the fork, and null for
  // a road id the geometry pass never saw — which cannot happen for an entry of this same map.
  const laneOf = (entry: RankEntry): number | null =>
    entry.road === undefined ? null : geometry.lanes.get(entry.road) ?? null;

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
      road: laneOf(entry),
      start,
      best: false,
    });
  };

  // The entry for a rank the guess log does not cover, for the one lookup that needs it (below).
  // The near field answers it outright on a generated map — its roads run out to the departure
  // and a hole never sits farther than where it was put down — so the scan is the fallback for a
  // `--no-roads` map, which has no near field to speak of. Aliases of a group carry identical
  // values, so the first key found wins, exactly as in the geometry pass.
  //
  // That walk is the one cost in this module that isn't paid once, so it is MEMOIZED on the
  // geometry (which is itself cached per map object): `buildRoute` re-runs on every guess while
  // the map is open, and both callers below ask for the same two ranks each time. Memoized, a
  // rank is scanned for once and the round's repeats are free; the memo is bounded by the ranks
  // the hole actually occupies.
  const entryAtRank = (rank: number): RankEntry | undefined => {
    const known = geometry.near.get(rank);
    if (known) return known;
    if (geometry.resolved.has(rank)) return geometry.resolved.get(rank);
    let found: RankEntry | undefined;
    for (const key in rankMap) {
      if (rankMap[key].rank === rank) {
        found = rankMap[key];
        break;
      }
    }
    geometry.resolved.set(rank, found);
    return found;
  };

  const startEntry = entryAtRank(startRank);
  if (startEntry) visit(startEntry, true);
  for (const typed of tried) {
    const entry = rankMap[typed];
    if (!entry) {
      misses.push(typed); // no rank at all: literally off the map
      continue;
    }
    visit(entry, false);
  }

  // "You are here" is the hole's OWN position, looked up rather than inferred from the guess log:
  // the hole is the authority on where the player stands, and the log is not a complete record of
  // how they got there. A guess deduped as a canonical duplicate never enters `tried`
  // (gameStore.recordGuess) and can still IMPROVE another hole, so the current group may be one
  // the history never mentions. Reading the closest LOGGED stop instead put the marker on a word
  // the player had already moved past — a hole sitting at rank 5 reading as its rank-104
  // departure — and left its current word censored in the near field, `???` on the map while the
  // sentence showed it. Visiting it here also makes it a STOP, which is what it is: a place they
  // have been. A solved hole has reached the terminus, so nothing on the axis carries the marker.
  if (!solved) {
    const entry = entryAtRank(hole.rank);
    if (entry) visit(entry, false);
    const here = byRank.get(hole.rank);
    if (here) here.best = true;
  }

  const stops = [...byRank.values()].sort((a, b) => a.rank - b.rank);

  // Roads are named by DISCOVERY: stops are closest-first, so the first one on a lane is
  // the best word the player has found there. A lane nobody reached stays censored.
  const roads: RouteRoad[] = Array.from({ length: Math.max(geometry.lanes.size, 1) }, (_, id) => ({
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
      road: laneOf(entry),
      word: solved ? entry.word : null,
    });
  }

  return {
    number,
    secret: solved ? secretWord : null,
    solved,
    roads,
    stops,
    hidden,
    misses,
  };
}
