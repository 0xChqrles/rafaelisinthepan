import type { BenchmarkEntry, BenchmarkResults } from '@whippin/shared';

// The player-facing display trio, in fixed left-to-right order. A puzzle's benchmark array
// records EVERY tested model (variable length) and may carry any SUBSET of these three plus
// lab-only models; the front end renders only these, and each keeps a stable sprite (its
// pixel character) by its position here regardless of which others are present.
export const DISPLAY_MODEL_IDS = ['claude-fable-5', 'k3', 'gpt-5.6-sol'] as const;

export interface DisplayEntry {
  entry: BenchmarkEntry;
  sprite: number; // 0..2 canonical index — which pixel character it wears
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
// A type predicate, so callers get the narrowed array without a second `benchmark &&`.
export function hasDisplayEntries(
  entries: BenchmarkResults | undefined,
): entries is BenchmarkResults {
  return entries !== undefined && displayEntries(entries).length > 0;
}

// Ascending by tries with DNF (null) last.
function byTries(a: { tries: number | null }, b: { tries: number | null }): number {
  if (a.tries === null) return b.tries === null ? 0 : 1;
  if (b.tries === null) return -1;
  return a.tries - b.tries;
}

// One entrant standing in the mid-game lineup (#81). `key` is a stable render identity
// (the model id, or "player") so a reorder moves the same element instead of remounting
// it; `sprite` is the opponent's fixed puzzle-order index (0..2) driving which pixel
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

// Map (live counted tries, benchmark entries) -> the standings lineup, and — replayed
// once more at the end — the solved leaderboard's row order, so the two surfaces can
// never disagree about the same race. Position encodes ORDER only, ties among models keep
// the curator's puzzle order, and DNF models stand at the far right. A tie keeps the
// PLAYER ahead: an opponent only moves in front once the live count strictly EXCEEDS its
// score (decided 2026-07-24) — reaching an opponent's count is not yet losing to it while
// the round is still running, and a finished tie displays as a HUMAN WIN (#110).
// entrants[0] is the leader.
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
  ].sort((a, b) => byTries(a, b) || Number(b.player) - Number(a.player));
  return { entrants, playerIndex: entrants.findIndex((e) => e.player) };
}

// What changed for the player between two lineup states. Opponent scores are static and
// the live count only grows, so the player only ever moves RIGHT: `passedBy` lists the
// opponents newly ahead of the player, and `lostLead` fires (at most once per round) when
// the player loses first place — the new leader is then among `passedBy`.
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
