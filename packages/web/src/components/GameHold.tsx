import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Hole as PuzzleHole, Puzzle } from '@whippin/shared';
import Phrase from './Phrase';
import { SWEEP_MS } from './PhraseIntro';
import { DISSOLVE_MS, SKELETON_WAIT_MS } from './bayerTiles';
import { KEYBOARD_ROWS } from '../game/keyboard';
import { prefersReducedMotion } from '../hooks/useScramble';
import type { RuntimeHole } from '../game/types';
import { t } from '../i18n';

// THE GAME'S HOLD (the user, 2026-10-06: "the 'loading' component is a bit lame compared to
// the rest"): what the game route shows while its three reads are out — the puzzle, the
// language's word list, the round's server state — as TODAY'S GAME TAKING SHAPE, never a
// word. ONE hold for the three, mounted by the route and never restarted between them, in
// `.game`'s own zones (`.play` over the reserved prompt row, `.tray` at the keyboard's
// height), so what replaces it lands where it stood:
//
//   THE SENTENCE as its silhouette — each word a bar of slate stipple, each hole a block of
//     the board skeleton's checker — laid out by the board's own `Phrase` (`silhouette`), so
//     the bars wrap where the words will and the blocks stand where the holes will. Until
//     the puzzle is in it is a GENERIC sentence's shape; once it is, the day's own words
//     (the start words in the holes), the generic one giving way through the dither. Never
//     the day's shape before the puzzle has answered.
//   THE TRAY as the keyboard's three rows of UNLIT IRON KEYS — the archive's and the code
//     prompt's material: dusk faces under slate caps — at the keys' exact boxes.
//
// What is still out MOVES, what has answered stands still: the bars breathe while the puzzle
// is out and the blocks while the round is (the house's 640ms stepped breath), and while the
// word list is, a light washes across the keys' caps (the archive's read wave). It comes in
// only after `SKELETON_WAIT_MS` (a quick load never flashes it), through the dither;
// `aria-busy` on the route's column and the sr-only word say "loading" for a screen reader.
// Then the game TAKES OVER FROM IT, under which it stood (`useHold`'s `leaving`): the
// sentence decodes over its bars, each bar and block giving way the moment the decode's
// front reaches its word (`Phrase` stamps that front, `--at`, on a silhouette too); the keys
// light in over their slates as the slates go, cell for cell (`.kb-lit`); a day already over
// dissolves in over it. Reduced motion: no breath, no dissolve — the game at once.

// The hold's whole exit: the decode's front crossing the sentence, then the last bar's going.
export const HOLD_LEAVE_MS = SWEEP_MS + DISSOLVE_MS;

type Stage = 'idle' | 'pending' | 'shown' | 'leaving';

export interface Hold {
  // The hold is mounted: a read is out, or it is still giving way.
  mounted: boolean;
  // Its picture is on screen (a read out longer than `SKELETON_WAIT_MS`).
  shown: boolean;
  // The game has taken over and the hold gives way under it.
  leaving: boolean;
}

// The hold's life, off ONE fact: whether the game is still `waiting` on a read. Read in the
// render itself, so the frame the game lands on already knows the hold is leaving (the
// game's arrival is chosen off it, at its mount).
export function useHold(waiting: boolean): Hold {
  const [stage, setStage] = useState<Stage>(waiting ? 'pending' : 'idle');
  const [reduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (waiting) {
      if (stage === 'idle') setStage('pending');
      else if (stage === 'leaving') setStage('shown');
      else if (stage === 'pending') {
        const id = window.setTimeout(() => setStage('shown'), SKELETON_WAIT_MS);
        return () => window.clearTimeout(id);
      }
      return undefined;
    }
    if (stage === 'pending') setStage('idle');
    else if (stage === 'shown') setStage(reduced ? 'idle' : 'leaving');
    else if (stage === 'leaving') {
      const id = window.setTimeout(() => setStage('idle'), HOLD_LEAVE_MS);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [waiting, stage, reduced]);
  const up = stage === 'shown' || stage === 'leaving';
  if (waiting) return { mounted: true, shown: up, leaving: false };
  return { mounted: up && !reduced, shown: up && !reduced, leaving: up && !reduced };
}

// A sentence's SHAPE: what the silhouette lays out.
interface Shape {
  key: string;
  words: string[];
  puzzleHoles: PuzzleHole[];
  holes: RuntimeHole[];
}

const word = (n: number) => 'x'.repeat(n);
const hole = (pos: number, length: number): PuzzleHole => ({
  pos,
  secret: { word: 'x', slug: 'x' },
  start: { word: word(length), slug: word(length) },
  start_rank: 123,
});

// A sentence of the usual length and three holes, before the day's own is known.
const GENERIC_WORDS = [5, 3, 7, 2, 8, 4, 6, 2, 3, 6, 5, 9, 3, 4, 7, 2, 6].map(word);
const GENERIC_HOLES = [hole(4, 8), hole(9, 6), hole(14, 7)];

function shapeOf(words: string[], puzzleHoles: PuzzleHole[], key: string): Shape {
  return {
    key,
    words,
    puzzleHoles,
    holes: puzzleHoles.map((h) => ({
      pos: h.pos,
      secret: h.secret.slug,
      word: h.start.word,
      rank: h.start_rank,
      startRank: h.start_rank,
    })),
  };
}

const GENERIC = shapeOf(GENERIC_WORDS, GENERIC_HOLES, 'generic');

function noop() {}

// The picture takes no focus and no tap (React 18 knows no `inert` prop).
const makeInert = (el: HTMLElement | null) => el?.setAttribute('inert', '');

// One silhouette of a sentence: the board's own layout, the hold's own dress.
function Silhouette({ shape, leaving }: { shape: Shape; leaving?: boolean }) {
  const labels = useMemo(() => shape.holes.map(() => '-'), [shape]);
  return (
    <div className={`hold-sentence${leaving ? ' out' : ''}`}>
      <Phrase
        silhouette
        words={shape.words}
        holes={shape.holes}
        puzzleHoles={shape.puzzleHoles}
        hits={[]}
        onHitDone={noop}
        exploreLabels={labels}
        exploreDisabled
        onExplore={noop}
      />
    </div>
  );
}

export default function GameHold({
  lang,
  puzzle,
  wordsIn,
  roundIn,
  race,
  shown,
  leaving,
}: {
  lang: string;
  // The day's puzzle once it is in (its words shape the silhouette), else null.
  puzzle: Puzzle | null;
  // The language's word list is in (the keyboard's).
  wordsIn: boolean;
  // The round's server state is in.
  roundIn: boolean;
  // Today's sentence keeps the race line's band clear (`.play-race`): so does its hold.
  race: boolean;
  shown: boolean;
  leaving: boolean;
}) {
  const shape = useMemo(
    () => (puzzle ? shapeOf(puzzle.words, puzzle.holes, `${puzzle.lang}:${puzzle.revision}`) : GENERIC),
    [puzzle],
  );

  // A shape giving way to the next (the generic one to the day's) goes out through the
  // cells the next comes in through — only while the hold is on screen.
  const last = useRef(shape);
  const [outgoing, setOutgoing] = useState<Shape | null>(null);
  useLayoutEffect(() => {
    const was = last.current;
    last.current = shape;
    if (was.key === shape.key || !shown) return undefined;
    setOutgoing(was);
    const id = window.setTimeout(() => setOutgoing(null), DISSOLVE_MS);
    return () => window.clearTimeout(id);
  }, [shape, shown]);

  // What is still out, each its own motion (index.css).
  const reading = `${puzzle ? '' : ' reading-sentence'}${roundIn ? '' : ' reading-round'}${
    wordsIn ? '' : ' reading-keys'
  }`;
  const lastRow = KEYBOARD_ROWS.length - 1;

  return (
    <div className={`game-hold${leaving ? ' leaving' : reading}`}>
      <span className="sr-only">{t(lang, 'loading')}</span>
      {shown && (
        <>
          <div className={`play${race ? ' play-race' : ''}`} aria-hidden="true" ref={makeInert}>
            <div className="phrase-anchor hold-sentences">
              {outgoing && <Silhouette key={outgoing.key} shape={outgoing} leaving />}
              <Silhouette key={shape.key} shape={shape} />
            </div>
            {/* The prompt's row, held (its line and its hint's): never drawn. */}
            <div className="prompt-zone">
              <div className="input-area retired">
                <span className="word-input">
                  <span className="wi-prompt">&gt;</span>
                </span>
                <p className="hint"> </p>
              </div>
            </div>
          </div>
          <div className="tray" aria-hidden="true" ref={makeInert}>
            <div className="kb-exit">
              <div className="keyboard hold-keys">
                {KEYBOARD_ROWS.map((row, r) => {
                  // The row as the keyboard lays it out: ENTER, the letters, the dash and
                  // BACKSPACE on the last one. Each slate knows its diagonal (`--d`).
                  const count = row.length + (r === lastRow ? 3 : 0);
                  return (
                    <div className="kb-row" key={r}>
                      {Array.from({ length: count }, (_, c) => (
                        <span key={c} className="kb-key kb-slate" style={{ '--d': r + c } as CSSProperties} />
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
