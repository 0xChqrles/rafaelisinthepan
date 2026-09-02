import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, RefObject } from 'react';
import { createPortal } from 'react-dom';
import ChevronLeftIcon from '../assets/icons/chevron-left.svg?react';
import useDrum from '../hooks/useDrum';
import useModalDismiss from '../hooks/useModalDismiss';
import { t } from '../i18n';
import { LANGS, pathForArchive, pathForMode, type LangCode, type Mode } from '../langs';
import { navigate } from '../routing';

// THE SELECTION BEHIND THE TITLE (user-decided 2026-09-02, over four passes). The title is
// a HELD WORD — it wears the sentence chip — and what opens under it is the hole wheel's
// grammar on a screen of its own: two picker DRUMS side by side, the DAILY's and the
// LANGUAGE's, each a column that scrolls THROUGH a fixed slot in the middle of the screen;
// the row in a slot wears the chip and the others stand plain; and what BOTH slots hold when
// the screen folds is the pick. The iOS date picker's day | month, in the app's own dress.
//
// WHY A SCREEN, AND WHY DRUMS. The first cut stood the drums on the title's own chip in the
// header, and the user retired it within the hour: a slot at the top of the screen has no
// room above it, so rows "just get clipped" instead of turning. A one-tap menu replaced it —
// and the user asked for the drums BACK, on the flat screen where there is room for them
// ("make the mode/lang selection use the wheel scrolling, and bring back the 3 tap logic, so
// users can change the mode and lang without having to reopen the menu"): turning both
// drums and folding once is one errand, where a one-tap menu made switching both axes two
// openings. So: open, turn (as many drums as you like), fold.
//
// THE PICK LANDS AS THE FOLD BEGINS — under the veil, not after it. The fold is ONE door
// (the back chevron top-left, a tap on a slot row, a tap outside the drums, or Escape), and
// the moment it opens the app navigates to whatever the two slots hold (or nowhere, when
// neither moved), so the new screen — its loading state included — is what stands under
// the veil while it lifts. Navigating on the dialog's `close` instead (the hole wheel's
// "pick lands on the fold", kept here for one pass) showed the OLD mode's screen for the
// length of the fade, then a beat of loading, then the new one — "a sensation of rapid
// blinking between multiple screens" (user-reported 2026-09-02). The hole wheel keeps its
// rule for its own reason (a pick reflows the sentence the wheel stands on); here the
// screen under the veil is exactly what should change. It routes by the SURFACE it was
// opened from, which is what the retired tabs did: from the archive, the other daily means
// that daily's CALENDAR.
//
// THE GROUND IS FLAT `--bg` (third pass: "make just the veil go all black" — two translucent
// veils left the sentence and the rules printing behind the options; the hole wheel's dim
// is a quarter because the sentence under it is what that wheel is ABOUT, and nothing under
// this one is). With nothing showing through it is a full-screen dialog, so it wears the
// app's header row — and its way back is a LEFT CHEVRON in the left slot (fourth pass, "use
// a left chevron as a back icon on the header"), the title's own chevron turned to point
// the way out, rather than the modals' ✕. A native <dialog> on `useModalDismiss`, so the
// screen under it is inert.

// The air between rows, and between the two drums.
const GAP = 14;
// Rows visible in a drum, the slot in the middle: room for a row above and below the ends
// (the CSS fades the outer 44px of each end, so a row arrives out of the dark).
const VISIBLE = 5;

const MODES: { mode: Mode; key: 'modeSentence' | 'modeWord' }[] = [
  { mode: 'sentence', key: 'modeSentence' },
  { mode: 'word', key: 'modeWord' },
];

export default function PuzzleSelect({
  lang,
  mode,
  onArchive,
  onClose,
}: {
  lang: LangCode;
  mode: Mode;
  onArchive: boolean;
  onClose: () => void;
}) {
  // FIRST hook, per the contract: a closed <dialog> is `display: none`, and the row height
  // is measured below.
  const { closing, beginClose, dialogProps } = useModalDismiss('select-out');

  // A row is as tall as the chip it holds — measured once the dialog is open, off a chip
  // in the tree, so the CSS owns the type and the drums follow it.
  const probe = useRef<HTMLSpanElement>(null);
  const [rowH, setRowH] = useState(0);
  useLayoutEffect(() => {
    const el = probe.current;
    if (!el) return undefined;
    const update = () => setRowH(el.getBoundingClientRect().height);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const pitch = rowH + GAP;
  const ready = rowH > 0;

  const modeBox = useRef<HTMLDivElement>(null);
  const modeTrack = useRef<HTMLDivElement>(null);
  const langBox = useRef<HTMLDivElement>(null);
  const langTrack = useRef<HTMLDivElement>(null);
  const modeIndex = Math.max(0, MODES.findIndex((m) => m.mode === mode));
  const langIndex = Math.max(0, LANGS.findIndex((l) => l.code === lang));
  const modeDrum = useDrum({
    ref: modeBox,
    active: ready,
    count: MODES.length,
    pitch,
    initial: modeIndex,
    write: (px) => {
      if (modeTrack.current) modeTrack.current.style.translate = `0 ${-px}px`;
    },
  });
  const langDrum = useDrum({
    ref: langBox,
    active: ready,
    count: LANGS.length,
    pitch,
    initial: langIndex,
    write: (px) => {
      if (langTrack.current) langTrack.current.style.translate = `0 ${-px}px`;
    },
  });
  // Open ON the held pair: each drum's current row in its slot, before paint, once the
  // pitch is known.
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (!ready || opened.current) return;
    opened.current = true;
    modeDrum.jump(modeIndex);
    langDrum.jump(langIndex);
  }, [langDrum, langIndex, modeDrum, modeIndex, ready]);

  // The fold BEGINS (every door sets `closing`): the app moves to what both slots hold,
  // once, while the veil is still up. A screen that unmounts this title with the route
  // takes the dialog with it, which is the same picture a beat sooner.
  const moved = useRef(false);
  useEffect(() => {
    if (!closing || moved.current) return;
    moved.current = true;
    const m = MODES[modeDrum.peek()]?.mode ?? mode;
    const l = LANGS[langDrum.peek()]?.code ?? lang;
    if (m !== mode || l !== lang) navigate(onArchive ? pathForArchive(l, m) : pathForMode(l, m));
  }, [closing, lang, langDrum, mode, modeDrum, onArchive]);

  // The arrow keys turn the drum that holds focus — the daily's when none does; Left and
  // Right hand focus from one drum's slot row to the other's.
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const inLang = langBox.current?.contains(document.activeElement) ?? false;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        (inLang ? langDrum : modeDrum).glideBy(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const box = (e.key === 'ArrowRight' ? langBox : modeBox).current;
        box?.querySelector<HTMLElement>('[aria-current="true"]')?.focus({ preventScroll: true });
      }
    },
    [langDrum, modeDrum],
  );

  // A drum: the slot sits in the middle of `VISIBLE` rows, so row i is in it at
  // `translate = i × pitch` once the lead spacer holds the rows above it off the top.
  const half = Math.floor(VISIBLE / 2);
  const drum = (
    items: { key: string; label: string }[],
    d: typeof modeDrum,
    box: RefObject<HTMLDivElement | null>,
    track: RefObject<HTMLDivElement | null>,
    stagger: number,
  ) => (
    <div className="ps-drum" ref={box} style={{ height: VISIBLE * pitch - GAP }}>
      <div className="ps-track" ref={track}>
        <div className="ps-lead" style={{ height: half * pitch }} />
        {items.map((item, i) => {
          const inSlot = i === d.current;
          return (
            <button
              key={item.key}
              type="button"
              className={`ps-row${inSlot ? ' on' : ''}`}
              style={{ height: rowH, marginBottom: GAP, '--i': stagger + Math.abs(i - d.current) } as CSSProperties}
              aria-current={inSlot ? 'true' : undefined}
              aria-label={inSlot ? `${item.label}, ${t(lang, 'ariaClose')}` : item.label}
              onClick={() => {
                if (d.tap(i) === 'slot') beginClose();
              }}
            >
              <span className="ps-chip">{item.label}</span>
            </button>
          );
        })}
        <div className="ps-trail" style={{ height: half * pitch - GAP }} />
      </div>
    </div>
  );

  return createPortal(
    <dialog
      {...dialogProps}
      className={`wheel-dialog puzzle-select${closing ? ' closing' : ''}`}
      aria-label={t(lang, 'puzzleMenu')}
      onClose={onClose}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        // A drag that ended here is not a tap on anything.
        if (modeDrum.endedDrag() || langDrum.endedDrag()) return;
        // The dialog, the drums' boxes and their spacers have no content of their own, so
        // a click that lands on one of them landed on nothing in the selection.
        const el = e.target as HTMLElement;
        const bare =
          el === e.currentTarget ||
          ['ps-cols', 'ps-drum', 'ps-track', 'ps-lead', 'ps-trail'].some((c) => el.classList.contains(c));
        if (bare && !closing) beginClose();
      }}
    >
      {/* The app's header row, with the way back in its left slot. */}
      <div className="modal-bar">
        <div className="topbar-inner">
          <div className="topbar-left">
            <button
              type="button"
              className="home-btn ps-back"
              aria-label={t(lang, 'ariaClose')}
              onClick={() => {
                if (!closing) beginClose();
              }}
            >
              <ChevronLeftIcon className="ui-icon" aria-hidden />
            </button>
          </div>
          <div className="topbar-right" />
        </div>
      </div>
      {/* The row-height probe: one chip in the tree, off screen, in the rows' own dress. */}
      <span ref={probe} className="ps-chip ps-probe" aria-hidden>
        X
      </span>
      {ready && (
        <div className="ps-cols">
          {drum(
            MODES.map((m) => ({ key: m.mode, label: t(lang, m.key).toUpperCase() })),
            modeDrum,
            modeBox,
            modeTrack,
            0,
          )}
          {drum(
            LANGS.map((l) => ({ key: l.code, label: l.native.toUpperCase() })),
            langDrum,
            langBox,
            langTrack,
            1,
          )}
        </div>
      )}
    </dialog>,
    document.body,
  );
}
