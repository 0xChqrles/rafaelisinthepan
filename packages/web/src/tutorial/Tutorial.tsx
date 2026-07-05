import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Phrase from '../components/Phrase';
import ProgressBar from '../components/ProgressBar';
import FlagButton from '../components/FlagButton';
import WordInput from '../components/WordInput';
import Keyboard from '../components/Keyboard';
import { HIT_FADE_MS } from '../components/FloatingHit';
import { STAGGER_MS, FLOATING_HIT_INTRO_MS, WORD_BLINK_MS } from '../screens/Game';
import { computeProgress } from '../game/scoring';
import { buildPrefixSet, canExtend } from '../game/keyboard';
import { fold } from '@whippin/shared';
import type { HitState, RuntimeHole } from '@whippin/shared';
import { t, srHoleResult } from '../i18n';
import { scriptFor } from './scripts';
import type { Anchor } from './script';

// The onboarding tutorial (#51): a scripted round on a dummy two-hole sentence, played
// in the REAL game UI. Everything the player sees reacting — floating distances, MISS,
// exponent rolls, word swaps, greyed keys — is the actual components with the actual
// timing constants; this file only adds a small step machine and the coach-mark layer.
// The script (sentence, ranks, guesses, steps) is data in ./scripts/<lang>.ts.
//
// Deliberately NOT Round: Round is fused to the persisted store, and a tutorial round
// must never touch `rounds` (only the `onboarded` flag changes, set by the caller via
// onDone). The guess loop below is the same logic on local state.

// Gated-empty sets for the non-typing steps: every letter greys out, Enter greys out.
const NO_WORDS = new Set<string>();

// Which coach panels float WITHOUT the dimming backdrop: the wrap-up steps point at
// the watermark/progress bar, which a backdrop would hide — and during a guess prompt
// the player is about to type, so the board must stay fully visible and interactive.
const UNDIMMED_ANCHORS: readonly Anchor[] = ['watermark', 'progress'];

// Coach panels sit in three CSS zones rather than measuring elements (the spec's
// "simple absolute positioning per anchor"): top (below the HUD), center, and bottom
// (above the keyboard).
function zoneOf(anchor: Anchor): 'top' | 'center' | 'bottom' {
  if (anchor === 'center' || anchor === 'watermark') return 'center';
  if (anchor === 'input' || anchor === 'keyboard') return 'bottom';
  return 'top';
}

// Guess-step copy carries {WORD} so it can never drift from the script's expected word.
function withWord(copy: string, word: string): string {
  return copy.replace('{WORD}', word.toUpperCase());
}

function freshHoles(script: ReturnType<typeof scriptFor>): RuntimeHole[] {
  return script.puzzle.holes.map((h) => ({
    pos: h.pos,
    secret: h.secret.slug,
    word: h.start.word,
    rank: h.start_rank,
    startRank: h.start_rank,
  }));
}

export default function Tutorial({ lang, onDone }: { lang: string; onDone: () => void }) {
  const script = useMemo(() => scriptFor(lang), [lang]);
  const { puzzle } = script;

  // Step machine: `stepIndex` walks script.steps; guess steps go idle (typing gated to
  // the expected word) -> feedback (choreography playing, input fully gated) -> after
  // (explanation panel + NEXT).
  const [stepIndex, setStepIndex] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'feedback' | 'after'>('idle');

  // The scripted round's state — the local twin of Round's persisted state.
  const [holes, setHoles] = useState<RuntimeHole[]>(() => freshHoles(script));
  const [hits, setHits] = useState<HitState[]>([]);
  const [tries, setTries] = useState(0);
  const [input, setInput] = useState('');
  const [invalidAt, setInvalidAt] = useState(0);
  const hitId = useRef(0);

  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.current = timers.current.filter((x) => x !== id);
      fn();
    }, ms);
    timers.current.push(id);
  }, []);

  // Screen-reader mirror, same pattern as Game (zero-width flip forces re-announcement).
  const [announce, setAnnounce] = useState('');
  const announceFlip = useRef(false);
  const say = useCallback((text: string) => {
    announceFlip.current = !announceFlip.current;
    setAnnounce(text + (announceFlip.current ? '' : '​'));
  }, []);

  const step = script.steps[stepIndex];
  const isLast = stepIndex === script.steps.length - 1;
  const progress = useMemo(() => computeProgress(holes, puzzle.ranks), [holes, puzzle]);

  // Input gating IS the existing keyboard contract: during a guess step the vocab is
  // just the expected word and the prefix set its prefixes, so the real Keyboard greys
  // every other key (and greyed taps shake) with no tutorial-specific code. Outside a
  // guess step both sets are empty — the whole keyboard reads as inert.
  const expecting = step.kind === 'guess' && phase === 'idle' ? step.expect : null;
  const vocabSet = useMemo(() => (expecting ? new Set([expecting]) : NO_WORDS), [expecting]);
  const prefixSet = useMemo(() => (expecting ? buildPrefixSet([expecting]) : NO_WORDS), [expecting]);

  const appendChar = useCallback(
    (char: string) => {
      if (canExtend(prefixSet, input, char)) setInput(input + char);
      else setInvalidAt(Date.now());
    },
    [prefixSet, input],
  );
  const deleteChar = useCallback(() => setInput((cur) => cur.slice(0, -1)), []);
  const replaceInput = useCallback((v: string) => setInput(v), []);

  const removeHit = useCallback((id: number) => {
    setHits((prev) => prev.filter((h) => h.id !== id));
  }, []);

  // The same guess loop as Game.submit, on local state: every unsolved hole reacts,
  // hits stagger in sentence order and fade as one batch, improvements land at the
  // shared fade-out moment. Then the step advances to its explanation once the
  // choreography has settled (fade + blink), so the panel never covers a moving board.
  const submit = useCallback(
    (raw: string) => {
      if (!expecting) return;
      const typed = fold(raw);
      if (!typed) return;
      if (typed !== expecting) {
        setInvalidAt(Date.now());
        return;
      }
      setInput('');
      setTries((n) => n + 1);

      const impacted = holes.flatMap((h, index) => {
        if (h.rank === 0) return [];
        return [{ index, entry: puzzle.ranks[h.secret][typed] }];
      });
      const fadeDelayMs = Math.max(0, impacted.length - 1) * STAGGER_MS + FLOATING_HIT_INTRO_MS;
      let anyImprove = false;
      impacted.forEach(({ index, entry }, i) => {
        const id = (hitId.current += 1);
        setHits((prev) => [
          ...prev,
          entry != null
            ? { holeIndex: index, value: entry.rank, id, startDelayMs: i * STAGGER_MS, fadeDelayMs }
            : { holeIndex: index, value: 0, id, startDelayMs: i * STAGGER_MS, fadeDelayMs, miss: true },
        ]);
        if (entry == null || entry.rank >= holes[index].rank) return;
        anyImprove = true;
        const { word, rank } = entry;
        later(
          () =>
            setHoles((prev) => prev.map((h, j) => (j === index && rank < h.rank ? { ...h, word, rank } : h))),
          fadeDelayMs,
        );
      });

      const solvesAll = holes.every((h) => h.rank === 0 || puzzle.ranks[h.secret][typed]?.rank === 0);
      const parts = impacted.map(({ index, entry }) =>
        srHoleResult(lang, index + 1, entry ? entry.rank : null),
      );
      say(solvesAll ? [...parts, t(lang, 'srSolvedAll')].join(', ') : parts.join(', '));

      setPhase('feedback');
      const settleMs = fadeDelayMs + HIT_FADE_MS + (anyImprove ? WORD_BLINK_MS : 0) + 250;
      later(() => setPhase('after'), settleMs);
    },
    [expecting, holes, puzzle, lang, say, later],
  );

  const next = useCallback(() => {
    if (isLast) {
      onDone();
      return;
    }
    setPhase('idle');
    setStepIndex((i) => i + 1);
  }, [isLast, onDone]);

  // The coach layer for the current moment: a dimmed modal panel for tell steps and
  // guess explanations, an undimmed floating instruction while the player types, and
  // nothing at all while the feedback choreography plays.
  let panel: { copy: string; anchor: Anchor; modal: boolean } | null = null;
  if (step.kind === 'tell') {
    panel = { copy: t(lang, step.copyKey), anchor: step.anchor, modal: true };
  } else if (phase === 'idle') {
    panel = { copy: withWord(t(lang, step.copyKey), step.expect), anchor: 'hole', modal: false };
  } else if (phase === 'after') {
    panel = { copy: withWord(t(lang, step.afterKey), step.expect), anchor: 'hole', modal: true };
  }
  const dimmed = panel?.modal === true && !UNDIMMED_ANCHORS.includes(panel.anchor);

  return (
    <div className="game tutorial">
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>

      {/* Same HUD as the real game (the wrap-up points at the progress bar), plus the
          always-available SKIP. The HUD sits above the backdrop so SKIP stays live. */}
      <div className="hud">
        <FlagButton lang={lang} />
        <ProgressBar value={progress} />
        <button type="button" className="home-btn skip-btn" onClick={onDone}>
          {t(lang, 'tutSkip')}
        </button>
      </div>

      <div className="play">
        <div className="progress-background" aria-hidden="true">
          {tries}
        </div>
        <Phrase words={puzzle.words} holes={holes} puzzleHoles={puzzle.holes} hits={hits} onHitDone={removeHit} />
        <div className="input-area">
          <WordInput
            value={input}
            history={[]}
            onType={appendChar}
            onBackspace={deleteChar}
            onSubmit={submit}
            onReplace={replaceInput}
            invalidSignal={invalidAt}
          />
          <p className="hint"> </p>
        </div>
      </div>

      <div className="tray">
        <Keyboard
          input={input}
          prefixSet={prefixSet}
          vocabSet={vocabSet}
          lang={lang}
          onType={appendChar}
          onBackspace={deleteChar}
          onSubmit={submit}
        />
      </div>

      {dimmed && <div className="tutorial-backdrop" />}
      {panel && (
        <div
          // Remount per moment so the enter transition and autoFocus re-fire each step.
          key={`${stepIndex}:${phase}`}
          className={`coach coach--${zoneOf(panel.anchor)}${panel.modal ? '' : ' coach--prompt'}`}
        >
          <p className="coach-text" aria-live="polite">
            {panel.copy}
          </p>
          {panel.modal && (
            <div className="coach-actions">
              {/* eslint-disable-next-line jsx-a11y/no-autofocus -- each step is a
                  modal moment; focusing its only action is the accessible default */}
              <button type="button" className="coach-btn" onClick={next} autoFocus>
                {isLast ? t(lang, 'tutPlay') : t(lang, 'tutNext')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
