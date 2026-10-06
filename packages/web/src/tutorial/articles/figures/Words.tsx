import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { MISS_COLOR } from '@whippin/shared';
// The dissolve's tiles are set on the document's root as this module loads.
import { DISSOLVE_MS } from '../../../components/bayerTiles';
import { t } from '../../../i18n';
import { useArticleLang } from '../lang';
import type { WordList } from '../types';
import Rich from '../Rich';
import Tabs from './Tabs';

// LISTS OF NEIGHBOURS, as the game lists a hole's words once it is found (the words grid): the
// sentence they were read in, set in the pixel face as the game sets it (the word it is about
// in the found cobalt), then the words in the pixel face on the bare ground, in columns as wide
// as the longest word — or, with tabs, one list at a time on the boards' own switch, every list
// laid out in the same cell so a turn never changes the figure's height, the list turned to
// dissolving in through the Bayer order as the other dissolves out (a board line's arrival). A
// marked word wears the heat ramp's end its tone names: the weird red of a MISS for a wrong
// sense, the calm cobalt of a found word for the right one — and says so in words too.
function List({ list, state }: { list: WordList; state: 'shown' | 'in' | 'out' | 'hidden' }) {
  const lang = useArticleLang();
  const tone = list.tone ?? 'wrong';
  const said = t(lang, tone === 'wrong' ? 'levelMarkWrong' : 'levelMarkRight');
  const longest = Math.max(...list.words.map((w) => w.length));
  return (
    <div className={`ar-list ${state}`} hidden={state === 'hidden'} aria-hidden={state === 'out' || undefined}>
      <ol className="ar-list-words" style={{ '--mark': MISS_COLOR, '--longest': longest } as CSSProperties}>
        {list.words.map((w) => {
          const marked = list.marked?.includes(w);
          return (
            <li key={w} className={marked ? `marked ${tone}` : undefined}>
              {w}
              {marked && <span className="sr-only">{` (${said})`}</span>}
            </li>
          );
        })}
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
  // The list giving way to the one turned to, while it dissolves out.
  const [leaving, setLeaving] = useState<number | null>(null);
  useEffect(() => {
    if (leaving === null) return undefined;
    const id = window.setTimeout(() => setLeaving(null), DISSOLVE_MS);
    return () => window.clearTimeout(id);
  }, [leaving]);
  const turn = (i: number) => {
    setLeaving(at);
    setAt(i);
  };
  const stateOf = (i: number) =>
    i === at ? (leaving === null ? 'shown' : 'in') : i === leaving ? 'out' : 'hidden';
  return (
    <div className="ar-words">
      {tabs && <Tabs labels={lists.map((l) => l.label ?? '')} active={at} onPick={turn} />}
      {sentence && (
        <p className="ar-fig-sentence">
          <Rich text={sentence} mode="sentence" />
        </p>
      )}
      {/* A tab swaps the list shown: the figure says so itself, as the plane re-reads its lengths. */}
      <div className={`ar-lists${tabs ? ' stacked' : ''}`} aria-live={tabs ? 'polite' : undefined}>
        {lists.map((list, i) => (
          <List key={list.label ?? list.words[0]} list={list} state={tabs ? stateOf(i) : 'shown'} />
        ))}
      </div>
    </div>
  );
}
