import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import FloatingHit, { HIT_FADE_MS } from './FloatingHit';
import { heatColor } from '@whippin/shared';
import useAnimatedNumber, { linearEasing } from '../hooks/useAnimatedNumber';
import { prefersReducedMotion, useScramble } from '../hooks/useScramble';
import type { HitState, RuntimeHole } from '@whippin/shared';

// The floating number ("hit") does not improve any hole: cap its heat at 150 so
// the gradient stays meaningful. Above that, everything stays at the coldest color.
const HIT_HEAT_CAP = 150;

// Keep the existing 520ms beat for a ten-rank transition below the cap, while making
// every individual rank step take the same 52ms. Large transitions stay responsive.
export const RANK_STEP_MS = HIT_FADE_MS / 10;
export const RANK_MAX_MS = 500;
export function rankTransitionDuration(fromRank: number, toRank: number): number {
  return Math.min(
    RANK_MAX_MS,
    Math.abs(Math.round(fromRank) - Math.round(toRank)) * RANK_STEP_MS,
  );
}

// The exponent tween honors prefers-reduced-motion by SNAPPING (duration 0, so
// useAnimatedNumber jumps straight to the value). Otherwise the number would keep
// rolling for up to RANK_MAX_MS while the reduced-motion word swap has already settled
// instantly (useScramble) — leaving the two out of step. rankTransitionDuration itself
// stays pure: MixWord/Tutorial schedule their own timing against it.
function rankTweenDuration(fromRank: number, toRank: number): number {
  return prefersReducedMotion() ? 0 : rankTransitionDuration(fromRank, toRank);
}

// Hole heat: current rank -> [0 cold .. 1 hot] (rank 0 = solved = hot).
// Logarithmic scale: color changes quickly near the goal (low ranks) and slowly
// far away (the 100->150 gap weighs much less than 1->10).
// Exported: the tutorial's scramble demo (#51) paints its exponent with the same
// ramp so its word reads exactly like a real hole.
export function rankHeatColor(rank: number, startRank: number) {
  const maxRank = Math.max(1, startRank || rank || 1);
  const heat = 1 - Math.log(rank + 1) / Math.log(maxRank + 1);
  return heatColor(heat);
}

// A hole: "displayed_word^-current_rank" (ex: sailor^-87). Rank 0 = solved.
export default function Hole({
  hole,
  hit,
  holeIndex,
  onHitDone,
  onResolved,
}: {
  hole: RuntimeHole;
  hit: HitState | null;
  holeIndex: number;
  onHitDone: (id: number) => void;
  onResolved?: (index: number) => void;
}) {
  // Exponent rolls toward the current rank one rank step at a time (or snaps under
  // reduced motion, see rankTweenDuration). A solved hole visibly reaches 0, then removes
  // the exponent on the next frame so the decrease reads as -N -> ... -> 0 -> nothing.
  const animatedRank = useAnimatedNumber(hole.rank, rankTweenDuration, linearEasing);
  const shownRank = Math.round(animatedRank);
  const [displayWord, setDisplayWord] = useState<string>(hole.word);
  // Match the tutorial's rank-pop choreography: a nonce remounts the exact same
  // `.rank-pop` animation for each rank decrease.
  const [rankPop, setRankPop] = useState(0);
  const [rankPopActive, setRankPopActive] = useState(false);
  const previousRank = useRef(hole.rank);
  const [rankVisible, setRankVisible] = useState<boolean>(hole.rank > 0);
  const showRank = hole.rank > 0 || rankVisible;

  useEffect(() => {
    const improved = hole.rank < previousRank.current;
    previousRank.current = hole.rank;
    if (!improved) return undefined;
    setRankPopActive(false);
    const frame = requestAnimationFrame(() => {
      setRankPopActive(true);
      setRankPop((n) => n + 1);
    });
    return () => cancelAnimationFrame(frame);
  }, [hole.rank]);

  useEffect(() => {
    if (hole.rank > 0) {
      setRankVisible(true);
      return undefined;
    }
    if (!rankVisible || animatedRank !== hole.rank || rankPopActive) return undefined;
    const frame = requestAnimationFrame(() => setRankVisible(false));
    return () => cancelAnimationFrame(frame);
  }, [animatedRank, hole.rank, rankPopActive, rankVisible]);

  // Word replacement choreography. The improved word + rank arrive together (when the
  // hit starts fading), and the rank decrease + slot-machine scramble launch in the same
  // effect cycle. The word first mixes IN PLACE for RANK_MAX_MS — the exponent tween's
  // length — so the number finishes dropping before the letters settle; only THEN does
  // the word fix its letters and interpolate its length old -> new. So the sentence never
  // reflows while the exponent is still moving, and that gradual reflow is what lets the
  // phrase wrap as natural prose (no forced <br/> per hole).
  const { jumble, start } = useScramble();
  useEffect(() => {
    if (hole.word === displayWord) return undefined;
    // Mix in place through the numeric tween (RANK_MAX_MS), then settle. displayWord flips
    // to the target only when the scramble settles, which is also what marks the hole
    // resolved (see `resolved` below).
    const target = hole.word;
    const fromLen = displayWord.length;
    start(
      target,
      fromLen,
      () => {
        setDisplayWord(target);
      },
      RANK_MAX_MS,
    );
    return undefined;
  }, [displayWord, hole.word, start]);

  // Accent ("resolved") styling only once the FINAL secret word is on screen —
  // not during the exponent drop / scramble that precedes the swap.
  const resolved = hole.rank === 0 && displayWord === hole.word;
  useEffect(() => {
    if (resolved) onResolved?.(holeIndex);
  }, [holeIndex, onResolved, resolved]);

  // The exponent sizes to its own content (no reserved width), so a following suffix
  // sits right after the number instead of after a gap left for the widest rank.
  const rankStyle: CSSProperties & Record<'--rank-color', string> = {
    '--rank-color': rankHeatColor(shownRank, hole.startRank),
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
          className={`hole-word${hit ? ' hit-shake' : ''}`}
          style={hitStyle}
        >
          {jumble ?? displayWord}
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
          // Remount per rank decrease so the tutorial's exact rank-pop animation replays
          // even when two consecutive improvements happen close together.
          key={rankPop}
          className={`hole-rank${rankPopActive ? ' rank-pop' : ''}`}
          style={rankStyle}
          onAnimationEnd={() => setRankPopActive(false)}
        >
          {shownRank === 0 ? '0' : `-${shownRank}`}
        </sup>
      )}
    </span>
  );
}
