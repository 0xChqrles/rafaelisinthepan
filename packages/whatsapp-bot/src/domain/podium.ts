// The WhatsApp podium has ITS OWN ranking semantics (#236): a DENSE ordering of distinct
// scores, equal scores grouped onto one line — 1, 2, 2 → next position is 3 — which is the
// format the group already writes by hand. Deliberately NOT `rankBoard` from
// `@whippin/shared`: that is competition ranking (1, 2, 2, 4) and belongs to the public
// board, a different product. Everything here is deterministic; the only thing a model
// ever adds is a comment keyed to a line it may not reorder.

import type { Declaration } from './declarations';

export interface PodiumPlayer {
  jid: string;
  name: string;
}

export interface PodiumLine {
  position: number;
  score: number;
  players: PodiumPlayer[];
}

export interface Podium {
  dayNumber: number;
  lines: PodiumLine[];
  // Runs that ended at ∞ (#214): recorded declarations with no finite score. Listed after
  // the positions, never given one.
  capped: PodiumPlayer[];
}

export type NameOf = (declaration: Declaration) => string;

export function buildPodium(
  dayNumber: number,
  rows: readonly Declaration[],
  nameOf: NameOf = (d) => d.name,
): Podium {
  const byScore = new Map<number, PodiumPlayer[]>();
  const capped: PodiumPlayer[] = [];
  for (const row of rows) {
    if (row.dayNumber !== dayNumber) continue;
    const player = { jid: row.sender, name: nameOf(row) };
    if (row.capped) {
      capped.push(player);
      continue;
    }
    const players = byScore.get(row.score) ?? [];
    players.push(player);
    byScore.set(row.score, players);
  }
  const byName = (a: PodiumPlayer, b: PodiumPlayer) =>
    a.name.localeCompare(b.name) || a.jid.localeCompare(b.jid);
  const lines = [...byScore.entries()]
    .sort(([a], [b]) => a - b)
    .map(([score, players], index) => ({
      position: index + 1,
      score,
      players: players.sort(byName),
    }));
  return { dayNumber, lines, capped: capped.sort(byName) };
}
