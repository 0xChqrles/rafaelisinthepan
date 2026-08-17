import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import FloatingHit, { HIT_FADE_MS } from './FloatingHit';
import { HIT_HEAT_CAP, MISS_COLOR, rankHeatColor } from '@whippin/shared';
import useAnimatedNumber, { linearEasing } from '../hooks/useAnimatedNumber';
import useLetterWave, { WAVE_VARS } from '../hooks/useLetterWave';
import { prefersReducedMotion, useScramble } from '../hooks/useScramble';
import type { HitState, RuntimeHole } from '@whippin/shared';

// `rankHeatColor` and its `HIT_HEAT_CAP` scale live in @whippin/shared since 2026-08-16
// (they used to live here): the run ruler paints a progress % as the exponent still to go,
// and the share card renders that same bar in the Lambda, where no web component can be
// imported. Everything that draws an exponent — this hole, the floating hit, the route
// rows, a claim's loot, the tutorial — takes it from there.

// Keep the existing 520ms beat for a ten-rank transition below the cap, while making
// every individual rank step take the same 52ms. Large transitions stay responsive.
const RANK_STEP_MS = HIT_FADE_MS / 10;
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

// A hole: "displayed_word^current_rank" (ex: sailor^87). Rank 0 = solved. The exponent is
// written WITHOUT a leading minus (user-decided 2026-08-16): it is a distance, and distances
// are not negative — the app writes a rank the same bare way everywhere it shows one.
export default function Hole({
  hole,
  hit,
  holeIndex,
  onHitDone,
  onResolved,
  explore,
  quiet = false,
}: {
  hole: RuntimeHole;
  hit: HitState | null;
  holeIndex: number;
  onHitDone: (id: number) => void;
  onResolved?: (index: number) => void;
  // The history modal's entry point (2026-08-10, formerly the #117 route map's): the whole
  // hole becomes one button. Present for the WHOLE round or not at all — the choreography
  // gates it with `disabled` rather than by unwrapping, which would remount the word
  // mid-scramble. `hintId` points at the sr-only "your tries" note Phrase renders OUTSIDE
  // the sentence; see the button below for why it is a description and not a label.
  explore?: { hintId: string; disabled: boolean; onOpen: () => void };
  // Is the SENTENCE quiet — no guess feedback in flight, no modal over it, the round still
  // being played? That is the one thing about the ambient wave (#129) a hole cannot see for
  // itself, so the round supplies it and the hole owns everything else: its own clock, and
  // whether it is personally free to ripple.
  quiet?: boolean;
}) {
  // Exponent rolls toward the current rank one rank step at a time (or snaps under
  // reduced motion, see rankTweenDuration). A solved hole visibly reaches 0, then removes
  // the exponent on the next frame so the decrease reads as N -> ... -> 0 -> nothing.
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

  // The letters the word is drawn from — ONE splitting path, used by the resting word and by
  // the scramble's churning frames alike, so the wave has something to move without a second
  // way of rendering a hole's word existing. Split by code point: a display form keeps its
  // accents (`grincement`, `plissés`), and those are single code points in NFC.
  const letters = Array.from(jumble ?? displayWord);

  // The wave, on this hole's OWN clock. It never competes with feedback: a hole
  // mid-choreography — a floating hit landing on it, its word churning through the
  // slot-machine scramble, or already locked at rank 0 — does not run the clock at all, and a
  // wave in flight when a guess lands is cut. Nor does a hole with no tap ripple: the wave is
  // an affordance for the tap, so advertising one that does nothing is worse than none.
  // `ticking` is this hole's own answer to "free to ripple?", and it is what the shared
  // clock runs on — not just `busy`: the round drops `quiet` when a guess lands AND when the
  // history modal opens over the sentence, and the hook cuts a wave in flight either way (a
  // tail showing after a quickly-closed modal is worse than no wave at all).
  const busy = hit !== null || jumble !== null || hole.rank === 0;
  const ticking = quiet && !busy && explore !== undefined && !explore.disabled;
  const waving = useLetterWave(ticking, letters.length);

  // The exponent sizes to its own content (no reserved width), so a following suffix
  // sits right after the number instead of after a gap left for the widest rank.
  const rankStyle: CSSProperties & Record<'--rank-color', string> = {
    '--rank-color': rankHeatColor(shownRank, hole.startRank),
  };
  // The word carries the hit's shake delay and, while it waves, the two numbers its letters'
  // animation is built from — so the timing lives in ONE place (above) and CSS reads it.
  //
  // The word's COLOUR is the one global accent (user-decided 2026-08-17, third pass of the
  // day — a word coloured by its own live heat was built and rejected on the screen: the
  // exponent drowned in a word wearing its own colour). Temperature lives in the EXPONENT
  // alone; what says "still a hole" is the word's DRESS — the dashed OPEN-BLANK line CSS
  // draws under an unresolved word (`.hole-word::after`), gone the moment `.resolved`
  // lands. So this component sets no colour at all any more.
  const wordStyle: CSSProperties & Record<string, string> = {};
  if (hit) wordStyle['--hit-delay'] = `${hit.startDelayMs}ms`;
  if (waving) Object.assign(wordStyle, WAVE_VARS);

  // The word + its exponent. The route button (below) wraps this whole group WITHOUT
  // touching it: the floating-hit/scramble choreography keys off this exact structure.
  const body = (
    <>
      {/* The hit is positioned against this wrapper, which is sized to the WORD
          only (the exponent sits outside it), so the floating number stays centered
          over the word and not the word+exponent. */}
      <span className="hole-word-wrap">
        {/* Key distinct from FloatingHit (otherwise collision -> duplicated word);
            changing it restarts the shake even on two consecutive hits. */}
        <span
          key={hit ? `word-${hit.id}` : 'word'}
          className={`hole-word${hit ? ' hit-shake' : ''}${waving ? ' wave' : ''}`}
          style={wordStyle}
        >
          {/* One span per letter — the structure the wave moves. Keyed by position, so the
              scramble's 40ms frames replace glyphs in place instead of remounting the word
              (which would restart any animation running on it). */}
          {letters.map((ch, i) => (
            <span key={i} className="hole-letter" style={{ '--i': i } as CSSProperties}>
              {ch}
            </span>
          ))}
        </span>
        {/* Floating "damage"-style indicator: a distance number colored by the heatmap
            (capped heat), or "MISS" in the ramp's own COLD TERMINUS when too far
            (MISS_COLOR, user-decided 2026-08-17): the ramp runs down through blue and
            STOPS on the MISS colour, and the cap collapses every rank past 100 onto that
            same terminus — a 100-away exponent and a MISS share the colour, and only the
            label tells them apart. The float and the exponent are the round's ONLY
            temperature surfaces on the board — the words wear the flat brand accent. */}
        {hit && (
          <FloatingHit
            key={hit.id}
            id={hit.id}
            value={hit.value}
            miss={hit.miss}
            startDelayMs={hit.startDelayMs}
            fadeDelayMs={hit.fadeDelayMs}
            color={hit.miss ? MISS_COLOR : rankHeatColor(hit.value, HIT_HEAT_CAP)}
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
          {shownRank}
        </sup>
      )}
    </>
  );

  return (
    <span className={`hole${resolved ? ' resolved' : ''}`}>
      {explore ? (
        <button
          type="button"
          className="hole-btn"
          // DESCRIBED, never labelled. An aria-label REPLACES the content it wraps, and the
          // content here is the clue — the current word and its exponent — so labelling the
          // button deleted it from the button AND from the sentence a screen reader reads,
          // leaving "Explore word 2" where "attends -87" belongs. Named by its own content,
          // the hole reads as what it shows and the exploration hint stays supplementary.
          aria-describedby={explore.hintId}
          data-hole-explore={holeIndex}
          disabled={explore.disabled}
          onClick={explore.onOpen}
        >
          {body}
        </button>
      ) : (
        body
      )}
    </span>
  );
}
