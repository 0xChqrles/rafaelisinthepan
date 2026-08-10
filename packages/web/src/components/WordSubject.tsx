import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import FloatingHit, { HIT_FADE_MS } from './FloatingHit';
import WordSlash from './WordSlash';
import type { Strike } from './rarity';
import { STRUCK_MS, blowDelayMs, strikeDurationMs } from './rarity';
import { fitWord } from './routeDrawing';
import { prefersReducedMotion } from '../hooks/useScramble';
import { srWordBoardWord } from '../i18n';

// The day's word while the run is on (#163): JUST THE WORD, centred, in the solved blue —
// no node, no rail, no rank gutter, no lane. Word mode is a fast game and the board is now
// its post-mortem, so during the gate and the run there is exactly one thing on the screen
// and this is it.
//
// It is deliberately NOT the route drawing's terminus row. That row is a station on a line
// — it carries a square node, a rail stub and a rank gutter because it is the END OF A
// LINE, and none of those mean anything when there is no line. The post-mortem still
// mounts the real `WordTerminus` at the bottom of the revealed board; this is the other
// half of the same word, on a screen that has no map.
//
// The type size is the shared `fitWord`'s, so the one rule that matters for a long word —
// it may shrink but it may never break mid-word — holds here exactly as it does on every
// route the app draws. `--wordw` is this surface's own (see `.word-subject` in index.css):
// the whole page column, where the route frame's is what is left after the gutter and rail.
export const SUBJECT_PX = 40;

// Word mode's guess feedback (#163). The two outcomes are DIFFERENT EVENTS and they look
// nothing alike (decided 2026-08-09), which is the point: at a glance, before reading
// anything, you know which one happened.
//
//   claim — the word is STRUCK — a cut, a cross, or the ultra burst — and it SHAKES.
//           No text: a name has to be read, and a run against a clock has no time for that;
//           the grade is written down anyway, in the history and the tally.
//   miss  — the sentence game's MISS float, its own animation, and the word does NOT move.
//           Nothing was struck, so nothing recoils.
//
// Presentation state, owned by the screen.
export type WordHit =
  | { id: number; kind: 'claim'; color: string; strike: Strike }
  | { id: number; kind: 'miss'; color: string };

// The MISS float's own beat, the sentence game's lone-hit timing.
const MISS_HOLD_MS = 320;

// How long a hit is on screen, whichever kind it is — the screen holds its ending beat for
// whatever is still in the air when the clock dies.
export function hitDurationMs(hit: WordHit): number {
  return hit.kind === 'claim'
    ? strikeDurationMs(hit.strike)
    : MISS_HOLD_MS + HIT_FADE_MS;
}

// --- the word is HELD, like a hand of playing cards (decided 2026-08-09) -----------------
// The first letter leans left, the last leans right, and everything between follows the same
// arc, so the day's word reads as something someone is HOLDING rather than something
// printed. This is the ambient life of the run's screen — and it is deliberately separate
// from the GUESS FEEDBACK, which does not animate at all (see RarityHit): one is what the
// screen is doing while you think, the other is what it says back when you act.
//
// Two numbers describe the fan. The lean is the obvious one; the DROP is what makes it a
// hand rather than skewed type — cards splay from a pivot below the hand, so their tops
// spread and their outer ends fall away. Both are small: this is a pixel font, and rotation
// is the transform it survives least of.
const FAN_DEG = 6;
const FAN_ARC_PX = 3;

// Now and then the hand RIPPLES: #129's letter wave, the one the sentence game's holes run,
// on the same random clock (decided 2026-08-09, replacing a single letter that rose every
// 750ms as though it were about to be drawn). The four numbers are that wave's, restated
// here rather than reached for inside `Hole` — importing half a component's internals is
// not sharing it, and these are four literals against a coupling to a hole's `ticking`
// state, which this surface has no equivalent of.
const WAVE_LETTER_MS = 300;
const WAVE_STEP_MS = 40;
const WAVE_MIN_MS = 3_000;
const WAVE_MAX_MS = 10_000;
const waveDurationMs = (letters: number): number =>
  WAVE_LETTER_MS + Math.max(0, letters - 1) * WAVE_STEP_MS;

// Is the hand rippling right now? Two clocks, exactly as `Hole` runs them: one waits a fresh
// random delay and starts a wave, the other ends it after its own length and re-arms the
// first. Ending it in JS rather than on `animationend` keeps ONE owner of the two numbers
// CSS is handed. Never for a one-letter word (nothing to ripple) or under reduced motion.
function useLetterWave(letters: number): boolean {
  const [waving, setWaving] = useState(false);
  // Bumped by each finished wave, purely to re-arm the clock below with a fresh delay.
  const [waveCount, setWaveCount] = useState(0);

  useEffect(() => {
    if (letters < 2 || prefersReducedMotion()) return undefined;
    const id = window.setTimeout(
      () => setWaving(true),
      WAVE_MIN_MS + Math.random() * (WAVE_MAX_MS - WAVE_MIN_MS),
    );
    return () => window.clearTimeout(id);
  }, [letters, waveCount]);

  useEffect(() => {
    if (!waving) return undefined;
    const id = window.setTimeout(() => {
      setWaving(false);
      setWaveCount((n) => n + 1);
    }, waveDurationMs(letters));
    return () => window.clearTimeout(id);
  }, [waving, letters]);

  return waving;
}

// --- what the word does WHILE it is being struck ------------------------------------------
// It recoils and takes the strike's colour — and it does both PER BLOW, not for the length of
// the strike (decided 2026-08-09). Between the two blows of a cross there is a beat where
// nothing is on the word, and the word has to be untouched in it: a colour held across the
// gap turns two hits into one long state, which is the reading the gap exists to prevent.
//
// So this returns WHICH blow is landing, or null in the daylight between them and after the
// last — driven by the strike's own `blowDelayMs`/`STRUCK_MS`, the numbers the sheet itself is
// drawn from, so the word and the hit on it can never disagree about when a blow is on.
// It lets go a frame BEFORE the stroke does, which is where the beat between two hits comes
// from now that the strokes themselves run back to back.
// A miss lands no blow at all: nothing was struck, so nothing recoils.
function useStrikeBlow(hit: WordHit | null): number | null {
  const [blow, setBlow] = useState<number | null>(null);
  const claim = hit?.kind === 'claim' ? hit : null;
  const id = claim?.id ?? null;
  const strike = claim?.strike ?? null;
  const blows = strike?.blows ?? 0;

  useEffect(() => {
    if (id === null) {
      setBlow(null);
      return undefined;
    }
    // The first blow lands in the same commit the strike mounts in, so it is set here rather
    // than scheduled — a timer for 0ms would cost the recoil its first frame.
    setBlow(0);
    const timers: number[] = [];
    for (let i = 0; i < blows; i += 1) {
      if (i > 0) timers.push(window.setTimeout(() => setBlow(i), blowDelayMs(strike!, i)));
      timers.push(window.setTimeout(() => setBlow(null), blowDelayMs(strike!, i) + STRUCK_MS));
    }
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [id, blows, strike]);

  return blow;
}

// Where one letter of the fan sits: how far it leans, and how far it has fallen from the
// middle. Both go on the INDEPENDENT transform properties (`rotate` / `translate`) rather
// than into one `transform` string, which is what lets the wave — an ordinary `transform`
// animation — ride ON TOP of the fan instead of replacing it. `--i` is the letter's place in
// the ripple's stagger.
function letterStyle(index: number, letters: number): CSSProperties {
  // -1 at the first letter, +1 at the last, 0 in the middle.
  const t = letters < 2 ? 0 : (index / (letters - 1)) * 2 - 1;
  return {
    rotate: `${(t * FAN_DEG).toFixed(2)}deg`,
    translate: `0 ${(t * t * FAN_ARC_PX).toFixed(2)}px`,
    '--i': index,
  } as CSSProperties;
}

export default function WordSubject({
  word,
  lang,
  hit = null,
  onHitDone,
}: {
  word: string;
  lang: string;
  hit?: WordHit | null;
  onHitDone?: (id: number) => void;
}) {
  const letters = [...word];
  const waving = useLetterWave(letters.length);
  const blow = useStrikeBlow(hit);
  const struck = blow !== null && hit?.kind === 'claim' ? hit : null;

  return (
    <div className="word-subject">
      {/* The word is REAL TEXT here, not a decorative drawing: on the board it is announced
          by the sr mirror, but the board does not exist during the run, so without this the
          day's word would be spoken nowhere for the whole game. */}
      <span className="sr-only">{srWordBoardWord(lang, word)}</span>
      {/* The wrap carries the word's SIZE, so the slash drawn over it can be measured in the
          word's own em — and it carries the breathing, so the word and whatever is on it move
          as one. */}
      <span
        className="hole-word-wrap"
        aria-hidden="true"
        style={{ fontSize: fitWord(word, SUBJECT_PX) } as CSSProperties}
      >
        {/* The word RECOILS from a strike and from nothing else: a claim shakes it, a MISS
            leaves it alone, because nothing was struck. Both the recoil and the colour last
            exactly ONE BLOW (see `useStrikeBlow`), so a cross hits, lets go, and hits again.
            Keyed per BLOW so the second restarts the shake rather than inheriting a run
            already over, and so a claim landing on top of another does too (Hole's trick). */}
        <span
          key={struck ? `struck-${struck.id}-${blow}` : 'word'}
          className={`word-subject-text${struck ? ' struck' : ''}${waving ? ' wave' : ''}`}
          style={
            {
              ...(struck
                ? { '--struck-c': struck.color, '--shake-ms': `${STRUCK_MS}ms` }
                : null),
              // Handed down rather than repeated in CSS, so the JS that ends the wave and
              // the CSS that draws it cannot disagree about how long it is.
              '--wave-dur': `${WAVE_LETTER_MS}ms`,
              '--wave-step': `${WAVE_STEP_MS}ms`,
            } as CSSProperties
          }
        >
          {/* One box per letter, because the hand needs cards to fan. The pixel font is
              monospace and each box advances exactly as its glyph did, so the word measures
              the same as plain text and `fitWord`'s sizing is untouched. */}
          {letters.map((letter, i) => (
            <span key={i} className="hole-letter" style={letterStyle(i, letters.length)}>
              {letter}
            </span>
          ))}
        </span>
        {hit &&
          onHitDone &&
          (hit.kind === 'claim' ? (
            <WordSlash
              key={hit.id}
              id={hit.id}
              color={hit.color}
              strike={hit.strike}
              onDone={onHitDone}
            />
          ) : (
            // The sentence game's own MISS float, unchanged and unparameterised — the same
            // word, in the same red, with the same pop and rise it has everywhere else.
            <FloatingHit
              key={hit.id}
              id={hit.id}
              value={0}
              miss
              color={hit.color}
              startDelayMs={0}
              fadeDelayMs={MISS_HOLD_MS}
              onDone={onHitDone}
            />
          ))}
      </span>
    </div>
  );
}
