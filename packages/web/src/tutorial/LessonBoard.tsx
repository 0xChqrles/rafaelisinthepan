import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Phrase from '../components/Phrase';
import WordInput from '../components/WordInput';
import Keyboard from '../components/Keyboard';
import LoadError from '../components/LoadError';
import LoadingWave from '../components/LoadingWave';
import CellDigits from '../components/CellDigits';
import HistoryWheel from '../components/HistoryWheel';
import HistoryModal from '../components/HistoryModal';
import { HIT_FADE_MS } from '../components/FloatingHit';
import { RANK_MAX_MS, rankTransitionDuration } from '../components/Hole';
import { FLOATING_HIT_INTRO_MS, KB_EXIT_FALLBACK_MS, STAGGER_MS } from '../screens/Game';
import CoachText, { richToPlain } from './CoachText';
import { coachCopy, coachLine, type GuessEvent } from './coach';
import type { LessonStage } from './script';
import { canExtend } from '../game/keyboard';
import { buildHistory, type HistoryStop } from '../game/history';
import { guessKey, replayHoles } from '../game/scoring';
import { chargeForRank, initialOf, replayCharge } from '../game/charge';
import { sentenceStarts } from '../game/sentenceCase';
import { SCRAMBLE_MS } from '../hooks/useScramble';
import type { Vocab } from '../hooks/useVocab';
import { fold } from '@whippin/shared';
import type { HitState, RankEntry, RankMap, RuntimeHole } from '@whippin/shared';
import { t, ariaHoleHistory, srHoleCharge, srHoleInitial, srHoleResult } from '../i18n';
import type { LangCode } from '../langs';
import botIdle from '../assets/error-bot-idle.png';

// ONE STAGE OF THE LESSON, PLAYED (#269): a real board in the real game components, the real
// keyboard and the real vocabulary from the first frame, and a coach that speaks only when a
// guess calls for it (coach.ts). Screen contract, unchanged since #51: the explanation in the
// TOP box (typewritten, in-game word styling), the board in the middle, INTERACTIONS at the
// bottom. No modals but the tries, no NEXT, no SKIP in the body (the header is the exit) —
// the flow advances by playing.
//
// The same guess loop as Game.submit, on LOCAL state: a lesson board is never a round — it
// touches no outbox, no server, no `rounds` — so it is deliberately NOT Round. What it keeps
// of the round's grammar is what the player will meet on the day: one guess tried on every
// open hole, a floating number or MISS per hole, the closer word swapped in as the number
// fades, a tap on a word opening its tries (the wheel while open, the grid once found).
//
// A stage ends when every hole reads 0. A NON-FINAL stage rolls into the next one without a
// word (`onComplete`, after the last swap has settled); the FINAL stage drops the keyboard
// the way a solved round does and offers PLAY in its place (`onPlay`) — no score screen,
// because a lesson has no score to show.

// The board's holes at their start words — the same shape Game derives from a real puzzle, so
// every component it feeds behaves identically.
function freshHoles(stage: LessonStage): RuntimeHole[] {
  return stage.puzzle.holes.map((h) => ({
    pos: h.pos,
    secret: h.secret.slug,
    word: h.start.word,
    rank: h.start_rank,
    startRank: h.start_rank,
  }));
}
// The reveal's opening frame: the secret itself on the board, at rank 0 (the solved look).
function revealedHoles(stage: LessonStage): RuntimeHole[] {
  return stage.puzzle.holes.map((h) => ({
    pos: h.pos,
    secret: h.secret.slug,
    word: h.secret.word,
    rank: 0,
    startRank: h.start_rank,
  }));
}

function hasCoarsePointer(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  );
}

// Hold on a solved board before the next stage takes over.
const STAGE_HOLD_MS = 600;
// The bot's closing guess (the meter stage): how long after the player's last try has had
// its moment it lands its own.
const BOT_TURN_MS = 700;

export default function LessonBoard({
  lang,
  script,
  vocab,
  vocabError,
  retryVocab,
  final,
  onComplete,
  onPlay,
}: {
  lang: LangCode;
  script: LessonStage;
  vocab: Vocab | null;
  vocabError: unknown | null;
  retryVocab: () => void;
  // The last stage ends on PLAY; any other rolls into the next by itself.
  final: boolean;
  onComplete: () => void;
  onPlay: () => void;
}) {
  const { puzzle, kind: stage } = script;
  const puzzleHoles = puzzle.holes;
  // THE PAIR SWAP (the meter stage; user-decided 2026-09-16): before the letter is out, typing
  // the secret makes it the closest word and `pair.alt` the secret — so the letter is always
  // seen before the solve. ONE map serves both readings: swapped, every rank-0 entry reads 1
  // and every rank-1 entry reads 0, and the board, the meters, the wheel and every later
  // guess replay against that view. The bot then lands `alt`.
  const [swapped, setSwapped] = useState(false);
  const ranks = useMemo<RankMap>(() => {
    if (!swapped || !script.pair) return puzzle.ranks;
    const open = puzzleHoles.find((h) => h.secret.slug !== puzzleHoles[0].secret.slug) ?? puzzleHoles[puzzleHoles.length - 1];
    const map = puzzle.ranks[open.secret.slug];
    const dq1 = Object.values(map).find((e) => e.rank === 1)?.dq;
    const view: typeof map = {};
    for (const [key, entry] of Object.entries(map)) {
      if (entry.rank === 0) view[key] = { word: entry.word, rank: 1, dq: dq1 } as RankEntry;
      else if (entry.rank === 1) view[key] = { word: entry.word, rank: 0 } as RankEntry;
      else view[key] = entry;
    }
    return { ...puzzle.ranks, [open.secret.slug]: view };
  }, [swapped, script.pair, puzzle.ranks, puzzleHoles]);
  // The stage as the coach should read it: the swapped hole's secret is `alt`.
  const stageView = useMemo<LessonStage>(() => {
    if (!swapped || !script.pair) return script;
    const alt = script.pair.alt;
    return {
      ...script,
      puzzle: {
        ...puzzle,
        holes: puzzleHoles.map((h, i) => (i === puzzleHoles.length - 1 ? { ...h, secret: alt } : h)),
      },
    };
  }, [swapped, script, puzzle, puzzleHoles]);
  const viewHoles = stageView.puzzle.holes;
  // A sentence-shaped stage: the game's own layout, the try count behind the sentence, a
  // button (CONTINUE / PLAY) once solved — where a single word rolls on by itself.
  const sentenceLike = stage === 'sentence' || stage === 'meter';
  // THE METER STAGE (#301 taught; scripted, user-decided 2026-09-16): the meters are SHOWN on
  // this stage alone, and the BOT HAS ALREADY PLAYED — `played` is its log, replayed onto the
  // board, the meters and the tries wheel exactly as a round's own log would be. One secret
  // is found; the other's meter stands just under full, so the player's first close guess
  // fills it. The player then tries one more word, and the bot lands the answer itself.
  const withMeters = stage === 'meter';
  const seed = useMemo(() => script.played ?? [], [script]);
  const fresh = useMemo(() => freshHoles(script), [script]);
  const meters = useCallback(
    (log: readonly string[], map: RankMap = ranksRef.current) => replayCharge(fresh, map, log),
    [fresh],
  );

  // THE REVEAL (user-decided 2026-09-16): the secret word is SHOWN first, then hidden in
  // front of the player — its closest word takes its place, wearing a 1 — so the two things
  // the first line names, the secret and the word standing in for it, were both just seen.
  const [revealed, setRevealed] = useState(stage === 'reveal');
  // The player has opened a word's tries at least once (the coach reads it; the meter stage
  // waits on it).
  const [tapped, setTapped] = useState(false);
  // The board's local state — the ephemeral twin of Round's.
  const [holes, setHoles] = useState<RuntimeHole[]>(() =>
    stage === 'reveal' ? revealedHoles(script) : replayHoles(fresh, ranks, seed),
  );
  // The play log: the bot's tries first (the meter stage), then every counted guess — the
  // player's, and the bot's closing one. `events` are the PLAYER's guesses alone (the coach
  // reads those).
  const [tried, setTried] = useState<string[]>(seed);
  const [events, setEvents] = useState<GuessEvent[]>([]);
  const [botFound, setBotFound] = useState(false);
  // The closing guess runs off a timer, after the player's own has settled: read the board
  // as it stands then, not as the closure saw it.
  const triedRef = useRef(tried);
  triedRef.current = tried;
  const ranksRef = useRef(ranks);
  ranksRef.current = ranks;
  const holesRef = useRef(holes);
  holesRef.current = holes;
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const [hits, setHits] = useState<HitState[]>([]);
  const [input, setInput] = useState('');
  const [invalidAt, setInvalidAt] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  // play -> settling (the solving guess's choreography) -> done.
  const [phase, setPhase] = useState<'play' | 'settling' | 'done'>('play');
  const hitId = useRef(0);
  // The prompt's own field (#267): a submit puts the caret back into it.
  const guessField = useRef<HTMLInputElement>(null);
  const coarse = useMemo(hasCoarsePointer, []);

  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.current = timers.current.filter((x) => x !== id);
      fn();
    }, ms);
    timers.current.push(id);
    return id;
  }, []);

  // Screen-reader mirror, same pattern as Game (zero-width flip forces re-announcement).
  const [announce, setAnnounce] = useState('');
  const announceFlip = useRef(false);
  const say = useCallback((text: string) => {
    announceFlip.current = !announceFlip.current;
    setAnnounce(text + (announceFlip.current ? '' : '​'));
  }, []);

  // The meter stage opens WITHOUT the keyboard (user-decided 2026-09-16): the bot's tries are
  // the first thing to see, so the tap on the word comes first, and the keys arrive with the
  // line that hands the turn over.
  const waitingTap = stage === 'meter' && !tapped;
  const playing = phase === 'play' && !revealed && !waitingTap;
  const prefixSet = vocab?.prefixSet ?? null;
  // The reveal WAITS FOR THE PLAYER (user-decided 2026-09-16: "the dialog box should never
  // skip a dialog without the user interacting with the screen", and "it should always be
  // obvious where to click, with a clear action"): ONE button in the tray, where the keyboard
  // will land, named for what it does — HIDE THE WORD. Pressing it is the hiding.
  const hide = useCallback(() => {
    setHoles(freshHoles(script));
    setRevealed(false);
  }, [script]);

  const appendChar = useCallback(
    (char: string) => {
      if (!playing || !prefixSet) return;
      setFeedback(null);
      if (canExtend(prefixSet, input, char)) setInput(input + char);
      else setInvalidAt(Date.now());
    },
    [playing, prefixSet, input],
  );
  const deleteChar = useCallback(() => {
    if (!playing) return;
    setFeedback(null);
    setInput((cur) => cur.slice(0, -1));
  }, [playing]);
  const replaceInput = useCallback(
    (v: string) => {
      if (!playing) return;
      setFeedback(null);
      setInput(v);
    },
    [playing],
  );
  const removeHit = useCallback((id: number) => {
    setHits((prev) => prev.filter((h) => h.id !== id));
  }, []);

  // ONE guess landing on the board — the player's (counted, coached) or the bot's closing
  // one (`byBot`: not a player event, no vocabulary check, the answer by construction).
  const land = useCallback(
    (typed: string, byBot: boolean) => {
      const tried = triedRef.current;
      const holes = holesRef.current;
      let ranks = ranksRef.current;
      // The letter was already out before this guess: this is the player's "one more try",
      // and the bot closes after it (unless the try itself lands).
      const letterOut = eventsRef.current.some((e) => e.filled != null);
      // THE SWAP: the secret typed before the letter is out becomes the closest word, and the
      // obvious word the secret. Read the map through that view from this guess on.
      const open = holes.find((h) => h.rank !== 0);
      if (withMeters && !byBot && !letterOut && !swapped && script.pair && open && ranks[open.secret][typed]?.rank === 0) {
        setSwapped(true);
        const map = ranks[open.secret];
        const dq1 = Object.values(map).find((e) => e.rank === 1)?.dq;
        const view: typeof map = {};
        for (const [key, entry] of Object.entries(map)) {
          if (entry.rank === 0) view[key] = { word: entry.word, rank: 1, dq: dq1 } as RankEntry;
          else if (entry.rank === 1) view[key] = { word: entry.word, rank: 0 } as RankEntry;
          else view[key] = entry;
        }
        ranks = { ...ranks, [open.secret]: view };
      }
      // A counted guess is a NEW word identity (guessKey): a repeat still floats its numbers
      // but teaches nothing new and counts for nothing, as in the game.
      const id = guessKey(ranks, typed);
      const isNew = !tried.some((g) => guessKey(ranks, g) === id);

      // EVERY open hole reacts; a found hole is locked out.
      const impacted = holes.flatMap((h, index) => {
        if (h.rank === 0) return [];
        const entry: RankEntry | undefined = ranks[h.secret][typed];
        return [{ index, entry }];
      });
      const fadeDelayMs = Math.max(0, impacted.length - 1) * STAGGER_MS + FLOATING_HIT_INTRO_MS;
      // The meters before and after this guess (the meter stage only): what each chip gains
      // flies into it as loot, exactly as on the day (#301).
      const before = withMeters ? meters(tried, ranks) : null;
      const after = withMeters && isNew ? meters([...tried, typed], ranks) : before;
      impacted.forEach(({ index, entry }, step) => {
        const hit = (hitId.current += 1);
        const gained = before && after ? after[index].charge - before[index].charge : 0;
        const strike =
          entry?.rank === 0
            ? ('ultra' as const)
            : withMeters && isNew && chargeForRank(entry?.rank) > 0
              ? ('slash' as const)
              : undefined;
        setHits((prev) => [
          ...prev,
          entry != null
            ? {
                holeIndex: index,
                value: entry.rank,
                id: hit,
                startDelayMs: step * STAGGER_MS,
                fadeDelayMs,
                strike,
                charge: strike === 'slash' && gained > 0 ? gained : undefined,
              }
            : { holeIndex: index, value: 0, id: hit, startDelayMs: step * STAGGER_MS, fadeDelayMs, miss: true },
        ]);
      });

      const improved = holes.map((h, i) => {
        const entry = impacted.find((x) => x.index === i)?.entry;
        return entry != null && entry.rank < h.rank;
      });
      if (improved.some(Boolean)) {
        // The closer word and lower rank land as the number begins to fade; Hole stages the
        // rest (the exponent ticks down, the letters scramble over).
        later(
          () =>
            setHoles((prev) =>
              prev.map((h, i) => {
                const entry = impacted.find((x) => x.index === i)?.entry;
                return entry != null && entry.rank < h.rank ? { ...h, word: entry.word, rank: entry.rank } : h;
              }),
            ),
          fadeDelayMs,
        );
      }
      if (isNew) {
        setTried((prev) => [...prev, typed]);
        if (!byBot) {
          const filled =
            before && after ? after.findIndex((c, i) => c.revealed && !before[i].revealed) : -1;
          setEvents((prev) => [
            ...prev,
            {
              typed,
              entries: holes.map((h) => (h.rank === 0 ? undefined : ranks[h.secret][typed])),
              improved,
              charged: !!before && !!after && after.some((c, i) => c.charge > before[i].charge),
              filled: filled >= 0 ? filled : null,
            },
          ]);
        }
      }

      const solvesAll = holes.every((h) => h.rank === 0 || ranks[h.secret][typed]?.rank === 0);
      const parts = impacted.map(({ index, entry }) =>
        srHoleResult(lang, index + 1, entry ? entry.rank : null),
      );
      say(solvesAll ? [...parts, t(lang, 'srSolvedAll')].join(', ') : parts.join(', '));

      if (solvesAll) {
        // A swapped Hole holds its exponent tween (RANK_MAX_MS) then settles the letters over
        // SCRAMBLE_MS, so its word finishes last. Wait for the slower of that, the rank tween
        // and the floating hit's fade before the stage ends.
        const settleMs =
          fadeDelayMs +
          Math.max(
            HIT_FADE_MS,
            ...impacted.map(({ index, entry }) =>
              entry != null && entry.rank < holes[index].rank
                ? Math.max(rankTransitionDuration(holes[index].rank, entry.rank), RANK_MAX_MS + SCRAMBLE_MS)
                : 0,
            ),
          ) +
          250;
        if (byBot) setBotFound(true);
        setPhase('settling');
        later(() => setPhase('done'), settleMs);
      } else if (withMeters && !byBot && isNew && letterOut) {
        // The bot's turn: it names the answer as if it had found it, once the player's try
        // has had its moment on the board.
        if (open) {
          // The answer under the current view: `alt` once swapped, the secret otherwise.
          const answer = Object.entries(ranks[open.secret]).find(([, e]) => e.rank === 0)?.[0] ?? open.secret;
          setPhase('settling');
          later(() => land(answer, true), fadeDelayMs + HIT_FADE_MS + BOT_TURN_MS);
        }
      }
    },
    [withMeters, swapped, script.pair, meters, lang, say, later],
  );

  const submit = useCallback(
    (raw: string) => {
      if (!playing || !vocab) return;
      guessField.current?.focus({ preventScroll: true });
      const typed = fold(raw);
      if (!typed) {
        setInput('');
        return;
      }
      // Existence is decided by the real vocabulary, exactly as in-game: an unknown word
      // shakes + says so and reaches no hole.
      if (!vocab.vocabSet.has(typed)) {
        setInvalidAt(Date.now());
        setFeedback(t(lang, 'notAWord'));
        say(t(lang, 'notAWord'));
        return;
      }
      setInput('');
      setFeedback(null);
      land(typed, false);
    },
    [playing, vocab, lang, say, land],
  );

  // --- the stage's end ---
  const done = phase === 'done';
  useEffect(() => {
    if (done && !final && !sentenceLike) later(onComplete, STAGE_HOLD_MS);
  }, [done, final, sentenceLike, later, onComplete]);
  // A sentence solved: the keyboard leaves the way it does in a solved round, and the button
  // renders only once it is gone (`kbGone`) — with the same deadline as Game's identical
  // beat, so a lost `animationend` cannot strand the player. The button is PLAY on the last
  // stage and CONTINUE before it: the solved line stands until the player acts on it (the
  // coach never skips a line without an interaction).
  const ending = done && (final || sentenceLike);
  const [kbGone, setKbGone] = useState(false);
  useEffect(() => {
    if (ending) later(() => setKbGone(true), KB_EXIT_FALLBACK_MS);
  }, [ending, later]);

  // --- the tries: a tap on a word (the wheel while open, the grid once found) ---
  const [historyHole, setHistoryHole] = useState<number | null>(null);
  const [picked, setPicked] = useState<Record<number, { word: string; rank: number; at: number }>>({});
  const exploreLabels = useMemo(() => holes.map((_, i) => ariaHoleHistory(lang, i + 1)), [holes, lang]);
  const openHistory = useCallback((index: number) => {
    setHistoryHole(index);
    setTapped(true);
  }, []);
  const closeHistory = useCallback(() => setHistoryHole(null), []);
  const wheelOpen = historyHole !== null && holes[historyHole]?.rank !== 0 && phase === 'play' && !revealed;
  const shownHoles = useMemo(
    () =>
      holes.map((h, i) => {
        const p = picked[i];
        return p && h.rank > 0 && p.at === h.rank && p.rank !== h.rank ? { ...h, word: p.word, rank: p.rank } : h;
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
  const historyModel = useMemo(() => {
    if (historyHole === null) return null;
    const hole = holes[historyHole];
    const puzzleHole = puzzleHoles[historyHole];
    if (!hole || !puzzleHole) return null;
    return buildHistory({
      rankMap: ranks[hole.secret],
      tried,
      hole,
      startRank: puzzleHole.start_rank,
      secretWord: viewHoles[historyHole].secret.word,
    });
  }, [historyHole, holes, puzzleHoles, viewHoles, ranks, tried]);

  // --- the coach: the one line the board's state calls for, or nothing ---
  const line = useMemo(
    () =>
      coachLine({ stage, holes, events, tapped, revealed, finished: phase !== 'play', botFound }),
    [phase, stage, holes, events, tapped, revealed, botFound],
  );
  const coach = line ? coachCopy(lang, line, stageView, coarse) : null;
  // THE BOX NEVER DISAPPEARS (user-decided 2026-09-16): a beat with nothing new to say keeps
  // the last line up rather than blanking the dialog.
  const lastCoach = useRef<string | null>(null);
  if (coach) lastCoach.current = coach;
  const shownCoach = coach ?? lastCoach.current;
  // Announce each new line once, in plain text (the visible typewriter is aria-hidden).
  useEffect(() => {
    if (coach) say(richToPlain(coach));
  }, [coach, say]);

  const quiet = playing && historyHole === null && hits.length === 0;
  const starts = sentenceStarts(puzzle.words);
  // The meters as the sentence shows them (the meter stage only): the reading, the initial
  // once revealed, and the sr-only description in the meter's place (#301).
  const charges = useMemo(() => {
    if (!withMeters) return undefined;
    return meters(tried).map((c, i) => {
      const initial = c.revealed ? initialOf(viewHoles[i].secret.word) : null;
      const hint =
        holes[i].rank === 0 ? '' : initial !== null ? srHoleInitial(lang, initial) : srHoleCharge(lang, c.charge);
      return { value: c.charge, initial, hint };
    });
  }, [withMeters, meters, tried, viewHoles, holes, lang]);

  return (
    // tutorial--word: the word stage is deliberately CLEAN — one big centered word in the
    // middle; the sentence stage wears the game's own layout.
    <div className={`game tutorial${sentenceLike ? '' : ' tutorial--word'}`}>
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>

      {/* THE COACH IS THE ERROR BOT (user-decided 2026-09-16: "people would want to read it
          more if it's something telling it"): the game's one character stands on the box and
          speaks it — the same sprite, the same idle bob, as on the error screen. */}
      {shownCoach && (
        <div className="coach coach--bot">
          <div className="coach-bot" aria-hidden style={{ backgroundImage: `url(${botIdle})` }} />
          <CoachText key={shownCoach} copy={shownCoach} />
        </div>
      )}

      <div className="play">
        {/* The hiding PLAYS as the game's own word change (user-decided 2026-09-16): the Hole
            scrambles the secret's letters into its stand-in's while the exponent arrives —
            the same choreography every improving guess gets — so the player SEES one word
            become the other, no remount. */}
        <div className="phrase-anchor">
          {/* The sentence stage shows the try count behind the sentence, as the day does:
              fewer tries is the score, and the number says so without a word. */}
          {sentenceLike && (
            <div className="progress-background" aria-hidden="true">
              <CellDigits value={events.length} />
            </div>
          )}
          <Phrase
            words={puzzle.words}
            holes={shownHoles}
            puzzleHoles={puzzleHoles}
            hits={hits}
            onHitDone={removeHit}
            exploreLabels={exploreLabels}
            // The tap works whenever the board is live — including while the meter stage
            // waits for exactly that tap.
            exploreDisabled={phase !== 'play' || revealed}
            onExplore={openHistory}
            quiet={quiet}
            veiledHole={wheelOpen ? historyHole : null}
            // A lone word is a word, not a sentence: no capital on the word stages.
            capital={sentenceLike}
            charges={charges}
          />
        </div>
        {/* Once there is nothing left to type the prompt retires in place — still laid out,
            so the board does not move, but invisible and inert. */}
        {/* …and the reveal has nothing to type yet (the button below is the one action), nor
            has the meter stage before the tap. */}
        <div
          className={`input-area${ending || revealed || waitingTap ? ' retired' : ''}`}
          aria-hidden={ending || revealed || waitingTap || undefined}
        >
          <WordInput
            value={input}
            history={tried}
            lang={lang}
            fieldRef={guessField}
            onType={appendChar}
            onBackspace={deleteChar}
            onSubmit={submit}
            onReplace={replaceInput}
            invalidSignal={invalidAt}
            active={playing && historyHole === null}
          />
          <p className="hint">{feedback || ' '}</p>
        </div>
      </div>

      {/* The bottom is for INTERACTIONS: the keyboard — which drops away at the very end,
          leaving one button under the solved sentence. */}
      <div className={`tray${ending && !kbGone ? ' kb-leaving' : ''}`}>
        {vocabError ? (
          <LoadError message={t(lang, 'failedVocab')} lang={lang} onRetry={retryVocab} />
        ) : !vocab ? (
          <p className="status">
            <LoadingWave text={t(lang, 'loading')} />
          </p>
        ) : kbGone ? (
          <button type="button" className="mix-btn" onClick={final ? onPlay : onComplete}>
            {t(lang, final ? 'tutPlay' : 'tutContinue')}
          </button>
        ) : revealed ? (
          // The reveal's one action, in the keyboard's place: the keyboard takes over the
          // moment the word is hidden (the tutorial's oldest gesture — "the button moves down,
          // the keyboard moves up").
          <button type="button" className="mix-btn" onClick={hide}>
            {t(lang, 'tutContinue')}
          </button>
        ) : waitingTap ? null : (
          <div
            className={`kb-exit${ending ? ' leaving' : ''}`}
            onAnimationEnd={(e) => {
              // Child animations (key shakes) bubble here too: only the wrapper's own
              // kb-drop end unmounts it.
              if (ending && e.target === e.currentTarget) setKbGone(true);
            }}
          >
            <Keyboard
              input={input}
              prefixSet={vocab.prefixSet}
              vocabSet={vocab.vocabSet}
              lang={lang}
              onType={appendChar}
              onBackspace={deleteChar}
              onSubmit={submit}
            />
          </div>
        )}
      </div>

      {historyModel && historyHole !== null && !wheelOpen && (
        <HistoryModal model={historyModel} number={historyHole + 1} lang={lang} onClose={closeHistory} />
      )}
      {historyModel && historyHole !== null && wheelOpen && (
        <HistoryWheel
          model={historyModel}
          hub={{
            word: shownHoles[historyHole].word,
            rank: shownHoles[historyHole].rank,
            meter: charges?.[historyHole]?.value,
          }}
          hostIndex={historyHole}
          number={historyHole + 1}
          lang={lang}
          capital={sentenceLike && starts[puzzleHoles[historyHole].pos] && !puzzleHoles[historyHole].prefix}
          onPick={(stop) => pickWord(historyHole, stop)}
          onClose={closeHistory}
        />
      )}
    </div>
  );
}
