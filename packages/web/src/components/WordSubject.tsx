import type { CSSProperties } from 'react';
import RarityHit from './RarityHit';
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
        {/* The word STEPS BACK while a grade is on it and returns when it goes. Not a
            flourish — the label sits on top of it, and two words of the same size in the
            same place cannot both be read (measured on the worst case, a cyan RARE over the
            blue day's word: at 0.45 and 0.32 they are mud, at 0.2 the label is clean). It is
            a STATE, not a transition: nothing here fades into it. */}
        <span
          className={`word-subject-text${hit ? ' stamped' : ''}`}
          style={{ fontSize: fitWord(word, SUBJECT_PX) } as CSSProperties}
        >
          {word}
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
