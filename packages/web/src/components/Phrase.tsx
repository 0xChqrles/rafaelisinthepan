import { Fragment } from 'react';
import Hole from './Hole';
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
  waveSolved = false,
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
  // Tutorial only (#155): its solved word may wave — the lesson ends on it (see Hole).
  waveSolved?: boolean;
}) {
  const holeIndexByPos = new Map<number, number>(holes.map((h, i) => [h.pos, i]));
  const puzzleHoleByPos = new Map<number, PuzzleHole>(puzzleHoles.map((h) => [h.pos, h]));
  const hintId = (holeIndex: number) => `hole-explore-${holeIndex}`;

  return (
    <>
    <p className="phrase">
      {words.map((w, i) => {
        const space = i > 0 ? ' ' : '';
        const idx = holeIndexByPos.get(i);
        if (idx !== undefined) {
          const rHole = holes[idx];
          const activeHit = hits.find((h) => h.holeIndex === idx) ?? null;
          const { prefix, suffix } = puzzleHoleByPos.get(i) ?? {};
          const exploreLabel = exploreLabels?.[idx] ?? null;
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
              <span className="hole-group">
                {prefix ? <span className="word">{prefix}</span> : null}
                <Hole
                  hole={rHole}
                  hit={activeHit}
                  holeIndex={idx}
                  onHitDone={onHitDone}
                  onResolved={onHoleResolved}
                  quiet={quiet}
                  waveSolved={waveSolved}
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
            <span className="word">{w}</span>
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
    </>
  );
}
