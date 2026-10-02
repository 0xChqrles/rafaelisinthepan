// The HISTORY model: one hole's guess log drawn as the JOURNEY it is — the player's own
// stops on a single line that leads down to the hidden word.
//
// This replaced the route map (user-decided 2026-08-10, retiring #117), then took the
// map's SPINE back the same day on review: a flat sorted list was legible but said
// nothing — no starting word, no direction you could feel, no target being reached. What
// was retired stays retired (the censored census of every unfound group, the sticky "you
// are here" machinery — the parts that never helped anyone); what returns is the journey
// reading those parts were buried in: the START word the puzzle
// handed out, the guesses as stops ordered by their rank, and the `???`
// terminus that says the whole game in one token.
//
// Everything here is DERIVED — from (ranks[secret], tried, hole state, the meter's given
// ranks) — so it survives a reload for free and nothing new is persisted. Rendering lives in
// components/HistoryModal; this file is pure and tested.

import type { RankEntry } from '@whippin/shared';
import type { RuntimeHole } from './types';
import type { GivenRank } from './charge';

// What a MASKED hint displays — in the wheel, and in the sentence when it is picked: this
// many question marks, whatever the word's length (the length is never given away;
// user-asked 2026-09-22: "????? instead of nothing").
export const MASK = '?????';

// One place on the line the player has actually been: a ranked group they typed, or the
// start word they were given. Aliases collapse — a group reached through any of its
// inflections (#104) is ONE stop.
export interface HistoryStop {
  rank: number; // the group's rank — also its identity on this line
  // What the SENTENCE would show if this stop were swapped into the hole (the net's pick,
  // 2026-09-01): the group's canonical accented form — the hole never displays a typed
  // form, and a pick is the hole showing one of its own words. `MASK` on a masked hint:
  // picking one shows the mask in the sentence (user-decided 2026-09-22 — the slot is what
  // the hole shows, masks included; the alternative, a fold that could not pick a mask,
  // snapped the hole back to its best word and "felt weird").
  display: string;
  // How the stop is NAMED: the form the PLAYER TYPED wherever a typed form reached it —
  // their log, their words (answering `sables` with the group's `sable` reads as a
  // correction, legal because this game's input produces folded slug characters only). The canonical form
  // is the fallback for the two stops nobody typed: the departure, and a "you are here"
  // the hole reached through a deduped guess that never entered the log. EMPTY on a
  // MASKED stop: the word is not the player's yet, and nothing rendered may carry it.
  word: string;
  // A folded KEY that reaches this stop in the map — what a REVEAL submits as the guess
  // (never the display form: `fold` of an accented canonical is not always a key). Empty
  // where no key is known (a stop with no entry).
  slug: string;
  start: boolean; // the departure: the start word the puzzle handed out
  best: boolean; // "you are here": the hole's current closest word
  // FARTHER than the departure: a guess that went backwards from where the puzzle put the
  // player down. The journey runs departure → word (anything farther than the start is
  // behind you), so the drawing quiets these and
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
  // GIVEN by the meter (user-decided 2026-09-22; one at a time since 2026-10-02,
  // `game/charge.ts`): the hint an active hole offers — the next word closer than its best.
  // MASKED until the player takes it: a masked stop has no word (`word` empty, `display`
  // the MASK), only its rank; taking it — revealing it, or typing it — is a guess, and the
  // stop is then a hint CONSUMED: given, unmasked, wearing the foil. The solve unmasks
  // what was never taken.
  given: boolean;
  masked: boolean;
  taken: boolean; // a given hint the player consumed (guessed after it was given)
}

export interface HistoryModel {
  // The destination, revealed once the hole is solved or the round is over. Censored
  // (`???`) during play — the unknown target the whole line is walked toward.
  secret: string | null;
  solved: boolean;
  stops: HistoryStop[]; // closest-first
}

// The WALKED STRETCH by rank: every group from the secret out to `top` (the departure),
// which is the extent the journey covers and the most the drawing ever names. One pass
// over the alias-expanded map — tens of thousands of keys on a real puzzle — so it is
// cached per map object, exactly like the route map's own geometry was: the maps are
// immutable for a puzzle's lifetime, and this walk answers three questions at once (the
// departure's entry, the hole's current entry, and the solve's reveal).
//
// Aliases of a group carry identical values, so the first key found at a rank wins.
interface Found {
  entry: RankEntry;
  key: string; // a folded key that reaches the entry — the one a reveal submits
}
interface NearField {
  top: number;
  byRank: Map<number, Found>;
}
const nearFieldCache = new WeakMap<Record<string, RankEntry>, NearField>();

function nearField(rankMap: Record<string, RankEntry>, top: number): Map<number, Found> {
  const cached = nearFieldCache.get(rankMap);
  if (cached && cached.top >= top) return cached.byRank;
  const byRank = new Map<number, Found>();
  for (const key in rankMap) {
    const entry = rankMap[key];
    // rank 0 is the secret — the terminus, never a stop on the axis.
    if (entry.rank === 0 || entry.rank > top) continue;
    if (!byRank.has(entry.rank)) byRank.set(entry.rank, { entry, key });
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
  given = [],
  over = false,
}: {
  rankMap: Record<string, RankEntry>;
  tried: readonly string[]; // the round's counted guesses, folded, in try order
  hole: RuntimeHole; // live state: its current rank is what "you are here" means
  // The departure, identified by its stated RANK (`hole.start_rank`) — never by the start
  // word's slug, which `fold` can hand to a closer group (the #119 agreed-form case).
  startRank: number;
  secretWord: string; // the destination's accented form, shown only once solved
  // The ranks the meter has GIVEN (`replayCharge`'s `given`), each with whether the
  // player consumed it; none before the activation.
  given?: readonly GivenRank[];
  // The ROUND is over with this hole unsolved (the cap): its result page already shows the
  // answer, so the words grid hides nothing — no mask, and the headline names the secret.
  // Presentation only: the hole is still unsolved, and nothing it never reached is named.
  over?: boolean;
}): HistoryModel {
  const solved = hole.rank === 0;
  const byRank = new Map<number, HistoryStop>();

  // One stop per GROUP: an alias typed twice, or two inflections of one word, land on the
  // same rank and collapse into ONE stop (#104) — the first visit wins, so a stop wears
  // the form that first reached it. Rank 0 is the secret itself — the terminus, never a
  // stop on the axis.
  const visit = (
    entry: RankEntry,
    key: string,
    {
      start = false,
      typed,
      revealed = false,
      given = false,
      masked = false,
      taken = false,
    }: {
      start?: boolean;
      typed?: string;
      revealed?: boolean;
      given?: boolean;
      masked?: boolean;
      taken?: boolean;
    } = {},
  ) => {
    if (entry.rank === 0) return;
    const seen = byRank.get(entry.rank);
    if (seen) {
      if (start) seen.start = true;
      // A typed stop the meter also gave is a hint CONSUMED: it keeps the typed form and
      // takes the given dress.
      if (given) {
        seen.given = true;
        seen.taken = taken;
      }
      return;
    }
    byRank.set(entry.rank, {
      rank: entry.rank,
      display: masked ? MASK : entry.word,
      word: masked ? '' : (typed ?? entry.word),
      slug: key,
      start,
      best: false,
      behind: entry.rank > startRank,
      revealed,
      given,
      masked,
      taken,
    });
  };

  // The walked stretch, walked once: the departure, "you", the given words and the solve's
  // reveal all read their entries out of it. A given word is always closer than a word the
  // hole held, so the departure bounds them too.
  const field = nearField(rankMap, startRank);

  const startEntry = field.get(startRank);
  if (startEntry) visit(startEntry.entry, startEntry.key, { start: true });
  for (const typed of tried) {
    const entry = rankMap[typed];
    // A try with no rank at all is off the line entirely.
    if (entry) visit(entry, typed, { typed });
  }

  // "You are here" is the hole's OWN position, looked up rather than inferred from the
  // log: a guess deduped as a canonical duplicate never enters `tried` and can still
  // improve another hole, so the current group can be one the history never mentions.
  // A solved hole has reached the terminus, so nothing on the axis carries the marker.
  if (!solved) {
    const found = field.get(hole.rank);
    if (found) visit(found.entry, found.key);
    const here = byRank.get(hole.rank);
    if (here) here.best = true;
  }

  // THE GIVEN WORDS (user-decided 2026-09-22): the hints the active hole has offered. One
  // the player CONSUMED — guessed while it was offered — is in the log already and stands
  // as a typed stop; visiting it again marks it given (the foil). The one on offer is
  // MASKED while the hole is live: a stop with a rank and no word. The solve — or the round
  // being over — unmasks it, named with the canonical form, still given (it was on offer,
  // not merely named afterwards).
  for (const { rank, consumed } of given) {
    const found = field.get(rank);
    if (found) {
      visit(found.entry, found.key, { given: true, masked: !solved && !over && !consumed, taken: consumed });
    }
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
      const found = field.get(rank);
      if (found) visit(found.entry, found.key, { revealed: true });
    }
  }

  return {
    secret: solved || over ? secretWord : null,
    solved,
    stops: [...byRank.values()].sort((a, b) => a.rank - b.rank),
  };
}
