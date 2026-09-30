// The WhatsApp podium has ITS OWN ranking semantics (#236): a DENSE ordering of distinct
// scores — 1, 2, 2 → next position is 3 — which is the format the group already writes by
// hand. ONE PLAYER PER LINE (user-decided 2026-09-29): equal scores share a position,
// never a line — a line holding two names got one comment for two people, and it read
// oddly. Deliberately NOT `rankBoard` from `@whippin/shared`: that is competition ranking
// (1, 2, 2, 4) and belongs to the public board, a different product. Everything here is
// deterministic; the only thing a model ever adds is a comment keyed to a line it may not
// reorder.

import type { Declaration } from './declarations';

export interface PodiumPlayer {
  jid: string;
  name: string;
}

export interface PodiumLine {
  position: number;
  score: number;
  player: PodiumPlayer;
}

export interface Podium {
  dayNumber: number;
  lines: PodiumLine[];
  // Runs that ended at ∞ (#214): recorded declarations with no finite score. Listed after
  // the positions, one per line too, never given one.
  capped: PodiumPlayer[];
}

export type NameOf = (declaration: Declaration) => string;

// A run that ended at ∞ is behind every finished one and level with another ∞.
export function rankOf(d: Pick<Declaration, 'score' | 'capped'>): number {
  return d.capped ? Number.POSITIVE_INFINITY : d.score;
}

export function buildPodium(
  dayNumber: number,
  rows: readonly Declaration[],
  nameOf: NameOf = (d) => d.name,
): Podium {
  const players: { score: number; player: PodiumPlayer }[] = [];
  const capped: PodiumPlayer[] = [];
  for (const row of rows) {
    if (row.dayNumber !== dayNumber) continue;
    const player = { jid: row.sender, name: nameOf(row) };
    if (row.capped) capped.push(player);
    else players.push({ score: row.score, player });
  }
  const byName = (a: PodiumPlayer, b: PodiumPlayer) =>
    a.name.localeCompare(b.name) || a.jid.localeCompare(b.jid);
  players.sort((a, b) => a.score - b.score || byName(a.player, b.player));
  const lines: PodiumLine[] = [];
  for (const { score, player } of players) {
    const previous = lines.at(-1);
    const position = !previous ? 1 : previous.score === score ? previous.position : previous.position + 1;
    lines.push({ position, score, player });
  }
  return { dayNumber, lines, capped: capped.sort(byName) };
}

// THE OTHER LANGUAGES' RESULTS OF A DAY (user-decided 2026-09-29). A group plays ONE
// language — its podium, its leader, its reminder — and a player who also shares the other
// language's result is recorded under that language and listed in ONE closing line of the
// podium: names and scores, best first, ∞ last. No places, no comments, no comparison with
// the group's own board: the two languages are two different puzzles.
export interface OtherLanguage {
  lang: string;
  results: { name: string; score: number | '∞' }[];
}

export function otherLanguages(
  dayNumber: number,
  rows: readonly Declaration[],
  language: string,
  nameOf: NameOf = (d) => d.name,
): OtherLanguage[] {
  const langs = [...new Set(rows.filter((r) => r.dayNumber === dayNumber && r.lang !== language).map((r) => r.lang))].sort();
  return langs.map((lang) => {
    const podium = buildPodium(
      dayNumber,
      rows.filter((r) => r.lang === lang),
      nameOf,
    );
    return {
      lang,
      results: [
        ...podium.lines.map((l) => ({ name: l.player.name, score: l.score as number | '∞' })),
        ...podium.capped.map((p) => ({ name: p.name, score: '∞' as const })),
      ],
    };
  });
}
