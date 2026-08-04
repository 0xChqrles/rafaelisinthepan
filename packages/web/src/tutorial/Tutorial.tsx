import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import Phrase from '../components/Phrase';
import WordInput from '../components/WordInput';
import Keyboard from '../components/Keyboard';
import LoadError from '../components/LoadError';
import { LANE_COLORS } from '../components/RouteModal';
import ThemeCloud from './ThemeCloud';
import RoutesTeaser from './RoutesTeaser';
import TopBar from '../components/TopBar';
import { HIT_FADE_MS } from '../components/FloatingHit';
import { RANK_MAX_MS, rankTransitionDuration } from '../components/Hole';
import SkipIcon from '../assets/icons/skip.svg?react';
import { STAGGER_MS, FLOATING_HIT_INTRO_MS } from '../screens/Game';
import MixWord, { SCRAMBLE_MS } from './MixWord';
import CoachText, { richToPlain } from './CoachText';
import { buildPrefixSet, canExtend } from '../game/keyboard';
import useVocab from '../hooks/useVocab';
import { fold } from '@whippin/shared';
import type { HitState, Hole as PuzzleHole, RankEntry, RuntimeHole } from '@whippin/shared';
import { ariaExploreHole, t, srHoleResult, type UiKey } from '../i18n';
import { track } from '../analytics';
import { scriptFor } from './scripts';

// The onboarding tutorial (#51, re-arced by #155). Screen contract: EXPLANATIONS in the
// top box (typewritten, in-game word styling), INTERACTIONS at the bottom (the mix button,
// then the keyboard), the word in the middle. No NEXT, no SKIP button in the body (browser
// navigation is the exit), no flag (the language was already chosen to get here) — the flow
// advances by playing.
//
//   ONE board, concept first. The secret is SHOWN (blue). MIX scrambles it to its 1st
//   neighbor; MIX AGAIN and MIX EVEN MORE scramble to the 10th and to the START word (the
//   exponent ticking through every rank in between) — then the button gives way to the
//   keyboard and three gated guesses show distance (farther, no move), MISS, and improvement,
//   each rolling straight into the next prompt. Then the player types back to the secret with
//   the real vocabulary (free exploration; a nudge reveals the word after 3 straight MISSes).
//   Finding it ENDS the lesson on the one concept nothing else teaches: the word they found
//   is tappable, and the tap REPLACES it with its THEMES — one cloud of themed words at a
//   time, in the route colors the game's map speaks — while the coach names each; the close
//   is an abstract glimpse of the route map (RoutesTeaser) under the general principle, and
//   PLAY in the tray is the graduation. There is no score to show, so there is no screen
//   for it.
//
// Everything that reacts is the real components with the real timing constants; the scripts
// are data (./scripts/<lang>.ts) over a REAL generated neighborhood (a pruned #154 artifact),
// which is what gives the themes their real roads. Deliberately NOT Round: Round is
// fused to the persisted store, and a tutorial round must never touch `rounds` (only the
// `onboarded` flag changes, set by the caller via onDone).

// Gated-empty sets: every letter greys out, Enter greys out.
const NO_WORDS = new Set<string>();
const noop = () => {};

// Consecutive MISSes in the find step before the prompt swaps to the reminder.
const NUDGE_AFTER_MISSES = 3;

// Mix demo pacing. EVERY press is the same slot-machine letter-scramble (see MixWord,
// SCRAMBLE_MS); on the later presses the exponent ticks through the real intermediate ladder
// ranks (>= 9 per segment, guarded by scripts.test.ts) while the letters churn.
const MIX_SETTLE_MS = 500; // hold on a landing before the copy / next prompt

// The tutorial's ONE hole, at the board's start word — the same shape Game derives from a
// real puzzle, so every component it feeds behaves identically.
function freshHole(h: PuzzleHole): RuntimeHole[] {
  return [
    {
      pos: h.pos,
      secret: h.secret.slug,
      word: h.start.word,
      rank: h.start_rank,
      startRank: h.start_rank,
    },
  ];
}

// The header stays in place throughout: the flag (left) opens the language screen —
// the SAME navigation as everywhere else; because the open-tutorial state is
// transient store state, picking a language there lands back INTO the tutorial in
// that language — the centre reads "TUTORIAL", and the right control is a
// fast-forward that SKIPS the whole tutorial (`onDone`) — a header affordance, not a
// "close this box" icon, so it can't be mistaken for dismissing the explanation
// alone. `onDone` fires on both a natural finish (the map closing) and a skip.
export default function Tutorial({ lang, onDone }: { lang: string; onDone: () => void }) {
  const script = useMemo(() => scriptFor(lang), [lang]);
  const { puzzle } = script;
  const hole = puzzle.holes[0];
  const rankMap = puzzle.ranks[hole.secret.slug];

  const [stepIndex, setStepIndex] = useState(0);
  // idle (acting) -> feedback (choreography playing).
  const [phase, setPhase] = useState<'idle' | 'feedback'>('idle');

  const step = script.steps[stepIndex];

  // The scripted round's local state — the ephemeral twin of Round's persisted state.
  const [holes, setHoles] = useState<RuntimeHole[]>(() => freshHole(hole));
  const [hits, setHits] = useState<HitState[]>([]);
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

  // The find step types against the REAL vocabulary (loaded at mount, so it is warm long
  // before the free step — and already cached for the game right after).
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

  // Advance to the next step. The LAST step is the tap, which no guess can leave: only its
  // PLAY ends the tutorial.
  const advance = useCallback(() => {
    setPhase('idle');
    setStepIndex((i) => Math.min(i + 1, script.steps.length - 1));
  }, [script]);

  // Input gating. A gated guess step admits ONLY the expected word (the keyboard's
  // own prefix/vocab contract greys everything else); the find step uses the real sets.
  const gatedWord = step.kind === 'guess' && phase === 'idle' ? step.expect : null;
  const freeTyping = step.kind === 'find' && phase === 'idle';
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

  // The same guess loop as Game.submit, on local state and one hole. Gated guesses freeze
  // input through the choreography then roll into the next prompt; the find step keeps typing
  // open and only locks when the guess completes it.
  const playGuess = useCallback(
    (typed: string, lock: boolean) => {
      const current = holes[0];
      const entry = current.rank === 0 ? undefined : (rankMap[typed] as RankEntry | undefined);
      const fadeDelayMs = FLOATING_HIT_INTRO_MS;
      const id = (hitId.current += 1);
      setHits((prev) => [
        ...prev,
        entry != null
          ? { holeIndex: 0, value: entry.rank, id, startDelayMs: 0, fadeDelayMs }
          : { holeIndex: 0, value: 0, id, startDelayMs: 0, fadeDelayMs, miss: true },
      ]);

      const improves = entry != null && entry.rank < current.rank;
      if (improves) {
        const { word, rank } = entry;
        later(
          () => setHoles((prev) => prev.map((h) => (rank < h.rank ? { ...h, word, rank } : h))),
          fadeDelayMs,
        );
      }

      if (step.kind === 'find') setMissStreak((s) => (entry == null ? s + 1 : 0));

      const solves = entry?.rank === 0;
      say(
        solves
          ? [srHoleResult(lang, 1, 0), t(lang, 'srSolvedAll')].join(', ')
          : srHoleResult(lang, 1, entry ? entry.rank : null),
      );

      // A swapped Hole holds its exponent tween (RANK_MAX_MS) then settles the letters
      // over SCRAMBLE_MS (see Hole/useScramble), so its word finishes last. Wait for the
      // slower of that, the rank tween, and the floating hit's fade before advancing.
      const settleMs =
        fadeDelayMs +
        Math.max(
          HIT_FADE_MS,
          improves ? rankTransitionDuration(current.rank, entry.rank) : 0,
          improves ? RANK_MAX_MS + SCRAMBLE_MS : 0,
        ) +
        250;
      if (lock) {
        // The feedback taught the lesson — straight to the next prompt.
        setPhase('feedback');
        later(advance, settleMs);
      } else if (solves) {
        // Finding it needs no comment either: it rolls into the tap that ends the tutorial.
        setPhase('feedback');
        later(advance, settleMs + 350);
      }
    },
    [holes, rankMap, step, lang, say, later, advance],
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
      // The find step behaves exactly like the game: existence is decided by the real
      // vocabulary; invalid words shake + message and reach no hole.
      if (!vocab || !vocab.vocabSet.has(typed)) {
        setInvalidAt(Date.now());
        setFeedback(t(lang, 'notAWord'));
        say(t(lang, 'notAWord'));
        return;
      }
      setInput('');
      setFeedback(null);
      playGuess(typed, false);
    },
    [gatedWord, freeTyping, vocab, lang, say, playGuess],
  );

  // The mix ladder: the board's own real rank entries up to the start word, rank ascending —
  // the demo's word path. ONE entry per GROUP: a real map keys every inflection of a group to
  // the same entry (#104), and a ladder that walked them all would tick the same rank several
  // times over and show the same word twice.
  const ladder = useMemo<RankEntry[]>(() => {
    const byRank = new Map<number, RankEntry>();
    for (const entry of Object.values(rankMap)) {
      if (entry.rank > 0 && entry.rank <= hole.start_rank && !byRank.has(entry.rank)) {
        byRank.set(entry.rank, entry);
      }
    }
    return [...byRank.values()].sort((a, b) => a.rank - b.rank);
  }, [rankMap, hole]);

  // One press of the mix button: MixWord scrambles the letters into the stop's word
  // (and, from the second press on, ticks the exponent through the intermediate ranks);
  // we just set the landing entry and wait out the animation. The last stop lands on the
  // start word, then the keyboard takes the button's place.
  const pressMix = useCallback(() => {
    if (step.kind !== 'mix' || mixBusy) return;
    const stop = step.stops[mixStop];
    if (!stop) return;
    const targetIdx = ladder.findIndex((e) => e.rank === stop.rank);
    if (targetIdx < 0) return;
    setMixBusy(true);
    const lastStop = mixStop === step.stops.length - 1;
    setMixAt(targetIdx);
    later(() => {
      if (stop.copyKey) setMixCopy(stop.copyKey);
      setMixStop((s) => s + 1);
      setMixBusy(false);
      if (lastStop) advance();
    }, SCRAMBLE_MS + MIX_SETTLE_MS);
  }, [step, mixBusy, mixStop, ladder, later, advance]);

  // --- the ending (#155): the found word gives way to its THEMES, one cloud at a time ---
  // The button wraps the hole for the WHOLE tutorial (unwrapping it mid-round would remount
  // the word while its scramble is running, exactly as in the game); only the tap STEP
  // enables it. `quiet` lets the hole run its ambient wave then — the affordance for the tap
  // the copy is asking for. The tap swaps the play area from the word to a CLOUD of one
  // theme's words in that route's color (findings 2026-08-04, superseding both the inline
  // route line and its one-road-at-a-time variant: the line was too much information at
  // once); NEXT THEME swaps clouds — never two on screen — and after the last one the close
  // shows the abstract routes teaser (the themes' colored lines, a glimpse of the game's
  // map) while the coach states the general principle, and PLAY in the tray is the way out.
  const [themesOpen, setThemesOpen] = useState(false);
  const [themeStage, setThemeStage] = useState(0);
  const openThemes = useCallback(() => {
    setThemeStage(0);
    setThemesOpen(true);
  }, []);
  const nextTheme = useCallback(() => setThemeStage((k) => k + 1), []);
  const finish = useCallback(() => {
    track('tutorial', { action: 'finish' });
    onDone();
  }, [onDone]);
  // Every theme named -> the close. Reading the count off the MAP (not the script) keeps the
  // stages honest to the board actually shipped; scripts.test.ts pins the script's copy list
  // to the same count.
  const themeCount = useMemo(() => {
    const roads = new Set<number>();
    for (const entry of Object.values(rankMap)) {
      if (entry.road !== undefined) roads.add(entry.road);
    }
    return roads.size;
  }, [rankMap]);
  const themesDone = themeStage >= themeCount;

  // The keyboard leaves the way it does in a solved round: it drops out of the tray once
  // there is nothing left to type. No deadline behind the `animationend` (unlike Game's):
  // nothing waits on it — the keyboard is already off screen and out of reach when it fires,
  // so a lost event costs an unmount, not the screen.
  const tapping = step.kind === 'tap';
  const [kbGone, setKbGone] = useState(false);

  // The nudge speaks the input device's own verb — "tap" only where the pointer actually
  // taps, "click" everywhere else (the same coarse-pointer test the streak celebration's
  // TAP/CLICK ANYWHERE hint uses; findings 2026-08-03).
  const coarse = useMemo(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches,
    [],
  );

  // The explanation currently in the top box. Mix stop copy overrides the step's standing
  // copy; once the clouds replace the word, the theme on screen names the box.
  let coachKey: UiKey | null = null;
  if (step.kind === 'mix') coachKey = mixCopy ?? step.copyKey;
  else if (step.kind === 'guess') coachKey = step.copyKey;
  else if (step.kind === 'find') {
    coachKey = missStreak >= NUDGE_AFTER_MISSES ? step.nudgeKey : step.copyKey;
  } else if (step.kind === 'tap') {
    coachKey = !themesOpen
      ? coarse
        ? step.tapCopyKey
        : step.clickCopyKey
      : themesDone
        ? step.closeCopyKey
        : step.themeCopyKeys[Math.min(themeStage, step.themeCopyKeys.length - 1)];
  }
  const coachCopy = coachKey ? t(lang, coachKey) : null;

  // Announce each new explanation once, in plain text (the visible typewriter is
  // aria-hidden — a live region would read every keystroke).
  useEffect(() => {
    if (coachCopy) say(richToPlain(coachCopy));
  }, [coachCopy, say]);

  const mixLabel = step.kind === 'mix' ? step.stops[Math.min(mixStop, step.stops.length - 1)] : null;
  const exploreLabels = useMemo(() => [ariaExploreHole(lang, 1)], [lang]);

  return (
    // tutorial--word: the board is deliberately CLEAN — explanation on top, one big centered
    // word in the middle, the interaction at the bottom.
    <div className="game tutorial tutorial--word">
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>

      {/* The floating header: "TUTORIAL" in the top-left status chip — no progress
          counter here, the tutorial keeps its chrome minimal — and flag + a
          fast-forward that SKIPS the tutorial on the right. */}
      <TopBar
        lang={lang}
        left={<span className="topbar-title">{t(lang, 'inviteTutorial')}</span>}
        right={
          <button
            type="button"
            className="home-btn topbar-skip"
            aria-label={t(lang, 'ariaSkipTutorial')}
            onClick={() => {
              track('tutorial', { action: 'skip' });
              onDone();
            }}
          >
            <SkipIcon className="pixel-icon" aria-hidden />
          </button>
        }
      />

      {/* The top box: the current explanation, typewritten. Same background as the
          app, surface border — a dialog, not a modal. While a theme cloud is on screen its
          NAME in the copy wears the cloud's color ([[t:]] -> --coach-theme-c). */}
      {coachCopy && (
        <div
          className="coach"
          style={
            themesOpen && !themesDone
              ? ({ '--coach-theme-c': LANE_COLORS[themeStage % LANE_COLORS.length] } as CSSProperties)
              : undefined
          }
        >
          <CoachText key={coachCopy} copy={coachCopy} />
        </div>
      )}

      <div className="play">
        {step.kind === 'mix' ? (
          <>
            <MixWord
              secret={hole.secret.word}
              entry={mixAt >= 0 ? ladder[mixAt] : null}
              startRank={hole.start_rank}
              ladder={ladder}
            />
            {/* Hidden input slot: the REAL prompt structure, invisible and inert,
                reserves its natural height so the prompt appearing on the next step
                never shifts the word (no hardcoded min-height, 2026-07-25). */}
            <div className="input-area retired" aria-hidden="true">
              <WordInput
                value=""
                history={[]}
                onType={noop}
                onBackspace={noop}
                onSubmit={noop}
                onReplace={noop}
                invalidSignal={0}
                active={false}
              />
              <p className="hint"> </p>
            </div>
          </>
        ) : themesOpen && themesDone ? (
          // The close: a glimpse of the route map every word offers — the themes' colored
          // lines with a couple of their words riding them — under the general principle.
          <RoutesTeaser
            map={rankMap}
            lanes={themeCount}
            startRank={hole.start_rank}
            lang={lang}
          />
        ) : themesOpen ? (
          // The word gave way to one of its THEMES: a cloud of that theme's words in its
          // route color. One at a time.
          <ThemeCloud map={rankMap} road={themeStage} startRank={hole.start_rank} />
        ) : (
          <>
            <Phrase
              words={puzzle.words}
              holes={holes}
              puzzleHoles={puzzle.holes}
              hits={hits}
              onHitDone={removeHit}
              exploreLabels={exploreLabels}
              exploreDisabled={!tapping}
              onExplore={openThemes}
              quiet={tapping && !themesOpen}
              // The lesson ends ON the solved word: its wave is the affordance for the tap
              // the coach is asking for, so the game's solved-holes-never-wave rule is
              // inverted here and only here (see Hole.waveSolved). Inert outside the tap
              // step, where `quiet` is false anyway.
              waveSolved
            />
            {/* Once there is nothing left to type the prompt retires in place, the same way
                the game's does on the solving submit: still laid out, so the word does not
                move, but invisible and inert. */}
            <div className={`input-area${tapping ? ' retired' : ''}`} aria-hidden={tapping || undefined}>
              <WordInput
                value={input}
                history={[]}
                onType={appendChar}
                onBackspace={deleteChar}
                onSubmit={submit}
                onReplace={replaceInput}
                invalidSignal={invalidAt}
                // The tap step has nothing left to submit.
                active={!tapping}
              />
              <p className="hint">{feedback || ' '}</p>
            </div>
          </>
        )}
      </div>

      {/* The bottom is for INTERACTIONS: the mix button, then the keyboard — which drops
          away for the ending, leaving the word alone with the invitation to tap it. */}
      <div className={`tray${tapping && !kbGone ? ' kb-leaving' : ''}`}>
        {step.kind === 'mix' ? (
          mixLabel && (
            <button type="button" className="mix-btn" onClick={pressMix} disabled={mixBusy}>
              {t(lang, mixLabel.labelKey)}
            </button>
          )
        ) : vocabError ? (
          <LoadError message={t(lang, 'failedVocab')} lang={lang} onRetry={retryVocab} />
        ) : !vocab ? (
          <p className="status">{t(lang, 'loading')}</p>
        ) : themesOpen ? (
          // The theme stepper, then the graduation: NEXT THEME swaps the clouds one at a
          // time, and once every theme has spoken the same full-width interaction the mix
          // button opened the lesson with closes it — PLAY.
          <button type="button" className="mix-btn" onClick={themesDone ? finish : nextTheme}>
            {t(lang, themesDone ? 'tutPlay' : 'tutNextTheme')}
          </button>
        ) : kbGone ? null : (
          <div
            className={`kb-exit${tapping ? ' leaving' : ''}`}
            onAnimationEnd={(e) => {
              // Child animations (key shakes) bubble here too: only the wrapper's own
              // kb-drop end unmounts it.
              if (tapping && e.target === e.currentTarget) setKbGone(true);
            }}
          >
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
        )}
      </div>
    </div>
  );
}
