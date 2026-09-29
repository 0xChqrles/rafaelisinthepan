import type { Figure as FigureData } from '../types';
import Arcs from './Arcs';
import Bars from './Bars';
import Flow from './Flow';
import Loop from './Loop';
import Plane from './Plane';
import Ranks from './Ranks';
import Tournament from './Tournament';
import Words from './Words';

// One figure's drawing, by kind (types.ts).
export default function FigureBody({ lang, fig }: { lang: string; fig: FigureData }) {
  switch (fig.kind) {
    case 'plane':
      return <Plane lang={lang} states={fig.states} edges={fig.edges} tabs={fig.tabs} />;
    case 'bars':
      return <Bars lang={lang} rows={fig.rows} />;
    case 'loop':
      return <Loop steps={fig.steps} />;
    case 'words':
      return <Words sentence={fig.sentence} lists={fig.lists} tabs={fig.tabs} />;
    case 'ranks':
      return <Ranks board={fig.board} take={fig.take} more={fig.more} />;
    case 'arcs':
      return <Arcs lang={lang} tokens={fig.tokens} focus={fig.focus} weights={fig.weights} hidden={fig.hidden} />;
    case 'flow':
      return <Flow rows={fig.rows} />;
    case 'tournament':
      return <Tournament lang={lang} rows={fig.rows} labels={fig.labels} />;
  }
}
