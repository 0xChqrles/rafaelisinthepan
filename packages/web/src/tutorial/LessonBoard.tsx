import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Phrase from '../components/Phrase';
import DissolvePhrase from '../components/DissolvePhrase';
import WordInput from '../components/WordInput';
import Keyboard from '../components/Keyboard';
import RevealTray from '../components/RevealTray';
import LoadError from '../components/LoadError';
import KeyboardHold from '../components/KeyboardHold';
import { DISSOLVE_MS } from '../components/bayerTiles';
import CellDigits from '../components/CellDigits';
import HistoryWheel from '../components/HistoryWheel';
import HistoryModal from '../components/HistoryModal';
import { HIT_FADE_MS } from '../components/FloatingHit';
import { RANK_MAX_MS, rankTransitionDuration } from '../components/Hole';
import { FLOATING_HIT_INTRO_MS, KB_EXIT_FALLBACK_MS, REVEAL_HOLD_MS, STAGGER_MS } from '../game/timing';
import CoachText, { richToPlain } from './CoachText';
import { activatedHole, coachCopy, coachLine, type GuessEvent } from './coach';
import { meterView, tradeFor, type LessonStage, type MeterTrade } from './script';
import { canExtend } from '../game/keyboard';
import { latestMaskedPick, selectWord, shownHolesFor, withoutMaskedPicks, type WordPick } from '../game/wordWheel';
import { MASK, buildHistory, type HistoryStop } from '../game/history';
import { guessKey, replayHoles } from '../game/scoring';
import { replayCharge, strikeFor } from '../game/charge';
import { sentenceStarts } from '../game/sentenceCase';
import { SCRAMBLE_MS, coarsePointer, prefersReducedMotion, useScramble } from '../hooks/useScramble';
import type { Vocab } from '../hooks/useVocab';
import { fold } from '@whippin/shared';
import type { RankEntry, RankMap } from '@whippin/shared';
import type { HitState, RuntimeHole } from '../game/types';
import { t, ariaHoleHistory, srHoleCharge, srHoleGiven, srHoleResult } from '../i18n';
import type { LangCode } from '../langs';
import playerIdle from '../assets/player-idle.png';
import LevelCard from './LevelCard';
import { LEVELS, PLAY_LEVEL } from './levels';

// ONE STAGE OF THE LESSON, PLAYED (#269): a real board in the real game components, the real
// keyboard and the real vocabulary from the first frame, and a coach that speaks only when a
// guess calls for it (coach.ts). Screen contract, unchanged since #51: the explanation at the
// TOP (typewritten under the level's byline, in-game word styling), the board in the middle,
// INTERACTIONS at the bottom. No modals but the tries, no NEXT, no SKIP in the body (the header is the exit) —
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
//
// A STAGE TURNS INTO THE NEXT ONE THE WAY A WORD CHANGES (2026-09-30): the next board's
// letters churn in place from its first frame and settle, as an improved word does
// (Phrase's `morphFrom`). The last one dissolves into LEVEL 1's own card, which stands in the
// room between the coach's line and PLAY at the list hero's shape and turns DONE under the
// player's eyes, in its own material (`LevelCard`).
//
// THE WORD LIST IS WAITED FOR WHERE IT IS NEEDED, NOT BEFORE: the reveal needs none, so its
// CONTINUE stands from the first frame; pressed before the list has landed, the keyboard's
// footprint rises as its HOLD (`KeyboardHold`), and the keys come in over it through the
// dither once they can be greyed.

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

// Hold on a solved word before the next stage takes over.
const STAGE_HOLD_MS = 400;
// The bot's reactions (`react`): its sprite jumps by whole texels, a pose a frame.
const HOP_PX = [0, -2, -4, -2];
const HOP_FRAME_MS = 80;
const JUMP_PX = [0, -4, -8, -8, -4, 0, -2, 0];
const JUMP_FRAME_MS = 70;
// The finale: PLAY has arrived under the found sentence; this long after, the sentence
// dissolves into the level's card.
const END_HOLD_MS = 900;
// The card dissolves in at this scene time of its picture (the page typing itself in), stands
// in its NEXT dress while the page types, then turns DONE this long after it mounts — its
// number inked, its title's chip wiped off (index.css `mark-unwipe`, UNWIPE_MS), its held
// words inked in.
const CARD_FROM_S = 0.6;
const CLEAR_AT_MS = 2400;
const UNWIPE_MS = 320;
// The card's shape: the list hero's (index.css `--learn-hero-ar`), read where the card stands.
function heroAspect(el: Element): number {
  const v = parseFloat(getComputedStyle(el).getPropertyValue('--learn-hero-ar'));
  return Number.isFinite(v) && v > 0 ? v : 1;
}

export default function LessonBoard({
  lang,
  script,
  step,
  totalSteps,
  vocab,
  vocabError,
  retryVocab,
  final,
  arrivedFrom,
  clearedBefore,
  onComplete,
  onPlay,
  onCleared,
}: {
  lang: LangCode;
  script: LessonStage;
  step: number;
  totalSteps: number;
  vocab: Vocab | null;
  vocabError: unknown | null;
  retryVocab: () => void;
  // The last stage ends on PLAY; any other rolls into the next by itself.
  final: boolean;
  // The text the stage before this one ended on: a lone word scrambles in from its length,
  // a sentence's holes from their own. None on the first stage, which decodes in as a
  // sentence arrives.
  arrivedFrom?: string;
  // Level 1 was already done on this device when the lesson opened: its card lands DONE.
  clearedBefore: boolean;
  onComplete: () => void;
  onPlay: () => void;
  // The finale's card has turned DONE: the level is recorded.
  onCleared: () => void;
}) {
  const { puzzle, kind: stage } = script;
  const puzzleHoles = puzzle.holes;
  // THE METER STAGE'S VIEW of the open secret's map (`meterView`): the obvious word
  // `pair.alt` reads 2 and the rank-2 word reads 1, so the word the full meter offers at
  // half its best — 1 — is there to reveal. THE PAIR TRADE (the secret's, user-decided
  // 2026-09-16): before the hole is active, a word typed that reads closer than `alt` — the
  // secret, or the word read 1 — reads 2 and `alt` takes its place, so the activation is
  // always seen before the solve, with a word left to reveal. ONE map serves every
  // reading, and the board, the meters, the wheel and every later guess replay against it.
  // The secret traded, the player then finds `alt`.
  const [traded, setTraded] = useState<MeterTrade>(null);
  const openSecret = useMemo(
    () => (puzzleHoles.find((h) => h.secret.slug !== puzzleHoles[0].secret.slug) ?? puzzleHoles[puzzleHoles.length - 1]).secret.slug,
    [puzzleHoles],
  );
  const ranks = useMemo<RankMap>(() => {
    if (!script.pair) return puzzle.ranks;
    return { ...puzzle.ranks, [openSecret]: meterView(puzzle.ranks[openSecret], traded) };
  }, [traded, script.pair, puzzle.ranks, openSecret]);
  // The stage as the coach should read it: once the secret is traded, the hole's secret is
  // `alt`.
  const stageView = useMemo<LessonStage>(() => {
    if (traded !== 0 || !script.pair) return script;
    const alt = script.pair.alt;
    const last = puzzleHoles.length - 1;
    return {
      ...script,
      puzzle: { ...puzzle, holes: puzzleHoles.map((h, i) => (i === last ? { ...h, secret: alt } : h)) },
      hints: script.hints.map((key, i) => (i === last ? script.pair!.hint : key)),
    };
  }, [traded, script, puzzle, puzzleHoles]);
  const viewHoles = stageView.puzzle.holes;
  const stageViewRef = useRef(stageView);
  stageViewRef.current = stageView;
  // A sentence-shaped stage: the game's own layout, the try count behind the sentence, a
  // button (CONTINUE / PLAY) once solved — where a single word rolls on by itself.
  const sentenceLike = stage === 'sentence' || stage === 'meter';
  // THE METER STAGE (#301 taught; scripted, user-decided 2026-09-16): the meters are SHOWN on
  // this stage alone, and the BOT HAS ALREADY PLAYED — `played` is its log, replayed onto the
  // board, the meters and the tries wheel exactly as a round's own log would be. One secret
  // is found; the other's meter stands just under full, so the player's first close guess
  // fills it.
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
  // The last stage is leaving: its solved sentence dissolves (`DissolvePhrase`), then the
  // level's card takes its place.
  const [leaving, setLeaving] = useState(false);
  // THE KEYBOARD RISES INTO THE TRAY when it arrives mid-stage — the reveal's CONTINUE, the
  // meter stage's tap — kb-drop's travel reversed. Never on a stage's own mount: between two
  // stages the keys stay still under the player's fingers.
  const [rising, setRising] = useState(false);
  // The board's local state — the ephemeral twin of Round's.
  const [holes, setHoles] = useState<RuntimeHole[]>(() =>
    stage === 'reveal' ? revealedHoles(script) : replayHoles(fresh, ranks, seed),
  );
  // THE ENTRANCE: from the stage before, each hole scrambles in from as many letters as it
  // takes over — a lone word from the word it replaces, a sentence's hole from its own.
  const [morphFrom] = useState(() =>
    arrivedFrom === undefined ? undefined : holes.map((h) => (sentenceLike ? h.word.length : arrivedFrom.length)),
  );
  // The play log: the bot's tries first (the meter stage), then every counted guess.
  // `events` are the PLAYER's guesses alone (the coach reads those).
  const [tried, setTried] = useState<string[]>(seed);
  const [events, setEvents] = useState<GuessEvent[]>([]);
  // What `land` reads when it runs: the log as it stands, not as the closure saw it.
  const triedRef = useRef(tried);
  triedRef.current = tried;
  // What the METERS read: the log as of the last RELEASE beat, the twin of Game's
  // `shownCharge`. Hole's contract is that a meter's value changes when the floating hit
  // fades (`fadeDelayMs`) and then waits for the drops to land; read off `tried`, it changed
  // at the submit — the very render that remounts the struck word, so the new canvas was
  // born already full and the blood flew back to a chip that had nothing left to fill.
  const [shownTried, setShownTried] = useState<string[]>(seed);
  const ranksRef = useRef(ranks);
  ranksRef.current = ranks;
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
  const coarse = useMemo(coarsePointer, []);

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

  // THE BOT REACTS, WITHOUT WORDS (2026-09-30): to a guess that brings a hole closer it hops;
  // to a word found it jumps; to the last one found, twice. On its sprite, by the Web
  // Animations API and on `translate` alone, so the idle walk never restarts — whole texels,
  // a pose a frame. The player's guesses only; none under reduced motion.
  const bot = useRef<HTMLDivElement | null>(null);
  const react = useCallback(
    (kind: 'closer' | 'found' | 'solved', atMs: number) => {
      if (prefersReducedMotion()) return;
      later(() => {
        const el = bot.current;
        if (!el || typeof el.animate !== 'function') return;
        const [px, frameMs] = kind === 'closer' ? [HOP_PX, HOP_FRAME_MS] : [JUMP_PX, JUMP_FRAME_MS];
        const frames: Keyframe[] = px.map((y, i) => ({
          translate: `0 ${y}px`,
          offset: i / px.length,
          easing: 'steps(1, end)',
        }));
        frames.push({ translate: '0 0', offset: 1 });
        el.animate(frames, { duration: px.length * frameMs, iterations: kind === 'solved' ? 2 : 1 });
      }, atMs);
    },
    [later],
  );
  const tappedRef = useRef(tapped);
  tappedRef.current = tapped;
  // The coach's line as it stands (the voice keeps the last one up; see below).
  const lastCoach = useRef<string | null>(null);

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
    setRising(true);
  }, [script]);

  // The ghost (derived below, after the picks) as the input handlers read it, and the
  // decode (Game's): the prompt uncyphers the word while the guess's choreography waits.
  // While either stands the REVEAL tray holds the keyboard's place (Game's rule): letters
  // and recall are refused, Backspace is BACK.
  const ghostRef = useRef<{ index: number; slug: string } | null>(null);
  // The wheel's picks, by hole index (Game's `picked`).
  const [picked, setPicked] = useState<Record<number, WordPick>>({});
  const [decoding, setDecoding] = useState<string | null>(null);
  const decode = useScramble();
  const appendChar = useCallback(
    (char: string) => {
      if (!playing || !prefixSet) return;
      setFeedback(null);
      if (decoding !== null || ghostRef.current !== null) {
        setInvalidAt(Date.now());
        return;
      }
      if (canExtend(prefixSet, input, char)) setInput(input + char);
      else setInvalidAt(Date.now());
    },
    [playing, prefixSet, input, decoding],
  );
  // BACK: the mask un-picked, the keyboard back under the caret, on an empty prompt.
  const unpickMask = useCallback(() => {
    setFeedback(null);
    setPicked(withoutMaskedPicks);
    guessField.current?.focus({ preventScroll: true });
  }, []);
  const deleteChar = useCallback(() => {
    if (!playing || decoding !== null) return;
    setFeedback(null);
    if (ghostRef.current !== null) unpickMask();
    else setInput((cur) => cur.slice(0, -1));
  }, [playing, decoding, unpickMask]);
  // The value a recall just put in the prompt, so the keyboard strikes no key for it.
  const recalledInput = useRef<string | null>(null);
  const replaceInput = useCallback(
    (v: string) => {
      if (!playing) return;
      setFeedback(null);
      if (decoding !== null || ghostRef.current !== null) {
        setInvalidAt(Date.now());
        return;
      }
      recalledInput.current = v;
      setInput(v);
    },
    [playing, decoding],
  );
  const removeHit = useCallback((id: number) => {
    setHits((prev) => prev.filter((h) => h.id !== id));
  }, []);

  // ONE guess landing on the board, counted and coached.
  const land = useCallback(
    (typed: string, revealed = false) => {
      // A reveal's choreography waits for the prompt's decode (Game's rule).
      const reveal = revealed ? (prefersReducedMotion() ? 0 : SCRAMBLE_MS) + REVEAL_HOLD_MS : 0;
      const tried = triedRef.current;
      let ranks = ranksRef.current;
      // Judge against the log immediately, independently of the delayed visual swaps.
      const holes = replayHoles(fresh, ranks, tried);
      // The hole has activated before this guess — whether or not a hint taken has since
      // halved its meter: the trade below is over.
      const activeOut = eventsRef.current.some((e) => e.filled != null);
      // THE TRADE: a word typed before the hole is active that reads closer than the obvious
      // word takes its place (it reads 2) and the obvious word takes this one's. Read the map
      // through that view from this guess on.
      const open = holes.find((h) => h.rank !== 0);
      const trade = withMeters && !activeOut && traded === null && script.pair && open
        ? tradeFor(ranks[open.secret][typed]?.rank)
        : null;
      if (open && trade !== null) {
        setTraded(trade);
        ranks = { ...ranks, [open.secret]: meterView(puzzle.ranks[open.secret], trade) };
        ranksRef.current = ranks;
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
      const fadeDelayMs = reveal + Math.max(0, impacted.length - 1) * STAGGER_MS + FLOATING_HIT_INTRO_MS;
      // The meters before and after this guess (the meter stage only): what each chip gains
      // flies into it as loot, exactly as on the day (#301).
      const before = withMeters ? meters(tried, ranks) : null;
      const after = withMeters && isNew ? meters([...tried, typed], ranks) : before;
      impacted.forEach(({ index, entry }, step) => {
        const hit = (hitId.current += 1);
        const gained = before && after ? after[index].charge - before[index].charge : 0;
        // The day's own rule (`strikeFor`) on every stage: a guess that gives the hole
        // something — a closer word, or charge on the meter stage — is CUT; before the meter
        // stage there is no meter, so it is the closer word alone.
        const strike = strikeFor(entry?.rank, isNew, gained, holes[index].rank);
        setHits((prev) => [
          ...prev,
          entry != null
            ? {
                holeIndex: index,
                value: entry.rank,
                id: hit,
                startDelayMs: reveal + step * STAGGER_MS,
                fadeDelayMs,
                strike,
                charge: strike === 'slash' && gained > 0 ? gained : undefined,
              }
            : { holeIndex: index, value: 0, id: hit, startDelayMs: reveal + step * STAGGER_MS, fadeDelayMs, miss: true },
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
      const next = isNew ? [...tried, typed] : tried;
      // The hole this guess activated, if any: a full meter offering a word it did not —
      // the first fill, or one after a hint halved it (`activatedHole`).
      const event: GuessEvent = {
        typed,
        entries: holes.map((h) => (h.rank === 0 ? undefined : ranks[h.secret][typed])),
        improved,
        holeRanks: holes.map((h) => h.rank),
        filled: before && after ? activatedHole(before, after) : null,
        revealed,
      };
      if (isNew) {
        triedRef.current = next;
        setTried(next);
        if (withMeters) later(() => setShownTried(next), fadeDelayMs);
        setEvents((prev) => [...prev, event]);
      }

      const solvesAll = holes.every((h) => h.rank === 0 || ranks[h.secret][typed]?.rank === 0);
      const parts = impacted.map(({ index, entry }) =>
        srHoleResult(lang, index + 1, entry ? entry.rank : null),
      );
      say(solvesAll ? [...parts, t(lang, 'srSolvedAll')].join(', ') : parts.join(', '));

      // The bot's reaction, on the beat the board answers: a word found on its star's impact,
      // a closer word as its number lands. A guess that also brings a new line leaves the hop
      // to the line (the sprite hops as it speaks) — except the last word found, which it
      // always cheers.
      const found = impacted.findIndex(({ entry }) => entry?.rank === 0);
      const nextLine = coachLine({
        stage,
        holes: replayHoles(fresh, ranks, next),
        events: isNew ? [...eventsRef.current, event] : eventsRef.current,
        tapped: tappedRef.current,
        revealed: false,
        finished: solvesAll,
      });
      const nextCopy = nextLine ? coachCopy(lang, nextLine, stageViewRef.current, coarse) : null;
      const quietLine = nextCopy === null || nextCopy === lastCoach.current;
      if (solvesAll) react('solved', reveal + found * STAGGER_MS + 50);
      else if (found >= 0 && quietLine) react('found', reveal + found * STAGGER_MS + 50);
      else if (improved.some(Boolean) && quietLine) react('closer', fadeDelayMs);

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
    [withMeters, traded, script.pair, puzzle.ranks, fresh, meters, lang, say, later, stage, coarse, react],
  );

  const submit = useCallback(
    (raw: string) => {
      if (!playing || !vocab) return;
      guessField.current?.focus({ preventScroll: true });
      // An empty submit with a mask picked — the tray's REVEAL, or Enter — is the REVEAL: the
      // ghost's key is the guess, flagged for the coach, the prompt uncyphering it meanwhile.
      if (decoding !== null) return;
      const ghost = ghostRef.current;
      const revealing = !fold(raw) && ghost !== null;
      const typed = fold(raw) || ghost?.slug || '';
      if (revealing) {
        setDecoding(typed);
        decode.start(typed, MASK.length, () => later(() => setDecoding(null), REVEAL_HOLD_MS), 0);
      }
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
      land(typed, revealing);
    },
    [playing, vocab, lang, say, land, decoding, decode, later],
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
  // THE FINALE (2026-09-30; its room and its material 2026-10-06): PLAY stands under the
  // found sentence, then the sentence dissolves and LEVEL 1's own card takes the room between
  // the coach's line and PLAY — the list's card at the list hero's shape, on the bare ground in
  // the frame's corners, coming in through the dither with its page typing itself in — and
  // turns DONE in front of the player: its number inks cobalt, its title's chip is wiped off,
  // its held words ink in. PLAY is live throughout.
  useEffect(() => {
    if (final && kbGone) later(() => setLeaving(true), END_HOLD_MS);
  }, [final, kbGone, later]);
  const [cleared, setCleared] = useState(false);
  // The card's DONE beat has begun (the chip being wiped off), and has landed.
  const [clearing, setClearing] = useState(false);
  const [clearDone, setClearDone] = useState(clearedBefore);
  const onLeft = useCallback(() => setCleared(true), []);
  const flipped = useRef(false);
  const flip = useCallback(() => {
    if (flipped.current) return;
    flipped.current = true;
    setClearDone(true);
    onCleared();
  }, [onCleared]);
  useEffect(() => {
    if (!cleared || clearedBefore) return;
    // Reduced motion: the card lands in its final state. Otherwise DONE on its beat, landing on
    // the wipe's own end, with a deadline behind it (a lost `animationend` must not leave the
    // level unrecorded).
    if (prefersReducedMotion()) flip();
    else {
      later(() => setClearing(true), CLEAR_AT_MS);
      later(flip, CLEAR_AT_MS + UNWIPE_MS + 500);
    }
  }, [cleared, clearedBefore, flip, later]);
  const levelOne = LEVELS.find((l) => l.level === PLAY_LEVEL)!;
  const cardState = clearing || clearDone ? 'done' : 'next';
  // The card's box: the list hero's shape, as large as the room holds, on whole pixels —
  // measured before the first frame it shows, and again as the room changes.
  const room = useRef<HTMLDivElement>(null);
  const [cardBox, setCardBox] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = room.current;
    if (!cleared || !el) return undefined;
    const fit = () => {
      const ar = heroAspect(el);
      const w = Math.floor(Math.min(el.clientWidth, el.clientHeight * ar));
      const h = Math.floor(w / ar);
      setCardBox((cur) => (cur && cur.w === w && cur.h === h ? cur : { w, h }));
    };
    fit();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [cleared]);
  // THE KEYBOARD'S HOLD: the keys asked for (the reveal's CONTINUE) before the word list has
  // landed — the pad's footprint stands as its hold, and once the list lands the keys come in
  // over it through the dither while it goes out (`holdOut`, one dissolve long) — set before
  // the keys' first frame is painted, so the tray never stands empty between the two.
  const holding = !vocab && !vocabError && !kbGone && !revealed && !waitingTap;
  const [heldKeys, setHeldKeys] = useState(false);
  useEffect(() => {
    if (holding) setHeldKeys(true);
  }, [holding]);
  const [holdOut, setHoldOut] = useState(false);
  useLayoutEffect(() => {
    if (!heldKeys || !vocab) return;
    setHoldOut(true);
    later(() => setHoldOut(false), DISSOLVE_MS);
  }, [heldKeys, vocab, later]);

  // --- the tries: a tap on a word (the wheel while open, the grid once found) ---
  const [historyHole, setHistoryHole] = useState<number | null>(null);
  const exploreLabels = useMemo(() => holes.map((_, i) => ariaHoleHistory(lang, i + 1)), [holes, lang]);
  const openHistory = useCallback((index: number) => setHistoryHole(index), []);
  // `tapped` lands on CLOSE (user-decided 2026-09-16): the line that follows the tap must
  // not type on behind the wheel.
  const closeHistory = useCallback(() => {
    setHistoryHole(null);
    // The meter stage's first close hands the turn over: the keyboard rises in.
    if (stage === 'meter' && !tapped) setRising(true);
    setTapped(true);
  }, [stage, tapped]);
  useEffect(() => {
    if (rising) later(() => setRising(false), KB_EXIT_FALLBACK_MS);
  }, [rising, later]);
  const wheelOpen = historyHole !== null && holes[historyHole]?.rank !== 0 && phase === 'play' && !revealed;
  // The meters as of the last RELEASE beat (the meter stage only) — what the sentence and
  // the wheel read (#301). Declared here: the picks below read the given ranks off them.
  const shownMeters = useMemo(() => (withMeters ? meters(shownTried) : undefined), [withMeters, meters, shownTried]);
  // A live pick in the hole's place; a picked MASK shows `?????` until its reveal lands
  // (Game's rule).
  const shownHoles = useMemo(
    () => shownHolesFor(holes, picked, shownMeters),
    [holes, picked, shownMeters],
  );
  const pickWord = useCallback(
    (index: number, stop: HistoryStop) => {
      const at = holes[index]?.rank;
      if (at === undefined || at === 0) return;
      // A mask picked: the draft goes first, and what was said about it (Game's rule).
      if (stop.masked) {
        setInput('');
        setFeedback(null);
      }
      setPicked((cur) => selectWord(cur, index, stop, at));
    },
    [holes],
  );
  // THE GHOST (Game's): the picked, unrevealed mask REVEAL submits — spent the instant the
  // guess is in the FULL log.
  const fullMeters = useMemo(() => (withMeters ? meters(tried) : undefined), [withMeters, meters, tried]);
  const ghost = useMemo(
    () => latestMaskedPick(picked, holes, fullMeters ?? []),
    [holes, picked, fullMeters],
  );
  ghostRef.current = ghost;
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
      given: shownMeters?.[historyHole]?.given,
    });
  }, [historyHole, holes, puzzleHoles, viewHoles, ranks, tried, shownMeters]);

  // --- the coach: the one line the board's state calls for, or nothing ---
  // Nothing new while the prompt DECODES a reveal: the line that names the word would read it
  // out under the marks still uncyphering it. The last line holds, and the new one types once
  // the word stands decoded.
  const line = useMemo(
    () =>
      decoding !== null
        ? null
        : coachLine({ stage, holes, events, tapped, revealed, finished: phase !== 'play' }),
    [decoding, phase, stage, holes, events, tapped, revealed],
  );
  const coach = line ? coachCopy(lang, line, stageView, coarse) : null;
  // THE LINE NEVER DISAPPEARS (user-decided 2026-09-16): a beat with nothing new to say keeps
  // the last line up rather than blanking the voice.
  if (coach) lastCoach.current = coach;
  const shownCoach = coach ?? lastCoach.current;
  // Announce each new line once, in plain text (the visible typewriter is aria-hidden).
  useEffect(() => {
    if (coach) say(richToPlain(coach));
  }, [coach, say]);

  const quiet = playing && historyHole === null && hits.length === 0;
  const starts = sentenceStarts(puzzle.words);
  // The meters as the sentence shows them (the meter stage only): the reading, whether the
  // hole is active, and the sr-only description in the meter's place (#301).
  const charges = useMemo(() => {
    if (!shownMeters) return undefined;
    return shownMeters.map((c, i) => {
      const hint =
        holes[i].rank === 0 ? '' : c.given.some((g) => !g.consumed) ? srHoleGiven(lang) : srHoleCharge(lang, c.charge);
      return { value: c.charge, active: c.active, hint };
    });
  }, [shownMeters, holes, lang]);

  return (
    // tutorial--word: the word stage is deliberately CLEAN — one big centered word in the
    // middle; the sentence stage wears the game's own layout.
    <div className={`game tutorial${sentenceLike ? '' : ' tutorial--word'}${cleared ? ' l1-cleared' : ''}`}>
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>

      {/* LEVEL 1 OPENS AS THE ARTICLE LEVELS DO (2026-09-30): a BYLINE on the stippled floor —
          the player, the level's number and line, the stage counter (the pixel face,
          user-decided 2026-09-17) — then the coach's line under it as the page's own voice, no
          box. THE COACH IS THE PLAYER (user-decided 2026-09-16: "people would want to read it
          more if it's something telling it"): the old lineup's PLAYER idle sheet stands on the
          floor and speaks the line under it. */}
      <div className="l1-band">
        {/* Keyed on the line: the character HOPS each time it says something new. The key is
            its own — CoachText is keyed on the same line, and two siblings sharing a key leave
            the old sprite behind. */}
        <div
          key={`bot:${shownCoach}`}
          ref={bot}
          className="coach-bot"
          aria-hidden
          style={{ backgroundImage: `url(${playerIdle})` }}
        />
        <div className="l1-byline">
          <h1 className="l1-title-row">
            <span className="l1-no" aria-hidden="true">
              {String(levelOne.level).padStart(2, '0')}
            </span>
            <span className="l1-title">{t(lang, levelOne.subKey)}</span>
          </h1>
          {/* Inked in the solve's cobalt once the stage's word is found. */}
          <span className={`l1-step${done ? ' found' : ''}`}>
            {step}/{totalSteps}
          </span>
        </div>
      </div>
      {/* The voice's height is reserved on this wrapper, so nothing under it ever moves. */}
      <div className="l1-voice">{shownCoach && <CoachText key={shownCoach} copy={shownCoach} />}</div>

      <div className={`play${leaving ? ' play-finished' : ''}`}>
        {/* THE BOARD: the stage's word or sentence on the bare ground, the try count clipped
            inside its box; the finale's card then takes the whole room. */}
        {cleared ? (
          <div ref={room} className="l1-clear-room">
            {cardBox && (
              <div
                className={`learn-card level-clear ${cardState}`}
                style={{ width: cardBox.w, height: cardBox.h }}
                aria-hidden="true"
              >
                <LevelCard
                  level={levelOne}
                  lang={lang}
                  state={cardState}
                  from={CARD_FROM_S}
                  titleMark={
                    clearing && !clearDone ? (
                      <span
                        className="level-clear-mark"
                        onAnimationEnd={(e) => e.target === e.currentTarget && flip()}
                      >
                        <span className="learn-title-text">{t(lang, levelOne.titleKey)}</span>
                      </span>
                    ) : null
                  }
                />
              </div>
            )}
          </div>
        ) : (
          // The hiding PLAYS as the game's own word change (user-decided 2026-09-16): the Hole
          // scrambles the secret's letters into its stand-in's while the exponent arrives — the
          // same choreography every improving guess gets — so the player SEES one word become
          // the other, no remount.
          <figure className="phrase-anchor l1-fig">
            {/* The sentence stage shows the try count behind the sentence, as the day does:
                fewer tries is the score, and the number says so without a word. */}
            {sentenceLike && (
              <div className="progress-background" aria-hidden="true">
                {/* The whole log — the bot's tries included on the meter stage (user-decided
                    2026-09-16): the count the day would show for this board. */}
                <CellDigits value={tried.length - (decoding !== null ? 1 : 0)} fit={0.84} />
              </div>
            )}
            {leaving ? (
              // The found sentence's exit: its exact pixels, eroded letter by letter —
              // `viewHoles`, so a traded meter stage dissolves the word it actually shows.
              <DissolvePhrase words={puzzle.words} puzzleHoles={viewHoles} brisk onDone={onLeft} />
            ) : (
              <Phrase
                words={puzzle.words}
                holes={shownHoles}
                puzzleHoles={puzzleHoles}
                hits={hits}
                onHitDone={removeHit}
                // A WORD IS TAPPABLE ON THE SENTENCES ONLY (user-decided 2026-09-16): a lone word
                // has no tries worth a wheel. The tap works whenever a sentence board is live —
                // including while the meter stage waits for exactly that tap.
                exploreLabels={sentenceLike ? exploreLabels : undefined}
                exploreDisabled={phase !== 'play' || revealed}
                onExplore={sentenceLike ? openHistory : undefined}
                quiet={quiet}
                veiledHole={wheelOpen ? historyHole : null}
                // A lone word is a word, not a sentence: no capital on the word stages.
                capital={sentenceLike}
                charges={charges}
                morphFrom={morphFrom}
              />
            )}
          </figure>
        )}
        {/* Once there is nothing left to type the prompt retires in place — still laid out, so
            the board does not move, but invisible and inert; the reveal has nothing to type
            yet either (the button below is the one action), nor has the meter stage before the
            tap. Level 1 cleared, it leaves the flow (`.l1-cleared`): the room is the finale's
            card's. */}
        <div
          className={`input-area${ending || revealed || waitingTap || cleared ? ' retired' : ''}`}
          aria-hidden={ending || revealed || waitingTap || cleared || undefined}
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
            ghost={decoding !== null ? (decode.jumble ?? decoding) : ghost ? MASK : undefined}
            ghostTarget={decoding ?? undefined}
            active={playing && historyHole === null}
          />
          <p className="hint">{feedback || ' '}</p>
        </div>
      </div>

      {/* The bottom is for INTERACTIONS: the keyboard — which drops away at the very end,
          leaving one button under the solved sentence. */}
      <div
        className={`tray${ending && !kbGone ? ' kb-leaving' : ''}${rising ? ' kb-rising' : ''}`}
        aria-busy={holding || undefined}
      >
        {kbGone ? (
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
        ) : waitingTap ? null : vocabError ? (
          <LoadError message={t(lang, 'failedVocab')} lang={lang} onRetry={retryVocab} />
        ) : (
          <div
            className={`kb-exit${ending ? ' leaving' : rising ? ' rising' : ''}${heldKeys ? ' from-hold' : ''}`}
            onAnimationEnd={(e) => {
              // Child animations (key shakes) bubble here too: only the wrapper's own
              // kb-drop end unmounts it, and its own kb-rise end settles it.
              if (e.target !== e.currentTarget) return;
              if (ending) setKbGone(true);
              else setRising(false);
            }}
          >
            {/* The word list still on its way: the pad's hold. A picked mask takes the
                keyboard's place with REVEAL (Game's tray swap). */}
            {!vocab ? (
              <>
                <span className="sr-only">{t(lang, 'loading')}</span>
                <KeyboardHold />
              </>
            ) : decoding !== null || ghost !== null ? (
              <RevealTray lang={lang} decoding={decoding !== null} onReveal={() => submit('')} onBack={unpickMask} />
            ) : (
              <Keyboard
                input={input}
                prefixSet={vocab.prefixSet}
                vocabSet={vocab.vocabSet}
                recalled={recalledInput}
                lang={lang}
                onType={appendChar}
                onBackspace={deleteChar}
                onSubmit={submit}
              />
            )}
            {holdOut && (
              <div className="kb-hold-out">
                <KeyboardHold still />
              </div>
            )}
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
