import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { rankHeatColor } from '../components/Hole';
import type { RankEntry } from '@whippin/shared';

// The scramble demo (#51, stage 1): the tutorial's one place that cannot be the real
// <Hole> — the game has no "walk AWAY from the secret" mechanic, and the fast roll
// must flash every intermediate word, which Hole's blink choreography (deliberately)
// prevents. It borrows Hole's exact CSS classes and heat ramp, so it LOOKS identical.
//
// Choreography (one SCRAMBLE press): the blue secret steps through its neighbors
// 1..STEP_UP_TO (each swap visible), then fast-rolls through the remaining ladder
// words, landing on the start word (rank = startRank). That landing word IS what a
// real round starts from — the demo is a literal explanation of the start word.

const STEP_UP_TO = 5; // slow, one-by-one phase: neighbors 1..5
const STEP_MS = 750; // pace of the slow phase
const ROLL_MS = 90; // pace of the fast roll ("in a second" to rank 100)

export default function ScrambleWord({
  secret,
  ladder,
  startRank,
  buttonLabel,
  onDone,
}: {
  secret: string; // the display form shown solved-blue before the scramble
  ladder: RankEntry[]; // real neighbors, rank ascending, ending at the start word
  startRank: number; // where the roll lands (the board's start_rank)
  buttonLabel: string;
  onDone: () => void;
}) {
  // Index into `ladder` (-1 = still the untouched blue secret).
  const [at, setAt] = useState(-1);
  const [running, setRunning] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const start = () => {
    if (running) return;
    setRunning(true);
    const advance = (i: number) => {
      setAt(i);
      if (i >= ladder.length - 1) {
        // Landed on the start word: hold a beat so the landing registers, then done.
        timer.current = window.setTimeout(onDone, 900);
        return;
      }
      const slow = ladder[i + 1].rank <= STEP_UP_TO;
      timer.current = window.setTimeout(() => advance(i + 1), slow ? STEP_MS : ROLL_MS);
    };
    timer.current = window.setTimeout(() => advance(0), STEP_MS);
  };

  const entry = at >= 0 ? ladder[at] : null;
  const rankStyle: (CSSProperties & Record<'--rank-color', string>) | undefined = entry
    ? { '--rank-color': rankHeatColor(entry.rank, startRank) }
    : undefined;

  return (
    <div className="scramble">
      {/* Same markup/classes as a real hole: gold word + heat-colored exponent; the
          untouched secret renders like a SOLVED hole (blue, no exponent). */}
      <p className="phrase">
        <span className={`hole${entry ? '' : ' resolved'}`}>
          <span className="hole-word-wrap">
            <span className="hole-word">{entry ? entry.word : secret}</span>
          </span>
          {entry && (
            <sup className="hole-rank" style={rankStyle}>
              -{entry.rank}
            </sup>
          )}
        </span>
      </p>
      {/* Sits in the input row's slot (same reserved height), so the input appearing
          on the next step never shifts the word. */}
      <div className="input-area scramble-actions">
        {!running && (
          <button type="button" className="scramble-btn" onClick={start}>
            {buttonLabel}
          </button>
        )}
      </div>
    </div>
  );
}
