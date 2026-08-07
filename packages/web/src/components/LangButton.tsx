import { navigate } from '../routing';
import { SELECT_PATH } from '../langs';
import { t } from '../i18n';

// The language control at the left of the app header's action group: it opens the language
// screen — a route, not a modal, and the ONE language-switching gesture everywhere (game and
// tutorial alike; the tutorial's transient open-state survives the round-trip).
//
// It shows a GLOBE, not the current language's flag (2026-08-06). The button's job is
// "change language", and a flag answered a different question — which language is loaded —
// while the header already says that in every other way (the puzzle is on screen in it). One
// glyph also means the control looks the same in every language, so it reads as a fixed piece
// of chrome rather than as a status that happens to be tappable. Flags still identify the
// languages where the choice is actually made: the cards on the language screen.
export default function LangButton({ lang }: { lang: string }) {
  return (
    <button
      type="button"
      className="home-btn lang-btn"
      onClick={() => navigate(SELECT_PATH)}
      aria-label={t(lang, 'ariaChangeLanguage')}
    >
      {/* Masked rather than drawn: globe.png is a single-colour glyph, so painting it with
          `currentColor` lets it take the header's muted -> --fg hover like the inline SVG
          icons beside it, instead of being the one control in the group that cannot. */}
      <span className="pixel-icon globe-icon" aria-hidden="true" />
    </button>
  );
}
