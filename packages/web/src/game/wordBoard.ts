// Word mode's BOARD model (#156): the day's neighborhood drawn as the route-map concept
// (#117) — dq-spaced stations on one trunk — but inverted and live. The center word is
// PUBLIC, there is no hidden destination, no departure and no "you are here": the whole
// zone is the playing field, and a claim reveals its station.
// `buildRoute` assumes a secret / start_rank / "you are here", so this is a SIBLING
// model, not a parameter tweak — same derivation contract though: everything comes from
// (ranks, ordered counted guesses), nothing new is persisted, and a guess landing simply
// changes the drawing.
//
// **RARITY is the thing the board says about the field besides distance** (decided
// 2026-08-10; carried by the WORD's COLOUR on one trunk since 2026-08-11 — the sentence
// route's exact drawing). The grade is what the claim PAID (#163), so the post-mortem
// answers "where were the expensive words?" in the colours the run's strikes and loot
// already taught. It costs generation nothing: `freq` is already on every entry.

import type { RankEntry, WordRanks } from '@whippin/shared';
import { CLAIM_ZONE, RARITY_NAMES, rarityOf, replayWordRun, type Rarity } from './wordGame';

// Since #163 this board is the END SCREEN's, not the play surface's: the run is typed
// against the clock with the word alone on screen, and the whole field is revealed when
// the clock dies, as the post-mortem the run earned. Nothing about the model changed
// with that — it is the same drawing, mounted at a different moment.
//
// One group of the zone: a station wearing its grade's colour. `word` is null while unclaimed
// and the field is still censored; a claim — or the reveal, which names the whole field
// — gives the canonical accented form. A null-word group IS still drawn, wearing the
// route map's fixed-width `???` (the census, restored 2026-08-05 after a day of drawing
// only the found words): every rank of the zone is a station, which is what lets the line
// show its real length and population, and what makes a claim land on a stop that was
// already there rather than appear out of nothing.
export interface WordStation {
  rank: number;
  dq: number;
  // The station's RARITY GRADE (decided 2026-08-10) — its colour on the line. Rarity is
  // what this mode is actually played on: it is what a claim is PAID by, so a grade is a
  // price bracket the player can aim at. It needs nothing extra shipped either — `freq` is
  // already on every entry (#163).
  //
  // Never null: `rarityOf` floors at COMMON, so every station carries exactly one grade
  // even on an artifact carrying no `freq` at all (which then draws all-common).
  rarity: Rarity;
  word: string | null;
  claimed: boolean;
}

// A ranked guess OUTSIDE the zone (a "near" miss): it rides the trunk above the field,
// its rank teaching where the boundary is. Always revealed — the player typed it.
export interface WordOutsideStop {
  rank: number;
  dq: number;
  // The form the PLAYER TYPED, not the group's canonical one (decided 2026-08-06 — the same
  // rule as the sentence map's trunk stops once had). Out there nothing
  // was drawn before the guess landed, so the stop IS the guess: answering `sables` with its
  // group's `sable` puts a word on the board that was never played. A CLAIM is the opposite
  // case — that station was already there as `???`, so revealing it names the census.
  word: string;
}

export interface WordBoardModel {
  word: string; // the day's word, accented display form — public from the first frame
  // The grades present, in ladder order (commonest first) — ONLY the grades the day's field
  // actually holds. A grade the zone does not contain is not listed, the same call the
  // retired per-grade tally made: an English board often has no ARCANE group at all, and a
  // permanently absent grade advertises a bracket nobody can reach. Never empty (COMMON is
  // the floor). Its consumer is the sr census.
  grades: Rarity[];
  stations: WordStation[]; // the zone, rank ascending (1 first)
  outside: WordOutsideStop[]; // ranked near misses, rank ascending
  misses: string[]; // off-map guesses, in try order (typed slugs — see route.ts misses)
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
  // The rank-1 group carries dq, so there is a line to draw at all. Deliberately the SAME
  // narrow gate as the route map's `hasRoute` and no stronger: `dq` is optional to every
  // consumer by contract, so a zone group missing one is not malformed data to refuse —
  // it simply gets no station. Such a group stays CLAIMABLE (the rules read `rank`, not
  // geometry) and scores; it just has nothing on the board to reveal. That cannot happen
  // on a generated artifact, where every rank >= 1 carries a dq.
  plottable: boolean;
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
  let maxRank = 1;
  for (const key in ranks) {
    const entry = ranks[key];
    // Before the zone filter: the widest exponent comes from the FAR end of the map, which is
    // exactly what the zone excludes.
    if (entry.rank > maxRank) maxRank = entry.rank;
    if (entry.rank === 0 || entry.rank > CLAIM_ZONE || entry.dq === undefined) continue;
    if (!zone.has(entry.rank)) zone.set(entry.rank, entry);
  }
  const geometry: WordGeometry = {
    zone,
    plottable: zone.get(1)?.dq !== undefined,
    maxRank,
  };
  geometryCache.set(ranks, geometry);
  return geometry;
}

// Can this artifact be played on the drawn board at all? Same gate as the route map
// (hasRoute) — see `plottable` for exactly what it does and does not promise.
export function hasWordBoard(ranks: WordRanks): boolean {
  return wordGeometry(ranks).plottable;
}

export function buildWordBoard({
  ranks,
  word,
  tried,
  corpusSize,
  reveal = false,
}: {
  ranks: WordRanks;
  word: string; // the day's accented display form
  tried: readonly string[]; // the round's counted guesses, folded, in try order
  // The language's whole vocabulary — the scale a grade is a FRACTION of (#163). The board's
  // colours are grades, so the drawing needs the same denominator the clock is priced with,
  // or a station could wear one grade and pay for another. It is deliberately NOT part of
  // `wordGeometry`'s cache (which is keyed on the rank map alone): grading is a walk of the
  // ~CLAIM_ZONE zone entries, not of the whole ~25k-key map.
  corpusSize: number;
  // When the post-mortem NAMES the field. Presentation pacing, owned by the screen: the
  // run's end is a DEADLINE fact (#163) and the reveal is its own later beat.
  reveal?: boolean;
}): WordBoardModel | null {
  const geometry = wordGeometry(ranks);
  if (!geometry.plottable) return null;

  // The RULES are `replayWordRun`'s, never restated here: this only sorts the counted
  // guesses it hands back into the three things the drawing shows. A near miss with no
  // `dq` is deliberately dropped from both — there is no distance to hang it on the trunk
  // by and it is not off the map either.
  const { counted } = replayWordRun(ranks, tried);
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

  const present = new Set<Rarity>();
  const stations: WordStation[] = [];
  for (const [rank, entry] of [...geometry.zone.entries()].sort((a, b) => a[0] - b[0])) {
    const isClaimed = claimed.has(rank);
    const rarity = rarityOf(entry.freq, corpusSize);
    present.add(rarity);
    stations.push({
      rank,
      dq: entry.dq!,
      rarity,
      // A claim reveals its word; the post-mortem reveals the WHOLE field — the board is
      // then the post-mortem, like the solved route map.
      word: isClaimed || reveal ? entry.word : null,
      claimed: isClaimed,
    });
  }

  return {
    word,
    // Ladder order, commonest to rarest, whatever a given
    // day's field happens to hold — the one thing that lets two boards be read the same way.
    // Empty only if the zone is, which `plottable` has already ruled out.
    grades: RARITY_NAMES.filter((grade) => present.has(grade)),
    stations,
    outside: [...outside.values()].sort((a, b) => a.rank - b.rank),
    misses,
    maxRank: geometry.maxRank,
  };
}
