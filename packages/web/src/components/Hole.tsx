import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import FloatingHit from './FloatingHit';
import { heatColor } from '../game/heat';
import useAnimatedNumber from '../hooks/useAnimatedNumber';
import type { HitState, RuntimeHole } from '@word-hunt/shared';

// The floating number ("hit") does not improve any hole: cap its heat at 150 so
// the gradient stays meaningful. Above that, everything stays at the coldest color (blue).
const HIT_HEAT_CAP = 150;

// Hole heat: current rank -> [0 cold .. 1 hot] (rank 0 = solved = hot).
// Logarithmic scale: color changes quickly near the goal (low ranks) and slowly
// far away (the 100->150 gap weighs much less than 1->10).
function rankHeatColor(rank: number, startRank: number) {
  const maxRank = Math.max(1, startRank || rank || 1);
  const heat = 1 - Math.log(rank + 1) / Math.log(maxRank + 1);
  return heatColor(heat);
}

// A hole: "displayed_word^-current_rank" (ex: sailor^-87). Rank 0 = solved.
export default function Hole({
  hole,
  hit,
  onHitDone,
}: {
  hole: RuntimeHole;
  hit: HitState | null;
  onHitDone: (id: number) => void;
}) {
  const resolved = hole.rank === 0;

  // Word found (rank 0): animate down to zero, then remove the exponent.
  const animatedRank = useAnimatedNumber(hole.rank);
  const shownRank = Math.round(animatedRank);
  const showRank = shownRank > 0;

  // Small "pop" on each improvement (rank decreases). Double-toggle through rAF
  // to replay the animation even on two consecutive improvements.
  const [popping, setPopping] = useState<boolean>(false);
  const prevRank = useRef<number>(hole.rank);
  useEffect(() => {
    const improved = hole.rank < prevRank.current;
    prevRank.current = hole.rank;
    if (!improved) return undefined;
    setPopping(false);
    const id = requestAnimationFrame(() => setPopping(true));
    return () => cancelAnimationFrame(id);
  }, [hole.rank]);

  const rankStyle: CSSProperties & Record<'--rank-color' | '--rank-width', string> = {
    '--rank-color': rankHeatColor(shownRank, hole.startRank),
    '--rank-width': `${String(hole.startRank).length + 1}ch`,
  };

  return (
    <span className={`hole${resolved ? ' resolved' : ''}`}>
      {/* Key distinct from FloatingHit (otherwise collision -> duplicated word);
          changing it restarts the shake even on two consecutive hits. */}
      <span key={hit ? `word-${hit.id}` : 'word'} className={`hole-word${hit ? ' hit-shake' : ''}`}>
        {hole.word}
      </span>
      {showRank && (
        <sup
          className={`hole-rank${popping ? ' rank-pop' : ''}`}
          style={rankStyle}
          onAnimationEnd={() => setPopping(false)}
        >
          -{shownRank}
        </sup>
      )}
      {/* Floating "damage"-style indicator: a distance number colored by the
          heatmap (capped heat), or "MISS" at the coldest color when too far. */}
      {hit && (
        <FloatingHit
          key={hit.id}
          id={hit.id}
          value={hit.value}
          miss={hit.miss}
          color={hit.miss ? heatColor(0) : rankHeatColor(hit.value, HIT_HEAT_CAP)}
          onDone={onHitDone}
        />
      )}
    </span>
  );
}
