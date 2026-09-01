import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { guessKey, replayHoles } from '../game/scoring';
import { playLogFor, withoutDeferred } from '../game/playLog';
import { replayRun, type RunReplay } from '../game/share';
import { canExtend } from '../game/keyboard';
import LoadingWave from '../components/LoadingWave';
import useVocab from '../hooks/useVocab';
import useScoreHistogram from '../hooks/useScoreHistogram';
import useRoundSync from '../hooks/useRoundSync';
import { notifyGuess, retryRoundSync } from '../state/roundSync';
import { useGameStore, roundKeyForDay } from '../state/gameStore';
import { noteSolvedDay, usePlayerHistory } from '../state/history';
import Phrase from '../components/Phrase';
import DissolvePhrase from '../components/DissolvePhrase';
import CellDigits from '../components/CellDigits';
import WordInput from '../components/WordInput';
import Keyboard from '../components/Keyboard';
import SolvedScreen from '../components/SolvedScreen';
import LazyStreakDialog, { preloadStreakDialog } from '../components/LazyStreakDialog';
import HistoryWheel from '../components/HistoryWheel';
import HistoryModal from '../components/HistoryModal';
import CoachText from '../tutorial/CoachText';
import LoadError from '../components/LoadError';
import { buildHistory } from '../game/history';
import type { HistoryStop } from '../game/history';
import { t, ariaHoleHistory, srHoleResult } from '../i18n';
import { track } from '../analytics';
import { fold, dateForDayNumber, ROUND_GUESS_CAP } from '@whippin/shared';
import { prefetchTurnstileTokens } from '../turnstile';
import { deviceIdentity, ensureDeviceIdentity, useDeviceIdentity } from '../identity';
import ErrorScreen from '../components/ErrorScreen';
import type {
  HitState,
  Hole,
  Puzzle,
  RankEntry,
  RankMap,
  RuntimeHole,
  Source,
} from '@whippin/shared';

// Feedback shown under the input is one string. Only INVALID words use it now (red shake +
// "does not exist"); a valid-but-too-far guess gives per-hole "MISS" feedback on the holes
// instead, so it needs no under-input message.

// When a guess impacts several holes, effect starts are staggered this many ms apart.
// Floating distance/MISS feedback uses the same start stagger, then fades as one batch.
// (The tutorial's board is ONE hole, so it staggers nothing — it takes the intro constant
// below instead, which is what makes its single hit read like a real one.)
const STAGGER_MS = 200;
export const FLOATING_HIT_INTRO_MS = 320;

const STREAK_AFTER_WORDS_MS = 300;

// The streak collection's quiet retry (see its effect): bounded attempts on a doubling
// delay, sized so a load-time blip recovers long before a solve, while an offline tab
// stops asking.
const STREAK_READ_RETRIES = 3;
const STREAK_READ_RETRY_MS = 4_000;

// One frozen empty log, so a round with nothing to play from does not hand every memo a
// fresh array on every render.
const EMPTY_LOG: string[] = [];

// Deadline for the keyboard's solved-exit beat handing the tray back (see its effect):
// a generous multiple of the real duration, so it only ever fires if the DOM signal
// itself was lost.
export const KB_EXIT_FALLBACK_MS = 1_200;

// Wrapper: drives the single puzzle. Loads the language's fixed vocabulary
// (existence set + keyboard prefix set) before playing — existence is decided by it,
// not by ranks. GameRoute supplies the actual app-header renderer; the round puts the
// day's DATE in the header's left slot (2026-08-16, replacing the progress counter).
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
  if (!vocab)
    return (
      <p className="status">
        <LoadingWave text={t(puzzle.lang, 'loading')} />
      </p>
    );

  return (
    <Round
      words={puzzle.words}
      puzzleHoles={puzzle.holes}
      ranks={puzzle.ranks}
      source={puzzle.source}
      vocabSet={vocab.vocabSet}
      prefixSet={vocab.prefixSet}
      lang={puzzle.lang}
      revision={puzzle.revision}
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
  vocabSet,
  prefixSet,
  lang,
  revision,
  dayNumber,
  isActiveDay,
  deferResultsAnimation,
}: {
  words: string[];
  puzzleHoles: Hole[];
  ranks: RankMap;
  source?: Source;
  vocabSet: Set<string>;
  prefixSet: Set<string>;
  lang: string;
  // WHICH PUBLISHED VERSION this puzzle is (#203) — the round's identity everywhere.
  revision: string;
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

  const ensureOutbox = useGameStore((s) => s.ensureOutbox);
  const appendOutbox = useGameStore((s) => s.appendOutbox);
  const sentenceRulesSeen = useGameStore((s) => s.sentenceRulesSeen);
  const markSentenceRulesSeen = useGameStore((s) => s.markSentenceRulesSeen);
  // Whether this device holds an account — REACTIVE, so the gate below closes on its own
  // when another tab deploys one (the storage adoption) and reopens after a sign-out.
  const identity = useDeviceIdentity();

  // The STREAK's own source since #211: the language's solved-day collection, read from the
  // server and held transiently. It is loaded HERE, on the active-day route, because the
  // celebration needs the collection BEFORE the solve — it counts the previous value off it
  // — and by the time a sentence is solved this read has long landed. An archive route
  // never asks: an archive solve never touches the streak.
  const playerHistory = usePlayerHistory({ lang, enabled: isActiveDay });

  // A FAILED collection read would otherwise be final for the whole round: nothing else
  // re-asks, and `noteSolvedDay` credits nothing off a collection that never arrived — so a
  // two-second network blip at load silently suppressed the streak celebration of a solve
  // twenty minutes later, while the server credited the day. Retried QUIETLY (the
  // celebration is best-effort, the standing rule for this read) and BOUNDED, so an offline
  // tab does not ask forever.
  const streakRetries = useRef(0);
  useEffect(() => {
    if (!isActiveDay) return undefined;
    if (playerHistory.solvedPhase === 'ready') {
      streakRetries.current = 0;
      return undefined;
    }
    if (playerHistory.solvedPhase !== 'failed') return undefined;
    if (streakRetries.current >= STREAK_READ_RETRIES) return undefined;
    const attempt = streakRetries.current;
    const id = window.setTimeout(() => {
      streakRetries.current = attempt + 1;
      playerHistory.retry();
    }, STREAK_READ_RETRY_MS * 2 ** attempt);
    return () => window.clearTimeout(id);
  }, [isActiveDay, playerHistory.solvedPhase, playerHistory.retry]);

  // Reconcile the OUTBOX before paint (#214): an outbox naming a different published
  // revision answered a retired question and is dropped. A layout effect commits that
  // before the browser paints, so a retired round's guesses never reach a render.
  useLayoutEffect(() => {
    ensureOutbox(roundKey, revision);
  }, [ensureOutbox, roundKey, revision]);

  // The server owns this round's log (#201), and since #214 the client waits for it: the
  // read below is what the board is replayed from, and until it settles there is nothing
  // to play. Archive days sync exactly like today's (the same date-addressed route), which
  // is what makes a player's full history follow them to a new device.
  const load = useRoundSync({
    roundKey,
    lang,
    mode: 'sentence',
    date: dateForDayNumber(dayNumber),
    // The round's identity on the wire (#203): the version this puzzle was published as.
    revision,
    ranks,
  });
  const server = load.status === 'ready' ? load.server : null;

  // The unacknowledged half — the ONLY persisted sentence-round state. Read straight out
  // of the map and checked against the revision: `ensureOutbox` reconciles in a layout
  // effect, so the very first render of a re-published round can still see the retired
  // one's guesses.
  const stored = useGameStore((s) => s.outbox[roundKey]);
  const outbox = stored && stored.puzzle === revision ? stored.guesses : EMPTY_LOG;

  // THE PLAY LOG: a pure first-occurrence projection of `server + outbox`, deduped by
  // canonical identity. Everything the screen shows is derived from it — the board, the
  // score, the recall history, the run ruler, the solve moments — so there is no second
  // copy of a round's state anywhere to reconcile against.
  const playLog = useMemo(
    () => (server ? playLogFor(ranks, server.guesses, outbox) : EMPTY_LOG),
    [ranks, server, outbox],
  );

  // Guess IDENTITIES whose BOARD effect is still animating. The play log is authoritative
  // the instant a guess lands, but a hole's word/rank swap is deliberately deferred to its
  // floating hit's fade-out — so the visible board replays the log MINUS what is still in
  // the air, and each release is one timer removing one entry. The deferral is presentation
  // only: the score, the history and the ruler all read the full log.
  const [deferred, setDeferred] = useState<string[]>([]);
  // The wheel's PICKS, by hole index — see `shownHoles` below.
  const [picked, setPicked] = useState<Record<number, { word: string; rank: number; at: number }>>(
    {},
  );
  const holes = useMemo(
    () => replayHoles(freshHoles, ranks, withoutDeferred(ranks, playLog, deferred)),
    [freshHoles, ranks, playLog, deferred],
  );
  // Score = number of unique tries. A try is a submitted word that exists in the
  // vocabulary, including misses; repeats and inflections of an already-played word are
  // one try (#104), which is exactly what the projection collapsed.
  const guessCount = playLog.length;
  // Prompt history for Up/Down recall = this round's unique valid guesses in order.
  const history = playLog;

  // Hole owns the actual word-replacement animation, so it also owns the reliable finish
  // signal. Keep every resolved hole reported for this round; the round-key dependency on
  // the callback makes already-resolved rehydrated holes report again after navigation.
  const [resolvedHoleIndices, setResolvedHoleIndices] = useState<Set<number>>(() => new Set());
  useLayoutEffect(() => {
    setResolvedHoleIndices(new Set());
    // Whatever was still animating belonged to the previous round.
    setDeferred([]);
    setPicked({});
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
  const [feedback, setFeedback] = useState<string | null>(null); // message under the input
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

  // ROUND CREATION is Turnstile-gated (#203), and the challenge is asked for HERE — while
  // the puzzle is on screen and the player is reading it — so it is in hand by the time
  // the first guess needs it rather than sitting in front of that write. Fire-and-forget:
  // the sync engine mints a fresh one if this never arrives.
  useEffect(() => {
    prefetchTurnstileTokens(deviceIdentity() === null ? 2 : 1);
  }, [roundKey]);

  // The board as this screen shows it. It is a LOCAL reading — the last hole's swap may
  // still be in the air, and the guess that closed it is still on its way to the server —
  // so it owns the prompt's lock and nothing else (#214).
  const boardComplete = holes.every((h) => h.rank === 0);
  const allWordsResolved = boardComplete && resolvedHoleIndices.size === holes.length;

  // AUTHORITATIVE solved: the server's own reading of the log it stores (#203). The local
  // board flips a beat earlier, while the solving append is still in flight, so everything
  // that must not happen twice or too early — the result, the leaderboard, the streak, the
  // `solve` event — hangs off this and never off `boardComplete`.
  const solved = server?.solved === true;
  // CAPPED (#214): the authoritative state is UNSOLVED with exactly the raw cap stored, so
  // the server refuses every further append. DERIVED, never a stored flag — the outbox's
  // own length can never reveal it, since what counts is what was STORED. A legitimate
  // solve accepted as raw entry 500 is an ordinary solved round: `solved` wins, and the
  // leaderboard entry it earned stands.
  const capped = server !== null && !server.solved && server.guesses.length >= ROUND_GUESS_CAP;
  // The round is over either way — the difference is what the headline says and whether
  // anything celebrates.
  const finished = solved || capped;

  // The day's score population (#170), READ once the SERVER holds this round (#203). The
  // score is no longer claimed: the append that solves the round is what records the row,
  // and `solved` is the server's own answer that it did. Gating on the local board alone
  // would read a population one round trip before this round joined it — and, with nothing
  // left to retry, would leave the standing blank for good.
  //
  // A CAPPED round simply never gets there: past the server's guess cap its appends are
  // refused, so its solve never reaches the server and no row exists to stand in.
  const placement = useScoreHistogram({
    finished: solved,
    mode: 'sentence',
    lang,
    dayNumber,
    score: guessCount,
  });
  // The instructions GATE (2026-08-11; reworked with the #216 triggers, user-decided
  // 2026-08-24). Two reasons to hold the round back, one dialog:
  //   - the RULES, stated once ever (the persisted flag) — an account-holding player who
  //     has read them never sees the gate again;
  //   - the ACCOUNT: a device with NO identity shows the full gate on EVERY sentence day
  //     (archive included), whatever the flag says, because its PLAY is the deploy button —
  //     the server owns the log from the first guess, so no guess may land before the
  //     account exists, and there is no other trigger on this screen.
  // Derived, not state. A tokenless device can hold a non-empty outbox only in the
  // pending-bootstrap recovery, and the gate deliberately shows over it: PLAY resumes the
  // interrupted deploy and the waiting guesses flush behind it.
  const gateOpen = identity === null || (!sentenceRulesSeen && !finished && guessCount === 0);
  // PLAY, when it is the deploy button: a single tap that creates the account and opens
  // the round — a clear loading state while the bootstrap runs, and the app's error
  // surface when it fails (nothing was created; TRY AGAIN re-runs it).
  const [deploying, setDeploying] = useState(false);
  const [deployFailed, setDeployFailed] = useState(false);
  const handleGatePlay = useCallback(() => {
    if (identity !== null) {
      markSentenceRulesSeen();
      return;
    }
    if (deploying) return;
    setDeploying(true);
    ensureDeviceIdentity()
      .then(() => markSentenceRulesSeen())
      .catch(() => setDeployFailed(true))
      .finally(() => setDeploying(false));
  }, [identity, deploying, markSentenceRulesSeen]);
  // The history-tap rule speaks the input device's own verb — the same coarse-pointer test
  // as the streak hint and the retired tutorial gesture line.
  const coarse = useMemo(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches,
    [],
  );
  // The rules as ONE bulleted string: what the gate's dialog box types, and what the
  // sr-only mirror states (the visible CoachText is aria-hidden, like every coach box).
  const gateRules = useMemo(
    () =>
      [
        t(lang, 'sentenceRulesGoal'),
        t(lang, coarse ? 'sentenceRulesHistoryTap' : 'sentenceRulesHistoryClick'),
      ]
        .map((line) => `- ${line}`)
        .join('\n'),
    [lang, coarse],
  );
  // The celebration is deliberately code-split out of startup. Warm its chunk only while
  // an eligible unsolved daily round is idle; if a player solves before idle fires, the
  // just-solved transition below starts the same preload immediately. Both scheduling paths
  // are cleaned up with the round, and a speculative load failure remains retryable.
  useEffect(() => {
    if (finished || !isActiveDay) return undefined;
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(() => preloadStreakDialog(), { timeout: 4_000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(() => preloadStreakDialog(), 1_500);
    return () => window.clearTimeout(id);
  }, [dayNumber, isActiveDay, roundKey, finished]);

  // This round replayed: the per-guess reconstruction-% trajectory (the run ruler's cells,
  // and what the share token carries) plus the solve moments (its ticks), from ONE walk of
  // the ordered valid guesses. Derived from the PLAY LOG, exactly like the score, so one
  // ruler cell is one canonical try — never one raw storage entry.
  const { trajectory, solvedAt } = useMemo<RunReplay>(
    () => replayRun(freshHoles, ranks, playLog),
    [freshHoles, ranks, playLog],
  );

  // Gate the solved presentation on every Hole reporting its final displayed secret. The
  // playing UI stays up through the real animationend events, so slow/throttled frames and
  // a multi-hole final guess cannot let the streak cover words that are still resolving.
  // An already-solved round on load still reveals immediately.
  const [showResults, setShowResults] = useState<boolean>(finished);
  // The results component also mounts behind the streak screen. Fresh solves keep it at
  // frame zero until the source finishes; rehydrated solves start at the final frame.
  // A dev streak preview deliberately opts a rehydrated result back into the choreography.
  const [animateResults, setAnimateResults] = useState<boolean>(
    () => finished && deferResultsAnimation,
  );
  // Player progression gets a separate, one-time celebration. This is deliberately
  // transient rather than persisted: only the live unsolved -> solved transition may open
  // it, so refreshing or revisiting an already-solved round never interrupts the player.
  const [showStreakDialog, setShowStreakDialog] = useState(false);
  const [streakAdvanced, setStreakAdvanced] = useState(false);
  const [awaitingWordAnimations, setAwaitingWordAnimations] = useState(false);
  // The sentence's EXIT (user-decided 2026-08-14): once the solving beats have played out
  // and the keyboard has dropped, the resolved sentence DISSOLVES — every letter churns
  // through the scramble's glyphs and goes out, left to right — and only then does the
  // solved stage take the whole screen. `dissolved` is the flag the swap hangs on: false
  // through a live round (a fresh solve earns the dissolve), true from the first frame of
  // a rehydrated solve (a revisit replays nothing, sentence included).
  const [dissolved, setDissolved] = useState(finished);
  // Solved exit choreography (#110, decided 2026-07-24): a LIVE solve doesn't swap the
  // tray instantly — the keyboard slides down out of it (kb-drop) before the sentence
  // dissolves and the stage rises. Rehydrated solves never set this: they mount the final
  // stage directly.
  const [keyboardLeaving, setKeyboardLeaving] = useState(false);
  // The solving beats have handed the screen back: streak dismissed, keyboard gone. What
  // it releases is the DISSOLVE (not yet the stage — the stage waits for the sentence to
  // finish going out).
  const resultsUp = showResults && !keyboardLeaving && !showStreakDialog;
  // The exit beat hands the tray back through a signal the DOM has to produce: the
  // keyboard's own `animationend`. It is reliable today, but the tray renders NOTHING
  // until it arrives — a lost signal (a dropped animation) would strand the player on an
  // empty tray with no way back. This deadline makes that unreachable: it fires well
  // after the real beat (kb-drop is 200ms) and is cancelled the moment the genuine
  // signal lands.
  useEffect(() => {
    if (!keyboardLeaving) return undefined;
    const id = window.setTimeout(() => setKeyboardLeaving(false), KB_EXIT_FALLBACK_MS);
    return () => window.clearTimeout(id);
  }, [keyboardLeaving]);
  const prevFinished = useRef<boolean>(finished);
  useEffect(() => {
    // A FRESH solve is one the SERVER confirmed on a batch THIS device sent
    // (`solvedByAppend`). An adopted one — read at mount, or learned from a `round_solved`
    // refusal because the same ACCOUNT finished the board in another tab or on another
    // device — is history as far as the beats are concerned: the board IS solved, and it is
    // shown solved, but nothing celebrates a finish that already happened somewhere else.
    // A CAPPED round is never fresh: it ends, it does not finish.
    const justFinished = finished && !prevFinished.current;
    const freshSolve = solved && server?.solvedByAppend === true;
    prevFinished.current = finished;
    if (!finished) {
      setShowResults(false);
      setAnimateResults(false);
      setShowStreakDialog(false);
      setStreakAdvanced(false);
      setAwaitingWordAnimations(false);
      setKeyboardLeaving(false);
      setPromptExiting(false);
      setDissolved(false);
      return undefined;
    }
    if (!justFinished || !freshSolve) {
      setShowResults(true); // adopted history, or the cap — reveal without waiting
      setAnimateResults(deferResultsAnimation);
      setShowStreakDialog(false);
      setStreakAdvanced(false);
      setAwaitingWordAnimations(false);
      setPromptExiting(false);
      setDissolved(true); // nothing to replay — the sentence is already gone
      return undefined;
    }
    // The one analytics beat for "did the player finish a puzzle": fired ONLY on the
    // play-solve transition (never on the rehydration branch above). `archive`
    // distinguishes a replayed past day ('yes', #55) from the live daily puzzle ('no').
    track('solve', { lang, tries: guessCount, day: dayNumber, archive: isActiveDay ? 'no' : 'yes' });
    // Streak (#56): ON TIME means ON THE DAY (user-decided 2026-08-23), and since the
    // PR-218 review the verdict is the SERVER's, carried on the confirming append's answer
    // (`credited`) — one predicate on one clock. Re-making the comparison here on the
    // device clock let a fast clock inside the route's skew window celebrate a streak day
    // the server refused, a phantom the transient collection could never take back out.
    // A solve past the 22:00 flip and an archive replay both come back uncredited, exactly
    // as the one comparison ruled before.
    //
    // Since #211 the collection this credits is the SERVER's (the append that confirms the
    // solve records the day); this is the transient copy the celebration counts from, and it
    // reports whether the day was genuinely new the same way `recordSolve` did — plus one
    // new refusal: a collection that never arrived cannot say what the previous streak was,
    // so it celebrates nothing rather than printing a guess.
    const didAdvanceStreak = noteSolvedDay(lang, dayNumber, server?.credited === true);
    setAnimateResults(true);
    setStreakAdvanced(didAdvanceStreak);
    if (didAdvanceStreak) preloadStreakDialog();
    setDissolved(false); // a fresh solve earns the sentence's dissolve
    setAwaitingWordAnimations(true);
    return undefined;
  }, [finished]);

  useEffect(() => {
    if (!awaitingWordAnimations || !allWordsResolved) return;
    // The archive and rehydration branches never open this dialog: `streakAdvanced` IS
    // `noteSolvedDay`'s answer, and it credited the day synchronously. This used to
    // re-check the freshness window because that window had slack in it — a tab left open
    // 2+ days could reach here with a credit the store had refused. On-time now means on
    // the day, so the credit already settled it, and re-deciding could only ever suppress
    // the celebration of a day the collection is holding.
    const willShowStreak = streakAdvanced;
    if (!willShowStreak) {
      setShowResults(true);
      setKeyboardLeaving(true);
      setShowStreakDialog(false);
      setAwaitingWordAnimations(false);
      return;
    }

    // Let the player see the fully resolved sentence for one clean beat before the
    // full-screen progression celebration begins. The keyboard stays put underneath
    // the modal — its exit beat (kb-drop) is VISIBLE choreography, so it waits for
    // the celebration's dismissal (decided 2026-07-24) instead of playing covered.
    const timer = window.setTimeout(() => {
      setShowResults(true);
      setShowStreakDialog(true);
      setAwaitingWordAnimations(false);
    }, STREAK_AFTER_WORDS_MS);
    return () => window.clearTimeout(timer);
  }, [allWordsResolved, awaitingWordAnimations, streakAdvanced]);

  const dismissStreakDialog = useCallback(() => {
    // StreakDialog calls this only AFTER its 200ms exit fade. On a streak solve it is
    // the exit choreography's start line (decided 2026-07-24): the keyboard drop held
    // still behind the modal so it plays in view now. The DISSOLVE does not start here —
    // the sequence is STREAK -> keyboard exit -> DISSOLVE -> the stage, so the sentence
    // waits for the drop to finish before it starts going out.
    //
    // NOTHING is focused when the solved stage later lands (decided 2026-07-27): buttons
    // are pointer-only app-wide, so the result actions remain unfocused by construction.
    setShowStreakDialog(false);
    setKeyboardLeaving(true);
  }, []);

  // The dissolve reporting itself finished is what swaps the screen: DissolvePhrase has
  // eroded every letter (plus its own closing breath), and the solved stage may rise.
  const finishDissolve = useCallback(() => {
    setDissolved(true);
  }, []);

  // --- the hole WHEEL (2026-09-01, replacing the history modal; 2026-08-10's own
  // replacement of the #117 route map): each hole opens the round's guess log ranked against
  // its own secret, as one column scrolling through the word's own place. Numbering is by DISTINCT secret in sentence
  // order (1..3) — the same numbers the run ruler's ticks and the share row's keycaps use —
  // so two occurrences of one secret, which share a rank map, share a number. A history
  // needs no #115 geometry, so EVERY hole has one.
  const holeNumbers = useMemo<number[]>(() => {
    const order: string[] = [];
    for (const h of puzzleHoles) if (!order.includes(h.secret.slug)) order.push(h.secret.slug);
    return puzzleHoles.map((h) => order.indexOf(h.secret.slug) + 1);
  }, [puzzleHoles]);
  const [historyHole, setHistoryHole] = useState<number | null>(null);
  // A PICK (the wheel): the hole shows one of its own earlier words in place of its best, so
  // the sentence can be read with that word in it. DISPLAY ONLY — the round's state, the
  // score, the progress and the history all read the real `holes` — and it lasts until the
  // hole IMPROVES: `at` records the real rank the pick was made against, and the moment that
  // rank moves the new best takes the hole back. A pick at the hole's own rank is simply the
  // hole. Never persisted: a reading aid, not a fact about the round.
  const shownHoles = useMemo(
    () =>
      holes.map((h, i) => {
        const p = picked[i];
        return p && h.rank > 0 && p.at === h.rank && p.rank !== h.rank
          ? { ...h, word: p.word, rank: p.rank }
          : h;
      }),
    [holes, picked],
  );
  const pickWord = useCallback(
    (index: number, stop: HistoryStop) => {
      const at = holes[index]?.rank;
      if (at === undefined || at === 0) return;
      setPicked((cur) => ({ ...cur, [index]: { word: stop.display, rank: stop.rank, at } }));
    },
    [holes],
  );
  // Tapping a hole is available during normal play only, since the 2026-08-14 redesign:
  // once the solving beats begin, the sentence belongs to the choreography (and then
  // dissolves), and the tap moves to the solved stage's own word buttons — which are
  // never disabled, because they only exist once every beat that owned the sentence is
  // over. The rules GATE does NOT disable the holes: its own copy teaches the tap, so the
  // gesture must work while the line that teaches it is on screen.
  //
  // `promptExiting` covers the START of those beats: the prompt leaves on the solving
  // submit while the holes are still resolving, so `boardComplete` — which only follows the
  // last word's settle — has not turned over yet.
  const exploreDisabled = promptExiting || boardComplete || finished;
  // Stable for the round: the button wraps the hole for the WHOLE round or not at all, and
  // the gating above only disables it — unwrapping mid-round would remount the word while
  // its scramble is running. These are the buttons' DESCRIPTIONS, not their names: a hole is
  // named by the word and exponent it shows, which is the clue (see Hole/Phrase).
  const exploreLabels = useMemo<string[]>(
    () => holeNumbers.map((n) => ariaHoleHistory(lang, n)),
    [holeNumbers, lang],
  );
  // The solved stage's word row (2026-08-14): the DISTINCT secrets in sentence order —
  // the ruler ticks' own numbering — each carrying the first hole index of its secret,
  // which is all the history modal needs (occurrences of one secret share a rank map and
  // a log).
  const solvedWords = useMemo(
    () =>
      puzzleHoles.flatMap((h, holeIndex) =>
        puzzleHoles.findIndex((p) => p.secret.slug === h.secret.slug) === holeIndex
          ? [{ word: h.secret.word, holeIndex, number: holeNumbers[holeIndex] }]
          : [],
      ),
    [puzzleHoles, holeNumbers],
  );
  const historyModel = useMemo(() => {
    if (historyHole === null) return null;
    const hole = holes[historyHole];
    const puzzleHole = puzzleHoles[historyHole];
    if (!hole || !puzzleHole) return null;
    const rankMap = ranks[hole.secret];
    if (!rankMap) return null;
    return buildHistory({
      rankMap,
      tried: history,
      hole,
      startRank: puzzleHole.start_rank,
      secretWord: puzzleHole.secret.word,
    });
  }, [historyHole, holes, puzzleHoles, ranks, history]);
  const closeHistory = useCallback(() => {
    setHistoryHole(null);
  }, []);
  // A COMPLETED hole (rank 0) opens the words MODAL — there is nothing to swap in — whether
  // or not the rest of the sentence is done (user-decided 2026-09-01); an open hole opens
  // the WHEEL, and only the wheel veils the word beneath it.
  const wheelOpen = historyHole !== null && holes[historyHole]?.rank !== 0;
  // The wheel measures the tapped word itself (`data-hole-explore`), so opening is only
  // naming the hole.
  const openHistory = useCallback((index: number) => {
    setHistoryHole(index);
  }, []);

  // --- #129: the ambient letter wave ---
  // EVERY hole runs its own clock (see Hole), so several words can stir at once and on their
  // own rhythms. All the round contributes is the one fact a hole cannot see for itself: that
  // the SENTENCE is quiet. Guess feedback owns these words while it plays, and the history
  // modal owns the screen while it is open, so the affordance stands down for both — and once
  // the round is over, stillness is what "done" looks like. The rules gate is NOT a veto:
  // the holes are live under it (the gate teaches the tap), so the wave advertises them.
  const quiet =
    !boardComplete && !finished && !promptExiting && historyHole === null && hits.length === 0;

  const removeHit = useCallback((id: number) => {
    setHits((prev) => prev.filter((h) => h.id !== id));
  }, []);

  // Input mutations shared by the on-screen keyboard (taps) and the physical keyboard.
  // Every path clears the "does not exist" feedback as soon as the player edits again.

  // Append one slug char, but ONLY if it keeps the input a prefix of some real word
  // (the same rule that greys the on-screen key). A dead-end char shakes the prompt
  // instead of being silently dropped: the on-screen keys grey out and shake in place,
  // but physical typing has no key to look at — without feedback a swallowed letter
  // reads as broken input. Shake only, no "does not exist" message (that one is about
  // a submitted word).
  const appendChar = useCallback(
    (char: string) => {
      if (promptExiting) return;
      setFeedback(null);
      if (canExtend(prefixSet, input, char)) setInput(input + char);
      else setInvalidAt(Date.now());
    },
    [prefixSet, input, promptExiting],
  );

  const deleteChar = useCallback(() => {
    if (promptExiting) return;
    setFeedback(null);
    setInput((cur) => cur.slice(0, -1));
  }, [promptExiting]);

  // Replace the whole input (physical-keyboard history recall). Recalled values are
  // past valid words, hence valid prefixes, so no re-validation is needed.
  const replaceInput = useCallback((v: string) => {
    if (promptExiting) return;
    setFeedback(null);
    setInput(v);
  }, [promptExiting]);

  const submit = useCallback(
    (raw: string) => {
      // A board already complete takes no more guesses, and neither does a round the server
      // has closed — solved (frozen) or capped.
      if (boardComplete || finished || promptExiting) return;
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
        setFeedback(t(lang, 'notAWord'));
        say(t(lang, 'notAWord'));
        return;
      }

      // Know at submit time whether this valid guess closes every remaining hole. Start
      // the prompt exit NOW — in the same React commit as the final hit indicators —
      // instead of waiting for the deferred board swap, let alone for the server.
      const solvesAll = holes.every((h) => h.rank === 0 || ranks[h.secret][typed]?.rank === 0);
      setInput('');
      setFeedback(null);
      if (solvesAll) setPromptExiting(true);
      // Counted guess: a unique valid word (misses included). Deduplicated against the PLAY
      // LOG by canonical identity (guessKey), so repeats, inflections of an already-played
      // word (#104) and the non-existent words returned above never increase the score. A
      // NEW guess goes straight into the outbox — the server's copy catches up behind the
      // board's reaction, and nothing waits for that write.
      const id = guessKey(ranks, typed);
      const isNew = !playLog.some((g) => guessKey(ranks, g) === id);
      if (isNew) {
        appendOutbox(roundKey, revision, typed);
        notifyGuess(roundKey);
        // The board is a REPLAY of the log, so this guess would land on it in the very next
        // render. Hold it back until its floating hit fades — the deferral is the swap's
        // choreography, and the release below is what applies it.
        setDeferred((cur) => [...cur, id]);
      }

      // EVERY unsolved hole reacts to a valid guess (solved holes are locked out).
      // A hole is WARM when `typed` is in its top-K rank map (`entry` set) and TOO
      // FAR otherwise (`entry` undefined). Built in sentence order so the floating
      // feedback below staggers left-to-right.
      const impacted = holes.flatMap((h, index) => {
        if (h.rank === 0) return [];
        const entry: RankEntry | undefined = ranks[h.secret][typed];
        return [{ index, entry }];
      });

      // Announce the guess's outcome to assistive tech — the audible twin of the
      // floating numbers below. One sentence covering every impacted hole (1-based, in
      // sentence order). The solved fanfare stays last when this guess finishes the round.
      const parts = impacted.map(({ index, entry }) =>
        srHoleResult(lang, index + 1, entry ? entry.rank : null),
      );
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
        const startDelayMs = step * STAGGER_MS;
        const hit = (hitId.current += 1);
        setHits((prev) => [
          ...prev,
          entry != null
            ? { holeIndex: index, value: entry.rank, id: hit, startDelayMs, fadeDelayMs }
            : { holeIndex: index, value: 0, id: hit, startDelayMs, fadeDelayMs, miss: true },
        ]);
      });

      // RELEASE the guess into the board as its floating hits start fading out: every hole
      // it improves swaps to the closer accented word and lower rank together, and Hole
      // stages the rest (decrease the exponent one rank at a time, then scramble out the
      // old word and reveal the new one). ONE timer for the whole guess — the replay
      // decides which holes move, so there is nothing per-hole to schedule and nothing to
      // keep monotonic: two guesses released out of order still land on the same board.
      if (isNew) {
        const timer = window.setTimeout(() => {
          pendingTimers.current = pendingTimers.current.filter((t) => t !== timer);
          setDeferred((cur) => cur.filter((entry) => entry !== id));
        }, fadeDelayMs);
        pendingTimers.current.push(timer);
      }
    },
    [
      holes,
      playLog,
      ranks,
      boardComplete,
      finished,
      promptExiting,
      vocabSet,
      appendOutbox,
      revision,
      lang,
      say,
      roundKey,
    ],
  );

  // The game is deliberately NETWORK-DEPENDENT at load (#214): the board is replayed from
  // the server's own log, so until that read settles there is nothing honest to show and
  // nothing to type into. A FAILED read is said out loud with a RETRY rather than silently
  // starting the player on a guessed local mirror — the guesses they would then type would
  // be answers to a board the server disagrees with.
  if (load.status === 'failed') {
    return (
      <LoadError
        message={t(lang, 'failedRound')}
        lang={lang}
        onRetry={() => retryRoundSync(roundKey)}
      />
    );
  }
  if (load.status !== 'ready') {
    return (
      <p className="status">
        <LoadingWave text={t(lang, 'loading')} />
      </p>
    );
  }

  return (
    <div className="game">
      {/* Invisible live region: the screen-reader mirror of the per-hole visual
          feedback (see `say`). Polite, so it never interrupts the player's own typing
          echo mid-word. */}
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>

      {showResults && dissolved ? (
        /* The SOLVED STAGE (user-decided 2026-08-14): the sentence has dissolved, so the
           result takes the WHOLE column the play area and the tray used to split — the
           source typed big, the guessed words (still the history tap), the score over its
           ruler, the day's population, SHARE on the bottom edge. The tray goes with the
           keyboard: nothing left down there to reserve a footprint for. */
        <SolvedScreen
          guessCount={guessCount}
          trajectory={trajectory}
          dayNumber={dayNumber}
          lang={lang}
          // A capped round has no solve to tick and no count to name: it ends at `∞`
          // (#214), with the answer and the credit shown like any other finished round.
          solvedAt={capped ? undefined : solvedAt}
          capped={capped}
          source={source}
          words={solvedWords}
          onExplore={openHistory}
          veiledHole={wheelOpen ? historyHole : null}
          placement={placement}
          animate={animateResults}
          // The dev `?streak=N` preview (App owns that dialog, so this round never sees it
          // in `showStreakDialog`) opens over an ALREADY-SOLVED day, where the stage is
          // mounted from the first frame. Without this it would play its whole reveal —
          // words, citation, tally, standing — under a full-screen modal, and dismissal
          // would land on a finished frame: the exact choreography the harness exists to
          // replay, spent unseen. The prop flips false on dismissal, which is the cue.
          start={!deferResultsAnimation}
        />
      ) : (
        <>
          {/* The play area fills the space between the fixed HUD (top) and the keyboard
              (bottom) and centers its content, so the sentence + prompt sit in the middle.
              It also anchors the score watermark, so the big try count stays centered
              behind THIS content rather than the full-height .game. */}
          <div className="play">
            {/* The sentence, through every phase that owns it: the live holes/hits while
                playing, the fully resolved sentence through the solving beats — and then
                its EXIT: once the keyboard has dropped (`resultsUp`), the live Phrase
                hands its exact pixels to DissolvePhrase, which erodes them letter by
                letter and reports done (the stage swap above). The wrapper anchors the
                score watermark behind the phrase (z-index:-1 in .play's isolated stacking
                context), printed on the background's 24px cells (CellDigits); it fades
                with the dissolve — the count's next appearance is the stage's headline. */}
            <div className={`phrase-anchor${resultsUp ? ' dissolving' : ''}`}>
              <div className="progress-background" aria-hidden="true">
                <CellDigits value={guessCount} />
              </div>
              {resultsUp ? (
                <DissolvePhrase words={words} puzzleHoles={puzzleHoles} onDone={finishDissolve} />
              ) : (
                <Phrase
                  words={words}
                  holes={shownHoles}
                  puzzleHoles={puzzleHoles}
                  hits={hits}
                  onHitDone={removeHit}
                  onHoleResolved={markHoleResolved}
                  exploreLabels={exploreLabels}
                  exploreDisabled={exploreDisabled}
                  onExplore={openHistory}
                  quiet={quiet}
                  veiledHole={wheelOpen ? historyHole : null}
                />
              )}
            </div>

            {/* Below the sentence: the prompt. It exits on the solving submit and stays
                laid out (retired, invisible) through the streak and the dissolve, so the
                centered sentence never moves while it erodes. (The source citation no
                longer overlays here — since the 2026-08-14 redesign it belongs to the
                solved stage, so an unsolved round's DOM never carries it at all.) */}
            <div className="prompt-zone">
              <div
                className={`input-area${promptExiting ? ' solving' : ''}${
                  showResults || gateOpen ? ' retired' : ''
                }`}
                aria-hidden={promptExiting || showResults || gateOpen || undefined}
              >
                <WordInput
                  value={input}
                  history={history}
                  onType={appendChar}
                  onBackspace={deleteChar}
                  onSubmit={submit}
                  onReplace={replaceInput}
                  invalidSignal={invalidAt}
                  // The history modal covers the prompt: keystrokes must not build (or submit)
                  // a guess the player cannot see behind it. The gate holds it back the same
                  // way — the prompt arrives with the keyboard, on PLAY.
                  active={!showResults && historyHole === null && !gateOpen}
                />
                <p className="hint">{feedback || ' '}</p>
              </div>
            </div>
          </div>

          {/* Bottom zone (fixed keyboard-height footprint): the on-screen keyboard, or the
              gate. The keyboard lingers (inert; submit is guarded) through the last hole's
              animation, then slides down out of the tray (#110); the tray then sits empty
              under the dissolving sentence until the stage takes the whole column. */}
          <div
            className={`tray${keyboardLeaving ? ' kb-leaving' : ''}${
              gateOpen ? ' tray-gate' : ''
            }`}
          >
            {gateOpen ? (
              /* The GATE, in the keyboard's own footprint: the rules in the app's shared
                 dialog box (`.coach-rules` — the tutorial's coach, so one design says "this
                 is here to help" everywhere), bulleted, and the PLAY that dismisses them for
                 good — the tutorial's own full-width button, so the graduation and the gate
                 speak one language. */
              <div className="rules-gate">
                <p className="sr-only">{gateRules}</p>
                <div className="coach-rules" aria-hidden="true">
                  <CoachText copy={gateRules} />
                </div>
                <button
                  type="button"
                  className="mix-btn"
                  onClick={handleGatePlay}
                  disabled={deploying}
                >
                  {deploying ? <LoadingWave text={t(lang, 'loading')} /> : t(lang, 'gatePlay')}
                </button>
              </div>
            ) : resultsUp ? null : (
              <div
                className={`kb-exit${keyboardLeaving ? ' leaving' : ''}`}
                onAnimationEnd={(e) => {
                  // Child animations (key shakes) bubble here too: only the wrapper's own
                  // kb-drop end releases the tray (and lets the dissolve begin).
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
        </>
      )}

      {/* The deploy's failure, on the app's error surface: what happened, and TRY AGAIN
          re-runs the same single-tap chain. */}
      {deployFailed && (
        <ErrorScreen
          lang={lang}
          title={t(lang, 'failedAccount')}
          note={t(lang, 'failedAccountNote')}
          onRetry={handleGatePlay}
          onClose={() => setDeployFailed(false)}
        />
      )}

      {showStreakDialog && (
        <LazyStreakDialog lang={lang} solvedDay={dayNumber} onDismiss={dismissStreakDialog} />
      )}

      {/* One hole's found words (2026-09-01): a COMPLETED hole opens them as a plain grid in
          the full-screen words modal; an open hole opens the WHEEL, scrolling them through
          the word's own place. Fully derived from (tried, ranks), so it survives a reload
          for free like everything else. The hub is what the tapped control SHOWS — a pick
          included — and picking is play-only. */}
      {historyModel && historyHole !== null && !wheelOpen && (
        <HistoryModal
          model={historyModel}
          number={holeNumbers[historyHole]}
          lang={lang}
          onClose={closeHistory}
        />
      )}
      {historyModel && historyHole !== null && wheelOpen && (
        <HistoryWheel
          model={historyModel}
          hub={{ word: shownHoles[historyHole].word, rank: shownHoles[historyHole].rank }}
          hostIndex={historyHole}
          number={holeNumbers[historyHole]}
          lang={lang}
          onPick={exploreDisabled ? undefined : (stop) => pickWord(historyHole, stop)}
          onClose={closeHistory}
        />
      )}
    </div>
  );
}
