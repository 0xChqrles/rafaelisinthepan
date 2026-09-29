import type { CSSProperties } from 'react';
import { rankHeatColor } from '@whippin/shared';
import type { WordPuzzle } from '@whippin/shared';

// A REAL NEIGHBOURHOOD: the first words of a bundled board (the game's own embedding, the
// tutorial's pruned #154 artifact), one per rank, then the farther words the text names —
// every rank in the colour the sentence would print it in.
function byRank(board: WordPuzzle): Map<number, string> {
  const out = new Map<number, string>();
  for (const entry of Object.values(board.ranks)) {
    if (entry.rank > 0 && !out.has(entry.rank)) out.set(entry.rank, entry.word);
  }
  return out;
}

export default function Ranks({ board, take, more }: { board: WordPuzzle; take: number; more: string[] }) {
  const ranks = byRank(board);
  const first = [...ranks.entries()].sort((a, b) => a[0] - b[0]).slice(0, take);
  const far = more
    .map((slug) => board.ranks[slug])
    .filter((e): e is NonNullable<typeof e> => e !== undefined)
    .sort((a, b) => a.rank - b.rank)
    .map((e) => [e.rank, e.word] as const);
  const row = ([rank, word]: readonly [number, string]) => (
    <li key={rank} style={{ '--rank-color': rankHeatColor(rank) } as CSSProperties}>
      <span className="ar-ranks-no">{rank}</span>
      <span className="ar-ranks-word">{word}</span>
    </li>
  );
  return (
    <div className="ar-ranks">
      <p className="ar-ranks-secret">
        <span className="ar-held">
          <span className="ar-held-text">{board.word.word}</span>
        </span>
      </p>
      <ol className="ar-ranks-list">{first.map(row)}</ol>
      {far.length > 0 && (
        <>
          <p className="ar-ranks-gap" aria-hidden="true">
            ⋯
          </p>
          <ol className="ar-ranks-list">{far.map(row)}</ol>
        </>
      )}
    </div>
  );
}
