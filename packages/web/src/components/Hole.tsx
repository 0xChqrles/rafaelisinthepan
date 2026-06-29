import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import FloatingHit, { HIT_FADE_MS } from './FloatingHit';
import { heatColor } from '../game/heat';
import useAnimatedNumber from '../hooks/useAnimatedNumber';
import type { HitState, RuntimeHole } from '@whippin/shared';

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
  // Exponent rolls toward the current rank over the SAME time the hit takes to
  // fade out: on an improvement the number drops as the floating hit disappears,
  // and reaches zero when a hole is solved (then the exponent is removed).
  const animatedRank = useAnimatedNumber(hole.rank, HIT_FADE_MS);
  const shownRank = Math.round(animatedRank);
  const showRank = shownRank > 0;

  // Word replacement choreography. The improved word + rank arrive together (when
  // the hit starts fading). We keep the OLD word on screen through the exponent
  // drop, THEN blink it 3× and swap to the new word (see `.word-replace-blink`).
  const [displayWord, setDisplayWord] = useState<string>(hole.word);
  const [replacing, setReplacing] = useState<boolean>(false);
  useEffect(() => {
    if (hole.word === displayWord) return undefined;
    // Hold the old word through the exponent drop / hit fade, then blink it.
    const t = window.setTimeout(() => setReplacing(true), HIT_FADE_MS);
    return () => window.clearTimeout(t);
  }, [hole.word, displayWord]);

  // Accent ("resolved") styling only once the FINAL secret word is on screen —
  // not during the exponent drop / blink that precedes the swap.
  const resolved = hole.rank === 0 && displayWord === hole.word;

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
  const hitStyle: (CSSProperties & Record<'--hit-delay', string>) | undefined = hit
    ? { '--hit-delay': `${hit.startDelayMs}ms` }
    : undefined;

  return (
    <span className={`hole${resolved ? ' resolved' : ''}`}>
      {/* The hit is positioned against this wrapper, which is sized to the WORD
          only (the exponent sits outside it), so the floating number stays centered
          over the word and not the word+exponent. */}
      <span className="hole-word-wrap">
        {/* Key distinct from FloatingHit (otherwise collision -> duplicated word);
            changing it restarts the shake even on two consecutive hits. */}
        <span
          key={hit ? `word-${hit.id}` : 'word'}
          className={`hole-word${hit ? ' hit-shake' : ''}${replacing ? ' word-replace-blink' : ''}`}
          style={hitStyle}
          onAnimationEnd={(e) => {
            if (e.animationName !== 'word-replace-blink') return;
            setDisplayWord(hole.word); // blink finished -> reveal the improved word
            setReplacing(false);
          }}
        >
          {displayWord}
        </span>
        {/* Floating "damage"-style indicator: a distance number colored by the
            heatmap (capped heat), or "MISS" at the coldest color when too far. */}
        {hit && (
          <FloatingHit
            key={hit.id}
            id={hit.id}
            value={hit.value}
            miss={hit.miss}
            startDelayMs={hit.startDelayMs}
            fadeDelayMs={hit.fadeDelayMs}
            color={hit.miss ? heatColor(0) : rankHeatColor(hit.value, HIT_HEAT_CAP)}
            onDone={onHitDone}
          />
        )}
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
    </span>
  );
}
