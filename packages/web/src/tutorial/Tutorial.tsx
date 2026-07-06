import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Phrase from '../components/Phrase';
import ProgressBar from '../components/ProgressBar';
import WordInput from '../components/WordInput';
import Keyboard from '../components/Keyboard';
import LoadError from '../components/LoadError';
import SolvedScreen from '../components/SolvedScreen';
import { HIT_FADE_MS } from '../components/FloatingHit';
import { STAGGER_MS, FLOATING_HIT_INTRO_MS, WORD_BLINK_MS } from '../screens/Game';
import MixWord, { SCRAMBLE_MS } from './MixWord';
import CoachText, { richToPlain } from './CoachText';
import { computeProgress } from '../game/scoring';
import { progressTrajectory } from '../game/share';
import { buildPrefixSet, canExtend } from '../game/keyboard';
import useVocab from '../hooks/useVocab';
import { fold } from '@whippin/shared';
import type { HitState, RankEntry, RuntimeHole } from '@whippin/shared';
import { t, srHoleResult, type UiKey } from '../i18n';
import { scriptFor } from './scripts';
import { isPadWord, type TutorialStage } from './script';

// The onboarding tutorial (#51). Screen contract: EXPLANATIONS in the top box
// (typewritten, in-game word styling), INTERACTIONS at the bottom (the mix button,
// then the keyboard), the word/sentence in the middle. No modals, no NEXT, no SKIP
// (browser navigation is the exit), no flag (the language was already chosen to get
// here) — the flow advances by playing.
//
//   Stage 1 — one word, concept first. The secret is SHOWN (blue). MIX shakes it to
//   its 1st neighbor; MIX AGAIN fast-rolls to the 10th; MIX EVEN MORE rolls to the
//   100th — where the button gives way to the keyboard and three gated guesses show
//   distance (farther, no move), MISS, and improvement, each rolling straight into
//   the next prompt. Then the player types back to the secret with the real
//   vocabulary (free exploration; a nudge reveals the word after 3 straight MISSes).
//
//   Stage 2 — an easy two-hole sentence played UNGUIDED (real vocabulary, tries
//   counted, progress bar live). Solving it ends the tutorial wordlessly: the tray
//   swaps to the score + PLAY TODAY'S PUZZLE.
//
// Everything that reacts is the real components with the real timing constants; the
// scripts are data (./scripts/<lang>.ts). Deliberately NOT Round: Round is fused to
// the persisted store, and a tutorial round must never touch `rounds` (only the
// `onboarded` flag changes, set by the caller via onDone).

// Gated-empty sets: every letter greys out, Enter greys out.
const NO_WORDS = new Set<string>();

// Consecutive MISSes in the find step before the prompt swaps to the reminder.
const NUDGE_AFTER_MISSES = 3;

// Mix demo pacing. The first stop letter-scrambles into the 1st neighbor (see
// MixWord); later stops roll through every ladder word with a DECELERATING cadence —
// fast blur first, then ticking slower and slower into the landing, like a slot
// wheel settling — instead of a constant flicker that just stops.
const MIX_LAND_MS = 240; // the roll's final (longest) interval
const MIX_MIN_TICK_MS = 45; // the roll's fastest flashes
const MIX_SETTLE_MS = 500; // hold on a landing before the copy / next prompt

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
  // idle (acting) -> feedback (choreography playing) -> after (play step only: the
  // sentence is solved, the tray shows the score + exit).
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

  // Mix demo state: which ladder entry is showing (-1 = the untouched blue secret),
  // which stop the next press goes to, the stop copy currently explaining, and a
  // busy flag while an animation runs.
  const [mixAt, setMixAt] = useState(-1);
  const [mixStop, setMixStop] = useState(0);
  const [mixCopy, setMixCopy] = useState<UiKey | null>(null);
  const [mixBusy, setMixBusy] = useState(false);

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

  // The same guess loop as Game.submit, on local state. Gated guesses freeze input
  // through the choreography then roll into the next prompt; free steps keep typing
  // open and only lock when the guess completes the step.
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
        // The feedback taught the lesson — straight to the next prompt.
        setPhase('feedback');
        later(advance, settleMs);
      } else if (solvesAll) {
        setPhase('feedback');
        // Solving needs no comment either: find rolls into the sentence stage; play
        // is the graduation — the tray swaps to the score + exit ('after').
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

  // The mix ladder: the stage's own real rank entries up to the start word, rank
  // ascending — the demo's word path.
  const ladder = useMemo<RankEntry[]>(() => {
    const hole = puzzle.holes[0];
    return Object.values(puzzle.ranks[hole.secret.slug])
      .filter((e) => !isPadWord(e.word) && e.rank > 0 && e.rank <= hole.start_rank)
      .sort((a, b) => a.rank - b.rank);
  }, [puzzle]);

  // One press of the mix button: the first stop letter-scrambles into the 1st
  // neighbor (MixWord animates it; we just wait out SCRAMBLE_MS); later stops roll
  // through every ladder word up to the stop on a decelerating cadence (cumulative
  // time ∝ progress², so intervals grow linearly — a slot wheel settling). The last
  // stop lands on the start word, then the keyboard takes the button's place.
  const pressMix = useCallback(() => {
    if (step.kind !== 'mix' || mixBusy) return;
    const stop = step.stops[mixStop];
    if (!stop) return;
    const targetIdx = ladder.findIndex((e) => e.rank === stop.rank);
    if (targetIdx < 0) return;
    setMixBusy(true);
    const lastStop = mixStop === step.stops.length - 1;
    const finish = () => {
      if (stop.copyKey) setMixCopy(stop.copyKey);
      setMixStop((s) => s + 1);
      setMixBusy(false);
      if (lastStop) advance();
    };
    if (mixAt < 0) {
      setMixAt(targetIdx); // MixWord scrambles the letters into place
      later(finish, SCRAMBLE_MS + MIX_SETTLE_MS);
      return;
    }
    const steps = targetIdx - mixAt;
    // Deceleration: interval k = D·(k² − (k−1)²)/steps², sized so the LAST interval
    // is MIX_LAND_MS; the earliest (shortest) ones clamp to MIX_MIN_TICK_MS.
    const d = (MIX_LAND_MS * steps * steps) / (2 * steps - 1);
    let prevAt = 0;
    let at = 0;
    for (let k = 1; k <= steps; k += 1) {
      const t = d * (k / steps) ** 2;
      at += Math.max(MIX_MIN_TICK_MS, t - prevAt);
      prevAt = t;
      const idx = mixAt + k;
      later(() => setMixAt(idx), at);
    }
    later(finish, at + MIX_SETTLE_MS);
  }, [step, mixBusy, mixStop, mixAt, ladder, later, advance]);

  // The explanation currently in the top box (hidden once graduated — the score
  // speaks last). Mix stop copy overrides the step's standing copy.
  const graduated = step.kind === 'play' && phase === 'after';
  let coachKey: UiKey | null = null;
  if (step.kind === 'mix') coachKey = mixCopy ?? step.copyKey;
  else if (step.kind === 'guess' || step.kind === 'play') coachKey = step.copyKey;
  else if (step.kind === 'find') {
    coachKey = missStreak >= NUDGE_AFTER_MISSES ? step.nudgeKey : step.copyKey;
  }
  const coachCopy = !graduated && coachKey ? t(lang, coachKey) : null;

  // Announce each new explanation once, in plain text (the visible typewriter is
  // aria-hidden — a live region would read every keystroke).
  useEffect(() => {
    if (coachCopy) say(richToPlain(coachCopy));
  }, [coachCopy, say]);

  const vocabNeeded = step.kind === 'find' || step.kind === 'play';
  const mixLabel = step.kind === 'mix' ? step.stops[Math.min(mixStop, step.stops.length - 1)] : null;

  return (
    // tutorial--word: the concept stage is deliberately CLEAN — explanation on top,
    // one big centered word in the middle, the interaction at the bottom.
    <div className={`game tutorial${liveStage ? '' : ' tutorial--word'}`}>
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>

      {/* No flag (the language was already chosen to get here), no SKIP (browser
          navigation is the exit): the HUD exists only on the sentence stage, and
          only for the progress bar. */}
      {liveStage && (
        <div className="hud">
          <ProgressBar value={progress} />
        </div>
      )}

      {/* The top box: the current explanation, typewritten. Same background as the
          app, surface border — a dialog, not a modal. */}
      {coachCopy && (
        <div className="coach">
          <CoachText key={coachCopy} copy={coachCopy} />
        </div>
      )}

      <div className="play">
        {liveStage && (
          <div className="progress-background" aria-hidden="true">
            {tries}
          </div>
        )}
        {step.kind === 'mix' ? (
          <>
            <MixWord
              secret={puzzle.holes[0].secret.word}
              entry={mixAt >= 0 ? ladder[mixAt] : null}
              startRank={puzzle.holes[0].start_rank}
            />
            {/* Empty input slot: reserves the row so the prompt appearing on the
                next step never shifts the word. */}
            <div className="input-area" aria-hidden="true" />
          </>
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

      {/* The bottom is for INTERACTIONS: the mix button, then the keyboard, and at
          the very end the REAL solved layout — heat squares + score reveal, with
          PLAY standing in SHARE's slot — so graduation looks exactly like tomorrow's
          win will. */}
      <div className="tray">
        {graduated ? (
          <SolvedScreen
            guessCount={tries}
            trajectory={progressTrajectory(freshHoles(stage), puzzle.ranks, [...triedRef.current])}
            dayNumber={null}
            lang={lang}
            action={{ label: t(lang, 'tutPlay'), onClick: onDone }}
          />
        ) : step.kind === 'mix' ? (
          mixLabel && (
            <button type="button" className="mix-btn" onClick={pressMix} disabled={mixBusy}>
              {t(lang, mixLabel.labelKey)}
            </button>
          )
        ) : vocabNeeded && vocabError ? (
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
    </div>
  );
}
