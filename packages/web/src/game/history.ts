// The HISTORY model: one hole's guess log drawn as the JOURNEY it is — the player's own
// stops on a single line that leads down to the hidden word.
//
// This replaced the route map (user-decided 2026-08-10, retiring #117), then took the
// map's SPINE back the same day on review: a flat sorted list was legible but said
// nothing — no starting word, no direction you could feel, no target being reached. What
// was retired stays retired (the semantic roads, the censored census of every unfound
// group, the sticky "you are here" machinery — the parts that never helped anyone); what
// returns is the journey reading those parts were buried in: the START word the puzzle
// handed out, the guesses as stops spaced by their REAL distance (`dq`), and the `???`
// terminus that says the whole game in one token.
//
// Everything here is DERIVED — from (ranks[secret], tried, hole state) — so it survives a
// reload for free and nothing new is persisted. Rendering lives in
// components/HistoryModal; this file is pure and tested.

import type { RankEntry, RuntimeHole } from '@whippin/shared';

// One place on the line the player has actually been: a ranked group they typed, or the
// start word they were given. Aliases collapse — a group reached through any of its
// inflections (#104) is ONE stop.
export interface HistoryStop {
  rank: number; // the group's rank — also its identity on this line
  // Position on the distance axis, for the connector lengths. Null on pre-#115 data that
  // carries no `dq` — the drawing then falls back to uniform spacing instead of refusing
  // (the old map's hasRoute gate died with it: a history exists on every puzzle).
  dq: number | null;
  // How the stop is NAMED: the form the PLAYER TYPED wherever a typed form reached it —
  // their log, their words (answering `sables` with the group's `sable` reads as a
  // correction; the rule the old trunk stops and the MISSED shelf always followed, legal
  // because this game's input produces folded slug characters only). The canonical form
  // is the fallback for the two stops nobody typed: the departure, and a "you are here"
  // the hole reached through a deduped guess that never entered the log.
  word: string;
  start: boolean; // the departure: the start word the puzzle handed out
  best: boolean; // "you are here": the hole's current closest word
  // FARTHER than the departure: a guess that went backwards from where the puzzle put the
  // player down. The journey runs departure → word (the doctrine the road zone was cut
  // by: anything farther than the start is behind you), so the drawing quiets these and
  // hangs them on the broken trace — real stops, just not steps of the walk. Never true
  // of the departure itself or of "you" (a hole's rank only ever improves from its
  // start_rank, so the current position cannot sit behind it).
  behind: boolean;
  // NAMED by the post-mortem rather than reached: a group between the departure and the
  // secret the player never typed, which SOLVING reveals (user-decided 2026-08-10). False
  // for everything they actually played AND for the departure, which was handed to them —
  // both are words they HELD, and the drawing keeps those at full strength while these
  // recede. Never true while the hole is live: an unsolved line shows only where the
  // player has been.
  revealed: boolean;
}

export interface HistoryModel {
  // The destination, revealed only once the hole is solved. Censored (`???`) during play —
  // the unknown target the whole line is walked toward.
  secret: string | null;
  solved: boolean;
  stops: HistoryStop[]; // closest-first
  // Tried words with NO entry in this map, in try order — off the line entirely.
  misses: string[];
  // The farthest rank this MAP holds (not the farthest drawn), so the drawing can reserve
  // a rank gutter wide enough for any exponent the round can still produce.
  maxRank: number;
}

// The WALKED STRETCH by rank: every group from the secret out to `top` (the departure),
// which is the extent the journey covers and the most the drawing ever names. One pass
// over the alias-expanded map — tens of thousands of keys on a real puzzle — so it is
// cached per map object, exactly like the route map's own geometry was: the maps are
// immutable for a puzzle's lifetime, and this walk answers three questions at once (the
// departure's entry, the hole's current entry, and the solve's reveal).
//
// Aliases of a group carry identical values, so the first key found at a rank wins.
interface NearField {
  top: number;
  byRank: Map<number, RankEntry>;
}
const nearFieldCache = new WeakMap<Record<string, RankEntry>, NearField>();

function nearField(rankMap: Record<string, RankEntry>, top: number): Map<number, RankEntry> {
  const cached = nearFieldCache.get(rankMap);
  if (cached && cached.top >= top) return cached.byRank;
  const byRank = new Map<number, RankEntry>();
  for (const key in rankMap) {
    const entry = rankMap[key];
    // rank 0 is the secret — the terminus, never a stop on the axis.
    if (entry.rank === 0 || entry.rank > top) continue;
    if (!byRank.has(entry.rank)) byRank.set(entry.rank, entry);
  }
  nearFieldCache.set(rankMap, { top, byRank });
  return byRank;
}

export function buildHistory({
  rankMap,
  tried,
  hole,
  startRank,
  secretWord,
}: {
  rankMap: Record<string, RankEntry>;
  tried: readonly string[]; // the round's counted guesses, folded, in try order
  hole: RuntimeHole; // live state: its current rank is what "you are here" means
  // The departure, identified by its stated RANK (`hole.start_rank`) — never by the start
  // word's slug, which `fold` can hand to a closer group (the #119 agreed-form case).
  startRank: number;
  secretWord: string; // the destination's accented form, shown only once solved
}): HistoryModel {
  const solved = hole.rank === 0;
  const byRank = new Map<number, HistoryStop>();
  const misses: string[] = [];
  let maxRank = 1;
  for (const key in rankMap) {
    if (rankMap[key].rank > maxRank) maxRank = rankMap[key].rank;
  }

  // One stop per GROUP: an alias typed twice, or two inflections of one word, land on the
  // same rank and collapse into ONE stop (#104) — the first visit wins, so a stop wears
  // the form that first reached it. Rank 0 is the secret itself — the terminus, never a
  // stop on the axis.
  const visit = (
    entry: RankEntry,
    { start = false, typed, revealed = false }: { start?: boolean; typed?: string; revealed?: boolean } = {},
  ) => {
    if (entry.rank === 0) return;
    const seen = byRank.get(entry.rank);
    if (seen) {
      if (start) seen.start = true;
      return;
    }
    byRank.set(entry.rank, {
      rank: entry.rank,
      dq: entry.dq ?? null,
      word: typed ?? entry.word,
      start,
      best: false,
      behind: entry.rank > startRank,
      revealed,
    });
  };

  // The walked stretch, walked once: the departure, "you", and the solve's reveal all
  // read their entries out of it.
  const field = nearField(rankMap, startRank);

  const startEntry = field.get(startRank);
  if (startEntry) visit(startEntry, { start: true });
  for (const typed of tried) {
    const entry = rankMap[typed];
    if (!entry) misses.push(typed); // no rank at all: off the line entirely
    else visit(entry, { typed });
  }

  // "You are here" is the hole's OWN position, looked up rather than inferred from the
  // log: a guess deduped as a canonical duplicate never enters `tried` and can still
  // improve another hole, so the current group can be one the history never mentions.
  // A solved hole has reached the terminus, so nothing on the axis carries the marker.
  if (!solved) {
    const entry = field.get(hole.rank);
    if (entry) visit(entry);
    const here = byRank.get(hole.rank);
    if (here) here.best = true;
  }

  // SOLVED: the line becomes the post-mortem and NAMES the whole walked stretch — every
  // group from the secret out to the departure, including the ones the player never
  // reached (user-decided 2026-08-10). Only that stretch: what lies BEHIND the departure
  // was never on the way, so nothing there is named that they did not type themselves.
  // The words are the group's canonical accented forms — nobody typed these, so there is
  // no typed form to prefer, and this is the map naming its own field.
  if (solved) {
    for (let rank = 1; rank <= startRank; rank += 1) {
      if (byRank.has(rank)) continue;
      const entry = field.get(rank);
      if (entry) visit(entry, { revealed: true });
    }
  }

  return {
    secret: solved ? secretWord : null,
    solved,
    stops: [...byRank.values()].sort((a, b) => a.rank - b.rank),
    misses,
    maxRank,
  };
}
