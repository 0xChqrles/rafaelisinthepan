// THE CHROME LANGUAGE OF A SCREEN THE URL DOES NOT NAME ONE FOR — the account area, the
// chooser, the invite landing, the signed-out screen, and the `/` redirect's destination.
//
// Three sources, in order (`resolveUiLang`): the LINK's own `?lang=` (user-decided
// 2026-09-03 — a sent link renders in the language it was sent in), then the STORED
// preference, then the browser's. It is a hook rather than a call because the middle source
// is store state — the language selection writes it — and the first is the URL, which
// `useLocation` already re-reads on every navigation and on `dropLangParam`.
//
// A language-scoped route does NOT use this: `/fr` names its language, and the path is the
// more specific statement.
import { resolveUiLang, type LangCode } from '../langs';
import { useLocation } from '../routing';
import { useGameStore } from '../state/gameStore';

export default function useUiLang(): LangCode {
  // Subscribed for its SIDE EFFECT: the pathname is not read, but a navigation (and the
  // parameter's own removal) has to re-run the resolution below.
  useLocation();
  const lastLang = useGameStore((s) => s.lastLang);
  return resolveUiLang(window.location.search, lastLang, navigator.language);
}
