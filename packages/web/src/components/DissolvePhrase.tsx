import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Hole as PuzzleHole } from '@whippin/shared';
import { prefersReducedMotion, randomGlyphs } from '../hooks/useScramble';

// The solved sentence's EXIT (user-decided 2026-08-14; scattered on review the same
// day): once the solving beats have played out, the sentence hands the screen to the
// result by dissolving through the game's own word-transition language — each letter
// churns through random glyphs, then goes out, until nothing is left. It is the
// slot-machine scramble run in reverse: the same 40ms frame rate, the same random
// glyphs, but settling into ABSENCE instead of into a word.
//
// The erosion is SCATTERED, not a wipe: each letter draws its start uniformly from ONE
// fixed window, so the order is random every time (a first cut swept left to right,
// which read as a cursor deleting the sentence rather than the sentence burning down —
// the round-level wave scheduler's lesson, relearned). That single draw is also what
// bounds the beat: the window is a constant, so a long sentence dissolves in exactly the
// time a short one does — more letters just go out per tick, and "batches" fall out of
// the uniform draw with no batching machinery at all.
//
// This component renders the resolved sentence with EXACTLY Phrase's structure and
// classes (`.phrase`, `.word`, `.hole-group`, `.hole.resolved`, `.hole-letter`), so the
// swap from the live Phrase to this one is pixel-identical on its first frame — same
// wrap, same colours, same shadows. A dissolved letter keeps its own box with
// `visibility: hidden` (`.gone`), never an actual space: the pixel font is monospace, so
// the advance is identical either way, and an invisible glyph can never collapse or
// reflow what remains. The sentence erodes IN PLACE; nothing moves until the parent
// unmounts the whole area.

// The scramble's own frame rate (useScramble's SCRAMBLE_TICK_MS): this is the same
// churn, so it runs on the same clock.
const TICK_MS = 40;
// Every letter's start falls somewhere in this fixed window — the whole erosion's
// length, independent of the sentence's. In ticks so a start is always a whole frame.
const SPREAD_TICKS = 18; // 720ms
// Each letter churns a random number of frames before going out — the second die that
// keeps two letters starting together from ending together.
const CHURN_MIN_TICKS = 2;
const CHURN_MAX_TICKS = 5;
// A breath after the last letter goes, so the empty stage registers before the result
// builds on it.
const DONE_HOLD_MS = 180;

interface Letter {
  ch: string;
  // Ticks before this letter starts churning, then how many churn frames it holds.
  startTick: number;
  churnTicks: number;
}

interface Token {
  key: number;
  // The joining space before this token (Phrase renders it outside the word span).
  space: boolean;
  secret: boolean;
  prefix?: string;
  suffix?: string;
  letters: Letter[];
  prefixLetters?: Letter[];
  suffixLetters?: Letter[];
}

export default function DissolvePhrase({
  words,
  puzzleHoles,
  onDone,
}: {
  words: string[];
  puzzleHoles: PuzzleHole[];
  onDone: () => void;
}) {
  // The letter plan is rolled ONCE at mount (both dice — start and churn length), so a
  // re-render can never re-roll a letter mid-flight — the same rule that keeps a slash
  // from flipping mid-swing.
  const tokens = useMemo<Token[]>(() => {
    const holeByPos = new Map(puzzleHoles.map((h) => [h.pos, h]));
    const plan = (text: string): Letter[] =>
      Array.from(text).map((ch) => ({
        ch,
        startTick: Math.floor(Math.random() * SPREAD_TICKS),
        churnTicks:
          CHURN_MIN_TICKS + Math.floor(Math.random() * (CHURN_MAX_TICKS - CHURN_MIN_TICKS + 1)),
      }));
    return words.map((w, i) => {
      const space = i > 0;
      const hole = holeByPos.get(i);
      if (hole) {
        return {
          key: i,
          space,
          secret: true,
          prefix: hole.prefix,
          suffix: hole.suffix,
          prefixLetters: hole.prefix ? plan(hole.prefix) : undefined,
          letters: plan(hole.secret.word),
          suffixLetters: hole.suffix ? plan(hole.suffix) : undefined,
        };
      }
      return { key: i, space, secret: false, letters: plan(w) };
    });
    // Static for the dissolve's lifetime: the sentence it erodes is the one it mounted with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lastTick = useMemo(
    () =>
      Math.max(
        0,
        ...tokens.flatMap((t) =>
          [...(t.prefixLetters ?? []), ...t.letters, ...(t.suffixLetters ?? [])].map(
            (l) => l.startTick + l.churnTicks,
          ),
        ),
      ),
    [tokens],
  );

  const [tick, setTick] = useState(0);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    // Reduced motion: no churn, no erosion — the sentence simply yields the stage.
    if (prefersReducedMotion()) {
      const id = window.setTimeout(() => onDoneRef.current(), 0);
      return () => window.clearTimeout(id);
    }
    const interval = window.setInterval(() => {
      setTick((current) => {
        if (current >= lastTick) {
          window.clearInterval(interval);
          return current;
        }
        return current + 1;
      });
    }, TICK_MS);
    return () => window.clearInterval(interval);
  }, [lastTick]);

  useEffect(() => {
    if (tick < lastTick) return undefined;
    if (prefersReducedMotion()) return undefined; // the mount effect already reported
    const id = window.setTimeout(() => onDoneRef.current(), DONE_HOLD_MS);
    return () => window.clearTimeout(id);
  }, [tick, lastTick]);

  // One letter's frame: itself, a churning glyph, or its own invisible box.
  const letter = (l: Letter, index: number) => {
    const gone = tick >= l.startTick + l.churnTicks;
    const churning = !gone && tick >= l.startTick;
    return (
      <span key={index} className={`hole-letter${gone ? ' gone' : ''}`}>
        {churning ? randomGlyphs(1) : l.ch}
      </span>
    );
  };

  return (
    // Decorative from its first frame: the round is over, the solved announcement has
    // been spoken, and what erodes here is no longer content.
    <p className="phrase" aria-hidden="true">
      {/* Exactly Phrase's node structure — the joining space as a bare text node between
          the word spans — so the wrap points are the same wrap points. */}
      {tokens.map((t) => (
        <Fragment key={t.key}>
          {t.space ? ' ' : ''}
          {t.secret ? (
            <span className="hole-group">
              {t.prefixLetters && <span className="word">{t.prefixLetters.map(letter)}</span>}
              <span className="hole resolved">
                <span className="hole-word">{t.letters.map(letter)}</span>
              </span>
              {t.suffixLetters && <span className="word">{t.suffixLetters.map(letter)}</span>}
            </span>
          ) : (
            <span className="word">{t.letters.map(letter)}</span>
          )}
        </Fragment>
      ))}
    </p>
  );
}
