import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { INFINITY_EM_HEIGHT, INFINITY_EM_WIDTH, INFINITY_GLYPH, type Source } from '@whippin/shared';
import { prefersReducedMotion } from '../hooks/useScramble';
import { shareHeadline, shareText, shareUrl } from '../game/share';
import type { ScorePlacementState } from '../hooks/useScoreHistogram';
import RunRuler, { rulerStagger } from './RunRuler';
import ScoreTop from './ScoreTop';
import SolvedCaption, { captionDurationMs } from './SolvedCaption';
import useAnimatedNumber from '../hooks/useAnimatedNumber';
import useShare from '../hooks/useShare';
import Button from './Button';
import ShareAs, { useShareSigner } from './ShareAs';
import { ariaHoleHistory, t } from '../i18n';
import { capitalize, sentenceStarts } from '../game/sentenceCase';
import { RESULTS_IN_MS, SCORE_COUNT_MS } from './resultAnimation';

// The sentence result — a STAGE in two parts, the score above and the sentence's page
// below (user-decided 2026-09-08, on #266's second review). It takes the whole column the
// dissolved sentence handed over (the 2026-08-14 hand-over, restored), and it stacks:
//
//   SCORE   — at the TOP, right under the header: the named `<tries> TRIES` over its run
//             ruler, the day's standing badge, and SHARE with its AS drum (sharing is what
//             you do with a RESULT, user-decided 2026-08-14). Its height is the same on
//             every round, and it is above the fold on every phone — SHARE is the
//             reveal's closing beat and the game's one liked-indicator, and it is never
//             reached by scrolling.
//   CONTEXT — under it, with a gap: the source credit, then the sentence the player
//             rebuilt in the READING face, its secrets in the solve blue and tappable.
//             This is the round's variable-height content, so THIS is what scrolls: a
//             long sentence (and, with #270, the sentences of the book around it, read
//             top-down from the credit) goes under the fold, the score never does.
//
// The reveal runs stage → credit + secrets → score → rank → SHARE: the stage rises in,
// the credit types under it while the secrets pop into the sentence, and the SCORE block
// follows once that citation has FINISHED PRINTING (user-decided 2026-08-15: numbers
// arriving over a half-typed credit read as two things happening at once, where waiting
// reads as one thing after another). That is the screen's one signal-driven beat, so it
// carries a DEADLINE behind it (the `KB_EXIT_FALLBACK_MS` rule: a lost signal must never
// be able to stall the solved sequence), derived from the typewriter's own numbers.
// Inside the score block the tally counts WHILE the ruler colors — one beat saying one
// thing, "here is your run" — and only then the standing lands, with SHARE as the
// reveal's closing beat: the screen ends on its action. Everything else hangs off an
// offset. Rehydrated solves render the final frame immediately and replay nothing.
//
// THAT LAST SENTENCE IS ALSO THE FAST-FORWARD (#179, user-decided 2026-08-16): a tap
// during the reveal flips `animate` off, and every beat below already answers that flag
// with its own settled value — so the skip reuses the rehydrated rendering instead of
// inventing a parallel fast path, which is exactly what the decision asks for. Nothing
// here listens for the tap: the round owns it, because the beats before this one (the
// keyboard drop, the dissolve) are its.
const NEUTRAL_HOLD_MS = 55;
// The secrets POP into the sentence one by one, 200ms apart, each a fast scale pop — the
// round's three trophies counted out, back in the gaps they were taken from. Keep aligned
// with `.solved-secret.in` / `solved-word-pop`.
const WORD_STEP_MS = 200;
const WORD_POP_MS = 300;
// The breath between the citation's last character and the numbers arriving.
const SCORE_LEAD_MS = 320;
// A puzzle with no source has no printing to wait for, so its numbers follow the pops.
const WORDS_LEAD_MS = 140;
// How long past the citation's own length the result waits before giving up on the
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
}

export default function SolvedScreen({
  guessCount,
  trajectory,
  solvedAt,
  dayNumber,
  lang,
  source,
  words,
  holes,
  onExplore,
  placement = null,
  capped = false,
  animate = true,
  start = true,
  onRevealEnd,
}: {
  guessCount: number;
  trajectory: number[]; // reconstruction % after each counted guess (one per try)
  solvedAt?: (number | null)[]; // the player's solve moments (ruler ticks)
  dayNumber: number;
  lang: string; // packed into the share token (drives the link's click-through target)
  source?: Source;
  words: string[]; // the sentence's full display tokens (the puzzle's own `words[]`)
  holes: SolvedHole[]; // one entry per occurrence, sorted by `pos` — the secrets inside it
  onExplore: (holeIndex: number) => void;
  // The day's score population (#170): 'pending' while the round trip is in flight
  // (the slot shows RANKING...); null renders the reserved empty slot (silent).
  placement?: ScorePlacementState;
  // The round hit the server's guess cap unsolved (#214): the HEADLINE becomes `∞` and no
  // leaderboard entry exists (`placement` is null by construction — a capped round's solve
  // never reached the server). Everything else is an ordinary result: the sentence with its
  // answer in place, the credit, the ruler at its real length, and SHARE.
  capped?: boolean;
  // Rehydrated solves render their final result immediately and replay nothing — and so
  // does a reveal the player has fast-forwarded (#179): the round flips this off, and the
  // settled frame this draws IS the decision's "settled end state".
  animate?: boolean;
  // Hold the WHOLE choreography at frame zero until the screen is actually the player's to
  // look at. Every beat below hangs off `stageIn`, so gating that one flip gates all of
  // them — which is the point: a reveal that plays under a full-screen modal is a reveal
  // nobody sees, and what lands on dismissal is a finished frame.
  start?: boolean;
  // The reveal's last beat has landed (SHARE, or the settled frame): the round disarms
  // its fast-forward on it.
  onRevealEnd?: () => void;
}) {
  const reduceMotion = prefersReducedMotion();
  const n = Math.max(trajectory.length, 1);
  // A settled result staggers NOTHING: the ruler's per-cell delays are what a fast-forward
  // would otherwise sweep across the bar for over a second after the frame it snapped
  // (`rulerStagger`'s reduced-motion argument, spent here on the same problem).
  const stagger = animate ? rulerStagger(n, reduceMotion) : 0;
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

  // The page's own beat: once the stage has risen, the credit types and the secrets pop
  // into the sentence under it — one beat, "here is what you rebuilt, and where it is
  // from". The credit's completion only retires its own cursor and releases the score.
  const [captionDone, setCaptionDone] = useState(false);
  const finishCaption = useCallback(() => setCaptionDone(true), []);
  const [textIn, setTextIn] = useState(() => !animate);
  useEffect(() => {
    if (!animate) {
      setTextIn(true);
      return undefined;
    }
    if (!stageIn) return undefined;
    const id = window.setTimeout(() => setTextIn(true), reduceMotion ? 0 : RESULTS_IN_MS);
    return () => window.clearTimeout(id);
  }, [animate, stageIn, reduceMotion]);

  // The SCORE block. Its arrival is what starts the tally, so the number never counts
  // behind a block that has not appeared yet. It waits for the source to finish PRINTING
  // — on the caption's own completion signal, with the derived deadline behind it — and,
  // on a puzzle with no source, simply follows the secrets' pops.
  const [scoreIn, setScoreIn] = useState(() => !animate);
  useEffect(() => {
    if (!animate) {
      setScoreIn(true);
      return undefined;
    }
    if (!textIn) return undefined;
    if (reduceMotion) {
      setScoreIn(true);
      return undefined;
    }
    if (!hasSource) {
      const id = window.setTimeout(() => setScoreIn(true), popSpanMs + WORDS_LEAD_MS);
      return () => window.clearTimeout(id);
    }
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
  }, [animate, textIn, reduceMotion, hasSource, captionDone, popSpanMs, source, lang]);

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

  useEffect(() => {
    if (shareIn) onRevealEnd?.();
  }, [shareIn, onRevealEnd]);

  // Delivery (native sheet / clipboard + the "COPIED" confirmation) is the shared hook's;
  // this screen only composes the sentence result's text.
  const { share, copied } = useShare();
  // The stage is the scroller; the sticky credit is its way back to the top (the score,
  // SHARE) once the reader has scrolled them away.
  const stageRef = useRef<HTMLDivElement>(null);
  const backToTop = useCallback(() => {
    stageRef.current?.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, []);
  // The AS drum under SHARE: on the player's row, the link is signed with this account
  // (see ShareAs). Fresh on every mount — never remembered from one result to the next.
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
    <div
      ref={stageRef}
      className={`solved-stage pixel-scroll${stageIn ? ' in' : ''}${animate ? '' : ' settled'}`}
    >
      {/* ---- the SCORE block, at the top: how the round went, and what you do with it. */}
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
          <Button
            variant="secondary"
            className={`result-action${copied ? ' copied' : ''}`}
            onClick={onShare}
          >
            {copied ? t(lang, 'copied') : t(lang, 'share')}
          </Button>
          <ShareAs lang={lang} signer={signer} />
        </div>
      </div>

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
            secrets are the only difference inside the line: the solve blue, the pop, and
            the tap onto their own history. Prefix and suffix are sentence context and
            always show, in the nowrap group that keeps them on the secret's own line —
            Phrase's rule, unchanged. */}
        <p className="solved-text">
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
                      className={`solved-secret${textIn ? ' in' : ''}`}
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
          <a className="solved-listen" href={source.url} target="_blank" rel="noopener noreferrer">
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
