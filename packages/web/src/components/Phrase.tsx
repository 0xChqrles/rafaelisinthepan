import { Fragment } from 'react';
import Hole from './Hole';
import type { HitState, RuntimeHole } from '@rafaelisinthepan/shared';

// Render the sentence: normal words as plain text, holes via <Hole>.
export default function Phrase({
  words,
  holes,
  hits,
  onHitDone,
}: {
  words: string[];
  holes: RuntimeHole[];
  hits: HitState[]; // one transient number per warm hole (multi-hit)
  onHitDone: (id: number) => void;
}) {
  const holeIndexByPos = new Map<number, number>(holes.map((h, i) => [h.pos, i]));

  return (
    <p className="phrase">
      {words.map((w, i) => {
        const space = i > 0 ? ' ' : '';
        const idx = holeIndexByPos.get(i);
        if (idx !== undefined) {
          const activeHit = hits.find((h) => h.holeIndex === idx) ?? null;
          return (
            <Fragment key={i}>
              {space}
              <Hole hole={holes[idx]} hit={activeHit} onHitDone={onHitDone} />
              {/* line break AFTER each hole: the hole ends its line, words flow until the next hole */}
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
