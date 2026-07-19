import type { BenchmarkResults } from '@whippin/shared';

export interface BenchmarkRankingEntry {
  label: string;
  tries: number | null;
  player: boolean;
}

// Ascending by tries with DNF (null) last. Used with a stable sort and the player
// appended AFTER the models, so an equal count leaves the finished model AHEAD of the
// still-counting player — a tie reads as the opponent already done at N.
function byTries(a: { tries: number | null }, b: { tries: number | null }): number {
  if (a.tries === null) return b.tries === null ? 0 : 1;
  if (b.tries === null) return -1;
  return a.tries - b.tries;
}

// Build the solved-screen race result. Modern JS sort is stable, so equal-scoring models
// retain the curator's puzzle order and the player (inserted last) follows tied models.
export function benchmarkRanking(
  entries: BenchmarkResults,
  playerTries: number,
  playerLabel: string,
): BenchmarkRankingEntry[] {
  return [
    ...entries.map(({ label, tries }) => ({ label, tries, player: false })),
    { label: playerLabel, tries: playerTries, player: true },
  ].sort(byTries);
}

// One entrant standing in the mid-game lineup (#81). `key` is a stable render identity
// (the model id, or "player") so a reorder moves the same element instead of remounting
// it; `sprite` is the opponent's fixed puzzle-order index (0..2) driving which placeholder
// character it wears, independent of its current standing.
export interface LineupEntrant {
  key: string;
  tag: string; // compact name under the character (the localized YOU label for the player)
  label: string; // full name, for live-region announcements
  tries: number | null; // models: final score (null = DNF); player: live counted tries
  player: boolean;
  sprite: number;
}

export interface LineupModel {
  entrants: LineupEntrant[]; // sorted best -> worst == left -> right; entrants[0] leads
  playerIndex: number;
}

// Map (live counted tries, benchmark entries) -> the standings lineup. Same ordering
// contract as benchmarkRanking (stable sort, player inserted last): position encodes
// ORDER only, ties keep the curator's model order with the player to the RIGHT of an
// opponent it just caught, and DNF models stand at the far right. The crown always
// belongs to entrants[0].
export function lineupModel(
  entries: BenchmarkResults,
  playerTries: number,
  playerLabel: string,
): LineupModel {
  const entrants = [
    ...entries.map(({ model, tag, label, tries }, sprite) => ({
      key: model,
      tag,
      label,
      tries,
      player: false,
      sprite,
    })),
    { key: 'player', tag: playerLabel, label: playerLabel, tries: playerTries, player: true, sprite: -1 },
  ].sort(byTries);
  return { entrants, playerIndex: entrants.findIndex((e) => e.player) };
}

// What changed for the player between two lineup states. Opponent scores are static and
// the live count only grows, so the player only ever moves RIGHT: `passedBy` lists the
// opponents newly ahead of the player, and `lostLead` fires (at most once per round) when
// the crown leaves the player — the new leader is then among `passedBy`.
export interface LineupEvents {
  passedBy: LineupEntrant[];
  lostLead: boolean;
}

export function lineupEvents(prev: LineupModel, next: LineupModel): LineupEvents {
  const wasAhead = new Set(
    prev.entrants.slice(0, prev.playerIndex).map((e) => e.key),
  );
  return {
    passedBy: next.entrants
      .slice(0, next.playerIndex)
      .filter((e) => !wasAhead.has(e.key)),
    lostLead: prev.entrants[0].player && !next.entrants[0].player,
  };
}
