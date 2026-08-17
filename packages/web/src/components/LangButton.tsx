import { navigate } from '../routing';
import { SELECT_PATH } from '../langs';
import { t } from '../i18n';
import LanguagesIcon from '../assets/icons/languages.svg?react';

// The language control at the left of the app header's action group: it opens the language
// screen — a route, not a modal, and the ONE language-switching gesture everywhere (game and
// tutorial alike; the tutorial's transient open-state survives the round-trip).
//
// It shows the LANGUAGES glyph (Lucide's 文/A translation mark since 2026-08-18; a globe
// before that, 2026-08-06), not the current language's flag. The button's job is "change
// language", and a flag answered a different question — which language is loaded — while
// the header already says that in every other way (the puzzle is on screen in it). One
// glyph also means the control looks the same in every language, so it reads as a fixed
// piece of chrome rather than as a status that happens to be tappable.
export default function LangButton({ lang }: { lang: string }) {
  return (
    <button
      type="button"
      className="home-btn lang-btn"
      onClick={() => navigate(SELECT_PATH)}
      aria-label={t(lang, 'ariaChangeLanguage')}
    >
      <LanguagesIcon className="ui-icon" aria-hidden />
    </button>
  );
}
