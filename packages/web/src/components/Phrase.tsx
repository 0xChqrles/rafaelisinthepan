import { Fragment, type CSSProperties } from 'react';
import Hole, { type HoleChargeView } from './Hole';
import { DecodeWord, introPlan, useIntroClock } from './PhraseIntro';
import { capitalize, sentenceStarts } from '../game/sentenceCase';
import type { HitState, Hole as PuzzleHole, RuntimeHole } from '@whippin/shared';

// Render the sentence: normal words as plain text, holes via <Hole>. A blanked word
// keeps its display affixes (a leading clitic like "t'", trailing punctuation) around
// the <Hole>; these come from the STATIC puzzle holes (not the runtime/persisted
// state), so they are always correct even for a round persisted before they existed.
export default function Phrase({
  words,
  holes,
  puzzleHoles,
  hits,
  onHitDone,
  onHoleResolved,
  exploreLabels,
  exploreDisabled = false,
  onExplore,
  quiet = false,
  veiledHole = null,
  charges,
  // Sentence case: the first letter of the sentence and of each new one gets a capital.
  // OFF for a board that is ONE word (the tutorial's word stage): a lone word is a word, not
  // a sentence, and a capital on it read wrong (user feedback 2026-09-16).
  capital = true,
}: {
  words: string[];
  holes: RuntimeHole[];
  puzzleHoles: PuzzleHole[]; // static per-hole data (affixes), keyed by pos below
  hits: HitState[]; // one transient number per warm hole (multi-hit)
  onHitDone: (id: number) => void;
  onHoleResolved?: (index: number) => void;
  // Route map (#117), by hole index: the button's exploration hint, or null for a hole whose
  // secret carries no #115 geometry (no map, so no entry point at all). Stable for the
  // round — the solved choreography gates the buttons with `exploreDisabled`, never by
  // taking them away.
  exploreLabels?: (string | null)[];
  exploreDisabled?: boolean;
  onExplore?: (holeIndex: number) => void;
  // Is the sentence quiet enough for the ambient wave (#129)? Passed straight through: each
  // hole keeps its own clock and decides for itself, this is only the round-wide veto.
  quiet?: boolean;
  // The hole the wheel is open over, whose word is hidden in place meanwhile (see Hole).
  veiledHole?: number | null;
  // The holes' CHARGE METERS (#301), by hole index: what each shows, and the sr-only
  // description of it (empty for a hole with nothing to describe — a solved one).
  charges?: (HoleChargeView & { hint: string })[];
  capital?: boolean;
}) {
  const holeIndexByPos = new Map<number, number>(holes.map((h, i) => [h.pos, i]));
  // Sentence case is a DISPLAY rule (`game/sentenceCase.ts`): the first token and every
  // token after a sentence-final mark open on a capital; a hole's prefix takes it when
  // the hole has one, else the hole's own displayed word.
  const starts = capital ? sentenceStarts(words) : words.map(() => false);
  const puzzleHoleByPos = new Map<number, PuzzleHole>(puzzleHoles.map((h) => [h.pos, h]));
  const hintId = (holeIndex: number) => `hole-explore-${holeIndex}`;
  const chargeId = (holeIndex: number) => `hole-charge-${holeIndex}`;

  // THE SENTENCE DECODES ITSELF IN when it arrives (`PhraseIntro` holds the why): a front
  // sweeps it left to right, a plain word's letters churning into place as it passes, a hole
  // stamped in at its own letter (`--at`, `.phrase-intro`). Each token's place on that
  // front is the count of the letters before it. Keyed on the words, so a new sentence (a
  // lesson's next stage) decodes again and nothing else ever replays it; the dissolve's copy
  // of the sentence (`DissolvePhrase`) is a component of its own and never decodes.
  const key = words.join(' ');
  const shownText = (w: string, i: number) => (starts[i] ? capitalize(w) : w);
  const tokenText = (w: string, i: number) => {
    const idx = holeIndexByPos.get(i);
    if (idx === undefined) return shownText(w, i);
    const { prefix, suffix } = puzzleHoleByPos.get(i) ?? {};
    return `${prefix ?? ''}${holes[idx].word}${suffix ?? ''}`;
  };
  const firsts: number[] = [];
  let letters = 0;
  words.forEach((w, i) => {
    firsts.push(letters);
    letters += tokenText(w, i).replace(/\s/g, '').length;
  });
  const plan = introPlan(letters);
  const intro = useIntroClock(key, plan.totalMs);
  const beat = (i: number) =>
    intro.running ? ({ '--at': `${Math.round(firsts[i] * plan.charMs)}ms` } as CSSProperties) : undefined;

  return (
    <>
    <p className={`phrase${intro.running ? ' phrase-intro' : ''}`} key={key}>
      {words.map((w, i) => {
        const space = i > 0 ? ' ' : '';
        const idx = holeIndexByPos.get(i);
        if (idx !== undefined) {
          const rHole = holes[idx];
          const activeHit = hits.find((h) => h.holeIndex === idx) ?? null;
          const { prefix, suffix } = puzzleHoleByPos.get(i) ?? {};
          const exploreLabel = exploreLabels?.[idx] ?? null;
          const charge = charges?.[idx];
          // Prefix (leading clitic) and suffix (trailing punctuation) are sentence
          // context and always show. They live with the blank in a nowrap group so
          // they can never break onto a different line from it.
          // The sentence wraps as natural prose (issue #102). A hole's word is
          // replaced many times per round (start word -> ever-closer words, arbitrary
          // widths), but each swap plays the slot-machine scramble that grows/shrinks
          // its length one letter at a time (see Hole), so the surrounding text
          // reflows gradually instead of snapping — the old forced <br/> per hole is
          // no longer needed.
          return (
            <Fragment key={i}>
              {space}
              <span className="hole-group" style={beat(i)}>
                {prefix ? (
                  <span className="word">{starts[i] ? capitalize(prefix) : prefix}</span>
                ) : null}
                <Hole
                  capital={starts[i] && !prefix}
                  hole={rHole}
                  hit={activeHit}
                  holeIndex={idx}
                  onHitDone={onHitDone}
                  onResolved={onHoleResolved}
                  quiet={quiet}
                  veiled={veiledHole === idx}
                  charge={charge && { value: charge.value, active: charge.active }}
                  chargeHintId={charge?.hint ? chargeId(idx) : undefined}
                  explore={
                    exploreLabel && onExplore
                      ? {
                          hintId: hintId(idx),
                          disabled: exploreDisabled,
                          onOpen: () => onExplore(idx),
                        }
                      : undefined
                  }
                />
                {suffix ? <span className="word">{suffix}</span> : null}
              </span>
            </Fragment>
          );
        }
        return (
          <Fragment key={i}>
            {space}
            <span className="word">
              {intro.running ? (
                <DecodeWord text={shownText(w, i)} first={firsts[i]} plan={plan} clock={intro} />
              ) : (
                shownText(w, i)
              )}
            </span>
          </Fragment>
        );
      })}
    </p>
    {/* The exploration hints, referenced by each hole button's aria-describedby. They sit
        OUTSIDE the sentence on purpose: a hole is named by its own content (the word and its
        exponent — the clue), so the hint has to be a description, and a description lives in
        the DOM. Inside the <p> it would interleave "Explore word 2" into the prose a screen
        reader reads straight through; after it, the sentence stays a sentence. */}
    {onExplore &&
      exploreLabels?.map((label, idx) =>
        label === null ? null : (
          <span key={idx} id={hintId(idx)} className="sr-only">
            {label}
          </span>
        ),
      )}
    {/* The meters' descriptions (#301), outside the sentence for the same reason: the
        charge and the given words are the hole's STATE, read as a description of the
        hole, never as words in the prose. */}
    {charges?.map((charge, idx) =>
      charge.hint ? (
        <span key={idx} id={chargeId(idx)} className="sr-only">
          {charge.hint}
        </span>
      ) : null,
    )}
    </>
  );
}
