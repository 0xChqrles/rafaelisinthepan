import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Hole as PuzzleHole } from '@whippin/shared';
import { prefersReducedMotion, scrambleFrame, SCRAMBLE_MS } from '../hooks/useScramble';

// The solved sentence's EXIT (user-decided 2026-08-14; word-sliced on review): once the
// solving beats have played out, the sentence hands the screen to the result by playing
// the game's OWN word-transition on every word — the slot-machine scramble (#102), with
// the EMPTY STRING as the target. `scrambleFrame('', len, p)` is exactly the swap a hole
// plays all round: the letters churn while the length interpolates down one letter at a
// time, and the sentence re-wraps gradually around each shrinking word — the same
// grammar, so the exit reads as one more transition, not a new effect.
//
// WORDS are the unit, and each draws its start uniformly from ONE fixed window: the
// order is random every time, "batches" of words fall out of the uniform draw with no
// batching machinery, and the window being a constant is what bounds the beat — a long
// sentence dissolves in exactly the time a short one does.
//
// The first frame renders the resolved sentence with EXACTLY Phrase's structure and
// classes (`.phrase`, `.word`, `.hole-group`, `.hole.resolved`, `.hole-word`,
// `.hole-letter`), so the swap from the live Phrase to this one is pixel-identical —
// same wrap, same colours, same shadows.

// The scramble's own frame rate (useScramble's SCRAMBLE_TICK_MS) and its own settle
// length: this IS that animation, so it runs on that clock.
const TICK_MS = 40;
const SETTLE_TICKS = Math.round(SCRAMBLE_MS / TICK_MS);
// Every word's start falls somewhere in this fixed window — the erosion's spread,
// independent of the sentence's length. In ticks so a start is always a whole frame.
const SPREAD_TICKS = 13; // 520ms
// A breath after the last word goes, so the empty stage registers before the result
// builds on it.
const DONE_HOLD_MS = 180;

interface Token {
  key: number;
  // The joining space before this token (Phrase renders it outside the word span).
  space: boolean;
  secret: boolean;
  // The token's display pieces — a plain word is one; a hole keeps its prefix / secret /
  // suffix apart so each holds its own colour while it shrinks.
  prefix?: string;
  word: string;
  suffix?: string;
  // The tick this whole token starts scrambling out on (its pieces go together).
  startTick: number;
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
  // The plan is rolled ONCE at mount, so a re-render can never re-roll a word
  // mid-flight — the same rule that keeps a slash from flipping mid-swing.
  const tokens = useMemo<Token[]>(() => {
    const holeByPos = new Map(puzzleHoles.map((h) => [h.pos, h]));
    return words.map((w, i) => {
      const hole = holeByPos.get(i);
      const startTick = Math.floor(Math.random() * SPREAD_TICKS);
      return hole
        ? {
            key: i,
            space: i > 0,
            secret: true,
            prefix: hole.prefix,
            word: hole.secret.word,
            suffix: hole.suffix,
            startTick,
          }
        : { key: i, space: i > 0, secret: false, word: w, startTick };
    });
    // Static for the dissolve's lifetime: the sentence it erodes is the one it mounted with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lastTick = useMemo(
    () => Math.max(0, ...tokens.map((t) => t.startTick + SETTLE_TICKS)),
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

  // One piece's frame: the word-swap scramble toward '' — untouched before its token's
  // start, gone past its settle. Letters render in Hole's own per-letter boxes, keyed by
  // position, so churning frames replace glyphs in place.
  const piece = (text: string, startTick: number) => {
    const p = (tick - startTick) / SETTLE_TICKS;
    const shown = p <= 0 ? text : scrambleFrame('', Array.from(text).length, p);
    return Array.from(shown).map((ch, i) => (
      <span key={i} className="hole-letter" style={{ '--i': i } as CSSProperties}>
        {ch}
      </span>
    ));
  };

  return (
    // Decorative from its first frame: the round is over, the solved announcement has
    // been spoken, and what erodes here is no longer content.
    //
    // Exactly Phrase's node structure — the joining space as a bare text node between
    // the word spans — so the wrap points are the same wrap points; the spaces around a
    // fully-gone word collapse, and the sentence closes up the way it always has around
    // a shrinking word (#102).
    <p className="phrase" aria-hidden="true">
      {tokens.map((t) => (
        <Fragment key={t.key}>
          {t.space ? ' ' : ''}
          {t.secret ? (
            <span className="hole-group">
              {t.prefix && <span className="word">{piece(t.prefix, t.startTick)}</span>}
              <span className="hole resolved">
                <span className="hole-word">{piece(t.word, t.startTick)}</span>
              </span>
              {t.suffix && <span className="word">{piece(t.suffix, t.startTick)}</span>}
            </span>
          ) : (
            <span className="word">{piece(t.word, t.startTick)}</span>
          )}
        </Fragment>
      ))}
    </p>
  );
}
