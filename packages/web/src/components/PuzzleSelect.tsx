import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import useDrum from '../hooks/useDrum';
import useModalDismiss from '../hooks/useModalDismiss';
import { HeaderBack } from './TopBar';
import { t } from '../i18n';
import { LANGS, type LangCode } from '../langs';

// THE SELECTION BEHIND THE TITLE (user-decided 2026-09-02, over four passes). The title is
// a HELD WORD — it wears the sentence chip — and what opens under it is the hole wheel's
// grammar on a screen of its own: the LANGUAGE's picker DRUM, a column that scrolls THROUGH
// a fixed slot in the middle of the screen; the row in the slot wears the chip and the
// others stand plain; and what the slot holds when the screen folds is the pick.
//
// WHY A SCREEN, AND WHY A DRUM. The first cut stood the drums on the title's own chip in the
// header, and the user retired it within the hour: a slot at the top of the screen has no
// room above it, so rows "just get clipped" instead of turning. A one-tap menu replaced it —
// and the user asked for the drums BACK, on the flat screen where there is room for them.
// So: open, turn, fold.
//
// THE PICK LANDS AS THE FOLD BEGINS — under the veil, not after it. The fold is ONE door
// (the back chevron top-left, a tap on the slot row, a tap outside the drum, or Escape), and
// the moment it opens the caller hears what the slot holds (or nothing, when it did not
// move), so the new screen — its loading state included — is what stands under the veil
// while it lifts. Answering on the dialog's `close` instead (the hole wheel's "pick lands on
// the fold", kept here for one pass) showed the OLD screen for the length of the fade, then a
// beat of loading, then the new one — "a sensation of rapid blinking between multiple
// screens" (user-reported 2026-09-02). The hole wheel keeps its rule for its own reason (a
// pick reflows the sentence the wheel stands on); here the screen under the veil is exactly
// what should change.
//
// THE GROUND IS FLAT `--bg` (third pass: "make just the veil go all black" — two translucent
// veils left the sentence and the rules printing behind the options; the hole wheel's dim
// is a quarter because the sentence under it is what that wheel is ABOUT, and nothing under
// this one is). With nothing showing through it is a full-screen dialog, so it wears the
// app's header row — and its way back is a LEFT CHEVRON in the left slot (fourth pass, "use
// a left chevron as a back icon on the header"), the title's own chevron turned to point
// the way out, rather than the modals' ✕. A native <dialog> on `useModalDismiss`, so the
// screen under it is inert.
//
// WHAT A PICK MEANS IS THE CALLER'S (`onLang`), because the screens that mount this answer
// it differently: a puzzle surface names its language in the URL, so a pick NAVIGATES —
// and keeps you on the same kind of screen (from the archive, the other language's
// CALENDAR; from the leaderboard, its BOARD; user-reported 2026-09-03: a pick there once
// dropped the player onto the puzzle instead); the account area's routes are GLOBAL — an
// identity is not language-scoped — so there is no URL to move to and the pick is a
// PREFERENCE: `lastLang`, which is exactly what every screen of that area reads its chrome
// language from (`resolveHomeLang`). This component knows the drum; the screen knows what
// its own language means.

// The air between rows.
const GAP = 14;
// Rows visible in a drum, the slot in the middle: room for a row above and below the ends
// (the CSS fades the outer 44px of each end, so a row arrives out of the dark).
const VISIBLE = 5;

export default function PuzzleSelect({
  lang,
  onLang,
  onClose,
}: {
  lang: LangCode;
  // What a pick does — see above. Called once, as the fold begins, and only when the drum
  // moved.
  onLang: (lang: LangCode) => void;
  onClose: () => void;
}) {
  // FIRST hook, per the contract: a closed <dialog> is `display: none`, and the row height
  // is measured below.
  const { closing, beginClose, dialogProps } = useModalDismiss('select-out');

  // A row is as tall as the chip it holds — measured once the dialog is open, off a chip
  // in the tree, so the CSS owns the type and the drum follows it.
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

  const langBox = useRef<HTMLDivElement>(null);
  const langTrack = useRef<HTMLDivElement>(null);
  const langIndex = Math.max(0, LANGS.findIndex((l) => l.code === lang));
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
  // Open ON the held language: its row in the slot, before paint, once the pitch is known.
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (!ready || opened.current) return;
    opened.current = true;
    langDrum.jump(langIndex);
  }, [langDrum, langIndex, ready]);

  // The fold BEGINS (every door sets `closing`): the caller hears what the slot holds, once,
  // while the veil is still up. A screen that unmounts this title with the route takes the
  // dialog with it, which is the same picture a beat sooner.
  const moved = useRef(false);
  useEffect(() => {
    if (!closing || moved.current) return;
    moved.current = true;
    const l = LANGS[langDrum.peek()]?.code ?? lang;
    if (l !== lang) onLang(l);
  }, [closing, lang, langDrum, onLang]);

  // A drum that turns while one of its rows holds the focus carries the focus into the
  // slot (#267): the pick is the drum's one tab stop, so what the keyboard is on and what
  // the slot shows stay one thing. A drum turned by a pointer moves no focus.
  useEffect(() => {
    const box = langBox.current;
    if (box?.contains(document.activeElement)) {
      box.querySelector<HTMLElement>('[aria-current="true"]')?.focus({ preventScroll: true });
    }
  }, [langDrum.current]);

  // The arrow keys turn the drum.
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        langDrum.glideBy(e.key === 'ArrowDown' ? 1 : -1);
      }
    },
    [langDrum],
  );

  // The drum: the slot sits in the middle of `VISIBLE` rows, so row i is in it at
  // `translate = i × pitch` once the lead spacer holds the rows above it off the top.
  const half = Math.floor(VISIBLE / 2);

  return createPortal(
    <dialog
      {...dialogProps}
      className={`wheel-dialog puzzle-select${closing ? ' closing' : ''}`}
      aria-label={t(lang, 'langMenu')}
      onClose={onClose}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        // A drag that ended here is not a tap on anything.
        if (langDrum.endedDrag()) return;
        // The dialog, the drum's box and its spacers have no content of their own, so a
        // click that lands on one of them landed on nothing in the selection.
        const el = e.target as HTMLElement;
        const bare =
          el === e.currentTarget ||
          ['ps-cols', 'ps-drum', 'ps-track', 'ps-lead', 'ps-trail'].some((c) => el.classList.contains(c));
        if (bare && !closing) beginClose();
      }}
    >
      {/* The app's header row, with the way back in its left slot — `HeaderBack` ITSELF, not
          a look-alike: the selection opens over a header that carries the same control on
          every step of the account area, and a chevron drawn a few pixels off from the one
          it covers reads as the back button MOVING when the screen opens (user-reported
          2026-09-03). Same component, same geometry, same slot: it does not move. */}
      <div className="modal-bar">
        <div className="topbar-inner">
          <div className="topbar-left">
            <HeaderBack
              label={t(lang, 'ariaClose')}
              onBack={() => {
                if (!closing) beginClose();
              }}
            />
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
          <div className="ps-drum" ref={langBox} style={{ height: VISIBLE * pitch - GAP }}>
            <div className="ps-track" ref={langTrack}>
              <div className="ps-lead" style={{ height: half * pitch }} />
              {LANGS.map((item, i) => {
                const inSlot = i === langDrum.current;
                const label = item.native.toUpperCase();
                return (
                  <button
                    key={item.code}
                    type="button"
                    className={`ps-row${inSlot ? ' on' : ''}`}
                    style={{ height: rowH, marginBottom: GAP, '--i': Math.abs(i - langDrum.current) } as CSSProperties}
                    aria-current={inSlot ? 'true' : undefined}
                    // The drum's ONE tab stop is the row in the slot (#267): the arrows turn it.
                    tabIndex={inSlot ? 0 : -1}
                    aria-label={inSlot ? `${label}, ${t(lang, 'ariaClose')}` : label}
                    onClick={() => {
                      if (langDrum.tap(i) === 'slot') beginClose();
                    }}
                  >
                    <span className="ps-chip" data-focus-box>
                      {label}
                    </span>
                  </button>
                );
              })}
              <div className="ps-trail" style={{ height: half * pitch - GAP }} />
            </div>
          </div>
        </div>
      )}
    </dialog>,
    document.body,
  );
}
