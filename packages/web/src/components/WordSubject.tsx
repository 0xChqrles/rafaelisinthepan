import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import RarityHit from './RarityHit';
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

// Word mode's guess feedback (#163): what the player's word says back. A claim reports its
// RARITY GRADE — the rank exponent is gone from play, because a timed run has no use for a
// number it cannot act on, and the grade is the thing that just bought time. Anything
// outside the claim zone reports MISS. Presentation state, owned by the screen.
//
// NONE OF IT ANIMATES (2026-08-09): the label appears, stays, and goes, and the word does
// nothing but step back while it is there. Several choreographies were tried on this and
// all were rejected; what is left is the plain baseline they were built on top of.
export interface WordHit {
  id: number; // monotonic, so a new guess replaces the one on screen
  label: string; // the rarity grade, or MISS
  color: string;
  scale: number; // the type size, straight off components/rarity.ts
  holdMs: number; // how long it stays
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

  return (
    <div className="word-subject">
      {/* The word is REAL TEXT here, not a decorative drawing: on the board it is announced
          by the sr mirror, but the board does not exist during the run, so without this the
          day's word would be spoken nowhere for the whole game. */}
      <span className="sr-only">{srWordBoardWord(lang, word)}</span>
      <span className="hole-word-wrap" aria-hidden="true">
        {/* The word STEPS BACK while a grade is on it and returns when it goes. Not a
            flourish — the label sits on top of it, and two words of the same size in the
            same place cannot both be read (measured on the worst case, a cyan RARE over the
            blue day's word: at 0.45 and 0.32 they are mud, at 0.2 the label is clean). It is
            a STATE, not a transition: nothing here fades into it. */}
        <span
          className={`word-subject-text${hit ? ' stamped' : ''}${waving ? ' wave' : ''}`}
          style={
            {
              fontSize: fitWord(word, SUBJECT_PX),
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
        {hit && onHitDone && (
          <RarityHit
            key={hit.id}
            id={hit.id}
            label={hit.label}
            color={hit.color}
            scale={hit.scale}
            holdMs={hit.holdMs}
            onDone={onHitDone}
          />
        )}
      </span>
    </div>
  );
}
