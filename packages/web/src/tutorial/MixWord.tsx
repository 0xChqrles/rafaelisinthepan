import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { rankHeatColor } from '../components/Hole';
import type { RankEntry } from '@whippin/shared';

// The mix demo's word (#51, stage 1). Tutorial owns the slot-machine animation
// (which ladder entry is flashing, and whether the wheel has LANDED); this renders
// it with the real hole's markup, classes and heat ramp, so it is visually
// indistinguishable from the game. It cannot BE <Hole>: the game has no
// walk-away-from-the-secret mechanic, and the rolls must flash every intermediate
// word, which Hole's blink choreography deliberately prevents.
//
// Exponent contract (all three mixes): NO exponent while the wheel spins — the
// flashing is words only. On landing, the exponent's slot is reserved immediately
// (visibility, not conditional render), so the landed word claims its final centered
// position at once; the rank then POPS IN a beat later, moving nothing.

const EXPONENT_DELAY_MS = 200; // beat between the wheel landing and the rank pop

export default function MixWord({
  secret,
  entry,
  startRank,
  landed,
}: {
  secret: string; // display form shown solved-blue before any mix
  entry: RankEntry | null; // the flashing/landed ladder word (null = the secret)
  startRank: number; // heat scale (the ladder's landing rank)
  landed: boolean; // false while the wheel spins; true once it stops on a word
}) {
  const [supIn, setSupIn] = useState(false);
  const supTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(supTimer.current);
    if (!landed) {
      setSupIn(false); // a new spin: the exponent leaves with it
      return undefined;
    }
    supTimer.current = window.setTimeout(() => setSupIn(true), EXPONENT_DELAY_MS);
    return () => window.clearTimeout(supTimer.current);
  }, [landed]);

  const rankStyle: (CSSProperties & Record<'--rank-color', string>) | undefined = entry
    ? {
        '--rank-color': rankHeatColor(entry.rank, startRank),
        visibility: supIn ? undefined : 'hidden',
      }
    : undefined;

  return (
    <p className="phrase">
      <span className={`hole${entry ? '' : ' resolved'}`}>
        <span className="hole-word-wrap">
          <span className="hole-word">{entry ? entry.word : secret}</span>
        </span>
        {entry && landed && (
          <sup className={`hole-rank${supIn ? ' rank-pop' : ''}`} style={rankStyle}>
            -{entry.rank}
          </sup>
        )}
      </span>
    </p>
  );
}
