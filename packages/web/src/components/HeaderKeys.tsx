// THE HEADER'S RIGHT GROUP, and it is THE SAME ROW ON EVERY GAME SURFACE (user-decided
// 2026-08-31: "the header is supposed to be something stable" — the first cuts moved keys
// around on a tap, dropping one here and adding a ✕ there, and a row that rearranges itself
// under your thumb cannot be learned).
//
//     home · archive · board · rules · face
//
// Five keys, fixed order, and the PLACE you are standing in is LIT — ON EVERY SCREEN THAT
// HAS A HEADER, the account area and the tutorial included (user-decided 2026-08-31, on
// the question "keep the right icons always in place?"): the account is a place, so the
// FACE lights on `/account` and stays lit on the steps inside it (the editor, the email
// doors), and the tutorial is the RULES' place, so the BOOK lights there. That retired two
// private grammars: the account area's back-arrow-as-only-exit (`profileReturn` with it —
// every place is one tap away, so nothing has to remember where it was opened from), and
// the tutorial's fast-forward SKIP (leaving the lesson is tapping any other key). Leaving a place is
// tapping another one — a tab bar's grammar, which needs no exit control at all: the board
// is left by tapping HOME (or the archive), never by pressing the lit crown again (rejected
// the same day as "not intuitive at all") and never by a ✕ that appears only there. That is
// also why the crown no longer hides on an ARCHIVE day: #190's active-day-only rule kept a
// key from silently swapping the day under the player, but a key that vanishes is the very
// instability this row exists to end — the crown always leads to the LIVE board, and the lit
// calendar already says the day on screen is a past one.
//
// The keys are one FAMILY: stroke objects in the `.ui-icon` dress (a house, a calendar, a
// crown, an open book), and the player's own mark as a small framed portrait — in colour,
// because that colour is the one thing on the row that is THEIRS, framed so a dark palette
// does not sink into the band and a loud one is contained.
import { useLayoutEffect, useRef, useState } from 'react';
import type React from 'react';
import { useGameStore } from '../state/gameStore';
import AccountKey from './AccountKey';
import HomeIcon from '../assets/icons/home.svg?react';
import CalendarIcon from '../assets/icons/calendar.svg?react';
import BoardIcon from '../assets/icons/board.svg?react';
import BookIcon from '../assets/icons/book.svg?react';
import { t } from '../i18n';
import { pathForArchive, pathForBoard, pathForMode, type Mode } from '../langs';
import { navigate } from '../routing';

export type HeaderPlace = 'home' | 'archive' | 'board' | 'rules' | 'account';

// The row's DOM order — the dot indexes keys by it.
const PLACES: HeaderPlace[] = ['home', 'archive', 'board', 'rules', 'account'];

// THE TWO DOTS (user-decided 2026-09-01, replacing the held chip + hover chip): two small
// squares under the row, and they MOVE — translations, never appearances.
//   · the FG dot marks the LIT place and stays with it;
//   · the SECONDARY (`--muted`) dot answers the mouse: it travels to the hovered key and
//     slides back UNDER the fg dot on leave (at rest the two are stacked, so only the fg
//     one shows). A touch has no hover to return from, so only a mouse moves it.
//   · a CLICK navigates, the row is rebuilt, and the fg dot travels from where the previous
//     row left it to land ON TOP of the secondary dot already waiting under the new place —
//     which is why its last x is remembered at module level: one dot travelling, never two
//     dots swapping.
let lastDotX: number | null = null;

export default function HeaderKeys({
  lang,
  mode,
  on,
  // Run before ANY key leaves this surface — the tutorial closes itself here (a lesson
  // left by the row is a lesson skipped, and the store must not reopen it on the game).
  leave,
}: {
  lang: string;
  mode: Mode;
  on: HeaderPlace;
  leave?: () => void;
}) {
  const openTutorial = useGameStore((s) => s.openTutorial);
  const row = useRef<HTMLDivElement>(null);
  const dot = useRef<HTMLSpanElement>(null);
  const hoverDot = useRef<HTMLSpanElement>(null);
  const [hover, setHover] = useState<HeaderPlace | null>(null);
  useLayoutEffect(() => {
    const el = row.current;
    const d = dot.current;
    const h = hoverDot.current;
    if (!el || !d || !h) return;
    const xOf = (place: HeaderPlace, size: number) => {
      const key = el.querySelectorAll<HTMLElement>('.home-btn')[PLACES.indexOf(place)];
      return key ? key.offsetLeft + key.offsetWidth / 2 - size / 2 : null;
    };
    const jump = (n: HTMLElement, x: number) => {
      n.style.transition = 'none';
      n.style.transform = `translateX(${x}px)`;
      n.getBoundingClientRect();
      n.style.transition = '';
    };
    const place = () => {
      const x = xOf(on, d.offsetWidth);
      if (x !== null) {
        if (!d.style.transform) {
          // A fresh mount: the fg dot starts where the previous row left it, then travels.
          jump(d, lastDotX ?? x);
        }
        d.style.transform = `translateX(${x}px)`;
        lastDotX = x;
      }
      const hx = xOf(hover ?? on, h.offsetWidth);
      if (hx !== null) {
        // The secondary dot has no history: it is simply under the lit place until a
        // mouse moves it.
        if (!h.style.transform) jump(h, hx);
        h.style.transform = `translateX(${hx}px)`;
      }
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [on, hover]);
  const hoverFrom = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    const key = (e.target as HTMLElement).closest('.home-btn');
    // Between two keys the pointer is over the ROW, not a key: keep the last key's hover
    // rather than dropping it — the gap is a few pixels the mouse crosses on its way,
    // and a dot that ran home and back for every crossing read as a lost hover
    // (user-reported 2026-09-01). Only leaving the row ends the hover.
    if (!key) return;
    const keys = row.current ? Array.from(row.current.querySelectorAll('.home-btn')) : [];
    const i = keys.indexOf(key);
    if (i >= 0) setHover(PLACES[i]);
  };
  const go = (to: string) => {
    leave?.();
    navigate(to);
  };
  const key = (place: HeaderPlace, label: string, to: string, Icon: typeof HomeIcon) => {
    const lit = on === place;
    return (
      <button
        type="button"
        className={`home-btn${lit ? ' on' : ''}`}
        aria-label={label}
        aria-current={lit ? 'page' : undefined}
        onClick={() => {
          if (!lit) go(to);
        }}
      >
        <Icon className="ui-icon" aria-hidden />
      </button>
    );
  };
  return (
    <div
      ref={row}
      className="hk-row"
      onPointerOver={hoverFrom}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') setHover(null);
      }}
    >
      <span ref={hoverDot} className="hk-dot hk-dot-hover" aria-hidden="true" />
      <span ref={dot} className="hk-dot" aria-hidden="true" />
      {key('home', t(lang, 'ariaHome'), pathForMode(lang, mode), HomeIcon)}
      {key('archive', t(lang, 'ariaArchive'), pathForArchive(lang, mode), CalendarIcon)}
      {key('board', t(lang, 'ariaLeaderboard'), pathForBoard(lang, mode), BoardIcon)}
      {/* The RULES — the onboarding tutorial (#51), lit while it is open. It mounts on the
          game route, so from anywhere else the tap goes home with it. */}
      <button
        type="button"
        className={`home-btn${on === 'rules' ? ' on' : ''}`}
        aria-label={t(lang, 'ariaHelp')}
        aria-current={on === 'rules' ? 'page' : undefined}
        onClick={() => {
          if (on === 'rules') return;
          openTutorial('replay');
          if (on !== 'home') go(pathForMode(lang, mode));
        }}
      >
        <BookIcon className="ui-icon" aria-hidden />
      </button>
      <AccountKey lang={lang} lit={on === 'account'} onLeave={leave} />
    </div>
  );
}
