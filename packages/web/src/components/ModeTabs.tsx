import { t } from '../i18n';
import type { Mode } from '../langs';

// The header's SEGMENTED MODE SWITCHER (user-decided 2026-08-18, retiring the /mode
// chooser screen): switching dailies is the app's most frequent navigation, and a
// round-trip through a chooser was the wrong shape for a binary choice. The tabs show
// BOTH dailies and mark the active one with the app's inverted selection box — which is
// exactly what the 2026-08-06 icon-toggle lacked (it showed only the mode you were NOT
// in). A third daily is one more segment.
//
// Where a tap lands is the CALLER's (`onSelect`): the game routes to the other mode's
// today, the archive to the other mode's calendar — the tabs work anywhere a route has
// a lang + mode context.
const MODES: { mode: Mode; nameKey: 'modeSentence' | 'modeWord' }[] = [
  { mode: 'sentence', nameKey: 'modeSentence' },
  { mode: 'word', nameKey: 'modeWord' },
];

export default function ModeTabs({
  lang,
  mode,
  onSelect,
}: {
  lang: string;
  mode: Mode;
  onSelect: (mode: Mode) => void;
}) {
  return (
    <nav className="mode-tabs" aria-label={t(lang, 'ariaChangeMode')}>
      {MODES.map(({ mode: m, nameKey }) => (
        <button
          key={m}
          type="button"
          className={`mode-tab${m === mode ? ' active' : ''}`}
          aria-current={m === mode || undefined}
          onClick={() => {
            if (m !== mode) onSelect(m);
          }}
        >
          {t(lang, nameKey)}
        </button>
      ))}
    </nav>
  );
}
