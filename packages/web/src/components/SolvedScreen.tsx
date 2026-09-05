import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { INFINITY_EM_HEIGHT, INFINITY_EM_WIDTH, INFINITY_GLYPH, type Source } from '@whippin/shared';
import { prefersReducedMotion } from '../hooks/useScramble';
import { shareHeadline, shareText, shareUrl } from '../game/share';
import type { ScorePlacementState } from '../hooks/useScoreHistogram';
import RunRuler, { rulerStagger } from './RunRuler';
import ScoreTop from './ScoreTop';
import SolvedCaption, { captionDurationMs } from './SolvedCaption';
import useAnimatedNumber from '../hooks/useAnimatedNumber';
import useLetterWave, { WAVE_VARS } from '../hooks/useLetterWave';
import useShare from '../hooks/useShare';
import ShareProfile, { useShareSigner } from './ShareProfile';
import { ariaHoleHistory, t } from '../i18n';
import { SCORE_COUNT_MS } from './resultAnimation';

// The sentence result, redesigned as the WHOLE screen (user-decided 2026-08-14): the
// dissolved sentence hands over the full play column, and the result reads in TWO
// BLOCKS, separated by a real seam (user-decided the same day) — first the PUZZLE, then
// the SCORE, because they answer different questions and running them together read as
// one undifferentiated column:
//
//   PUZZLE — the GUESSED WORDS in the solve blue, popping in one by one (each still a
//            button onto its own history line, with the ambient wave advertising the
//            tap), and the SOURCE typed under them at its own small caption size.
//   SCORE  — the named `<tries> TRIES` over its run ruler, the day's standing line,
//            and SHARE, which belongs to it (user-decided 2026-08-14: sharing is what
//            you do with a RESULT). The whole block sits on the screen's BOTTOM EDGE,
//            which is what turns the seam between the two into real space rather than a
//            measured gap — the taller the screen, the more the split reads.
//
// The reveal runs words → source → score → rank → SHARE (user-decided 2026-08-16,
// superseding "the standing arrives with the block it heads"): the words count themselves
// out, the source types under them, and the SCORE block follows once that citation has
// FINISHED PRINTING (user-decided 2026-08-15, superseding the fixed 420ms lead off the
// source's first line) — numbers arriving over a half-typed credit read as two things
// happening at once, where waiting reads as one thing after another. That is the screen's
// one signal-driven beat, so it carries a DEADLINE behind it (the `KB_EXIT_FALLBACK_MS`
// rule: a lost signal must never be able to stall the solved sequence), derived from the
// typewriter's own numbers. Inside the score block the tally counts WHILE the ruler
// colors — one beat saying one thing, "here is your run" — and only then the standing
// lands, with SHARE as the reveal's closing beat: the screen ends on its action.
// Everything else still hangs off an offset.
// Rehydrated solves render the final frame immediately and replay nothing.
const NEUTRAL_HOLD_MS = 55;
// The words POP in one by one: 200ms apart, each a fast scale pop — the round's three
// trophies arriving, counted out. Fast and ONE-SHOT, which is the only form a scale may
// take on the pixel font (the rank exponent's `rank-pop` and the tally's `score-land`,
// same reasoning): a long scale TRANSITION renders blurry intermediate frames for its
// whole length, a 300ms hop lands before the eye can read one.
const WORD_STEP_MS = 200;
const WORD_POP_MS = 300;
// The breath between the citation's last character and the numbers arriving.
const SCORE_LEAD_MS = 320;
// A puzzle with no source has no printing to wait for, so its numbers follow the words.
const WORDS_LEAD_MS = 140;
// How long past the citation's own length the stage waits before giving up on the
// completion signal and moving on anyway. Generous by design: it is a backstop, and the
// typewriter's intervals are merely THROTTLED on a hidden tab, never dropped.
const CAPTION_FALLBACK_SLACK_MS = 4_000;
// The reveal's closing beats: the standing waits out the tally-and-colorize beat plus a
// breath, and SHARE waits out the standing's own rung-in plus another.
const RANK_LEAD_MS = 260;
// `.score-top.in`'s rung-in — keep aligned with the CSS.
const RANK_IN_MS = 220;
const SHARE_LEAD_MS = 180;

// The capped round's headline (#214). Press Start 2P has no `∞`, so the glyph is drawn from
// the shared path data — the same path, at the same fraction of the font size, that the OG
// card draws, so the screen and the card it shares cannot show two different marks. It
// stands exactly where `.solved-score-num` would, keeping the unit beside it.
function InfinityScore() {
  return (
    <svg
      className="solved-score-inf"
      viewBox={INFINITY_GLYPH.viewBox}
      style={{ height: `${INFINITY_EM_HEIGHT}em`, width: `${INFINITY_EM_WIDTH}em` }}
      aria-hidden="true"
      focusable="false"
    >
      <path d={INFINITY_GLYPH.path} fill="currentColor" />
    </svg>
  );
}

interface SolvedWordEntry {
  word: string; // the accented secret, as the sentence displayed it
  holeIndex: number; // the FIRST hole carrying this secret (the history modal's key)
  number: number; // 1-based distinct-secret position — the ruler ticks' own numbering
}

// One guessed word: a button named by its own content (the hole-button rule — the word IS
// what it shows), described by the sr hint, opening the history line it walked. Its
// letters ripple on the word's own clock while the screen is idle — the same affordance
// the holes wore, saying the same thing: this word can be tapped.
function SolvedWord({
  entry,
  shown,
  veiled,
  onExplore,
}: {
  entry: SolvedWordEntry;
  shown: boolean;
  // The wheel stands over this word: it is hidden in place meanwhile (Hole's own rule).
  veiled: boolean;
  onExplore: (holeIndex: number) => void;
}) {
  const letters = Array.from(entry.word);
  // The word is free to ripple from the moment it has popped in — the shared clock (#129)
  // the holes and the day's word run, saying here what it said on the hole this word came
  // from: this can be tapped.
  const waving = useLetterWave(shown, letters.length);
  const waveStyle: CSSProperties & Record<string, string> = waving ? { ...WAVE_VARS } : {};

  return (
    <button
      type="button"
      className={`solved-word${shown ? ' in' : ''}${veiled ? ' veiled' : ''}`}
      style={{ '--step': entry.number - 1 } as CSSProperties}
      aria-describedby={`solved-explore-${entry.number}`}
      data-hole-explore={entry.holeIndex}
      onClick={() => onExplore(entry.holeIndex)}
    >
      <span className="solved-word-num" aria-hidden="true">
        {entry.number}
      </span>
      {/* The wrap is what the history modal zooms out of (Game.openHistory measures it),
          exactly as it measured a hole's word. */}
      <span className="hole-word-wrap">
        <span className={`solved-word-text${waving ? ' wave' : ''}`} style={waveStyle}>
          {letters.map((ch, i) => (
            <span key={i} className="hole-letter" style={{ '--i': i } as CSSProperties}>
              {ch}
            </span>
          ))}
        </span>
      </span>
    </button>
  );
}

export default function SolvedScreen({
  guessCount,
  trajectory,
  solvedAt,
  dayNumber,
  lang,
  source,
  words,
  onExplore,
  veiledHole = null,
  placement = null,
  capped = false,
  animate = true,
  start = true,
}: {
  guessCount: number;
  trajectory: number[]; // reconstruction % after each counted guess (one per try)
  solvedAt?: (number | null)[]; // the player's solve moments (ruler ticks)
  dayNumber: number;
  lang: string; // packed into the share token (drives the link's click-through target)
  source?: Source;
  words: SolvedWordEntry[]; // distinct secrets, sentence order — the ruler ticks' numbering
  onExplore: (holeIndex: number) => void;
  // The word the wheel is open over, hidden in place meanwhile (see SolvedWord).
  veiledHole?: number | null;
  // The day's score population (#170): 'pending' while the round trip is in flight
  // (the slot shows RANKING...); null renders the reserved empty slot (silent).
  placement?: ScorePlacementState;
  // The round hit the server's guess cap unsolved (#214): the HEADLINE becomes `∞` and no
  // leaderboard entry exists (`placement` is null by construction — a capped round's solve
  // never reached the server). Everything else is an ordinary result: the answer, the
  // credit, the ruler at its real length, and SHARE.
  capped?: boolean;
  // Rehydrated solves render their final result immediately and replay nothing.
  animate?: boolean;
  // Hold the WHOLE choreography at frame zero until the screen is actually the player's to
  // look at. Every beat below hangs off `stageIn`, so gating that one flip gates all of
  // them — which is the point: a reveal that plays under a full-screen modal is a reveal
  // nobody sees, and what lands on dismissal is a finished frame.
  start?: boolean;
}) {
  const reduceMotion = prefersReducedMotion();
  const n = Math.max(trajectory.length, 1);
  const stagger = rulerStagger(n, reduceMotion);
  const hasSource = Boolean(source?.kind || source?.author || source?.work);

  // The words count themselves out; everything after them is timed off the beat before it.
  const wordsSpanMs = words.length ? (words.length - 1) * WORD_STEP_MS + WORD_POP_MS : 0;

  // The stage rises once; every block's own beat hangs off this one flip.
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

  // The words need no beat of their own: they pop the moment the stage is up, and CSS
  // counts them out from each word's own index (`--step`).
  const wordsIn = !animate || stageIn;

  // The source types once the last word has landed; its completion only retires its own
  // cursor — nothing downstream waits on it.
  const [captionDone, setCaptionDone] = useState(false);
  const finishCaption = useCallback(() => setCaptionDone(true), []);
  const [captionIn, setCaptionIn] = useState(() => !animate);
  useEffect(() => {
    if (!animate) {
      setCaptionIn(true);
      return undefined;
    }
    if (!stageIn) return undefined;
    const id = window.setTimeout(() => setCaptionIn(true), reduceMotion ? 0 : wordsSpanMs);
    return () => window.clearTimeout(id);
  }, [animate, stageIn, reduceMotion, wordsSpanMs]);

  // The SCORE block: the seam's other side. Its arrival is what starts the tally, so the
  // number never counts behind a block that has not appeared yet. It waits for the source
  // to finish PRINTING — on the caption's own completion signal, with the derived deadline
  // behind it — and, on a puzzle with no source, simply follows the words.
  const [scoreIn, setScoreIn] = useState(() => !animate);
  useEffect(() => {
    if (!animate) {
      setScoreIn(true);
      return undefined;
    }
    if (!stageIn) return undefined;
    if (reduceMotion) {
      setScoreIn(true);
      return undefined;
    }
    if (!hasSource) {
      const id = window.setTimeout(() => setScoreIn(true), wordsSpanMs + WORDS_LEAD_MS);
      return () => window.clearTimeout(id);
    }
    if (!captionIn) return undefined;
    if (captionDone) {
      const id = window.setTimeout(() => setScoreIn(true), SCORE_LEAD_MS);
      return () => window.clearTimeout(id);
    }

    // The typewriter advances on a short interval, which browsers throttle or suspend in
    // a hidden tab. Its backstop therefore counts VISIBLE time too: a plain wall-clock
    // timeout can expire while only a handful of letters have printed and reveal the
    // numbers over a half-typed credit on return. The real completion signal normally
    // wins; restarting the generous fallback when visibility returns only affects the
    // lost-signal path it exists to rescue.
    let id = 0;
    const armFallback = () => {
      window.clearTimeout(id);
      if (document.visibilityState === 'hidden') return;
      id = window.setTimeout(
        () => setScoreIn(true),
        captionDurationMs(source, lang) + CAPTION_FALLBACK_SLACK_MS,
      );
    };
    armFallback();
    document.addEventListener('visibilitychange', armFallback);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('visibilitychange', armFallback);
    };
  }, [animate, stageIn, reduceMotion, hasSource, wordsSpanMs, captionIn, captionDone, source, lang]);

  const [countTarget, setCountTarget] = useState(() => (animate ? 0 : guessCount));
  useEffect(() => {
    if (scoreIn) setCountTarget(guessCount);
  }, [scoreIn, guessCount]);
  const shownScore = useAnimatedNumber(countTarget, !animate || reduceMotion ? 1 : SCORE_COUNT_MS);

  // The ruler rides the tally (user-decided 2026-08-16, superseding "after the score
  // lands"): the neutral cells sweep in the moment the block arrives and the color wave
  // chases them a breath behind, so the bar colors WHILE the number counts — one beat.
  // The ruler always reserves its final footprint, so neither animation moves the
  // actions below it.
  const rulerSpanMs = Math.max(0, n - 1) * stagger;
  const [rulerShown, setRulerShown] = useState(() => !animate);
  const [rulerColorized, setRulerColorized] = useState(() => !animate);
  useEffect(() => {
    if (!animate) {
      setRulerShown(true);
      setRulerColorized(true);
      return undefined;
    }
    if (!scoreIn) return undefined;
    setRulerShown(true);
    if (reduceMotion) {
      setRulerColorized(true);
      return undefined;
    }
    const color = window.setTimeout(() => setRulerColorized(true), NEUTRAL_HOLD_MS);
    return () => window.clearTimeout(color);
  }, [animate, reduceMotion, scoreIn]);

  // The reveal's closing beats (user-decided 2026-08-16): the STANDING lands only once
  // the tally-and-colorize beat has settled, and SHARE once the standing's own rung-in
  // has — the screen ends on its action. Both hold their layout space throughout (the
  // rank's slot is always mounted, SHARE hides in place), so these flips change when
  // each appears, never where anything sits.
  const scoreBeatMs = Math.max(SCORE_COUNT_MS, NEUTRAL_HOLD_MS + rulerSpanMs);
  const [rankIn, setRankIn] = useState(() => !animate);
  const [shareIn, setShareIn] = useState(() => !animate);
  useEffect(() => {
    if (!animate) {
      setRankIn(true);
      setShareIn(true);
      return undefined;
    }
    if (!scoreIn) return undefined;
    if (reduceMotion) {
      setRankIn(true);
      setShareIn(true);
      return undefined;
    }
    const rank = window.setTimeout(() => setRankIn(true), scoreBeatMs + RANK_LEAD_MS);
    const share = window.setTimeout(
      () => setShareIn(true),
      scoreBeatMs + RANK_LEAD_MS + RANK_IN_MS + SHARE_LEAD_MS,
    );
    return () => {
      window.clearTimeout(rank);
      window.clearTimeout(share);
    };
  }, [animate, reduceMotion, scoreIn, scoreBeatMs]);

  // Delivery (native sheet / clipboard + the "COPIED" confirmation) is the shared hook's;
  // this screen only composes the sentence result's text.
  const { share, copied } = useShare();
  // The SHARE MY PROFILE box under SHARE: checked, the link is signed with this account
  // (see ShareProfile). Fresh on every mount — never remembered from one result to the next.
  const signer = useShareSigner();

  const onShare = useCallback(async () => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const url = shareUrl(
      origin,
      {
        lang,
        dayNumber,
        score: guessCount,
        trajectory,
        solvedAt: solvedAt ?? [],
        capped,
      },
      signer.by,
    );
    // This screen owns only its localized UNIT; the line's shape is share.ts's, shared
    // with Word mode so the two modes' messages cannot drift apart. A capped round names
    // no count — `∞` stands where the number would, exactly as the card draws it — and
    // the unit stays plural, since there is no "1" to agree with.
    const unit = t(lang, !capped && guessCount === 1 ? 'try' : 'tries').toLowerCase();
    const headline = shareHeadline(dayNumber, capped ? '∞' : guessCount, unit);
    // The card (via the token) draws the run in full; the plain-text row is the bounded
    // summary of that SAME run — trajectory and solve moments both — so the link and its
    // fallback can't disagree.
    await share(shareText(headline, trajectory, solvedAt ?? [], url));
  }, [lang, dayNumber, guessCount, trajectory, solvedAt, capped, share, signer.by]);

  return (
    <div className={`solved-stage${stageIn ? ' in' : ''}${animate ? '' : ' settled'}`}>
      {/* ---- the PUZZLE block: what the round was about. Its auto margins take the
           leftover height, which centres it above the score block and pins that block
           to the bottom edge. */}
      <div className="solved-puzzle">
        {/* The found words — the round's trophies, and still its buttons: each opens the
            history line it walked, numbered as the ruler's ticks number them. They pop
            in one by one; CSS counts them out off each word's own `--step`. */}
        <div className="solved-words">
          {words.map((entry) => (
            <SolvedWord
              key={entry.number}
              entry={entry}
              shown={wordsIn}
              veiled={veiledHole === entry.holeIndex}
              onExplore={onExplore}
            />
          ))}
        </div>
        {words.map((entry) => (
          <span key={entry.number} id={`solved-explore-${entry.number}`} className="sr-only">
            {ariaHoleHistory(lang, entry.number)}
          </span>
        ))}

        {/* The sentence's attribution, UNDER the words it belongs to and at its own
            caption size — the small quote-style citation it has always been. A
            source-less puzzle simply shows the words. */}
        {hasSource && (
          <div className={`solved-source${captionIn ? ' in' : ''}`}>
            <SolvedCaption
              source={source}
              lang={lang}
              animate={animate && captionIn && !captionDone}
              onComplete={finishCaption}
            />
          </div>
        )}
      </div>

      {/* ---- the SCORE block, on the bottom edge: how the round went, and what you do
           with it. */}
      <div className={`solved-numbers${scoreIn ? ' in' : ''}`}>
        {/* The primary sentence metric. The hidden final value reserves the count's width
            so its tally never moves the content below it — a capped round has no tally to
            reserve for, since `∞` is one fixed shape. Where this run stands among the
            day's players (#170) is the TOP badge BESIDE the number (user-decided
            2026-09-05), absolutely placed so its arrival moves nothing. */}
        <span className="solved-score">
          <span className="solved-score-line">
            {capped ? (
              <span className="solved-score-num">
                <InfinityScore />
                <span className="sr-only">∞</span>
              </span>
            ) : (
              <span className="solved-score-num">
                <span className="solved-score-ghost" aria-hidden="true">
                  {guessCount}
                </span>
                <span className="solved-score-live">{Math.round(shownScore)}</span>
              </span>
            )}
            <ScoreTop
              placement={placement}
              mode="sentence"
              lang={lang}
              animate={animate}
              start={rankIn}
            />
          </span>
          <span className="solved-score-unit">
            {t(lang, !capped && guessCount === 1 ? 'try' : 'tries')}
          </span>
        </span>

        {/* The player's own run ruler — the share card draws this same ruler from the v2
            token. */}
        <div className="run-ruler-frame" aria-hidden="true">
          <RunRuler
            trajectory={trajectory}
            solvedAt={solvedAt ?? []}
            stagger={stagger}
            shown={rulerShown}
            colorized={rulerColorized}
          />
        </div>

        {/* SHARE closes the reveal: hidden in place (footprint kept) until the standing
            has landed. */}
        <div className={`result-actions${shareIn ? ' in' : ''}`}>
          <button
            type="button"
            className={`result-action${copied ? ' copied' : ''}`}
            onClick={onShare}
          >
            {copied ? t(lang, 'copied') : t(lang, 'share')}
          </button>
          <ShareProfile lang={lang} signer={signer} />
        </div>
      </div>
    </div>
  );
}
