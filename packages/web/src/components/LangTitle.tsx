// THE SCREEN'S NAME, AND THE LANGUAGE IT IS SPEAKING (user-decided 2026-09-03: "on every
// page of the game we should be able to switch lang").
//
// The play surfaces could always switch — `PuzzleTitle` carries the language they show and
// the selection behind it turns it. The ACCOUNT AREA could not: `/account` carried a
// plain name and its steps carried a back control, so a player who landed there in the wrong
// language had to go back to a game to get out of it. This is the same control for a screen
// that is not a puzzle: the name in the header's chip, the language beside it in the ARCHIVE
// DAY's exact dress (`.title-tag` — quieter than the name it qualifies, outside the chip,
// like a hole's exponent), the same chevron, and the same selection behind it
// (`PuzzleSelect`).
//
// **THE TAG IS THE FIRST THING TO GIVE, and the name is the last** (`.lang-tag`, measured
// 2026-09-03). A step's left slot holds FOUR things now — arrow, name, language, chevron —
// beside a five-key group that may never shrink, and French runs ~20% longer than English:
// SAUVEGARDE and VIE PRIVÉE ran into the keys. So when the name would be CUT, the LANGUAGE
// goes and the name stays whole — measured, never a fixed width: the keys' own sizes step at
// several widths, and a breakpoint chosen at one of them was wrong at the next. It is the honest order — a screen must say where
// you are (the name), then that the axis can be changed (the chevron), and only then WHICH
// value it holds (the tag) — and it is the tag's own rule: it is which of a thing, not what
// the thing is. Nothing is lost that the page is not already saying in that language.
//
// **The TAG is the language's CODE, not its name.** `LANGS[].native` is what the drum shows,
// because a language must be readable by the person who needs it; two letters is what fits a
// header slot that is already at its measured width budget, and EN/FR is the one spelling
// nobody has to translate.
//
// It wears `.puzzle-title`, which is the dress of BOTH clickable header titles rather than
// the puzzle one's alone: the row's three phone step-downs are tuned on that class, and a
// second class beside it would be three more overrides that nothing forces to agree.

import { useLayoutEffect, useRef, useState } from 'react';
import ChevronDownIcon from '../assets/icons/chevron-down.svg?react';
import PuzzleSelect from './PuzzleSelect';
import { t } from '../i18n';
import type { LangCode } from '../langs';
import { dropLangParam, navigate } from '../routing';
import { useGameStore } from '../state/gameStore';

export default function LangTitle({
  lang,
  title,
  // WHERE this screen lives in the OTHER language, when its URL names one. The account area
  // has no such URL — its routes are global — so a pick there is a preference and the page
  // re-renders where it stands; the TUTORIAL sits on `/fr` or `/en`, so its pick has to
  // travel, and `key={lang}` restarts the lesson in the language it lands in.
  to,
}: {
  lang: LangCode;
  title: string;
  to?: (lang: LangCode) => string;
}) {
  const [open, setOpen] = useState(false);
  const tag = lang.toUpperCase();
  // Whether this name is CUT with its tag beside it — asked of the layout WITH the tag every
  // time, whatever is on screen now: the check lifts `.squeezed` for the length of one
  // measurement (a synchronous reflow, never painted) and puts it back. The answer depends on
  // nothing but the layout, so it can never feed itself: no remembered width, no flip-flop
  // while the window is dragged.
  const buttonRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLSpanElement>(null);
  const [squeezed, setSqueezed] = useState(false);
  const key = `${title}:${tag}`;
  useLayoutEffect(() => {
    const button = buttonRef.current;
    const name = nameRef.current;
    if (!button || !name) return undefined;
    const check = () => {
      const held = button.classList.contains('squeezed');
      if (held) button.classList.remove('squeezed');
      const cut = name.scrollWidth > name.clientWidth;
      if (held) button.classList.add('squeezed');
      setSqueezed(cut);
    };
    check();
    // (Asked again once the chrome's font has landed: measured in the fallback face, every
    // name fits.)
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) check();
    });
    window.addEventListener('resize', check);
    return () => {
      live = false;
      window.removeEventListener('resize', check);
    };
  }, [key]);
  // A DELIBERATE PICK OUTRANKS THE LINK THAT SUGGESTED ONE: `?lang=` is read ahead of the
  // stored preference, so it has to go before the preference is written — or the URL would
  // answer the player instead of the wheel, and a reload would put the link's language back.
  const pick = (picked: LangCode) => {
    dropLangParam();
    useGameStore.getState().setLastLang(picked);
    if (to) navigate(to(picked));
  };
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`puzzle-title${squeezed ? ' squeezed' : ''}`}
        // The NAME first, then what the control does — `aria-label` REPLACES the content,
        // so labelling it "Change language" alone would take the screen's own name away
        // from a reader entirely (`PuzzleTitle`'s rule).
        aria-label={`${title} ${tag}, ${t(lang, 'langMenu')}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span ref={nameRef} className="topbar-title">
          {title}
        </span>
        <span className="title-tag lang-tag">{tag}</span>
        <ChevronDownIcon className="ui-icon" aria-hidden />
      </button>
      {open && (
        <PuzzleSelect lang={lang} onLang={pick} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
