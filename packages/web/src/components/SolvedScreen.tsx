import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { isBonusRef, shareHeadline, type PuzzleRef, type Source } from '@whippin/shared';
import { prefersReducedMotion } from '../hooks/useScramble';
import { shareText, shareUrl } from '../game/share';
import SolvedCard from './SolvedCard';
import SolvedCaption, { captionDurationMs } from './SolvedCaption';
import { COUNT_END_MS, COUNT_RUN_MS } from './countRun';
import useShare from '../hooks/useShare';
import Button from './Button';
import ResultBoards, { type ResultBoardsData } from './ResultBoards';
import { useDeviceIdentity } from '../identity';
import { ariaHoleHistory, t } from '../i18n';
import { capitalize, sentenceStarts } from '../game/sentenceCase';

// The sentence result — a STAGE: the score above, the player's boards under it, and the
// sentence's page below (user-decided 2026-09-08, on #266's second review). It takes the whole
// column the dissolved sentence handed over (the 2026-08-14 hand-over, restored), and it stacks:
//
//   SCORE   — at the TOP, right under the header: THE CARD (`SolvedCard` — the share card
//             this result sends, live: the edition, the count as its subject, the run)
//             and SHARE under it (sharing is what you do with a RESULT, user-decided
//             2026-08-14). Its height is the same on every round, and it is above the fold
//             on every phone — SHARE is the card's closing beat and the game's one
//             liked-indicator, and it is never reached by scrolling.
//   BOARDS  — on the ACTIVE day only: how the day compares, the player's groups then the
//             GLOBAL (`ResultBoards`), in one fixed box that holds its room from frame one.
//   CONTEXT — under it, with a gap: the source credit, then the sentence the player
//             rebuilt in the READING face, its secrets in the solve blue and tappable.
//             This is the round's variable-height content, so THIS is what scrolls: a
//             long sentence (and, with #270, the sentences of the book around it, read
//             top-down from the credit) goes under the fold, the score never does.
//
// The reveal runs stage → CARD drawn → tally → SHARE → BOARDS → credit → sentence
// (user-decided 2026-09-11, reversing 2026-08-15's page-first order now that the score is a
// CARD above the page): the stage comes up and the card draws itself reading 0 over a ruler
// with no colour in it yet; then the tally counts WHILE the ruler colours in, try by try —
// one beat saying one thing, "here is your run" — and lands; then SHARE lands, closing the
// card, and the boards under it; only THEN, with the score standing above it, the credit types, and
// only once it has printed does the sentence appear under it, its secrets popping in. The 2026-08-15 rule survives in the other direction:
// nothing prints while the numbers move, so the two never read as happening at once. The
// citation's completion is the screen's one signal-driven beat, so it carries a DEADLINE
// behind it (the `KB_EXIT_FALLBACK_MS` rule: a lost signal must never be able to stall
// the solved sequence), derived from the typewriter's own numbers — and it is what ends
// the reveal now. Everything else hangs off an offset, or — the closing beat — off the
// count's own landing, which the run's clock always reaches (no DOM signal to lose).
// Rehydrated solves render the final frame immediately and replay nothing.
//
// THAT LAST SENTENCE IS ALSO THE FAST-FORWARD (#179, user-decided 2026-08-16): a tap
// during the reveal flips `animate` off, and every beat below already answers that flag
// with its own settled value — so the skip reuses the rehydrated rendering instead of
// inventing a parallel fast path, which is exactly what the decision asks for. Nothing
// here listens for the tap: the round owns it, because the beats before this one (the
// keyboard drop, the dissolve) are its.
// The result choreography: the stage comes up in the whole column the dissolved sentence
// handed over (`.solved-stage`'s fade), then the card draws itself, then the tally counts.
const RESULTS_IN_MS = 140;
// The card DRAWS itself before the tally starts (index.css `.solved-card.in` and its `--t-*`
// offsets): the FRAME (the brackets travel out, the edition types), then the INSTRUMENT (the
// ruler's track is wiped across, the count's zeros blink in) — done by 720ms.
const DRAW_MS = 720;
// The secrets POP into the sentence one by one, 200ms apart, each a fast scale pop — the
// round's three trophies counted out, back in the gaps they were taken from. Keep aligned
// with `.solved-secret.in` / `solved-word-pop`.
const WORD_STEP_MS = 200;
const WORD_POP_MS = 300;
// The breath between SHARE's arrival — the card's last beat — and the page starting to
// print under it.
const TEXT_LEAD_MS = 320;
// How long past the citation's own length the result waits before giving up on the
// completion signal and moving on anyway. Generous by design: it is a backstop, and the
// typewriter's intervals are merely THROTTLED on a hidden tab, never dropped.
const CAPTION_FALLBACK_SLACK_MS = 4_000;
// The card's closing beat — SHARE — follows the count's landing (the bar full) by a breath,
// and the boards follow SHARE by another.
const CLOSE_LEAD_MS = 260;
const BOARDS_LEAD_MS = 200;
// The boards' own arrival (`.solved-boards.in`: the tab's chip wiped across, the first line in):
// they are a tap onto the board only once it has played.
const BOARDS_ARRIVE_MS = 420;

// THE TALLY'S CLOCK: ms since `on`, a frame at a time, up to COUNT_END_MS — ONE fixed length
// for every score (`countRun.ts`: the last reel stops at COUNT_RUN_MS, its shake plays out by
// COUNT_END_MS). A settled frame is at the end at once, and so is reduced motion.
function useCountClock(animate: boolean, on: boolean, reduceMotion: boolean): number {
  const [ms, setMs] = useState(() => (animate ? 0 : COUNT_END_MS));
  useEffect(() => {
    if (!animate) {
      setMs(COUNT_END_MS);
      return undefined;
    }
    if (!on) return undefined;
    if (reduceMotion) {
      setMs(COUNT_END_MS);
      return undefined;
    }
    let raf = 0;
    let t0: number | null = null;
    const tick = (now: number) => {
      t0 ??= now;
      const at = Math.min(COUNT_END_MS, now - t0);
      setMs(at);
      if (at < COUNT_END_MS) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animate, on, reduceMotion]);
  return ms;
}

// ONE BEAT of the reveal: false until `ready` has held for `delayMs`, then true. A settled
// frame (`animate` off — rehydrated, or fast-forwarded) is true at once. Reduced motion
// collapses the wait: to a 0ms timer, or — `syncWhenReduced` — to a synchronous set.
function useBeat(
  animate: boolean,
  ready: boolean,
  delayMs: number,
  reduceMotion: boolean,
  syncWhenReduced: boolean,
): boolean {
  const [on, setOn] = useState(() => !animate);
  useEffect(() => {
    if (!animate) {
      setOn(true);
      return undefined;
    }
    if (!ready) return undefined;
    if (syncWhenReduced && reduceMotion) {
      setOn(true);
      return undefined;
    }
    const id = window.setTimeout(() => setOn(true), reduceMotion ? 0 : delayMs);
    return () => window.clearTimeout(id);
  }, [animate, ready, delayMs, reduceMotion, syncWhenReduced]);
  return on;
}

// One OCCURRENCE of a secret in the solved sentence. A slug appearing twice yields two of
// these (#5's own rule: one hole per occurrence, sharing one rank map) — they carry the
// same `number`, so they pop on the same beat and open the same history line.
export interface SolvedHole {
  pos: number; // index of this secret in `words` — where it sits in the sentence
  word: string; // the accented secret, as the sentence displays it
  holeIndex: number; // this hole's own index (the history modal's key)
  number: number; // 1-based distinct-secret position — the ruler ticks' own numbering
  prefix?: string; // display-only affixes, kept around the secret exactly as Phrase keeps them
  suffix?: string;
  // Did the player FIND it? A round that ended unsolved shows every secret, and the ones it
  // only revealed wear the held chip — the solve's cobalt says "found", and only says it
  // of a word that was.
  found: boolean;
}

export default function SolvedScreen({
  guessCount,
  trajectory,
  solvedAt,
  puzzleRef,
  lang,
  source,
  words,
  holes,
  onExplore,
  unfinished = false,
  animate = true,
  start = true,
  onRevealEnd,
  boards = null,
}: {
  guessCount: number;
  trajectory: number[]; // reconstruction % after each counted guess (one per try)
  solvedAt?: (number | null)[]; // the player's solve moments (ruler ticks)
  // WHICH puzzle — a day, or a BONUS (shared bonus.ts), whose result is a v7 token, a card
  // that says BONUS, and no analytics beat.
  puzzleRef: PuzzleRef;
  lang: string; // packed into the share token (drives the link's click-through target)
  source?: Source;
  words: string[]; // the sentence's full display tokens (the puzzle's own `words[]`)
  holes: SolvedHole[]; // one entry per occurrence, sorted by `pos` — the secrets inside it
  onExplore: (holeIndex: number) => void;
  // The round ENDED UNSOLVED — the player gave up, or it hit the server's guess cap (#214):
  // the HEADLINE becomes `∞` and no leaderboard entry exists. Everything else is an ordinary
  // result: the sentence with its answer in place, the credit, the ruler at its real length,
  // and SHARE — whose `share` event it does not count (below).
  unfinished?: boolean;
  // Rehydrated solves render their final result immediately and replay nothing — and so
  // does a reveal the player has fast-forwarded (#179): the round flips this off, and the
  // settled frame this draws IS the decision's "settled end state".
  animate?: boolean;
  // Hold the WHOLE choreography at frame zero until the screen is actually the player's to
  // look at. Every beat below hangs off `stageIn`, so gating that one flip gates all of
  // them — which is the point: a reveal that plays under a full-screen modal is a reveal
  // nobody sees, and what lands on dismissal is a finished frame.
  start?: boolean;
  // The reveal's last beat has landed (the credit printed under the card, or the settled
  // frame): the round disarms its fast-forward on it.
  onRevealEnd?: () => void;
  // How the day compares, on the ACTIVE day only (null on an archive day or a bonus): the
  // live answer the play screen keeps and whether one is on its way.
  boards?: ResultBoardsData | null;
}) {
  const reduceMotion = prefersReducedMotion();
  const hasSource = Boolean(source?.kind || source?.author || source?.work);
  // The page around the line (#270): the source's raw sentences before and after it, as
  // one paragraph of muted text — the line's own highlight is the contrast.
  const before = source?.excerpt?.before ?? [];
  const after = source?.excerpt?.after ?? [];

  // The secrets, by their place in the sentence — and the distinct numbers they carry, for
  // the exploration hints (two occurrences of one secret share a hint, as they share a
  // history line) and for the pop's span (they pop on one beat too).
  const holeByPos = useMemo(() => new Map(holes.map((h) => [h.pos, h])), [holes]);
  // The page reads in sentence case like the board did (`game/sentenceCase.ts`).
  const starts = useMemo(() => sentenceStarts(words), [words]);
  const secretNumbers = useMemo(
    () => Array.from(new Set(holes.map((h) => h.number))).sort((a, b) => a - b),
    [holes],
  );
  const popSpanMs = Math.max(0, secretNumbers.length - 1) * WORD_STEP_MS + WORD_POP_MS;

  // The stage is up; every block's own beat hangs off this one flip.
  const [stageIn, setStageIn] = useState(() => !animate);
  useEffect(() => {
    if (!animate) {
      setStageIn(true);
      return undefined;
    }
    if (!start) return undefined;
    const raf = requestAnimationFrame(() => setStageIn(true));
    return () => cancelAnimationFrame(raf);
  }, [animate, start]);

  // THE CARD, FIRST: its drawing is what starts the tally, so the number never counts in a
  // card that has not been drawn yet. It follows the stage's own fade.
  const scoreIn = useBeat(animate, stageIn, RESULTS_IN_MS, reduceMotion, false);

  // THE TALLY, once the card is DRAWN (user-decided 2026-09-11): the card stands reading 0
  // over the whole ruler, every cell there and none coloured yet, and only then does the
  // number run — the ruler colouring in try by try, each tick standing as its try is
  // reached, WHILE it counts. ONE clock drives both (`ms`, `countRun.ts`): the count's reels
  // spin and stop left to right, the last on COUNT_RUN_MS whatever the score (user-decided
  // 2026-10-03), and the ruler's last try is written on that stop. The card reserves its
  // final footprint throughout, so nothing below it moves.
  const countIn = useBeat(animate, scoreIn, DRAW_MS, reduceMotion, false);
  const ms = useCountClock(animate, countIn, reduceMotion);

  // The card's closing beat (user-decided 2026-08-16): SHARE lands once the tally has
  // landed — its own beat, never behind anything else's (user-reported 2026-09-11: waiting
  // out another rung-in put the card's one action far too late). It holds its layout space
  // throughout (SHARE hides in place), so the flip changes when it appears, never where
  // anything sits. The run lands on its clock: the last reel stops on the score and the
  // ruler's last try is written at COUNT_RUN_MS, never before.
  const countLanded = countIn && ms >= COUNT_RUN_MS;
  const shareIn = useBeat(animate, countLanded, CLOSE_LEAD_MS, reduceMotion, true);

  // THE BOARDS, under SHARE: their box has held its room since frame one, and lands now —
  // whatever its reads have answered by then (a read landing later fills the box in place).
  // Until it has LANDED — through its own arrival, which starts at opacity 0 — it is inert
  // (CSS), so a tap that skips the reveal never lands on a board the player cannot see yet.
  const boardsIn = useBeat(animate, shareIn, BOARDS_LEAD_MS, reduceMotion, false);
  const boardsArmed = useBeat(animate, boardsIn, BOARDS_ARRIVE_MS, reduceMotion, true);

  // THE PAGE, under the finished card and the boards: the credit types and the secrets pop
  // into the sentence — one beat, "here is what you rebuilt, and where it is from" — once
  // the blocks above it have landed. The credit's completion retires its own cursor and
  // ends the reveal.
  const [captionDone, setCaptionDone] = useState(false);
  const finishCaption = useCallback(() => setCaptionDone(true), []);
  const textIn = useBeat(animate, boards ? boardsIn : shareIn, TEXT_LEAD_MS, reduceMotion, false);

  // THE SENTENCE, after the source (user-decided 2026-09-11: "score view → source →
  // sentence"): the text appears — and its secrets pop into it — once the citation has
  // FINISHED PRINTING, on its own completion signal with the derived deadline behind it;
  // a puzzle with no source has nothing to wait for and shows it as the page's beat
  // starts.
  const [sentenceIn, setSentenceIn] = useState(() => !animate);
  useEffect(() => {
    if (!animate) {
      setSentenceIn(true);
      return undefined;
    }
    if (!textIn) return undefined;
    if (reduceMotion || !hasSource || captionDone) {
      setSentenceIn(true);
      return undefined;
    }

    // The typewriter advances on a short interval, which browsers throttle or suspend in
    // a hidden tab. Its backstop therefore counts VISIBLE time too: a plain wall-clock
    // timeout can expire while only a handful of letters have printed and end the reveal
    // over a half-typed credit on return. The real completion signal normally wins;
    // restarting the generous fallback when visibility returns only affects the
    // lost-signal path it exists to rescue.
    let id = 0;
    const armFallback = () => {
      window.clearTimeout(id);
      if (document.visibilityState === 'hidden') return;
      id = window.setTimeout(
        () => setSentenceIn(true),
        captionDurationMs(source, lang) + CAPTION_FALLBACK_SLACK_MS,
      );
    };
    armFallback();
    document.addEventListener('visibilitychange', armFallback);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('visibilitychange', armFallback);
    };
  }, [animate, textIn, reduceMotion, hasSource, captionDone, source, lang]);

  // The reveal's END: the secrets have popped into the sentence. The round disarms its
  // fast-forward on it.
  const textDone = useBeat(animate, sentenceIn, popSpanMs, reduceMotion, true);

  useEffect(() => {
    if (textDone) onRevealEnd?.();
  }, [textDone, onRevealEnd]);

  // Delivery (native sheet / clipboard + the "COPIED" confirmation) is the shared hook's;
  // this screen only composes the sentence result's text. A BONUS is no day's, and an
  // UNFINISHED result's share is not counted either: the `share` event is read as share ÷
  // solve, the "did they like the day" signal, and a share of a day given up is not that.
  const { share, copied } = useShare({ tracked: !isBonusRef(puzzleRef) && !unfinished });
  // The stage is the scroller; the sticky credit is its way back to the top (the score,
  // SHARE) once the reader has scrolled them away.
  const stageRef = useRef<HTMLDivElement>(null);
  const backToTop = useCallback(() => {
    stageRef.current?.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, []);
  // The link is SIGNED with this account, always (user-decided 2026-09-10, retiring the AS
  // drum): the card wears the player's mark and name, and the click opens the day.
  const by = useDeviceIdentity()?.accountId ?? null;

  const onShare = useCallback(async () => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const url = shareUrl(
      origin,
      {
        lang,
        ...puzzleRef,
        score: guessCount,
        trajectory,
        solvedAt: solvedAt ?? [],
        // The token's v6 flag means ENDED UNSOLVED, whichever way the round ended.
        capped: unfinished,
      },
      by,
    );
    // This screen owns only its localized UNIT; the line's shape is @whippin/shared's. An
    // unfinished round names no count — `∞` stands where the number would, exactly as the
    // card draws it — and the unit stays plural, since there is no "1" to agree with.
    const unit = t(lang, !unfinished && guessCount === 1 ? 'try' : 'tries').toLowerCase();
    const headline = shareHeadline(puzzleRef, unfinished ? '∞' : guessCount, unit);
    // The card (via the token) draws the run in full; the plain-text row is the bounded
    // summary of that SAME run — trajectory and solve moments both — so the link and its
    // fallback can't disagree.
    await share(shareText(headline, trajectory, solvedAt ?? [], url));
  }, [lang, puzzleRef, guessCount, trajectory, solvedAt, unfinished, share, by]);

  return (
    <div
      ref={stageRef}
      className={`solved-stage pixel-scroll${stageIn ? ' in' : ''}${animate ? '' : ' settled'}`}
    >
      {/* ---- THE CARD, at the top: how the round went — the share card this result sends,
           stood up in the column — and SHARE under it, what you do with it. */}
      <SolvedCard
        puzzleRef={puzzleRef}
        lang={lang}
        guessCount={guessCount}
        ms={ms}
        trajectory={trajectory}
        solvedAt={solvedAt ?? []}
        unfinished={unfinished}
        drawn={scoreIn}
        landed={animate && countLanded}
        settled={!animate}
      >
        {/* SHARE, under the card's frame, the result's ONE action: hidden in place
            (footprint kept) until the count lands. */}
        <div className={`result-actions${shareIn ? ' in' : ''}`}>
          <Button
            variant="primary"
            className={`result-action${copied ? ' copied' : ''}`}
            onClick={onShare}
          >
            {copied ? t(lang, 'copied') : t(lang, 'share')}
          </Button>
        </div>
      </SolvedCard>

      {/* ---- the BOARDS: how the day compares, the active day only. */}
      {boards && (
        <ResultBoards
          className={`solved-boards${boardsIn ? ' in' : ''}${boardsArmed ? ' armed' : ''}`}
          lang={lang}
          {...boards}
          tries={guessCount}
          progress={trajectory[trajectory.length - 1] ?? 0}
          ended={unfinished}
          pageIn={textIn}
        />
      )}

      {/* ---- the PAGE: the sentence's page. The credit first, then the text — read
           top-down, the way a page is. The whole stage scrolls; the credit sticks. */}
      <div className="solved-page">
        {/* The sentence's attribution, ABOVE the text it credits, at its own caption size
            — the small quote-style citation it has always been, and the running head
            once the page scrolls: a tap on it returns to the top. A source-less puzzle
            simply shows the sentence. */}
        {hasSource && (
          <button type="button" className={`solved-source${textIn ? ' in' : ''}`} onClick={backToTop}>
            <SolvedCaption
              source={source}
              lang={lang}
              animate={animate && textIn && !captionDone}
              onComplete={finishCaption}
            />
          </button>
        )}

        {/* THE SENTENCE (#266, user-decided 2026-09-07): the whole thing the player
            rebuilt, not just the three words it hid — the round is a sentence, and three
            words on their own are three adjacent word searches. In the READING face,
            because this is the book's page, not the board: the line is in the ink, and
            #270's sentences around it will be the muted text before and after it. The
            secrets are the only difference inside the line: the solve blue (the held chip
            for one a round that ended unsolved only revealed), the pop, and the tap onto
            their own history. Prefix and suffix are sentence context and
            always show, in the nowrap group that keeps them on the secret's own line —
            Phrase's rule, unchanged. */}
        <p className={`solved-text${sentenceIn ? ' in' : ''}`}>
          {before.length > 0 ? `${before.join(' ')} ` : null}
          <span className="solved-line">
            {words.map((w, i) => {
              const hole = holeByPos.get(i);
              const space = i > 0 ? ' ' : '';
              if (!hole) {
                return (
                  <Fragment key={i}>
                    {space}
                    {starts[i] ? capitalize(w) : w}
                  </Fragment>
                );
              }
              const capitalWord = starts[i] && !hole.prefix;
              return (
                <Fragment key={i}>
                  {space}
                  <span className="solved-line-group">
                    {hole.prefix && starts[i] ? capitalize(hole.prefix) : hole.prefix}
                    <button
                      type="button"
                      className={`solved-secret${hole.found ? '' : ' revealed'}${sentenceIn ? ' in' : ''}`}
                      style={{ '--step': hole.number - 1 } as CSSProperties}
                      aria-describedby={`solved-explore-${hole.number}`}
                      onClick={() => onExplore(hole.holeIndex)}
                    >
                      {capitalWord ? capitalize(hole.word) : hole.word}
                    </button>
                    {hole.suffix}
                  </span>
                </Fragment>
              );
            })}
          </span>
          {after.length > 0 ? ` ${after.join(' ')}` : null}
        </p>
        {/* A music day's LISTEN (#270): an ordinary link to the track's page, in a new
            tab — no embed, no third-party script on the page. */}
        {source?.url ? (
          <a
            className={`solved-listen${sentenceIn ? ' in' : ''}`}
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t(lang, 'listen')}
          </a>
        ) : null}
        {/* The exploration hints, referenced by each secret's `aria-describedby`. OUTSIDE
            the text, for Phrase's own reason: inside the <p> they would interleave
            "Explore word 2" into the prose a screen reader reads straight through. Two
            occurrences of one secret share a number, so they share one hint. */}
        {secretNumbers.map((number) => (
          <span key={number} id={`solved-explore-${number}`} className="sr-only">
            {ariaHoleHistory(lang, number)}
          </span>
        ))}
      </div>
    </div>
  );
}
