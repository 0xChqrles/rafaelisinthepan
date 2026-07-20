import type { BenchmarkEntry, BenchmarkResults } from '@whippin/shared';

// The player-facing display trio, in fixed left-to-right order. A puzzle's benchmark array
// records EVERY tested model (variable length) and may carry any SUBSET of these three plus
// lab-only models; the front end renders only these, and each keeps a stable sprite (its
// placeholder character) by its position here regardless of which others are present.
export const DISPLAY_MODEL_IDS = ['claude-fable-5', 'k3', 'gpt-5.6-sol'] as const;

export interface DisplayEntry {
  entry: BenchmarkEntry;
  sprite: number; // 0..2 canonical index — which placeholder character it wears
}

// Filter a puzzle's recorded models down to the present display models, in canonical order
// with a stable sprite each. Model ids are unique per the schema, so at most one per slot.
export function displayEntries(entries: BenchmarkResults): DisplayEntry[] {
  return DISPLAY_MODEL_IDS.flatMap((model, sprite) => {
    const entry = entries.find((e) => e.model === model);
    return entry ? [{ entry, sprite }] : [];
  });
}

// Whether a puzzle carries any RENDERABLE opponent — a benchmark array full of only
// lab-only models shows no lineup, exactly like a puzzle with no benchmark at all.
export function hasDisplayEntries(entries: BenchmarkResults | undefined): boolean {
  return entries !== undefined && displayEntries(entries).length > 0;
}

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
    ...displayEntries(entries).map(({ entry: { label, tries } }) => ({
      label,
      tries,
      player: false,
    })),
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
    ...displayEntries(entries).map(({ entry: { model, tag, label, tries }, sprite }) => ({
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
