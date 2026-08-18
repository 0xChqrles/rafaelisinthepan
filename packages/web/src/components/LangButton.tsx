import { navigate } from '../routing';
import { SELECT_PATH } from '../langs';
import { t } from '../i18n';

// The language control in the header's right group: it opens the language screen — a
// route, not a modal, and the ONE language-switching gesture everywhere (game and
// tutorial alike; the tutorial's transient open-state survives the round-trip).
//
// It reads as the loaded language's CODE — `FR` / `EN` — since 2026-08-18 (replacing
// the Lucide languages glyph; a globe before that): the two-letter code is the one
// place two letters are universally intuitive, it is more honest than an icon (it
// shows what is loaded), and it is the header's most delicate possible control — two
// small mono letters, no fill.
export default function LangButton({ lang }: { lang: string }) {
  return (
    <button
      type="button"
      className="home-btn lang-btn"
      onClick={() => navigate(SELECT_PATH)}
      aria-label={t(lang, 'ariaChangeLanguage')}
    >
      <span className="lang-chip" aria-hidden="true">
        {lang.toUpperCase()}
      </span>
    </button>
  );
}
