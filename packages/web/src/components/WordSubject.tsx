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
  fadeDelayMs: number; // how long the label holds before it leaves — rarity buys hold too
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
  return (
    <div className="word-subject">
      {/* The word is REAL TEXT here, not a decorative drawing: on the board it is announced
          by the sr mirror, but the board does not exist during the run, so without this the
          day's word would be spoken nowhere for the whole game. */}
      <span className="sr-only">{srWordBoardWord(lang, word)}</span>
      <span className="hole-word-wrap" aria-hidden="true">
        {/* Keyed per hit so a guess landing mid-shake restarts it (Hole's own trick), and
            the shake's amplitude rides the grade — `--shake-amp` defaults to 1 everywhere
            else, so the sentence hole and the standings sprite keep the exact shake they
            had. */}
        <span
          key={hit ? `word-${hit.id}` : 'word'}
          className={`word-subject-text${hit ? ' hit-shake' : ''}`}
          style={
            {
              fontSize: fitWord(word, SUBJECT_PX),
              '--shake-amp': hit ? String(hit.shake) : undefined,
            } as CSSProperties
          }
        >
          {word}
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
