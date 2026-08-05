// Word mode's BOARD model (#156): the day's neighborhood drawn as the route-map concept
// (#117) — lanes, dq-spaced stations — but inverted and live. The center word is PUBLIC,
// there is no hidden destination, no departure and no "you are here": the whole zone is
// the playing field, and a claim reveals its station.
// `buildRoute` assumes a secret / start_rank / "you are here", so this is a SIBLING
// model, not a parameter tweak — same derivation contract though: everything comes from
// (ranks, ordered counted guesses), nothing new is persisted, and a guess landing simply
// changes the drawing.

import type { RankEntry, WordRanks } from '@whippin/shared';
import { CLAIM_ZONE, STRIKES_TO_END, judgeWordGuess, wordGuessKey } from './wordGame';

// One group of the zone: a station on its road's lane. `word` is null while unclaimed
// and the run is live; a claim — or the run ending, which turns the board into the
// post-mortem — reveals the canonical accented form. A null-word group is NOT DRAWN
// (the board draws only found words, decided 2026-08-05); it still ships because the
// drawing measures its connectors across it and the sr mirror counts it.
export interface WordStation {
  rank: number;
  dq: number;
  road: number | null; // lane index (see lanes below); null on a --no-roads artifact
  word: string | null;
  claimed: boolean;
}

// A ranked guess OUTSIDE the zone (a "near" strike): it rides the trunk above the fork,
// its rank teaching where the boundary is. Always revealed — the player typed it.
export interface WordOutsideStop {
  rank: number;
  dq: number;
  word: string;
}

export interface WordBoardModel {
  word: string; // the day's word, accented display form — public from the first frame
  lanes: number; // how many roads the zone forks into (>= 1)
  stations: WordStation[]; // the zone, rank ascending (1 first)
  outside: WordOutsideStop[]; // near strikes, rank ascending
  misses: string[]; // off-map strikes, in try order (typed slugs — see route.ts misses)
  ended: boolean;
}

// One pass over the (alias-expanded) flat map, cached per map object — the map is
// immutable for the puzzle's lifetime, exactly like routeGeometry's cache.
interface WordGeometry {
  zone: Map<number, RankEntry>; // rank -> its group, for every zone group carrying dq
  lanes: Map<number, number>; // distinct road id -> lane index, ascending (see route.ts)
  plottable: boolean; // the rank-1 group carries dq -> the board can be drawn
}

const geometryCache = new WeakMap<WordRanks, WordGeometry>();

export function wordGeometry(ranks: WordRanks): WordGeometry {
  const cached = geometryCache.get(ranks);
  if (cached) return cached;
  const zone = new Map<number, RankEntry>();
  const roadIds = new Set<number>();
  for (const key in ranks) {
    const entry = ranks[key];
    if (entry.rank === 0 || entry.rank > CLAIM_ZONE || entry.dq === undefined) continue;
    if (!zone.has(entry.rank)) zone.set(entry.rank, entry);
    if (entry.road !== undefined) roadIds.add(entry.road);
  }
  // Ascending, so lane 0 holds the road of rank 1 — generation numbers roads by their
  // closest member, and looking ids up (never sizing an array by one) keeps a hostile
  // `road` value from allocating anything (the same rule as route.ts's lanes).
  const lanes = new Map<number, number>();
  for (const id of [...roadIds].sort((a, b) => a - b)) lanes.set(id, lanes.size);
  const geometry: WordGeometry = {
    zone,
    lanes,
    plottable: zone.get(1)?.dq !== undefined,
  };
  geometryCache.set(ranks, geometry);
  return geometry;
}

// Can this artifact be played on the drawn board at all? Same gate as the route map
// (hasRoute): the feature is the geometry or nothing.
export function hasWordBoard(ranks: WordRanks): boolean {
  return wordGeometry(ranks).plottable;
}

export function buildWordBoard({
  ranks,
  word,
  tried,
}: {
  ranks: WordRanks;
  word: string; // the day's accented display form
  tried: string[]; // the round's counted guesses, folded, in try order
}): WordBoardModel | null {
  const geometry = wordGeometry(ranks);
  if (!geometry.plottable) return null;

  // Walk the counted log once, with the model's own group-level dedup, splitting it into
  // claims / near strikes / off-map strikes — and replaying the end-of-run rule so the
  // board knows when it has become the post-mortem.
  const seen = new Set<string>();
  const claimed = new Set<number>();
  const outside = new Map<number, WordOutsideStop>();
  const misses: string[] = [];
  let strikes = 0;
  let ended = false;
  for (const typed of tried) {
    if (ended) break;
    const key = wordGuessKey(ranks, typed);
    if (seen.has(key)) continue;
    seen.add(key);
    const judged = judgeWordGuess(ranks, typed);
    if (judged.kind === 'zero') continue;
    if (judged.kind === 'claim') {
      claimed.add(judged.entry.rank);
      strikes = 0;
      continue;
    }
    if (judged.kind === 'near' && judged.entry.dq !== undefined) {
      outside.set(judged.entry.rank, {
        rank: judged.entry.rank,
        dq: judged.entry.dq,
        word: judged.entry.word,
      });
    } else if (judged.kind === 'miss') {
      misses.push(typed);
    }
    strikes += 1;
    if (strikes >= STRIKES_TO_END) ended = true;
  }

  const laneOf = (entry: RankEntry): number | null =>
    entry.road === undefined ? null : (geometry.lanes.get(entry.road) ?? null);

  const stations: WordStation[] = [];
  for (const [rank, entry] of [...geometry.zone.entries()].sort((a, b) => a[0] - b[0])) {
    const isClaimed = claimed.has(rank);
    stations.push({
      rank,
      dq: entry.dq!,
      road: laneOf(entry),
      // A claim reveals its word; the run ending reveals the WHOLE field — the board is
      // then the post-mortem, like the solved route map.
      word: isClaimed || ended ? entry.word : null,
      claimed: isClaimed,
    });
  }

  return {
    word,
    lanes: Math.max(geometry.lanes.size, 1),
    stations,
    outside: [...outside.values()].sort((a, b) => a.rank - b.rank),
    misses,
    ended,
  };
}
