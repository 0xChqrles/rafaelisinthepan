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
import { coachCopy, coachLine, type GuessEvent, type Stage } from './coach';
import type { LessonStage } from './script';
import { canExtend } from '../game/keyboard';
import { buildHistory, type HistoryStop } from '../game/history';
import { guessKey } from '../game/scoring';
import { sentenceStarts } from '../game/sentenceCase';
import { SCRAMBLE_MS } from '../hooks/useScramble';
import type { Vocab } from '../hooks/useVocab';
import { fold } from '@whippin/shared';
import type { HitState, RankEntry, RuntimeHole } from '@whippin/shared';
import { t, ariaHoleHistory, srHoleResult } from '../i18n';
import type { LangCode } from '../langs';

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

function hasCoarsePointer(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  );
}

// Hold on a solved board before the next stage takes over.
const STAGE_HOLD_MS = 600;

export default function LessonBoard({
  lang,
  stage,
  script,
  vocab,
  vocabError,
  retryVocab,
  final,
  onComplete,
  onPlay,
}: {
  lang: LangCode;
  stage: Stage;
  script: LessonStage;
  vocab: Vocab | null;
  vocabError: unknown | null;
  retryVocab: () => void;
  // The last stage ends on PLAY; any other rolls into the next by itself.
  final: boolean;
  onComplete: () => void;
  onPlay: () => void;
}) {
  const { puzzle } = script;
  const { ranks } = puzzle;
  const puzzleHoles = puzzle.holes;

  // The board's local state — the ephemeral twin of Round's.
  const [holes, setHoles] = useState<RuntimeHole[]>(() => freshHoles(script));
  const [events, setEvents] = useState<GuessEvent[]>([]);
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

  const playing = phase === 'play';
  const prefixSet = vocab?.prefixSet ?? null;

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

  const tried = useMemo(() => events.map((e) => e.typed), [events]);

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
      impacted.forEach(({ index, entry }, step) => {
        const hit = (hitId.current += 1);
        setHits((prev) => [
          ...prev,
          entry != null
            ? {
                holeIndex: index,
                value: entry.rank,
                id: hit,
                startDelayMs: step * STAGGER_MS,
                fadeDelayMs,
                strike: entry.rank === 0 ? ('ultra' as const) : undefined,
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
        setEvents((prev) => [
          ...prev,
          {
            typed,
            entries: holes.map((h) => (h.rank === 0 ? undefined : ranks[h.secret][typed])),
            improved,
          },
        ]);
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
        setPhase('settling');
        later(() => setPhase('done'), settleMs);
      }
    },
    [playing, vocab, lang, ranks, tried, holes, say, later],
  );

  // --- the stage's end ---
  const done = phase === 'done';
  useEffect(() => {
    if (done && !final) later(onComplete, STAGE_HOLD_MS);
  }, [done, final, later, onComplete]);
  // The final stage: the keyboard leaves the way it does in a solved round, and PLAY renders
  // only once it is gone (`kbGone`) — with the same deadline as Game's identical beat, so a
  // lost `animationend` cannot strand the player.
  const ending = done && final;
  const [kbGone, setKbGone] = useState(false);
  useEffect(() => {
    if (ending) later(() => setKbGone(true), KB_EXIT_FALLBACK_MS);
  }, [ending, later]);

  // --- the tries: a tap on a word (the wheel while open, the grid once found) ---
  const [historyHole, setHistoryHole] = useState<number | null>(null);
  const [tapped, setTapped] = useState(false);
  const [picked, setPicked] = useState<Record<number, { word: string; rank: number; at: number }>>({});
  const exploreLabels = useMemo(() => holes.map((_, i) => ariaHoleHistory(lang, i + 1)), [holes, lang]);
  const openHistory = useCallback((index: number) => {
    setHistoryHole(index);
    setTapped(true);
  }, []);
  const closeHistory = useCallback(() => setHistoryHole(null), []);
  const wheelOpen = historyHole !== null && holes[historyHole]?.rank !== 0 && playing;
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
      secretWord: puzzleHole.secret.word,
    });
  }, [historyHole, holes, puzzleHoles, ranks, tried]);

  // --- the coach: the one line the board's state calls for, or nothing ---
  const line = useMemo(
    () => (playing ? coachLine({ stage, holes, events, tapped }) : null),
    [playing, stage, holes, events, tapped],
  );
  const coach = line ? coachCopy(lang, line, script, coarse) : null;
  // Announce each new line once, in plain text (the visible typewriter is aria-hidden).
  useEffect(() => {
    if (coach) say(richToPlain(coach));
  }, [coach, say]);

  const quiet = playing && historyHole === null && hits.length === 0;
  const starts = sentenceStarts(puzzle.words);

  return (
    // tutorial--word: the word stage is deliberately CLEAN — one big centered word in the
    // middle; the sentence stage wears the game's own layout.
    <div className={`game tutorial${stage === 'word' ? ' tutorial--word' : ''}`}>
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>

      {coach && (
        <div className="coach">
          <CoachText key={coach} copy={coach} />
        </div>
      )}

      <div className="play">
        <div className="phrase-anchor">
          {/* The sentence stage shows the try count behind the sentence, as the day does:
              fewer tries is the score, and the number says so without a word. */}
          {stage === 'sentence' && (
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
            exploreDisabled={!playing}
            onExplore={openHistory}
            quiet={quiet}
            veiledHole={wheelOpen ? historyHole : null}
          />
        </div>
        {/* Once there is nothing left to type the prompt retires in place — still laid out,
            so the board does not move, but invisible and inert. */}
        <div className={`input-area${ending ? ' retired' : ''}`} aria-hidden={ending || undefined}>
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
          <button type="button" className="mix-btn" onClick={onPlay}>
            {t(lang, 'tutPlay')}
          </button>
        ) : (
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
          hub={{ word: shownHoles[historyHole].word, rank: shownHoles[historyHole].rank }}
          hostIndex={historyHole}
          number={historyHole + 1}
          lang={lang}
          capital={starts[puzzleHoles[historyHole].pos] && !puzzleHoles[historyHole].prefix}
          onPick={(stop) => pickWord(historyHole, stop)}
          onClose={closeHistory}
        />
      )}
    </div>
  );
}
