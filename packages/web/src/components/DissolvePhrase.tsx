import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Hole as PuzzleHole } from '@whippin/shared';
import { prefersReducedMotion, randomGlyphs } from '../hooks/useScramble';

// The solved sentence's EXIT (user-decided 2026-08-14; re-sliced BY WORD on review the
// same day): once the solving beats have played out, the sentence hands the screen to
// the result by dissolving through the game's own word-transition language — WORD by
// word, each one churning its letters through random glyphs, then going out whole, until
// nothing is left. It is the slot-machine scramble run in reverse: the same 40ms frame
// rate, the same random glyphs, but settling into ABSENCE instead of into a word. The
// word is the unit because it is the GAME's unit — words are what the player guessed,
// and the sentence losing them one at a time reads as the round packing up its pieces
// (per-letter erosion was built first and read as noise: the sentence turned to static
// everywhere at once instead of visibly losing words).
//
// The order is SCATTERED, not a wipe: each word draws its start uniformly from ONE fixed
// window, so the first words do not always go first (an earlier per-letter cut swept
// left to right, which read as a cursor deleting the sentence). That single draw is also
// what bounds the beat AND what makes "batches": the window is a constant (~1s all in,
// whatever the sentence's length), and on a long sentence several words land on the same
// tick and go out together — with no batching machinery at all.
//
// This component renders the resolved sentence with EXACTLY Phrase's structure and
// classes (`.phrase`, `.word`, `.hole-group`, `.hole.resolved`, `.hole-letter`), so the
// swap from the live Phrase to this one is pixel-identical on its first frame — same
// wrap, same colours, same shadows. A dissolved word keeps its letter boxes with
// `visibility: hidden` (`.gone`), never actual spaces: the pixel font is monospace, so
// the advance is identical either way, and an invisible word can never collapse or
// reflow what remains — the sentence keeps its global shape as it empties, right up to
// the swap. Nothing moves until the parent unmounts the whole area.

// The scramble's own frame rate (useScramble's SCRAMBLE_TICK_MS): this is the same
// churn, so it runs on the same clock.
const TICK_MS = 40;
// Every word's start falls somewhere in this fixed window — the erosion's length,
// independent of the sentence's. In ticks so a start is always a whole frame.
const SPREAD_TICKS = 15; // 600ms
// Each word churns a random number of frames before going out — the second die, which
// keeps two words starting together from ending together. Window + longest churn + the
// closing breath ≈ 1s, the beat's whole budget.
const CHURN_MIN_TICKS = 3;
const CHURN_MAX_TICKS = 7;
// A breath after the last word goes, so the empty stage registers before the result
// builds on it.
const DONE_HOLD_MS = 180;

// One word of the sentence — the dissolve's unit. A blanked word's display affixes (a
// leading clitic like "t'", trailing punctuation) belong to their word's group on screen,
// so they churn and go out WITH it, on the group's one roll.
interface Token {
  key: number;
  // The joining space before this token (Phrase renders it outside the word span).
  space: boolean;
  secret: boolean;
  prefix?: string;
  suffix?: string;
  text: string;
  // Ticks before this word starts churning, then how many churn frames it holds.
  startTick: number;
  churnTicks: number;
}

type Phase = 'still' | 'churning' | 'gone';

export default function DissolvePhrase({
  words,
  puzzleHoles,
  onDone,
}: {
  words: string[];
  puzzleHoles: PuzzleHole[];
  onDone: () => void;
}) {
  // The word plan is rolled ONCE at mount (both dice — start and churn length), so a
  // re-render can never re-roll a word mid-flight — the same rule that keeps a slash
  // from flipping mid-swing.
  const tokens = useMemo<Token[]>(() => {
    const holeByPos = new Map(puzzleHoles.map((h) => [h.pos, h]));
    return words.map((w, i) => {
      const hole = holeByPos.get(i);
      return {
        key: i,
        space: i > 0,
        secret: hole !== undefined,
        prefix: hole?.prefix,
        suffix: hole?.suffix,
        text: hole ? hole.secret.word : w,
        startTick: Math.floor(Math.random() * SPREAD_TICKS),
        churnTicks:
          CHURN_MIN_TICKS + Math.floor(Math.random() * (CHURN_MAX_TICKS - CHURN_MIN_TICKS + 1)),
      };
    });
    // Static for the dissolve's lifetime: the sentence it erodes is the one it mounted with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lastTick = useMemo(
    () => Math.max(0, ...tokens.map((t) => t.startTick + t.churnTicks)),
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

  // One word's frame: itself, all letters churning together, or its invisible boxes.
  const phaseOf = (t: Token): Phase => {
    if (tick >= t.startTick + t.churnTicks) return 'gone';
    return tick >= t.startTick ? 'churning' : 'still';
  };
  const letters = (text: string, phase: Phase) =>
    Array.from(text).map((ch, i) => (
      <span key={i} className={`hole-letter${phase === 'gone' ? ' gone' : ''}`}>
        {phase === 'churning' ? randomGlyphs(1) : ch}
      </span>
    ));

  return (
    // Decorative from its first frame: the round is over, the solved announcement has
    // been spoken, and what erodes here is no longer content.
    <p className="phrase" aria-hidden="true">
      {/* Exactly Phrase's node structure — the joining space as a bare text node between
          the word spans — so the wrap points are the same wrap points. */}
      {tokens.map((t) => {
        const phase = phaseOf(t);
        return (
          <Fragment key={t.key}>
            {t.space ? ' ' : ''}
            {t.secret ? (
              <span className="hole-group">
                {t.prefix && <span className="word">{letters(t.prefix, phase)}</span>}
                <span className="hole resolved">
                  <span className="hole-word">{letters(t.text, phase)}</span>
                </span>
                {t.suffix && <span className="word">{letters(t.suffix, phase)}</span>}
              </span>
            ) : (
              <span className="word">{letters(t.text, phase)}</span>
            )}
          </Fragment>
        );
      })}
    </p>
  );
}
