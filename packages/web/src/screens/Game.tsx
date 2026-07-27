import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { computeProgress, guessKey } from '../game/scoring';
import { replayRun, type RunReplay } from '../game/share';
import { canExtend } from '../game/keyboard';
import useVocab from '../hooks/useVocab';
import useToday from '../hooks/useToday';
import { useGameStore, roundKeyForDay, holesMatchPuzzle } from '../state/gameStore';
import Phrase from '../components/Phrase';
import CellDigits from '../components/CellDigits';
import ProgressCounter from '../components/ProgressCounter';
import WordInput from '../components/WordInput';
import Keyboard from '../components/Keyboard';
import SolvedScreen from '../components/SolvedScreen';
import StandingsLineup from '../components/StandingsLineup';
import LazyStreakDialog, { preloadStreakDialog } from '../components/LazyStreakDialog';
import SolvedCaption from '../components/SolvedCaption';
import RouteModal from '../components/RouteModal';
import LoadError from '../components/LoadError';
import { buildRoute, hasRoute, shouldAutoOpenRoute } from '../game/route';
import { t, ariaExploreHole, srHoleResult, srModelAhead, srModelLead } from '../i18n';
import { lineupModel, lineupEvents, hasDisplayEntries, displayEntries } from '../game/benchmark';
import { track } from '../analytics';
import { fold } from '@whippin/shared';
import type {
  BenchmarkResults,
  HitState,
  Hole,
  Puzzle,
  RankEntry,
  RankMap,
  RuntimeHole,
  Source,
} from '@whippin/shared';

// Feedback shown under the input. Only INVALID words use it now (red shake +
// "does not exist"); a valid-but-too-far guess gives per-hole "MISS" feedback
// on the holes instead, so it needs no under-input message.
type Feedback = { text: string };

// When a guess impacts several holes, effect starts are staggered this many ms apart.
// Floating distance/MISS feedback uses the same start stagger, then fades as one batch.
// Exported: the onboarding Tutorial (#51) replays the same choreography with the same
// numbers, so the scripted round feels exactly like the real one.
export const STAGGER_MS = 200;
export const FLOATING_HIT_INTRO_MS = 320;

const STREAK_AFTER_WORDS_MS = 300;

// Deadlines for the two solved-exit beats that hand the tray back (see their effects):
// generous multiples of the real durations, so they only ever fire if the DOM signal
// itself was lost.
const KB_EXIT_FALLBACK_MS = 1_200;
const LINEUP_EXIT_FALLBACK_MS = 3_000;

// The beat between the sentence coming to rest and a first-ever solved word's map opening
// itself (#129): long enough for the resolved word to land as its own moment, short enough to
// read as its consequence. Never a guessed timeout — it is measured from the holes' own settle
// reports (see the effect, which waits for the LAST of them).
const AUTO_ROUTE_AFTER_SOLVE_MS = 350;

// Wrapper: drives the single puzzle. Loads the language's fixed vocabulary
// (existence set + keyboard prefix set) before playing — existence is decided by it,
// not by ranks. The header lives ABOVE this (GameRoute), so Game renders only the game
// body (progress-bar row + play + tray) under the fixed header.
export default function Game({
  puzzle,
  dayNumber,
  isActiveDay = true,
  deferResultsAnimation = false,
}: {
  puzzle: Puzzle;
  dayNumber: number;
  // Whether this is the client's active day (false when replaying an archive day, #55):
  // gates the fresh-solve streak celebration and tags solve analytics as archive/live.
  isActiveDay?: boolean;
  // The dev streak preview lives above Game in App, so it supplies the same animation gate
  // as the real in-round dialog without coupling the preview to persisted round state.
  deferResultsAnimation?: boolean;
}) {
  const { vocab, error, retry } = useVocab(puzzle.lang);

  if (error !== null) {
    return <LoadError message={t(puzzle.lang, 'failedVocab')} lang={puzzle.lang} onRetry={retry} />;
  }
  if (!vocab) return <p className="status">{t(puzzle.lang, 'loading')}</p>;

  return (
    <Round
      words={puzzle.words}
      puzzleHoles={puzzle.holes}
      ranks={puzzle.ranks}
      source={puzzle.source}
      benchmark={puzzle.benchmark}
      vocabSet={vocab.vocabSet}
      prefixSet={vocab.prefixSet}
      lang={puzzle.lang}
      dayNumber={dayNumber}
      isActiveDay={isActiveDay}
      deferResultsAnimation={deferResultsAnimation}
    />
  );
}

// One round: a sentence to discover. Ends when all holes are solved
// (progress reaches 100%).
function Round({
  words,
  puzzleHoles,
  ranks,
  source,
  benchmark,
  vocabSet,
  prefixSet,
  lang,
  dayNumber,
  isActiveDay,
  deferResultsAnimation,
}: {
  words: string[];
  puzzleHoles: Hole[];
  ranks: RankMap;
  source?: Source;
  benchmark?: BenchmarkResults;
  vocabSet: Set<string>;
  prefixSet: Set<string>;
  lang: string;
  dayNumber: number;
  isActiveDay: boolean;
  deferResultsAnimation: boolean;
}) {
  // Fresh per-hole state derived from the puzzle. Used until the persisted store
  // reconciles to this round, and as the reset state on a new day/language.
  const freshHoles = useMemo<RuntimeHole[]>(
    () =>
      puzzleHoles.map((h) => ({
        pos: h.pos,
        secret: h.secret.slug,
        word: h.start.word,
        rank: h.start_rank,
        startRank: h.start_rank,
      })),
    [puzzleHoles],
  );

  // Identity of this round: the server day + language.
  const roundKey = useMemo(() => roundKeyForDay(dayNumber, lang), [dayNumber, lang]);

  const ensureRound = useGameStore((s) => s.ensureRound);
  const recordGuess = useGameStore((s) => s.recordGuess);
  const improveHole = useGameStore((s) => s.improveHole);
  const syncProgress = useGameStore((s) => s.syncProgress);
  const recordSolve = useGameStore((s) => s.recordSolve);
  // Has this player ever opened a route map? Device-lifetime and global (#129) — it gates
  // the one-time self-demonstration below.
  const routeSeen = useGameStore((s) => s.routeSeen);
  const markRouteSeen = useGameStore((s) => s.markRouteSeen);

  // The client's active game day (local, DST-correct) — the streak's reference point. May
  // be dayNumber + 1 when an in-flight round is finished just past the 22:00 flip; the
  // store's recordSolve resolves that flip-edge case (and refuses archive replays).
  const todayDayNumber = useToday();

  // Reconcile before paint: a matching key rehydrates the stored progress, a new key
  // (new day OR new language) resets to freshHoles. useLayoutEffect commits the reset
  // before the browser paints, so a stale day's holes never flash.
  useLayoutEffect(() => {
    ensureRound(roundKey, freshHoles);
  }, [ensureRound, roundKey, freshHoles]);

  // Persisted round state for THIS round, read straight out of the keyed map. Use it
  // only when its holes still match THIS puzzle: a re-published sentence keeps the
  // (day, lang) key but changes the holes, and those stale holes carry secrets absent
  // from `ranks` (scoring would crash). On that frame — as on the pre-reconcile frame
  // before ensureRound resets the store — fall back to freshHoles / zero.
  const round = useGameStore((s) => s.rounds[roundKey]);
  const live = round && holesMatchPuzzle(round.holes, freshHoles) ? round : undefined;
  const holes = live ? live.holes : freshHoles;
  // Score = number of unique tries. A try is a submitted word that exists in the
  // vocabulary, including misses; repeated folded guesses and non-existent words are
  // not counted (deduping happens in the store's recordGuess).
  const guessCount = live ? live.guessCount : 0;
  // Prompt history for Up/Down recall = this round's unique valid guesses in order.
  // Sourced from the persisted `tried` list, so recall survives a reload (per day+lang).
  const history = live ? live.tried : [];

  // Hole owns the actual word-replacement animation, so it also owns the reliable finish
  // signal. Keep every resolved hole reported for this round; the round-key dependency on
  // the callback makes already-resolved rehydrated holes report again after navigation.
  const [resolvedHoleIndices, setResolvedHoleIndices] = useState<Set<number>>(() => new Set());
  useLayoutEffect(() => {
    setResolvedHoleIndices(new Set());
  }, [roundKey]);
  const markHoleResolved = useCallback((index: number) => {
    setResolvedHoleIndices((current) => {
      if (current.has(index)) return current;
      const next = new Set(current);
      next.add(index);
      return next;
    });
  }, [roundKey]);

  const [input, setInput] = useState<string>('');
  // A solving submit closes the prompt immediately, on the same render that launches
  // the final floating hits. The actual hole/store updates still finish on their existing
  // delayed choreography; this flag only owns the prompt's leftward fade and input lock.
  const [promptExiting, setPromptExiting] = useState(false);
  // One transient floating indicator per impacted hole: a distance number when
  // warm, or "MISS" when too far. An improving hole shows the distance too; its
  // exponent drops as the number fades, then the old word scrambles out and the
  // closer word takes its place (the staging lives in Hole). Each carries a unique
  // id so it animates and clears independently. These are ephemeral UI, not persisted.
  const [hits, setHits] = useState<HitState[]>([]);
  const [invalidAt, setInvalidAt] = useState<number>(0); // timestamp signal -> input shake
  const [feedback, setFeedback] = useState<Feedback | null>(null); // message under the input
  const hitId = useRef<number>(0); // monotonic id source for floating hits
  const pendingTimers = useRef<number[]>([]); // deferred rank/word updates (fire as the hit fades)

  // Screen-reader mirror of the visual guess feedback (floating numbers / "MISS" /
  // shakes are invisible to assistive tech): each submit composes one sentence into a
  // polite live region. The alternating zero-width suffix forces a DOM change even when
  // two consecutive guesses produce the identical text, so it is re-announced.
  const [announce, setAnnounce] = useState<string>('');
  const announceFlip = useRef<boolean>(false);
  const say = useCallback((text: string) => {
    announceFlip.current = !announceFlip.current;
    setAnnounce(text + (announceFlip.current ? '' : '​'));
  }, []);

  // Clear any pending staggered effects when the round unmounts.
  useEffect(
    () => () => {
      pendingTimers.current.forEach(clearTimeout);
    },
    [],
  );

  const solved = holes.every((h) => h.rank === 0); // sentence discovered -> round over
  const allWordsResolved = solved && resolvedHoleIndices.size === holes.length;
  // Whether a lineup is on screen at all — a puzzle with no renderable opponents must
  // not leave the solved swap waiting on a teleport-out that will never play (#110).
  const hasLineup = hasDisplayEntries(benchmark);

  // The celebration is deliberately code-split out of startup. Warm its chunk only while
  // an eligible unsolved daily round is idle; if a player solves before idle fires, the
  // just-solved transition below starts the same preload immediately. Both scheduling paths
  // are cleaned up with the round, and a speculative load failure remains retryable.
  useEffect(() => {
    if (solved || !isActiveDay) return undefined;
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(() => preloadStreakDialog(), { timeout: 4_000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(() => preloadStreakDialog(), 1_500);
    return () => window.clearTimeout(id);
  }, [dayNumber, isActiveDay, roundKey, solved]);

  // Reconstruction progress (0–100): how much of the sentence is rebuilt. Drives the
  // WIDTH of the top progress bar. Distinct from the guess-count performance number.
  const progress = useMemo<number>(() => computeProgress(holes, ranks), [holes, ranks]);

  // This round replayed: the per-guess reconstruction-% trajectory (the run ruler's cells,
  // and what the share token carries) plus the solve moments (its ticks), from ONE walk of
  // the ordered valid guesses. Derived from the persisted `tried` list, so it survives a
  // reload just like the score.
  const { trajectory, solvedAt } = useMemo<RunReplay>(
    () => replayRun(freshHoles, ranks, history),
    [freshHoles, ranks, history],
  );

  // Each display opponent's run, replayed the same way: the leaderboard shows every
  // entrant's whole run as a ruler. Run words are stored as typed (accents kept) — fold
  // before lookup.
  const runReplays = useMemo<Map<string, RunReplay> | undefined>(
    () =>
      benchmark &&
      new Map(
        displayEntries(benchmark).map(({ entry }) => [
          entry.model,
          replayRun(
            freshHoles,
            ranks,
            entry.run.map((w) => fold(w)),
          ),
        ]),
      ),
    [benchmark, freshHoles, ranks],
  );

  // Gate the solved presentation on every Hole reporting its final displayed secret. The
  // playing UI stays up through the real animationend events, so slow/throttled frames and
  // a multi-hole final guess cannot let the streak cover words that are still resolving.
  // An already-solved round on load still reveals immediately.
  const [showResults, setShowResults] = useState<boolean>(solved);
  // The results component also mounts behind the streak screen. Fresh solves keep it at
  // frame zero until the source finishes; rehydrated solves start at the final frame.
  // A dev streak preview deliberately opts a rehydrated result back into the choreography.
  const [animateResults, setAnimateResults] = useState<boolean>(
    () => solved && deferResultsAnimation,
  );
  // Player progression gets a separate, one-time celebration. This is deliberately
  // transient rather than persisted: only the live unsolved -> solved transition may open
  // it, so refreshing or revisiting an already-solved round never interrupts the player.
  const [showStreakDialog, setShowStreakDialog] = useState(false);
  const [streakAdvanced, setStreakAdvanced] = useState(false);
  const [awaitingWordAnimations, setAwaitingWordAnimations] = useState(false);
  // Sentence metadata is its own reveal beat between player progression and the
  // sentence-specific metrics. Results may mount behind the streak, but their timers stay
  // frozen until the source typewriter explicitly reports that it has finished.
  const [sourceRevealStarted, setSourceRevealStarted] = useState(solved);
  const [sourceRevealComplete, setSourceRevealComplete] = useState(solved);
  // Solved exit choreography (#110, decided 2026-07-24): a LIVE solve doesn't swap the
  // tray instantly — the keyboard slides down out of it (kb-drop) while the lineup
  // characters teleport OUT one after another; only when the last is gone does the
  // leaderboard table rise into the tray. Rehydrated solves never set these: they mount
  // the final results directly, lineup already gone.
  const [keyboardLeaving, setKeyboardLeaving] = useState(false);
  const [lineupExiting, setLineupExiting] = useState(false);
  const [lineupGone, setLineupGone] = useState<boolean>(solved);
  const handleLineupExited = useCallback(() => {
    setLineupExiting(false);
    setLineupGone(true);
  }, []);
  // Both exit beats hand the tray back through a signal the DOM has to produce: the
  // keyboard's own `animationend`, and the lineup's tick clock reporting the last
  // character gone. Both are reliable today, but the tray renders NOTHING until they
  // arrive — a lost signal (a dropped animation, a suspended timer chain) would strand
  // the player on an empty tray with no way back. These deadlines make that unreachable:
  // they fire well after the real beats (kb-drop is 200ms; the teleport wave at most
  // ~1s) and are cancelled the moment the genuine signal lands.
  useEffect(() => {
    if (!keyboardLeaving) return undefined;
    const id = window.setTimeout(() => setKeyboardLeaving(false), KB_EXIT_FALLBACK_MS);
    return () => window.clearTimeout(id);
  }, [keyboardLeaving]);
  useEffect(() => {
    if (!lineupExiting) return undefined;
    const id = window.setTimeout(handleLineupExited, LINEUP_EXIT_FALLBACK_MS);
    return () => window.clearTimeout(id);
  }, [lineupExiting, handleLineupExited]);
  const prevSolved = useRef<boolean>(solved);
  useEffect(() => {
    const justSolved = solved && !prevSolved.current;
    prevSolved.current = solved;
    if (!solved) {
      setShowResults(false);
      setAnimateResults(false);
      setShowStreakDialog(false);
      setStreakAdvanced(false);
      setAwaitingWordAnimations(false);
      setKeyboardLeaving(false);
      setLineupExiting(false);
      setLineupGone(false);
      setPromptExiting(false);
      setSourceRevealStarted(false);
      setSourceRevealComplete(false);
      return undefined;
    }
    if (!justSolved) {
      setShowResults(true); // already solved on load (rehydrated) -> reveal without waiting
      setAnimateResults(deferResultsAnimation);
      setShowStreakDialog(false);
      setStreakAdvanced(false);
      setAwaitingWordAnimations(false);
      setLineupExiting(false);
      setLineupGone(true);
      setPromptExiting(false);
      setSourceRevealStarted(true);
      setSourceRevealComplete(true);
      return undefined;
    }
    // The one analytics beat for "did the player finish a puzzle": fired ONLY on the
    // play-solve transition (never on the rehydration branch above). `archive`
    // distinguishes a replayed past day ('yes', #55) from the live daily puzzle ('no').
    track('solve', { lang, tries: guessCount, day: dayNumber, archive: isActiveDay ? 'no' : 'yes' });
    // Streak (#56): only an ACTIVE-DAY solve counts — archive replays must not touch the
    // streak. The gate lives HERE, not in the store: recordSolve's activeDay-1 tolerance
    // (the genuine flip-edge — an undated tab finished just past 22:00) is
    // INDISTINGUISHABLE from deliberately opening /<lang>/<yesterday>, since both have
    // solvedDay === activeDay - 1. Only the caller knows which route this is — the undated
    // active route keeps isActiveDay true across the flip, a dated past route is false —
    // so the flip-edge still records while an archive-yesterday solve does not.
    const didAdvanceStreak = isActiveDay && recordSolve(lang, dayNumber, todayDayNumber);
    setAnimateResults(true);
    setStreakAdvanced(didAdvanceStreak);
    if (didAdvanceStreak) preloadStreakDialog();
    setSourceRevealStarted(false);
    setSourceRevealComplete(false);
    setAwaitingWordAnimations(true);
    return undefined;
  }, [solved]);

  useEffect(() => {
    if (!awaitingWordAnimations || !allWordsResolved) return;
    // The archive and rehydration branches never open this dialog. recordSolve has
    // already updated the solved-day set synchronously — and its freshness tolerance is
    // mirrored here (solvedDay >= activeDay - 1), so a tab left open 2+ days can't
    // celebrate a solve the store just refused to record.
    const willShowStreak =
      streakAdvanced && isActiveDay && dayNumber >= todayDayNumber - 1;
    if (!willShowStreak) {
      setShowResults(true);
      setKeyboardLeaving(true);
      if (hasLineup) setLineupExiting(true);
      else setLineupGone(true);
      setShowStreakDialog(false);
      setAwaitingWordAnimations(false);
      return;
    }

    // Let the player see the fully resolved sentence for one clean beat before the
    // full-screen progression celebration begins. The keyboard and the lineup stay put
    // underneath the modal — their exit beats (kb-drop + teleport-out) are VISIBLE
    // choreography, so they wait for the celebration's dismissal (decided 2026-07-24)
    // instead of playing covered.
    const timer = window.setTimeout(() => {
      setShowResults(true);
      setShowStreakDialog(true);
      setAwaitingWordAnimations(false);
    }, STREAK_AFTER_WORDS_MS);
    return () => window.clearTimeout(timer);
  }, [
    allWordsResolved,
    awaitingWordAnimations,
    dayNumber,
    hasLineup,
    isActiveDay,
    streakAdvanced,
    todayDayNumber,
  ]);

  const dismissStreakDialog = useCallback(() => {
    // StreakDialog calls this only AFTER its 200ms exit fade. On a streak solve it is
    // the exit choreography's start line (decided 2026-07-24): the keyboard drop and
    // the lineup teleport-out held still behind the modal so they play in view now.
    // The source typewriter does NOT start here — the sequence is STREAK -> exits ->
    // LEADERBOARD -> SOURCE, so the citation waits for the risen result stack
    // (handleResultsRisen below).
    setShowStreakDialog(false);
    setKeyboardLeaving(true);
    if (hasLineup) setLineupExiting(true);
    else setLineupGone(true);
  }, [hasLineup]);

  // The results' rise reporting done (SolvedScreen onRisen) is the source typewriter's
  // start line: SOURCE is the LAST beat of the solved sequence (decided 2026-07-24),
  // typing above a result stack already in place while its ruler colorizes beneath.
  const handleResultsRisen = useCallback(() => {
    setSourceRevealStarted(true);
  }, []);

  // NOTHING is focused when the solved screen lands (decided 2026-07-27, dropping the focus
  // the streak's dismissal used to hand to SHARE). The celebration has no trigger to restore
  // focus to, so the tray was taking it by default and the share button arrived already
  // ringed — a solved sentence is something to read, not a prompt to act. A keyboard user
  // reaches the actions with one Tab.
  const finishSourceReveal = useCallback(() => {
    setSourceRevealComplete(true);
  }, []);

  // Cache the progress on the persisted round so the language selector can badge an
  // in-progress language without re-loading its rank map. No-op when unchanged.
  useEffect(() => {
    syncProgress(progress);
  }, [progress, syncProgress]);

  // --- route map (#117): each hole opens its own neighborhood, drawn as a journey ---
  // Which holes have one, and under which number. Numbering is by DISTINCT secret in
  // sentence order (1..3) — the same numbers the run ruler's ticks and the share row's
  // keycaps use — so two occurrences of one secret, which share a rank map, share a number.
  // A hole whose secret carries no #115 geometry gets `null`: no map, hence no entry point
  // at all (explicit decision — there is no degraded list view).
  const routeNumbers = useMemo<(number | null)[]>(() => {
    const order: string[] = [];
    for (const h of puzzleHoles) if (!order.includes(h.secret.slug)) order.push(h.secret.slug);
    return puzzleHoles.map((h) =>
      hasRoute(ranks[h.secret.slug]) ? order.indexOf(h.secret.slug) + 1 : null,
    );
  }, [puzzleHoles, ranks]);
  const [routeHole, setRouteHole] = useState<number | null>(null);
  // The point the map zooms out of: the tapped word's centre, in viewport coordinates (the
  // dialog is fixed and fills the viewport, so they ARE its own box's). Null only if the hole
  // somehow isn't on screen, which falls back to a plain centre zoom.
  const [routeOrigin, setRouteOrigin] = useState<{ x: number; y: number } | null>(null);
  // The solved sequence has played out and the sentence is the player's again — which is also
  // the state a REHYDRATED solve mounts straight into.
  const solvedSettled =
    showResults && lineupGone && !keyboardLeaving && !showStreakDialog && sourceRevealComplete;
  // Tapping a hole is available during normal play and on that settled screen, where the map
  // becomes the post-mortem (terminus revealed, the whole neighborhood named) — never while the
  // solving beats are running, which own the sentence.
  //
  // `promptExiting` is what covers the START of those beats: the prompt leaves on the solving
  // submit while the holes are still resolving, so `solved` — which only follows the last word's
  // settle — has not turned over yet. It is NEVER set back to false on a fresh solve (it doubles
  // as "the input is retired", so resetting it would let typing resume), which is why it can only
  // be read as "the beats began" and `solvedSettled` has to be what ends them. Reading it as a
  // plain veto instead left every hole dead for the rest of the screen, and the post-mortem the
  // reveal was built for was reachable only by reloading the page.
  const exploreDisabled = !solvedSettled && (promptExiting || solved);
  // Stable for the round: the button wraps the hole for the WHOLE round or not at all, and
  // the gating above only disables it — unwrapping mid-round would remount the word while
  // its scramble is running. These are the buttons' DESCRIPTIONS, not their names: a hole is
  // named by the word and exponent it shows, which is the clue (see Hole/Phrase).
  const exploreLabels = useMemo<(string | null)[]>(
    () => routeNumbers.map((n) => (n === null ? null : ariaExploreHole(lang, n))),
    [routeNumbers, lang],
  );
  const routeModel = useMemo(() => {
    if (routeHole === null) return null;
    const hole = holes[routeHole];
    const puzzleHole = puzzleHoles[routeHole];
    const number = routeNumbers[routeHole];
    if (!hole || !puzzleHole || number === null) return null;
    return buildRoute({
      rankMap: ranks[hole.secret],
      tried: history,
      hole,
      startRank: puzzleHole.start_rank,
      secretWord: puzzleHole.secret.word,
      number,
    });
  }, [routeHole, holes, puzzleHoles, ranks, history, routeNumbers]);
  const closeRoute = useCallback(() => {
    const index = routeHole;
    setRouteHole(null);
    if (index === null) return;
    // Hand focus back to the hole that opened the map (the dialog has no other trigger).
    document
      .querySelector<HTMLButtonElement>(`[data-hole-explore="${index}"]`)
      ?.focus({ preventScroll: true });
  }, [routeHole]);
  // The ONE place a map opens — a tap, or the first-solve demonstration below — so the
  // "seen it" flag can never fall out of step with the thing it records (#129).
  //
  // It also takes the WORD's position on screen, which is where the map grows from: opening
  // is a zoom out of the thing you tapped, the way a desktop window opens out of its icon, so
  // the full screen that lands reads as that word rather than as a screen that replaced it.
  // Measured at the click (the word is on screen, and the auto-open fires with it settled),
  // never re-measured — the map covers the sentence anyway. `.hole-word-wrap` and not the
  // button, so the origin is the word itself with the exponent excluded.
  const openRoute = useCallback(
    (index: number) => {
      markRouteSeen();
      const word = document
        .querySelector<HTMLElement>(`[data-hole-explore="${index}"]`)
        ?.querySelector('.hole-word-wrap');
      const box = word?.getBoundingClientRect();
      setRouteOrigin(box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null);
      setRouteHole(index);
    },
    [markRouteSeen],
  );

  // --- #129, part A: the ambient letter wave ---
  // EVERY hole runs its own clock (see Hole), so several words can stir at once and on their
  // own rhythms. All the round contributes is the one fact a hole cannot see for itself: that
  // the SENTENCE is quiet. Guess feedback owns these words while it plays, and the map owns
  // the screen while it is open, so the affordance stands down for both — and once the round
  // is over, stillness is what "done" looks like.
  const quiet = !solved && !promptExiting && routeHole === null && hits.length === 0;

  // --- #129, part B: the one-time first-solve auto-open ---
  // The hole whose map is owed, waiting for its own word to finish resolving. Transient: a
  // reload during that second simply forgets it, and the next first-ever solve makes the
  // same offer.
  const [autoRouteHole, setAutoRouteHole] = useState<number | null>(null);
  useEffect(() => {
    if (autoRouteHole === null) return undefined;
    // Found by tapping while the word was still resolving: the demonstration is moot.
    if (routeSeen) {
      setAutoRouteHole(null);
      return undefined;
    }
    // The round ENDED while the map was owed. `shouldAutoOpenRoute` refuses a final solve at
    // arm time, but an offer armed by an EARLIER guess outlives it: guessing stays live
    // through the first solved word's ~1.7s of settle, so a player holding the last answer
    // can finish the sentence inside that window. The map would then open over the solved
    // sequence (streak -> exits -> leaderboard -> source) — two dialogs stacked, and the one
    // competing modal that sequence is not allowed to gain. Cancelling here rather than at
    // the submit keeps the rule in ONE place, and covers the store's own solved transition
    // as well as the prompt's exit. A later round's mid-round solve makes the offer again.
    if (promptExiting || solved) {
      setAutoRouteHole(null);
      return undefined;
    }
    // Never a guessed timeout: the hole reports its own settle (the same signal that gates
    // the solved sequence), and only then does the map get its beat.
    if (!resolvedHoleIndices.has(autoRouteHole)) return undefined;
    // And the beat is measured from the LAST settle, not this hole's — `resolvedHoleIndices`
    // is a fresh Set per resolve and it is a dependency, so a sibling hole settling after it
    // restarts the timer. That is deliberate, not incidental: one guess can drop two mappable
    // holes, and 350ms after the FIRST would put the modal over a word still scrambling —
    // exactly what waiting for a real settle exists to avoid. The target hole has settled
    // either way (the guard above), and the restart is bounded: at most one per hole, and the
    // set only ever grows. Don't "fix" this dependency away.
    const id = window.setTimeout(() => {
      setAutoRouteHole(null);
      openRoute(autoRouteHole);
    }, AUTO_ROUTE_AFTER_SOLVE_MS);
    return () => window.clearTimeout(id);
  }, [autoRouteHole, openRoute, promptExiting, resolvedHoleIndices, routeSeen, solved]);

  const removeHit = useCallback((id: number) => {
    setHits((prev) => prev.filter((h) => h.id !== id));
  }, []);

  // Input mutations shared by the on-screen keyboard (taps) and the physical keyboard.
  // Every path clears the "does not exist" feedback as soon as the player edits again.

  // A hole button keeps focus after its route map closes, so a keyboard user keeps their place.
  // But the moment the input is EDITED — typed, deleted or recalled — the player is guessing,
  // not exploring, so hand the keyboard back. WordInput deliberately leaves Enter to a focused
  // button (that is how the tutorial's NEXT is activated), so a button still holding focus after
  // an edit swallows the Enter that submits and re-opens the map instead. Every editing path
  // therefore has to release it, not just typing: a letter did, Backspace and history recall did
  // not, which made "close the map, fix a typo, press Enter" reopen the map.
  const releaseHoleFocus = useCallback(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.classList.contains('hole-btn')) focused.blur();
  }, []);

  // Append one slug char, but ONLY if it keeps the input a prefix of some real word
  // (the same rule that greys the on-screen key). A dead-end char shakes the prompt
  // instead of being silently dropped: the on-screen keys grey out and shake in place,
  // but physical typing has no key to look at — without feedback a swallowed letter
  // reads as broken input. Shake only, no "does not exist" message (that one is about
  // a submitted word).
  const appendChar = useCallback(
    (char: string) => {
      if (promptExiting) return;
      releaseHoleFocus();
      setFeedback(null);
      if (canExtend(prefixSet, input, char)) setInput(input + char);
      else setInvalidAt(Date.now());
    },
    [prefixSet, input, promptExiting, releaseHoleFocus],
  );

  const deleteChar = useCallback(() => {
    if (promptExiting) return;
    releaseHoleFocus();
    setFeedback(null);
    setInput((cur) => cur.slice(0, -1));
  }, [promptExiting, releaseHoleFocus]);

  // Replace the whole input (physical-keyboard history recall). Recalled values are
  // past valid words, hence valid prefixes, so no re-validation is needed.
  const replaceInput = useCallback((v: string) => {
    if (promptExiting) return;
    releaseHoleFocus();
    setFeedback(null);
    setInput(v);
  }, [promptExiting, releaseHoleFocus]);

  const submit = useCallback(
    (raw: string) => {
      if (solved || promptExiting) return;
      const typed = fold(raw);
      if (!typed) {
        setInput('');
        return;
      }

      // Existence is decided by the fixed vocabulary, NOT by the puzzle's ranks.
      if (!vocabSet.has(typed)) {
        // INVALID -> "does not exist": red shake + message under the input. Keep the
        // typed word (do NOT clear) so the player can correct it; the next edit clears
        // the message.
        setInvalidAt(Date.now());
        setFeedback({ text: t(lang, 'notAWord') });
        say(t(lang, 'notAWord'));
        return;
      }

      // Know at submit time whether this valid guess closes every remaining hole. Start
      // the prompt exit NOW — in the same React commit as the final hit indicators —
      // instead of waiting for the delayed store improvements to mark the round solved.
      const solvesAll = holes.every((h) => h.rank === 0 || ranks[h.secret][typed]?.rank === 0);
      setInput('');
      setFeedback(null);
      if (solvesAll) setPromptExiting(true);
      // Counted guess: a unique valid word (misses included). The store dedupes by
      // canonical identity (guessKey): repeats, inflections of an already-tried word
      // (#104), and the non-existent words returned above never increase the score.
      recordGuess(typed, (t) => guessKey(ranks, t));

      // EVERY unsolved hole reacts to a valid guess (solved holes are locked out).
      // A hole is WARM when `typed` is in its top-K rank map (`entry` set) and TOO
      // FAR otherwise (`entry` undefined). Built in sentence order so the floating
      // feedback below staggers left-to-right.
      const impacted = holes.flatMap((h, index) => {
        if (h.rank === 0) return [];
        const entry: RankEntry | undefined = ranks[h.secret][typed];
        return [{ index, entry }];
      });

      // The first hole this player EVER solves shows them the map (#129). Decided here, at
      // submit time, because this is where "solved by THIS guess" and "the round is over"
      // are both known — but only armed: the map waits for the word to finish resolving.
      // Restricted to holes that HAVE a map; a legacy puzzle simply never makes the offer.
      // The `routeSeen` test lives in the helper alone (where it is part of the tested
      // contract), not here as well — one decision, one place.
      const autoRoute = shouldAutoOpenRoute(
        routeSeen,
        impacted
          .filter(({ index, entry }) => entry?.rank === 0 && routeNumbers[index] !== null)
          .map(({ index }) => index),
        solvesAll,
      );
      // FIRST come, first served: it is the first hole this player ever solves that gets the
      // demonstration. Another hole solved while that one is still resolving would otherwise
      // replace the target and open a map they reached second. Cancellation is the effect's
      // job alone (a final solve, or a manual tap), never this assignment's.
      if (autoRoute !== null) setAutoRouteHole((current) => current ?? autoRoute);

      // Announce the guess's outcome to assistive tech — the audible twin of the
      // floating numbers below. One sentence covering every impacted hole (1-based, in
      // sentence order), plus the visible standings lineup's meaningful events (#81 —
      // the lineup itself is decorative): each opponent this counted try lets ahead,
      // by full label. The solved fanfare stays last when this guess finishes the round.
      const parts = impacted.map(({ index, entry }) =>
        srHoleResult(lang, index + 1, entry ? entry.rank : null),
      );
      // Only a guess that actually COUNTS can move the lineup, and counting is decided by
      // canonical identity (guessKey) — NOT by the raw slug: an inflection or accent
      // variant of an already-tried word folds to a slug absent from `history` yet does
      // not increase the score (#104). Comparing raw slugs here would announce an
      // overtake the visible lineup never performs.
      if (
        hasDisplayEntries(benchmark) &&
        !history.some((prev) => guessKey(ranks, prev) === guessKey(ranks, typed))
      ) {
        const before = lineupModel(benchmark, guessCount, t(lang, 'you'));
        const after = lineupModel(benchmark, guessCount + 1, t(lang, 'you'));
        const { passedBy, lostLead } = lineupEvents(before, after);
        parts.push(
          ...passedBy.map((e) =>
            lostLead && e.key === after.entrants[0].key
              ? srModelLead(lang, e.label, e.tries as number)
              : srModelAhead(lang, e.label, e.tries as number),
          ),
        );
      }
      say(solvesAll ? [...parts, t(lang, 'srSolvedAll')].join(', ') : parts.join(', '));

      // Every impacted hole shows a floating indicator: the distance number when
      // warm, or "MISS" when too far. They start in sentence-order sequence
      // (STAGGER_MS apart) and fade out together as one batch. A hole the guess
      // IMPROVES shows the distance too; the entry's closer word + lower rank are
      // handed over as its number begins to fade, and Hole stages the rest (decrease
      // the exponent one rank at a time, then scramble out the old word and reveal the
      // new one).
      const fadeDelayMs = Math.max(0, impacted.length - 1) * STAGGER_MS + FLOATING_HIT_INTRO_MS;
      impacted.forEach(({ index, entry }, step) => {
        const oldRank = holes[index].rank; // submit-time rank (start_rank on first improve)
        const improves = entry != null && entry.rank < oldRank;
        const startDelayMs = step * STAGGER_MS;

        const id = (hitId.current += 1);
        setHits((prev) => [
          ...prev,
          entry != null
            ? { holeIndex: index, value: entry.rank, id, startDelayMs, fadeDelayMs }
            : { holeIndex: index, value: 0, id, startDelayMs, fadeDelayMs, miss: true },
        ]);

        if (!improves || entry == null) return;

        // IMPROVEMENT: hand the entry's DISPLAY form (accents kept) and lower rank
        // to the hole as its floating hit starts fading out — Hole decreases the
        // exponent one rank at a time, then scrambles the old word out and reveals
        // this new one.
        const { word, rank } = entry;
        const timer = window.setTimeout(() => {
          pendingTimers.current = pendingTimers.current.filter((t) => t !== timer);
          improveHole(index, word, rank);
        }, fadeDelayMs);
        pendingTimers.current.push(timer);
      });
    },
    [
      holes,
      ranks,
      solved,
      promptExiting,
      vocabSet,
      recordGuess,
      improveHole,
      lang,
      say,
      benchmark,
      history,
      guessCount,
      routeSeen,
      routeNumbers,
    ],
  );

  return (
    <div className="game">
      {/* Invisible live region: the screen-reader mirror of the per-hole visual
          feedback (see `say`). Polite, so it never interrupts the player's own typing
          echo mid-word. */}
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>

      {/* The floating header (streak/flag/archive/help, top-right) is rendered by
          GameRoute ABOVE this, so it stays put across the route's states. The game owns
          the matching top-LEFT corner: the reconstruction % as a floating arcade
          counter — VALUE carries the length, ramp COLOR carries the feel. */}
      <div className="hud">
        <ProgressCounter value={progress} />
      </div>

      {/* The play area fills the space between the fixed HUD (top) and the keyboard
          (bottom) and centers its content, so the sentence + prompt sit in the middle.
          It also anchors the score watermark, so the big try count stays centered
          behind THIS content rather than the full-height .game. */}
      <div className="play">
        {/* The reconstructed sentence stays visible in BOTH states: while playing (with
            the live holes/hits) and once solved (every hole resolved to its accented
            secret) — it is the "full reconstructed sentence" of the solved screen.
            The wrapper anchors the score watermark to the SENTENCE (not sentence +
            prompt): the big faint try count centers behind the phrase, z-index:-1 in
            .play's isolated stacking context (the wrapper itself is deliberately NOT
            isolated, so the watermark paints behind the citation and prompt too, #110),
            printed on the background's 24px
            cells (CellDigits) so it reads as part of the grid, not a font over it. */}
        <div className="phrase-anchor">
          <div className="progress-background" aria-hidden="true">
            <CellDigits value={guessCount} />
          </div>
          <Phrase
            words={words}
            holes={holes}
            puzzleHoles={puzzleHoles}
            hits={hits}
            onHitDone={removeHit}
            onHoleResolved={markHoleResolved}
            exploreLabels={exploreLabels}
            exploreDisabled={exploreDisabled}
            onExplore={openRoute}
            quiet={quiet}
          />
        </div>

        {/* Below the sentence: the prompt and the solved source citation OVERLAY in one
            grid cell (.prompt-zone), BOTH mounted for the whole round — the zone sizes to
            the taller natural height (the caption lays out its full citation from frame
            one), so the prompt→citation swap cannot move the centered sentence and no
            reserved min-height is needed (the hand-synced 90px/72px pair, removed
            2026-07-25). The prompt exits on the solving submit; the caption stays
            invisible until the source reveal beat, then types in place — and until that
            beat it lays out MASKED, so reserving its height never puts the sentence's
            author/work in the DOM of a round still being played. */}
        <div className="prompt-zone">
          <div
            className={`input-area${promptExiting ? ' solving' : ''}${
              showResults ? ' retired' : ''
            }`}
            aria-hidden={promptExiting || showResults || undefined}
          >
            <WordInput
              value={input}
              history={history}
              onType={appendChar}
              onBackspace={deleteChar}
              onSubmit={submit}
              onReplace={replaceInput}
              invalidSignal={invalidAt}
              // The route map covers the prompt: keystrokes must not build (or submit) a
              // guess the player cannot see behind it.
              active={!showResults && routeHole === null}
            />
            <p className="hint">{feedback?.text || ' '}</p>
          </div>
          <div
            className={`caption-slot${showResults && sourceRevealStarted ? '' : ' pending'}`}
            aria-hidden={!(showResults && sourceRevealStarted) || undefined}
          >
            <SolvedCaption
              source={source}
              masked={!(showResults && sourceRevealStarted)}
              animate={showResults && sourceRevealStarted && !sourceRevealComplete}
              onComplete={finishSourceReveal}
            />
          </div>
        </div>
      </div>

      {/* Standings lineup (#81/#110): the player + the present display opponents sorted
          by tries (leader far left), between the input area and the keyboard. On solve
          the characters do NOT persist: as the keyboard drops they teleport out one by
          one (`exiting`), and once the last is gone the lineup unmounts — the
          leaderboard table in the results takes over the standings story. Its ZONE
          stays for the whole round though (empty after the exit, on rehydrated solves
          too): the reserved band keeps .play's centering fixed, so the sentence never
          shifts between the solved beats. */}
      {hasLineup && (
        <div className="lineup-zone">
          {!lineupGone && (
            <StandingsLineup
              benchmark={benchmark}
              guessCount={guessCount}
              solved={solved}
              lang={lang}
              exiting={lineupExiting}
              onExited={handleLineupExited}
            />
          )}
        </div>
      )}

      {/* Bottom zone (fixed keyboard-height footprint): the on-screen keyboard while
          playing, the solved results in the SAME space once they reveal — so the keyboard
          leaving neither reflows the layout nor leaves an empty hole. The keyboard lingers
          (inert; submit is guarded) through the last hole's animation, then slides down out
          of the tray (#110); the results wait out the lineup's teleport-out (the tray
          holds its footprint empty for that beat) and rise in only once it is gone. */}
      <div
        className={`tray${keyboardLeaving ? ' kb-leaving' : ''}${
          showResults && !keyboardLeaving && !showStreakDialog && lineupGone
            ? ' tray-results'
            : ''
        }`}
      >
        {showResults && !keyboardLeaving && !showStreakDialog ? (
          lineupGone ? (
            <SolvedScreen
              guessCount={guessCount}
              trajectory={trajectory}
              dayNumber={dayNumber}
              lang={lang}
              benchmark={benchmark}
              solvedAt={solvedAt}
              runReplays={runReplays}
              animate={animateResults}
              startAnimation={!showStreakDialog && !deferResultsAnimation}
              onRisen={handleResultsRisen}
            />
          ) : null
        ) : (
          <div
            className={`kb-exit${keyboardLeaving ? ' leaving' : ''}`}
            onAnimationEnd={(e) => {
              // Child animations (key shakes) bubble here too: only the wrapper's own
              // kb-drop end releases the tray to the results.
              if (keyboardLeaving && e.target === e.currentTarget) setKeyboardLeaving(false);
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

      {showStreakDialog && (
        <LazyStreakDialog lang={lang} solvedDay={dayNumber} onDismiss={dismissStreakDialog} />
      )}

      {/* One hole's neighborhood as a journey (#117). Fully derived from (tried, ranks,
          hole state), so a guess landing while it is open simply adds a stop. */}
      {routeModel && (
        <RouteModal model={routeModel} lang={lang} origin={routeOrigin} onClose={closeRoute} />
      )}
    </div>
  );
}
