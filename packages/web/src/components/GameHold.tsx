import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Puzzle } from '@whippin/shared';
import Phrase from './Phrase';
import { SWEEP_MS } from './PhraseIntro';
import { DISSOLVE_MS, SKELETON_WAIT_MS } from './bayerTiles';
import KeyboardHold from './KeyboardHold';
import { prefersReducedMotion } from '../hooks/useScramble';
import type { RuntimeHole } from '../game/types';
import type { LangCode } from '../langs';
import { t } from '../i18n';

// THE GAME'S HOLD (the user, 2026-10-06: "the 'loading' component is a bit lame compared to
// the rest"): what the game route shows while its three reads are out — the puzzle, the
// language's word list, the round's server state — as TODAY'S GAME TAKING SHAPE, never a
// word. ONE hold for the three, mounted by the route and never restarted between them, in
// `.game`'s own zones (`.play` over the reserved prompt row, `.tray` at the keyboard's
// height), so what replaces it lands where it stood:
//
//   THE SENTENCE. Until the puzzle is in, RAILS: a sentence of the language's median length
//     laid out by the browser in the sentence's own type and width (`.phrase`), one rail of
//     slate stipple for each line it fills — no words, no holes, nothing the day has not
//     said yet. Once the puzzle is in, the day's own SILHOUETTE, the rails giving way to it
//     through the dither: each word a bar, each hole a block of the board skeleton's
//     checker, laid out by the board's own `Phrase` (`silhouette`), so the bars wrap where
//     the words will and the blocks stand where the holes will. The holes hold the START
//     words until the round's read is in, then — in one step — the words the round stands on
//     (a returning player's best, a found word's bar), the board's own first frame.
//   THE TRAY, what the game will put there: the keyboard's three rows of UNLIT IRON KEYS —
//     the archive's and the code prompt's material — at the keys' exact boxes, for a player
//     who lands on the prompt; the GATE's slots (PLAY's box, LEARN's word) for everyone else.
//
// What is still out MOVES, what has answered stands still: the rails breathe while the
// puzzle is out, the blocks while the round is, the tray while the word list is (the
// house's 640ms stepped breath). It comes in only after `SKELETON_WAIT_MS` (a quick load
// never flashes it), through the dither; `aria-busy` on the route's column and the sr-only
// word say "loading" for a screen reader. Then the game TAKES OVER FROM IT, under which it
// stood (`useHold`'s `leaving`): the sentence decodes over its bars, each bar and block
// giving way the moment the decode's front reaches its word (`Phrase` stamps that front,
// `--at`, on a silhouette too); the keys light in over their slates as the slates go, cell
// for cell (`.kb-lit`); the gate dissolves in over its slots. A day already over takes the
// hold away at once (the route): its card comes in through the dither on bare ground.
// Reduced motion: no breath, no dissolve — the game at once.
//
// A READ THAT FAILED holds the picture STILL (`failure`): shown at once, every bar and rail at
// the Bayer order's half, nothing breathing, and the prompt's row — the one thing in the hold
// a finger reaches — says so, ONE line for the three reads, over its RETRY (the route's
// `QuietFailure`). The hold stays mounted through it, so a RETRY hands the same picture back
// to breathing in place.

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

// What the tray will hold once the game lands: the keyboard, or the gate — PLAY alone, or
// PLAY with LEARN under it while the lesson is not done (`Round`'s own `gateOpen`).
export type HoldTray = 'keys' | 'gate' | 'gate-learn';

// The published sentences' MEDIAN length per language, in characters (the words and the
// spaces between them): the length the rails stand for before the day's own is known, so the
// day's arrival moves the sentence's lines as little as a day can.
const MEDIAN_CHARS: Record<LangCode, number> = { fr: 144, en: 112 };
// The word lengths the rails' sentence runs through (the text is never seen: only where the
// browser wraps it matters, and words of the usual lengths wrap where a sentence does).
const RHYTHM = [5, 3, 7, 2, 8, 4, 6, 2, 3, 6, 5, 9, 3, 4, 7, 2, 6];

function railText(chars: number): string {
  const words: string[] = [];
  let length = -1;
  for (let i = 0; ; i += 1) {
    const n = RHYTHM[i % RHYTHM.length];
    if (length + 1 + n > chars) break;
    words.push('x'.repeat(n));
    length += 1 + n;
  }
  if (chars - length - 1 > 0) words.push('x'.repeat(chars - length - 1));
  return words.join(' ');
}

function noop() {}

// The picture takes no focus and no tap (React 18 knows no `inert` prop).
const makeInert = (el: HTMLElement | null) => el?.setAttribute('inert', '');

// The sentence before the puzzle: one rail per line a median sentence fills.
function Rails({ lang, leaving }: { lang: LangCode; leaving?: boolean }) {
  const text = useMemo(() => railText(MEDIAN_CHARS[lang]), [lang]);
  return (
    <div className={`hold-sentence${leaving ? ' out' : ''}`}>
      <p className="phrase">
        <span className="hold-rail">{text}</span>
      </p>
    </div>
  );
}

// The day's sentence, once the puzzle is in: the board's own layout, the hold's own dress —
// each hole at the word the board will mount on (`holes`). Keyed on those words, so the
// round's read re-lays them in one step, never through the hole's own word change.
function Silhouette({ puzzle, holes, leaving }: { puzzle: Puzzle; holes: RuntimeHole[]; leaving?: boolean }) {
  const labels = useMemo(() => holes.map(() => '-'), [holes]);
  return (
    <div className={`hold-sentence${leaving ? ' out' : ''}`}>
      <Phrase
        key={holes.map((h) => h.word).join(' ')}
        silhouette
        words={puzzle.words}
        holes={holes}
        puzzleHoles={puzzle.holes}
        hits={[]}
        onHitDone={noop}
        exploreLabels={labels}
        exploreDisabled
        onExplore={noop}
      />
    </div>
  );
}

// What one sentence of the hold draws: the rails (no puzzle yet), or the day's silhouette.
interface Drawn {
  puzzle: Puzzle | null;
  holes: RuntimeHole[] | null;
}

function Sentence({ lang, drawn, leaving }: { lang: LangCode; drawn: Drawn; leaving?: boolean }) {
  return drawn.puzzle && drawn.holes ? (
    <Silhouette puzzle={drawn.puzzle} holes={drawn.holes} leaving={leaving} />
  ) : (
    <Rails lang={lang} leaving={leaving} />
  );
}

const sentenceKey = (puzzle: Puzzle | null) => (puzzle ? `${puzzle.lang}:${puzzle.revision}` : 'rails');

export default function GameHold({
  lang,
  puzzle,
  holes,
  wordsIn,
  roundIn,
  race,
  tray,
  shown,
  leaving,
  failure,
}: {
  lang: LangCode;
  // The day's puzzle once it is in (its words shape the silhouette), else null.
  puzzle: Puzzle | null;
  // Its holes as the board will mount on them: the START words until the round's read is
  // in, then the words the round stands on (a returning player's best), so the board's
  // words land on their own boxes. Null with no puzzle.
  holes: RuntimeHole[] | null;
  // The language's word list is in (the keyboard's).
  wordsIn: boolean;
  // The round's server state is in.
  roundIn: boolean;
  // Today's sentence keeps the race line's band clear (`.play-race`): so does its hold.
  race: boolean;
  tray: HoldTray;
  shown: boolean;
  leaving: boolean;
  // A read that FAILED: what the prompt's row says instead (the route's `QuietFailure`), the
  // whole picture held still round it. Null while every read is out or in.
  failure: ReactNode;
}) {
  const failed = failure != null && failure !== false;
  // A sentence giving way to the next (the rails to the day's silhouette) goes out through
  // the cells the next comes in through — only while the hold is on screen.
  const key = sentenceKey(puzzle);
  const drawn: Drawn = { puzzle, holes };
  const last = useRef<Drawn>(drawn);
  const [outgoing, setOutgoing] = useState<{ key: string; drawn: Drawn } | null>(null);
  useLayoutEffect(() => {
    const was = last.current;
    last.current = { puzzle, holes };
    if (sentenceKey(was.puzzle) === key || !shown) return undefined;
    setOutgoing({ key: sentenceKey(was.puzzle), drawn: was });
    const id = window.setTimeout(() => setOutgoing(null), DISSOLVE_MS);
    return () => window.clearTimeout(id);
  }, [puzzle, holes, key, shown]);

  // What is still out, each its own motion (index.css) — and nothing moves once a read failed.
  const reading = `${puzzle ? '' : ' reading-sentence'}${roundIn ? '' : ' reading-round'}${
    wordsIn ? '' : ' reading-tray'
  }`;

  return (
    <div className={`game-hold${leaving ? ' leaving' : failed ? ' failed' : reading}`}>
      {!failed && <span className="sr-only">{t(lang, 'loading')}</span>}
      {shown && (
        <>
          <div className={`play${race ? ' play-race' : ''}`}>
            <div className="phrase-anchor hold-sentences" aria-hidden="true" ref={makeInert}>
              {outgoing && <Sentence key={outgoing.key} lang={lang} drawn={outgoing.drawn} leaving />}
              <Sentence key={key} lang={lang} drawn={drawn} />
            </div>
            {/* The prompt's row, held (its line and its hint's): never drawn — and where a read
                that failed is said, over it, in its own box. */}
            <div className="prompt-zone">
              <div className="input-area retired" aria-hidden="true" ref={makeInert}>
                <span className="word-input">
                  <span className="wi-prompt">&gt;</span>
                </span>
                <p className="hint"> </p>
              </div>
              {failed && <div className="hold-failure">{failure}</div>}
            </div>
          </div>
          {tray === 'keys' ? (
            <div className="tray" aria-hidden="true" ref={makeInert}>
              <div className="kb-exit">
                <KeyboardHold still={wordsIn || failed} className="hold-tray" />
              </div>
            </div>
          ) : (
            // The gate's stack as `Round` lays it out (`.rules-gate` at the tray's bottom):
            // PLAY's box with its word, and LEARN's word under it.
            <div className="tray tray-gate" aria-hidden="true" ref={makeInert}>
              <div className="rules-gate hold-tray">
                <span className="mix-btn gate-slot">
                  <span className="gate-word">{t(lang, 'gatePlay')}</span>
                </span>
                {tray === 'gate-learn' && (
                  <span className="btn btn-secondary gate-slot">
                    <span className="gate-word">{t(lang, 'gateLearn')}</span>
                  </span>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
