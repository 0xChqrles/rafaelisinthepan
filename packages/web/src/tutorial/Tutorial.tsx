import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Phrase from '../components/Phrase';
import ProgressBar from '../components/ProgressBar';
import FlagButton from '../components/FlagButton';
import WordInput from '../components/WordInput';
import Keyboard from '../components/Keyboard';
import LoadError from '../components/LoadError';
import { HIT_FADE_MS } from '../components/FloatingHit';
import { STAGGER_MS, FLOATING_HIT_INTRO_MS, WORD_BLINK_MS } from '../screens/Game';
import ScrambleWord from './ScrambleWord';
import { computeProgress } from '../game/scoring';
import { buildPrefixSet, canExtend } from '../game/keyboard';
import useVocab from '../hooks/useVocab';
import { fold } from '@whippin/shared';
import type { HitState, RankEntry, RuntimeHole } from '@whippin/shared';
import { t, srHoleResult } from '../i18n';
import { scriptFor } from './scripts';
import { isPadWord, type Anchor, type TutorialStage } from './script';

// The onboarding tutorial (#51), two stages of scripted play in the REAL game UI:
//
//   Stage 1 — one word, concept first. The secret is SHOWN (blue/solved), the
//   scramble demo walks it out to its 100th neighbor (= a real round's start word),
//   three gated guesses demonstrate distance / MISS / improvement, then the player
//   types their way back to the secret with the real vocabulary (free exploration,
//   with a nudge after 3 straight MISSes in case they forgot the word).
//
//   Stage 2 — an easy two-hole sentence played UNGUIDED (real vocabulary, tries
//   counted, progress bar live). Its rank maps are stocked so the obvious first
//   guess lands on BOTH holes: multi-hole broadcast is discovered, not told.
//
// Everything that reacts — floating distances, MISS, exponent rolls, word swaps,
// greyed keys — is the actual components with the actual timing constants; this file
// adds the step machine and the coach-mark layer. The scripts are data
// (./scripts/<lang>.ts). Deliberately NOT Round: Round is fused to the persisted
// store, and a tutorial round must never touch `rounds` (only the `onboarded` flag
// changes, set by the caller via onDone).

// Gated-empty sets: every letter greys out, Enter greys out.
const NO_WORDS = new Set<string>();

// Consecutive MISSes in the find step before the prompt swaps to the reminder.
const NUDGE_AFTER_MISSES = 3;

// Coach panels sit in three CSS zones rather than measuring elements: top (below the
// HUD), center, and bottom (above the keyboard).
function zoneOf(anchor: Anchor): 'top' | 'center' | 'bottom' {
  if (anchor === 'center' || anchor === 'watermark') return 'center';
  if (anchor === 'input' || anchor === 'keyboard') return 'bottom';
  return 'top';
}

// Which coach panels float WITHOUT the dimming backdrop: the wrap-up steps point at
// the watermark/progress bar, which a backdrop would hide.
const UNDIMMED_ANCHORS: readonly Anchor[] = ['watermark', 'progress'];

// Guess/nudge copy carries {WORD} so it can never drift from the script's word.
function withWord(copy: string, word: string): string {
  return copy.replace('{WORD}', word.toUpperCase());
}

function freshHoles(stage: TutorialStage): RuntimeHole[] {
  return stage.puzzle.holes.map((h) => ({
    pos: h.pos,
    secret: h.secret.slug,
    word: h.start.word,
    rank: h.start_rank,
    startRank: h.start_rank,
  }));
}

export default function Tutorial({ lang, onDone }: { lang: string; onDone: () => void }) {
  const script = useMemo(() => scriptFor(lang), [lang]);

  const [stageIndex, setStageIndex] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  // Guided steps: idle (acting) -> feedback (choreography playing) -> after
  // (explanation + NEXT). Free steps stay idle until they complete.
  const [phase, setPhase] = useState<'idle' | 'feedback' | 'after'>('idle');

  const stage = script.stages[stageIndex];
  const { puzzle } = stage;
  const step = stage.steps[stepIndex];
  // The sentence stage: live chrome (progress bar + tries watermark), free play.
  const liveStage = stage.steps.some((s) => s.kind === 'play');

  // The scripted round's local state — the ephemeral twin of Round's persisted state.
  const [holes, setHoles] = useState<RuntimeHole[]>(() => freshHoles(script.stages[0]));
  const [hits, setHits] = useState<HitState[]>([]);
  const [tries, setTries] = useState(0);
  const triedRef = useRef<Set<string>>(new Set()); // dedupes tries, like the store does
  const [missStreak, setMissStreak] = useState(0); // find step: consecutive MISSes
  const [input, setInput] = useState('');
  const [invalidAt, setInvalidAt] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const hitId = useRef(0);

  // The find/play steps type against the REAL vocabulary (loaded at mount, so it is
  // warm long before the free steps — and already cached for the game right after).
  const { vocab, error: vocabError, retry: retryVocab } = useVocab(lang);

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

  const progress = useMemo(() => computeProgress(holes, puzzle.ranks), [holes, puzzle]);

  // Advance to the next step, next stage, or hand over to the real game.
  const advance = useCallback(() => {
    if (stepIndex < stage.steps.length - 1) {
      setPhase('idle');
      setStepIndex((i) => i + 1);
      return;
    }
    if (stageIndex >= script.stages.length - 1) {
      onDone();
      return;
    }
    const nextStage = script.stages[stageIndex + 1];
    setHoles(freshHoles(nextStage));
    setHits([]);
    setTries(0);
    triedRef.current = new Set();
    setMissStreak(0);
    setInput('');
    setFeedback(null);
    setPhase('idle');
    setStepIndex(0);
    setStageIndex((i) => i + 1);
  }, [stage, stepIndex, stageIndex, script, onDone]);

  // Input gating. A gated guess step admits ONLY the expected word (the keyboard's
  // own prefix/vocab contract greys everything else); free steps use the real sets.
  const gatedWord = step.kind === 'guess' && phase === 'idle' ? step.expect : null;
  const freeTyping = (step.kind === 'find' || step.kind === 'play') && phase === 'idle';
  const vocabSet = useMemo(() => {
    if (gatedWord) return new Set([gatedWord]);
    if (freeTyping && vocab) return vocab.vocabSet;
    return NO_WORDS;
  }, [gatedWord, freeTyping, vocab]);
  const prefixSet = useMemo(() => {
    if (gatedWord) return buildPrefixSet([gatedWord]);
    if (freeTyping && vocab) return vocab.prefixSet;
    return NO_WORDS;
  }, [gatedWord, freeTyping, vocab]);

  const appendChar = useCallback(
    (char: string) => {
      setFeedback(null);
      if (canExtend(prefixSet, input, char)) setInput(input + char);
      else setInvalidAt(Date.now());
    },
    [prefixSet, input],
  );
  const deleteChar = useCallback(() => {
    setFeedback(null);
    setInput((cur) => cur.slice(0, -1));
  }, []);
  const replaceInput = useCallback((v: string) => {
    setFeedback(null);
    setInput(v);
  }, []);

  const removeHit = useCallback((id: number) => {
    setHits((prev) => prev.filter((h) => h.id !== id));
  }, []);

  // The same guess loop as Game.submit, on local state. `lock: true` (gated steps)
  // freezes input through the choreography and lands on the explanation panel; free
  // steps keep typing open and only lock when the guess completes the step.
  const playGuess = useCallback(
    (typed: string, lock: boolean) => {
      const impacted = holes.flatMap((h, index) => {
        if (h.rank === 0) return [];
        return [{ index, entry: puzzle.ranks[h.secret][typed] as RankEntry | undefined }];
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

      if (step.kind === 'find') {
        setMissStreak((s) => (impacted.every((x) => x.entry == null) ? s + 1 : 0));
      }

      const solvesAll = holes.every((h) => h.rank === 0 || puzzle.ranks[h.secret][typed]?.rank === 0);
      const parts = impacted.map(({ index, entry }) =>
        srHoleResult(lang, index + 1, entry ? entry.rank : null),
      );
      say(solvesAll ? [...parts, t(lang, 'srSolvedAll')].join(', ') : parts.join(', '));

      const settleMs = fadeDelayMs + HIT_FADE_MS + (anyImprove ? WORD_BLINK_MS : 0) + 250;
      if (lock) {
        setPhase('feedback');
        // Most gated guesses need no comment — the feedback taught the lesson, so
        // they roll straight into the next prompt. Only a step with an afterKey
        // (MISS, the least self-evident) pauses on an explanation.
        const afterKey = step.kind === 'guess' ? step.afterKey : undefined;
        later(afterKey ? () => setPhase('after') : advance, settleMs);
      } else if (solvesAll) {
        setPhase('feedback');
        // Solving needs no comment either: the find step rolls into the sentence
        // stage, and the play step is the graduation — the tray swaps to the score
        // + the PLAY TODAY'S PUZZLE exit ('after'), and nothing more is said.
        if (step.kind === 'find') later(advance, settleMs + 350);
        else later(() => setPhase('after'), settleMs + 350);
      }
    },
    [holes, puzzle, step, lang, say, later, advance],
  );

  const submit = useCallback(
    (raw: string) => {
      const typed = fold(raw);
      if (!typed) return;
      if (gatedWord) {
        if (typed !== gatedWord) {
          setInvalidAt(Date.now());
          return;
        }
        setInput('');
        playGuess(typed, true);
        return;
      }
      if (!freeTyping) return;
      // Free steps behave exactly like the game: existence is decided by the real
      // vocabulary; invalid words shake + message and reach no hole.
      if (!vocab || !vocab.vocabSet.has(typed)) {
        setInvalidAt(Date.now());
        setFeedback(t(lang, 'notAWord'));
        say(t(lang, 'notAWord'));
        return;
      }
      setInput('');
      setFeedback(null);
      if (step.kind === 'play' && !triedRef.current.has(typed)) {
        triedRef.current.add(typed);
        setTries((n) => n + 1);
      }
      playGuess(typed, false);
    },
    [gatedWord, freeTyping, vocab, step, lang, say, playGuess],
  );

  // The scramble ladder: the stage's own real rank entries up to the start word.
  const scrambleLadder = useMemo<RankEntry[]>(() => {
    if (step.kind !== 'scramble') return [];
    const hole = puzzle.holes[0];
    return Object.values(puzzle.ranks[hole.secret.slug])
      .filter((e) => !isPadWord(e.word) && e.rank > 0 && e.rank <= hole.start_rank)
      .sort((a, b) => a.rank - b.rank);
  }, [step, puzzle]);
  const scrambleDone = useCallback(() => setPhase('after'), []);

  // The coach layer: a dimmed modal panel for tells and explanations, an undimmed
  // floating instruction while the player acts, nothing while choreography plays.
  let panel: { copy: string; anchor: Anchor; modal: boolean } | null = null;
  if (step.kind === 'tell') {
    panel = { copy: t(lang, step.copyKey), anchor: step.anchor, modal: true };
  } else if (step.kind === 'scramble') {
    panel =
      phase === 'after'
        ? { copy: t(lang, step.afterKey), anchor: 'hole', modal: true }
        : { copy: t(lang, step.copyKey), anchor: 'hole', modal: false };
  } else if (step.kind === 'guess') {
    if (phase === 'idle') {
      panel = { copy: withWord(t(lang, step.copyKey), step.expect), anchor: 'hole', modal: false };
    } else if (phase === 'after' && step.afterKey) {
      panel = { copy: withWord(t(lang, step.afterKey), step.expect), anchor: 'hole', modal: true };
    }
  } else if (step.kind === 'find' && phase === 'idle') {
    panel = {
      copy:
        missStreak >= NUDGE_AFTER_MISSES
          ? withWord(t(lang, step.nudgeKey), step.target)
          : t(lang, step.copyKey),
      anchor: 'hole',
      modal: false,
    };
  } // play: no panel — they're on their own, and the solve says nothing either.
  const dimmed = panel?.modal === true && !UNDIMMED_ANCHORS.includes(panel.anchor);
  const isVeryLast = stageIndex === script.stages.length - 1 && stepIndex === stage.steps.length - 1;

  const showScramble = step.kind === 'scramble' && phase !== 'after';
  const vocabNeeded = step.kind === 'find' || step.kind === 'play';
  // The sentence solved: the tutorial's last word is the score + the exit button.
  const graduated = step.kind === 'play' && phase === 'after';

  return (
    // tutorial--word: the concept stage is deliberately CLEAN — panel on top, one big
    // centered word in the middle, keyboard at the bottom, nothing else.
    <div className={`game tutorial${liveStage ? '' : ' tutorial--word'}`}>
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>

      {/* Same HUD as the game — but the progress bar only exists on the sentence
          stage ("before the sentence and the progress bar, just a word"). SKIP is
          always live; the HUD sits above the backdrop. */}
      <div className="hud">
        <FlagButton lang={lang} />
        {liveStage ? <ProgressBar value={progress} /> : <div className="hud-spacer" />}
        <button type="button" className="home-btn skip-btn" onClick={onDone}>
          {t(lang, 'tutSkip')}
        </button>
      </div>

      <div className="play">
        {liveStage && (
          <div className="progress-background" aria-hidden="true">
            {tries}
          </div>
        )}
        {showScramble ? (
          <ScrambleWord
            secret={puzzle.holes[0].secret.word}
            ladder={scrambleLadder}
            startRank={puzzle.holes[0].start_rank}
            buttonLabel={t(lang, 'tutScrambleBtn')}
            onDone={scrambleDone}
          />
        ) : (
          <>
            <Phrase
              words={puzzle.words}
              holes={holes}
              puzzleHoles={puzzle.holes}
              hits={hits}
              onHitDone={removeHit}
            />
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
              <p className="hint">{feedback || ' '}</p>
            </div>
          </>
        )}
      </div>

      <div className="tray">
        {graduated ? (
          // No more talking: the score (unit named — lower is better reads itself)
          // and the way out, styled like the real solved screen's row.
          <div className="solved-actions in">
            <span className="solved-score">
              {tries} {t(lang, tries === 1 ? 'try' : 'tries')}
            </span>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus -- the round is over;
                its only action is the accessible default */}
            <button type="button" className="share-key" onClick={onDone} autoFocus>
              {t(lang, 'tutPlay')}
            </button>
          </div>
        ) : step.kind === 'scramble' ? null : vocabNeeded && vocabError ? (
          <LoadError message={t(lang, 'failedVocab')} lang={lang} onRetry={retryVocab} />
        ) : vocabNeeded && !vocab ? (
          <p className="status">{t(lang, 'loading')}</p>
        ) : (
          <Keyboard
            input={input}
            prefixSet={prefixSet}
            vocabSet={vocabSet}
            lang={lang}
            onType={appendChar}
            onBackspace={deleteChar}
            onSubmit={submit}
          />
        )}
      </div>

      {dimmed && <div className="tutorial-backdrop" />}
      {panel && (
        <div
          // Remount per moment so the transition and autoFocus re-fire each step.
          key={`${stageIndex}:${stepIndex}:${phase}:${missStreak >= NUDGE_AFTER_MISSES}`}
          className={`coach coach--${zoneOf(panel.anchor)}${panel.modal ? '' : ' coach--prompt'}`}
        >
          <p className="coach-text" aria-live="polite">
            {panel.copy}
          </p>
          {panel.modal && (
            <div className="coach-actions">
              {/* eslint-disable-next-line jsx-a11y/no-autofocus -- each step is a
                  modal moment; focusing its only action is the accessible default */}
              <button type="button" className="coach-btn" onClick={advance} autoFocus>
                {isVeryLast ? t(lang, 'tutPlay') : t(lang, 'tutNext')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
