import { Fragment, useEffect, useLayoutEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import FloatingHit, { HIT_FADE_MS } from './FloatingHit';
import WordSlash from './WordSlash';
import WordLoot, { lootDurationMs } from './WordLoot';
import type { Rarity } from '../game/wordGame';
import type { StrikeArt } from './rarity';
import { STRUCK_MS } from './rarity';
import { fitWord } from './routeDrawing';
import useLetterWave, { WAVE_VARS } from '../hooks/useLetterWave';
import { srWordBoardWord } from '../i18n';

// The day's word while the run is on (#163): JUST THE WORD, centred, in the solved blue —
// no node, no rail, no rank gutter. Word mode is a fast game and the board is now
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
const SUBJECT_PX = 40;

// Word mode's guess feedback (#163). The two outcomes are DIFFERENT EVENTS and they look
// nothing alike (decided 2026-08-09), which is the point: at a glance, before reading
// anything, you know which one happened.
//
//   claim — the word is STRUCK — a cut, a burst, or the ultra star — and it SHAKES; and
//           the hit knocks LOOT out of it (`WordLoot`, 2026-08-10): the guess's rank
//           exponent and its grade's name pop off the word and fall away, the run's one
//           statement of either number. No text ever PARKS on the screen — the loot is in
//           the air for under a second; the board still reads the run back at the end.
//   miss  — the sentence game's MISS float, its own animation, and the word does NOT move.
//           Nothing was struck, so nothing recoils and nothing drops.
//
// Presentation state, owned by the screen.
export type WordHit =
  | { id: number; kind: 'claim'; color: string; strike: StrikeArt; rank: number; grade: Rarity }
  | { id: number; kind: 'miss'; color: string };

// The MISS float's own beat, the sentence game's lone-hit timing.
const MISS_HOLD_MS = 320;

// How long a hit is on screen, whichever kind it is — the screen holds its ending beat for
// whatever is still in the air when the clock dies. A claim's is the LATER of its strike
// and its loot — in practice the loot, which outlives every sheet, and why the loot's
// timer is the one that reports the claim done below.
export function hitDurationMs(hit: WordHit): number {
  return hit.kind === 'claim'
    ? Math.max(hit.strike.ms, lootDurationMs)
    : MISS_HOLD_MS + HIT_FADE_MS;
}

// --- the word is HELD, like a hand of playing cards (decided 2026-08-09) -----------------
// The first letter leans left, the last leans right, and everything between follows the same
// arc, so the day's word reads as something someone is HOLDING rather than something
// printed. This is the ambient life of the run's screen — and it is deliberately separate
// from the GUESS FEEDBACK (the strike and its loot, `WordSlash`/`WordLoot`): one is what
// the screen is doing while you think, the other is what it says back when you act.
//
// Two numbers describe the fan. The lean is the obvious one; the DROP is what makes it a
// hand rather than skewed type — cards splay from a pivot below the hand, so their tops
// spread and their outer ends fall away. Both are small: this is a pixel font, and rotation
// is the transform it survives least of.
const FAN_DEG = 6;
const FAN_ARC_PX = 3;

// Now and then the hand RIPPLES: #129's letter wave, the one the sentence game's holes run,
// on the same random clock (decided 2026-08-09, replacing a single letter that rose every
// 750ms as though it were about to be drawn). The scheduling is the SHARED hook's since
// three surfaces came to want it; what stays here is this surface's own answer to "free to
// ripple?" — never a one-letter word, since there is nothing to ripple.

// --- what the word does WHILE it is being struck ------------------------------------------
// It recoils and takes the strike's colour — for the BLOW, not for the length of the sheet
// (decided 2026-08-09; a strike is one blow since 2026-08-11, when the RARE cross retired).
// It lets go a frame BEFORE the stroke ends (`STRUCK_MS`, one frame short of the shortest
// sheet), which is what makes a longer sheet's remaining frames read as dissipation over a
// word already back at rest. A miss lands no blow at all: nothing was struck, so nothing
// recoils.
function useStruck(hit: WordHit | null): boolean {
  const [struck, setStruck] = useState(false);
  const id = hit?.kind === 'claim' ? hit.id : null;

  // Layout effect, not a passive one, and that is the whole point of the hook: the blow
  // must land BEFORE the strike's first frame paints. A passive effect runs after paint,
  // so the sheet's opening frame showed over a word not yet recoiling — exactly the frame
  // the recoil exists for. (A 0ms timer would cost the same frame for the same reason.)
  useLayoutEffect(() => {
    if (id === null) {
      setStruck(false);
      return undefined;
    }
    setStruck(true);
    const t = window.setTimeout(() => setStruck(false), STRUCK_MS);
    return () => window.clearTimeout(t);
  }, [id]);

  return struck;
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
  const waving = useLetterWave(letters.length >= 2, letters.length);
  const struck = useStruck(hit) && hit?.kind === 'claim' ? hit : null;

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
            exactly the BLOW (see `useStruck`), a frame short of the sheet. Keyed per hit so
            a claim landing on top of another restarts the shake (Hole's trick). */}
        <span
          key={struck ? `struck-${struck.id}` : 'word'}
          className={`word-subject-text${struck ? ' struck' : ''}${waving ? ' wave' : ''}`}
          style={
            {
              ...(struck
                ? { '--struck-c': struck.color, '--shake-ms': `${STRUCK_MS}ms` }
                : null),
              // Handed down rather than repeated in CSS, so the JS that ends the wave and
              // the CSS that draws it cannot disagree about how long it is.
              ...WAVE_VARS,
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
            <Fragment key={hit.id}>
              {/* The strike does not report done — the loot always outlives it (see
                  hitDurationMs), so the loot's timer is the claim's one lifetime. */}
              <WordSlash id={hit.id} color={hit.color} art={hit.strike} />
              <WordLoot
                id={hit.id}
                rank={hit.rank}
                grade={hit.grade}
                color={hit.color}
                onDone={onHitDone}
              />
            </Fragment>
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
