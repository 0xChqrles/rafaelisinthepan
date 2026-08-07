// Word mode's BOARD model (#156): the day's neighborhood drawn as the route-map concept
// (#117) — lanes, dq-spaced stations — but inverted and live. The center word is PUBLIC,
// there is no hidden destination, no departure and no "you are here": the whole zone is
// the playing field, and a claim reveals its station.
// `buildRoute` assumes a secret / start_rank / "you are here", so this is a SIBLING
// model, not a parameter tweak — same derivation contract though: everything comes from
// (ranks, ordered counted guesses), nothing new is persisted, and a guess landing simply
// changes the drawing.

import type { RankEntry, WordRanks } from '@whippin/shared';
import { CLAIM_ZONE, replayWordRun } from './wordGame';

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
  // The form the PLAYER TYPED, not the group's canonical one (decided 2026-08-06 — the same
  // rule as the sentence map's trunk stops, see route.ts RouteStop.word). Off the roads nothing
  // was drawn before the guess landed, so the stop IS the guess: answering `sables` with its
  // group's `sable` puts a word on the board that was never played. A CLAIM is the opposite
  // case — that station was already there as `???`, so revealing it names the census.
  word: string;
}

export interface WordBoardModel {
  word: string; // the day's word, accented display form — public from the first frame
  lanes: number; // how many roads the zone forks into (>= 1)
  stations: WordStation[]; // the zone, rank ascending (1 first)
  outside: WordOutsideStop[]; // near strikes, rank ascending
  misses: string[]; // off-map strikes, in try order (typed slugs — see route.ts misses)
  ended: boolean;
  // The farthest rank this MAP holds, not the farthest currently drawn — so the drawing can
  // reserve a rank gutter wide enough for any exponent the round can still produce. It is a
  // property of the puzzle, so it never changes mid-round: the line cannot shift sideways
  // under the player when a far guess lands.
  maxRank: number;
}

// One pass over the (alias-expanded) flat map, cached per map object — the map is
// immutable for the puzzle's lifetime, exactly like routeGeometry's cache.
interface WordGeometry {
  zone: Map<number, RankEntry>; // rank -> its group, for every zone group carrying dq
  lanes: Map<number, number>; // distinct road id -> lane index, ascending (see route.ts)
  plottable: boolean; // the rank-1 group carries dq -> the board can be drawn
  // The FARTHEST rank this map holds — every one of which is typeable, so it is the widest
  // exponent the line can ever be asked to draw. The drawing reserves its rank gutter for it
  // (see WordBoardModel.maxRank); free here, since this pass already visits every entry.
  maxRank: number;
}

const geometryCache = new WeakMap<WordRanks, WordGeometry>();

export function wordGeometry(ranks: WordRanks): WordGeometry {
  const cached = geometryCache.get(ranks);
  if (cached) return cached;
  const zone = new Map<number, RankEntry>();
  const roadIds = new Set<number>();
  let maxRank = 1;
  for (const key in ranks) {
    const entry = ranks[key];
    // Before the zone filter: the widest exponent comes from the FAR end of the map, which is
    // exactly what the zone excludes.
    if (entry.rank > maxRank) maxRank = entry.rank;
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
    maxRank,
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
  reveal,
}: {
  ranks: WordRanks;
  word: string; // the day's accented display form
  tried: string[]; // the round's counted guesses, folded, in try order
  // When the post-mortem NAMES the field. Defaults to the run ending; the screen passes
  // its own later beat so the killing strike can play out before the reveal (the reveal
  // is presentation pacing — the run's END itself stays `replayWordRun`'s).
  reveal?: boolean;
}): WordBoardModel | null {
  const geometry = wordGeometry(ranks);
  if (!geometry.plottable) return null;

  // The RULES are `replayWordRun`'s, never restated here: this only sorts the counted
  // guesses it hands back into the three things the drawing shows. A near strike with no
  // `dq` is deliberately dropped from both — it struck, but there is no distance to hang it
  // on the trunk by and it is not off the map either.
  const { counted, ended } = replayWordRun(ranks, tried);
  const revealField = reveal ?? ended;
  const claimed = new Set<number>();
  const outside = new Map<number, WordOutsideStop>();
  const misses: string[] = [];
  for (const { typed, judged } of counted) {
    if (judged.kind === 'claim') {
      claimed.add(judged.entry.rank);
    } else if (judged.kind === 'near') {
      if (judged.entry.dq !== undefined) {
        outside.set(judged.entry.rank, {
          rank: judged.entry.rank,
          dq: judged.entry.dq,
          word: typed,
        });
      }
    } else {
      misses.push(typed);
    }
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
      // A claim reveals its word; the post-mortem reveals the WHOLE field — the board is
      // then the post-mortem, like the solved route map.
      word: isClaimed || revealField ? entry.word : null,
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
    maxRank: geometry.maxRank,
  };
}
