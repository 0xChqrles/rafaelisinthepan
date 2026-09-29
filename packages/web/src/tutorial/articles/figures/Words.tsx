import { useState } from 'react';
import type { WordList } from '../types';
import Rich from '../Rich';
import Tabs from './Tabs';

// LISTS OF NEIGHBOURS: the sentence they were read in (its word of interest a held chip, as
// in the game), then the lists side by side — or, with tabs, one at a time. A marked word
// wears the heat ramp's end its tone names: weird red for a wrong sense, calm cobalt for
// the right one.
function List({ list, showLabel }: { list: WordList; showLabel: boolean }) {
  return (
    <div className="ar-list">
      {showLabel && list.label && <p className="ar-list-label">{list.label}</p>}
      <ol className="ar-list-words">
        {list.words.map((w) => (
          <li
            key={w}
            className={list.marked?.includes(w) ? `marked ${list.tone ?? 'wrong'}` : undefined}
          >
            {w}
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function Words({
  sentence,
  lists,
  tabs,
}: {
  sentence?: string;
  lists: WordList[];
  tabs?: boolean;
}) {
  const [at, setAt] = useState(0);
  return (
    <div className="ar-words">
      {tabs && <Tabs labels={lists.map((l) => l.label ?? '')} active={at} onPick={setAt} />}
      {sentence && (
        <p className="ar-sentence ar-fig-sentence">
          <Rich text={sentence} mode="sentence" />
        </p>
      )}
      <div className={`ar-lists${lists.length > 1 && !tabs ? ' columns' : ''}`}>
        {tabs ? (
          <List key={at} list={lists[at]} showLabel={false} />
        ) : (
          lists.map((list) => <List key={list.label ?? list.words[0]} list={list} showLabel />)
        )}
      </div>
    </div>
  );
}
