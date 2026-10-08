import { useCallback, useEffect, useState } from 'react';
import type { Hole as PuzzleHole } from '@whippin/shared';
import Phrase from '../components/Phrase';
import WordInput from '../components/WordInput';
import { RANK_MAX_MS } from '../components/Hole';
import { SCRAMBLE_MS } from '../hooks/useScramble';
import { FLOATING_HIT_INTRO_MS } from '../game/timing';
import { capitalize } from '../game/sentenceCase';
import type { HitState, RuntimeHole } from '../game/types';
import type { LangCode } from '../langs';

// THE INVITATION'S DEMO: before the first visit asks anything, it SHOWS the game, once. The
// site's own sentence stands on the real board (`Phrase`, `Hole`, and the game's prompt,
// inactive), its hole holding a far word under a big number, and the demo types three
// guesses into the prompt: a word outside the map, answered MISS; a closer one, which the
// hole takes with a smaller number; the secret, which inks the hole in the solve's cobalt.
// The sentence then states its own pitch, the prompt retires as on a solve, and the screen is
// still: nothing loops and nothing is said. The question under it (`Invite`) stands from the
// first frame and waits on nothing here.
//
// Every frame reads as a sentence, the number falling as the meaning closes in:
//   en  Every guess tells you how lost⁹¹ you are.  →  banana: MISS  →  near²  →  close
//   fr  Chaque essai te dit si tu es paumé³⁵⁵.     →  banane: MISS  →  loin⁴  →  proche
// The ranks are real, read off the static single-word maps:
//   pnpm gen:word close --lang en --form close=adj:pos    (proximity¹ near² … far¹⁰ … lost⁹¹,
//                                                           a key of the `lose` group)
//   pnpm gen:word proche --lang fr --form proche=adj:m:s  (éloigné¹ proximité² près³ loin⁴ …
//                                                           paumé³⁵⁵)
// and neither `banana` nor `banane` is in its map. Re-read them if the embedding is rebuilt.
// They are written here, never imported as JSON (the invitation is in the startup bundle),
// and none of them is the lesson's, so level 1's REVEAL keeps its surprise.
//
// Each guess lands on the board's own choreography and no more: a miss is the game's MISS
// float and shake, exactly as the player then meets it (it rises over the line above, as in
// the game); a closer word is the hole's own word change (the exponent rolling down,
// the letters churning and settling). No cut, loot or star — those are the player's first
// hit's to give, and their sprites would cross the question under the demo.

interface DemoGuess {
  typed: string; // the keys pressed (the keyboard has no accents)
  // What the map answers: the group's word and rank, or null — outside the map, a MISS,
  // which never enters the hole.
  answer: { word: string; rank: number } | null;
}

interface Demo {
  words: string[]; // the sentence as it ends, in the puzzle schema's own shape
  hole: PuzzleHole;
  guesses: DemoGuess[];
}

const DEMOS: Record<LangCode, Demo> = {
  en: {
    words: ['every', 'guess', 'tells', 'you', 'how', 'close', 'you', 'are.'],
    hole: {
      pos: 5,
      secret: { word: 'close', slug: 'close' },
      start: { word: 'lost', slug: 'lost' },
      start_rank: 91,
    },
    guesses: [
      { typed: 'banana', answer: null },
      { typed: 'near', answer: { word: 'near', rank: 2 } },
      { typed: 'close', answer: { word: 'close', rank: 0 } },
    ],
  },
  fr: {
    words: ['chaque', 'essai', 'te', 'dit', 'si', 'tu', 'es', 'proche.'],
    hole: {
      pos: 7,
      secret: { word: 'proche', slug: 'proche' },
      start: { word: 'paumé', slug: 'paume' },
      start_rank: 355,
      suffix: '.',
    },
    guesses: [
      { typed: 'banane', answer: null },
      { typed: 'loin', answer: { word: 'loin', rank: 4 } },
      { typed: 'proche', answer: { word: 'proche', rank: 0 } },
    ],
  },
};

// THE BEATS. The first key waits out the sentence's decode (`PhraseIntro`, about 700ms); a
// key every `.wi-char` drop; a short pause before Enter; the sent word's lift-off
// (`.wi-launch`) before the board answers. A MISS stands for the game's own read of a hit
// before the next word is typed; a closer word for the hole's whole change — the exponent's
// longest roll, then the letters' settle. All told, about 6.5s.
const FIRST_KEY_MS = 900;
const KEY_MS = 90;
const SEND_MS = 200;
const LAND_MS = 240;
const MISS_READ_MS = FLOATING_HIT_INTRO_MS;
const CHANGE_MS = RANK_MAX_MS + SCRAMBLE_MS;

// The sentence waits for its face: the decode run in a fallback font would break its lines
// elsewhere, then jump when Press Start 2P lands (the `@font-face` family). Never longer than
// this, so a slow font costs a fallback frame rather than the demo.
const PIXEL_FACE = '16px "Press Start 2P"';
const FONT_WAIT_MS = 400;

const NO_HITS: HitState[] = [];
const NO_HISTORY: string[] = [];
const noop = () => {};

export default function InviteDemo({ lang }: { lang: LangCode }) {
  const demo = DEMOS[lang];
  const [hole, setHole] = useState<RuntimeHole>(() => ({
    pos: demo.hole.pos,
    secret: demo.hole.secret.slug,
    word: demo.hole.start.word,
    rank: demo.hole.start_rank,
    startRank: demo.hole.start_rank,
  }));
  const [typed, setTyped] = useState('');
  const [miss, setMiss] = useState<HitState | null>(null);
  const [done, setDone] = useState(false);

  // The show starts once its face is in (or the wait is over) AND the page is seen: a link
  // opened in a background tab keeps the board empty until it is looked at, so the show is
  // never spent unseen.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    let fontIn = false;
    const go = () => {
      if (alive && fontIn && document.visibilityState === 'visible') setReady(true);
    };
    const faceIn = () => {
      fontIn = true;
      go();
    };
    const cap = window.setTimeout(faceIn, FONT_WAIT_MS);
    if (document.fonts) document.fonts.load(PIXEL_FACE).then(faceIn, faceIn);
    else faceIn();
    document.addEventListener('visibilitychange', go);
    return () => {
      alive = false;
      window.clearTimeout(cap);
      document.removeEventListener('visibilitychange', go);
    };
  }, []);

  // ONE timeline, played once. Every step sets a final state, so a tab hidden mid-run (its
  // timers throttled) still ends on the right frame; a tap on TUTORIAL or SKIP unmounts the
  // demo and clears them all.
  useEffect(() => {
    if (!ready) return undefined;
    const timers: number[] = [];
    const at = (ms: number, step: () => void) => timers.push(window.setTimeout(step, ms));
    let t = FIRST_KEY_MS;
    demo.guesses.forEach(({ typed: keys, answer }, index) => {
      for (let n = 1; n <= keys.length; n += 1) {
        at(t, () => setTyped(keys.slice(0, n)));
        if (n < keys.length) t += KEY_MS;
      }
      t += SEND_MS;
      at(t, () => setTyped(''));
      t += LAND_MS;
      if (answer) {
        at(t, () => setHole((h) => ({ ...h, word: answer.word, rank: answer.rank })));
        t += CHANGE_MS;
      } else {
        at(t, () =>
          setMiss({ holeIndex: 0, value: 0, id: index + 1, startDelayMs: 0, fadeDelayMs: MISS_READ_MS, miss: true }),
        );
        t += MISS_READ_MS;
      }
    });
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [ready, demo]);

  const onHitDone = useCallback(() => setMiss(null), []);
  // The hole inked (Phrase's own signal, never a timer guessing it): the prompt leaves as it
  // does on a solve.
  const onFound = useCallback(() => setDone(true), []);

  // The game's own two rows, as children of the invitation's `.play`: the sentence (in the
  // game's `.phrase-anchor`) and the prompt (in its `.prompt-zone`), so they stand at the
  // game's left edge, size and spacing.
  return (
    <>
      <p className="sr-only">{capitalize(demo.words.join(' '))}</p>
      <div className="phrase-anchor invite-demo" aria-hidden="true">
        {ready ? (
          <Phrase
            words={demo.words}
            lang={lang}
            holes={[hole]}
            puzzleHoles={[demo.hole]}
            hits={miss ? [miss] : NO_HITS}
            onHitDone={onHitDone}
            onHoleResolved={onFound}
          />
        ) : (
          // The sentence's box, held empty until its face is in.
          <p className="phrase" />
        )}
      </div>
      <div className="prompt-zone" aria-hidden="true" style={ready ? undefined : { visibility: 'hidden' }}>
        <div className={`input-area${done ? ' solving' : ''}`}>
          <WordInput
            value={typed}
            history={NO_HISTORY}
            lang={lang}
            active={false}
            invalidSignal={0}
            onType={noop}
            onBackspace={noop}
            onSubmit={noop}
            onReplace={noop}
          />
        </div>
      </div>
    </>
  );
}
