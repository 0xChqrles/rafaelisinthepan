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
}: {
  words: string[];
  holes: RuntimeHole[];
  puzzleHoles: PuzzleHole[]; // static per-hole data (affixes), keyed by pos below
  hits: HitState[]; // one transient number per warm hole (multi-hit)
  onHitDone: (id: number) => void;
  onHoleResolved?: (index: number) => void;
}) {
  const holeIndexByPos = new Map<number, number>(holes.map((h, i) => [h.pos, i]));
  const puzzleHoleByPos = new Map<number, PuzzleHole>(puzzleHoles.map((h) => [h.pos, h]));

  return (
    <p className="phrase">
      {words.map((w, i) => {
        const space = i > 0 ? ' ' : '';
        const idx = holeIndexByPos.get(i);
        if (idx !== undefined) {
          const rHole = holes[idx];
          const activeHit = hits.find((h) => h.holeIndex === idx) ?? null;
          const { prefix, suffix } = puzzleHoleByPos.get(i) ?? {};
          // Prefix (leading clitic) and suffix (trailing punctuation) are sentence
          // context and always show. They live with the blank in a nowrap group so
          // they can never break onto a different line from it.
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
                />
                {suffix ? <span className="word">{suffix}</span> : null}
              </span>
              {/* DELIBERATE line break after each hole — do not swap for natural
                  wrapping. A hole's word is replaced many times during a round
                  (start word -> ever-closer words, arbitrary widths); if the
                  sentence wrapped as prose, every swap would rewrap the whole
                  paragraph and the text the player is reading would jump around.
                  Ending the line at the hole pins every word to its line for the
                  entire round; of the layouts tried, this read best. */}
              <br />
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
  );
}
