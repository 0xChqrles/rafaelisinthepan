import type { CSSProperties } from 'react';
import FloatingHit from './FloatingHit';
import { fitWord } from './routeDrawing';
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
export interface WordHit {
  id: number; // monotonic, so a guess landing mid-hit restarts the animation
  label: string; // the rarity grade, or MISS
  color: string;
  scale: number; // the intensity dimensions, straight off components/rarity.ts
  lift: number;
  rise: number;
  punch: number;
  shake: number; // multiplier on the word's own shake
  wave: number; // the letter wave's amplitude in px; 0 below RARE, where there is no wave
  fadeDelayMs: number; // how long the label holds before it leaves — rarity buys hold too
}

// The letter wave's own clock, the sentence game's #129 numbers exactly: one letter's whole
// up-and-down, and the gap between two consecutive letters. Handed to CSS rather than
// repeated there, the way `Hole` hands down the same pair.
const WAVE_LETTER_MS = 300;
const WAVE_STEP_MS = 40;

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
  return (
    <div className="word-subject">
      {/* The word is REAL TEXT here, not a decorative drawing: on the board it is announced
          by the sr mirror, but the board does not exist during the run, so without this the
          day's word would be spoken nowhere for the whole game. */}
      <span className="sr-only">{srWordBoardWord(lang, word)}</span>
      <span className="hole-word-wrap" aria-hidden="true">
        {/* Keyed per hit so a guess landing mid-shake restarts it (Hole's own trick) — which
            is also what replays the letter wave, so neither needs a clock of its own. The
            shake's amplitude and the wave's ride the grade; `--shake-amp` and `--wave-lift`
            both default to what the sentence game uses, so the hole, the standings sprite
            and the tutorial keep the exact motion they had. */}
        <span
          key={hit ? `word-${hit.id}` : 'word'}
          className={`word-subject-text${hit ? ' hit-shake' : ''}${
            hit && hit.wave > 0 ? ' wave' : ''
          }`}
          style={
            {
              fontSize: fitWord(word, SUBJECT_PX),
              '--shake-amp': hit ? String(hit.shake) : undefined,
              '--wave-lift': hit && hit.wave > 0 ? `${hit.wave}px` : undefined,
              '--wave-dur': `${WAVE_LETTER_MS}ms`,
              '--wave-step': `${WAVE_STEP_MS}ms`,
            } as CSSProperties
          }
        >
          {/* Split into per-letter boxes so the wave has something to ripple. The pixel font
              is monospace and each box advances exactly as the glyph did, so the word
              measures the same as plain text (the sentence game's holes are split the same
              way, for the same animation). */}
          {Array.from(word, (letter, i) => (
            <span key={i} className="hole-letter" style={{ '--i': i } as CSSProperties}>
              {letter}
            </span>
          ))}
        </span>
        {hit && onHitDone && (
          <FloatingHit
            key={hit.id}
            id={hit.id}
            value={0}
            label={hit.label}
            color={hit.color}
            scale={hit.scale}
            lift={hit.lift}
            rise={hit.rise}
            punch={hit.punch}
            startDelayMs={0}
            fadeDelayMs={hit.fadeDelayMs}
            onDone={onHitDone}
          />
        )}
      </span>
    </div>
  );
}
