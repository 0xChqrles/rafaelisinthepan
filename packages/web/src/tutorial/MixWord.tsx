import type { CSSProperties } from 'react';
import { rankHeatColor } from '../components/Hole';
import type { RankEntry } from '@whippin/shared';

// The mix demo's word (#51, stage 1) — a dumb display: Tutorial owns the animation
// (which ladder entry is showing, whether it is shaking); this renders it with the
// real hole's markup, classes and heat ramp, so it is visually indistinguishable
// from the game. It cannot BE <Hole>: the game has no walk-away-from-the-secret
// mechanic, and the fast roll must flash every intermediate word, which Hole's
// blink choreography deliberately prevents.
export default function MixWord({
  secret,
  entry,
  startRank,
  shaking,
}: {
  secret: string; // display form shown solved-blue before any mix
  entry: RankEntry | null; // current ladder word, or null = the untouched secret
  startRank: number; // heat scale (the ladder's landing rank)
  shaking: boolean;
}) {
  const rankStyle: (CSSProperties & Record<'--rank-color', string>) | undefined = entry
    ? { '--rank-color': rankHeatColor(entry.rank, startRank) }
    : undefined;

  return (
    <p className="phrase">
      <span className={`hole${entry ? '' : ' resolved'}`}>
        <span className="hole-word-wrap">
          <span className={`hole-word${shaking ? ' hit-shake' : ''}`}>
            {entry ? entry.word : secret}
          </span>
        </span>
        {entry && (
          <sup className="hole-rank" style={rankStyle}>
            -{entry.rank}
          </sup>
        )}
      </span>
    </p>
  );
}
