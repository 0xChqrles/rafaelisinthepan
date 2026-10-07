import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { rankHeatColor } from '@whippin/shared';
import { capitalize } from '../game/sentenceCase';
import { MASK, type HistoryModel, type HistoryStop } from '../game/history';
import { wheelOrder } from '../game/wordWheel';
import { holeTitle, srRouteStop, t } from '../i18n';
import useDrum from '../hooks/useDrum';
import useModalDismiss from '../hooks/useModalDismiss';
import MeterCanvas from './MeterCanvas';
// (For its side effect: the root's Bayer tiles the drum's ends thin through.)
import './bayerTiles';

// The hole WHEEL (user-decided 2026-09-01 — the day's fifth approach, after the history
// modal's line, a radial net with lines twice revised, and a plain stack; the brief was
// "item-by-item scrolling, beautiful, works well on mobile"): tap a hole and its place in
// the sentence becomes a fixed SLOT, and the words already found for it stand in ONE column
// that scrolls THROUGH that slot with mandatory snap — a picker drum. Farther words above,
// closer words below; EVERY row stands at the sentence's own size, the slot's included —
// one type size while the wheel is open, since rows of mixed sizes read as a mess — the
// word in the slot wearing the hole's own chip, the others plain; and the word in the slot
// when the wheel FOLDS is the pick. Tap a row and it glides into the slot; tap the slot,
// anywhere outside the column, or Escape, and it folds. THE PICK LANDS ON THE FOLD, NEVER
// WHILE THE WHEEL IS OPEN (user-reported 2026-09-01): a pick swaps the real hole beneath —
// its scramble, and a word of another length reflows the sentence, moving the hole to
// another line under a slot that stays put. So the sentence under the wheel is FROZEN, the
// slot row stands in for the word at its measured place, and the hole swaps with its usual
// choreography once the overlay is gone. EVERY word is a row, the words behind the start
// included — "you should be able to select far words" (user-decided 2026-09-01, third pass,
// retiring the dashed rule and the dim those rows wore for one pass): a far word is a word
// the player found, and reading the sentence with it is the wheel's whole point.
//
// THE WHEEL MOVES LIKE THE iOS DATE PICKER (user-decided 2026-09-01, the fifth pass on
// its feel): the scroller is driven by hand, with no native scrolling (`overflow: hidden`,
// `touch-action: none`), by the DRUM every wheel in the app shares (`hooks/useDrum` — the
// physics, the constants and the reasoning live there since the header's title grew a
// wheel of its own, 2026-09-02). This surface draws a position as the scroller's own
// `scrollTop`, so row i sits in the slot at `i × pitch`.
//
// There is no separate hub any more: the slot row IS the row of the current word, drawn
// at the measured place of the tapped word with the hole's own markup, so nothing sits
// behind it to be revealed by a scroll — the one thing the plain stack got wrong.
//
// What it keeps: the pure model (`buildHistory`; the order is `wheelOrder`, tested), the
// hole's TRUE position marked with an LED when the slot holds a pick, the exponent in the
// shared heat colour — as a real superscript, the hole's own — and the modal contract
// (`useModalDismiss`).
//
// THREE GROUNDS, THREE MEANINGS (user-decided 2026-09-22, with the activated hole): a
// word the player TYPED stands on the plain surface; a hint the meter GAVE stands on THE
// FOIL — the activated chip's own holographic dress (`MeterCanvas`), on the WORD ALONE so
// the exponent stands clear of it on the ground (user-reviewed the same day: "the exponent
// should be out of the background") — so the list says which words are theirs and which
// were handed over with no label; the STRETCH a full meter names at a best of 1 (user-
// decided 2026-10-07) stands on the plain ground in the muted ink, words nobody typed —
// the post-mortem's "named, not found". THE SLOT ROW NEVER MOVES: the word the wheel holds
// wears the regular white chip, foil or not ("when wheel focused, a word should not have
// a moving background, just the regular white for a better UX").
//
// THE HINTS ARE MASKED, AND PICKING ONE IS SELECTING IT (user-decided 2026-09-22, in three
// passes — "you can just select them with the wheel, it counts as a guess… you manage
// your own pace"; then a REVEAL control in the wheel, first a button, then a lock on the
// slot, then a lock on every masked row; then "maybe the best would be to display the
// button when the word has been selected, so you can only unlock it once back on the
// sentence and you can see the hits on the other words as well then"): a masked stop is
// `MASK` (`?????`) on the foil — never the word's length — with its exponent, so the
// player sees how close the hidden word is before spending a try; it turns through the
// slot and IS PICKED like any row, and the sentence then shows `?????²` on the hole's foil. The
// reveal happens THERE: the picked mask stands pre-typed in the prompt and REVEAL takes
// the keyboard's place to submit it as a guess (`Game`'s ghost, `RevealTray`). The wheel
// has no reveal control at all. The one mask an active hole offers is the word at half
// its best — closer than anything tried — so it turns up just under the slot.
// The slot row's own tap, a tap outside and Escape close, as ever. It stays a native <dialog>
// because the sentence and the keyboard under it must be inert; it is the PuzzleSelect's
// kind (a thing hanging off a control that stays on screen), so a tap outside closes it.

// The screen margin the column keeps, and the air between rows: the rows stand at the
// sentence's size, so a plain row's 1.5em ground fills its whole line box, and the gap is
// all that keeps the grounds from reading as one block.
const EDGE = 8;
const GAP = 10;
// The chip's overhang past the word, in em of the sentence (`.hole-word::before`'s 0.2em),
// plus a pixel of slack: a column on the word's LEFT edge is inset by this so the slot
// row's chip — and the plain rows' grounds — are not clipped by the scroller's edge
// (user-reported 2026-09-02: "when you click on a hole word, the left padding disappears").
// A column on the word's RIGHT edge is inset by what the rows draw past their box on that
// side instead: the exponent's nudge and its 2px print.
const OVERHANG_EM = 0.2;
// The room a column needs on the word's right before it stands on the word's RIGHT edge
// instead — a word near the right edge of a phone leaves nothing to left-align on.
const MIN_COLUMN = 160;
// What a row puts on its line beside its word, in em of the row's own size: the LED a best
// row wears before it (`.wheel-row-best`, 0.4em + 0.5em of margin), and the exponent after
// it — 0.55em a digit (`.wheel-rank`), nudged clear of the ground by 0.2em of the row plus
// 0.25em of its own (`.wheel-plain .wheel-rank`). And, in pixels, the exponent's margin
// and its 2px print.
const LED_EM = 0.9;
const RANK_EM = 0.55;
const NUDGE_EM = 0.2 + 0.25 * RANK_EM;
const SLACK_PX = 3;
// The floor of the last resort: a row no side of the screen holds shrinks, never below this.
const ROW_MIN_PX = 9;


interface Anchor {
  wrap: { x: number; y: number; w: number; h: number }; // the word — the slot's place
  fontSize: number;
  lineHeight: number;
  top: number; // where the screen begins under the header
  width: number;
  height: number;
}

const rect = (el: Element) => {
  const b = el.getBoundingClientRect();
  return { x: b.left, y: b.top, w: b.width, h: b.height };
};

function measureHost(index: number): Anchor | null {
  const host = document.querySelector<HTMLElement>(`[data-hole-explore="${index}"]`);
  const wrap = host?.querySelector<HTMLElement>('.hole-word-wrap');
  if (!host || !wrap) return null;
  const style = getComputedStyle(wrap.firstElementChild ?? wrap);
  const fontSize = parseFloat(style.fontSize) || 16;
  const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.5;
  const header = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0;
  return {
    wrap: rect(wrap),
    fontSize,
    lineHeight,
    top: Math.max(EDGE, header + EDGE),
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

// A row's whole width in em of its own size. Press Start 2P advances exactly 1em per glyph,
// so it is arithmetic: the LONGER of the row's two spellings — the typed form a plain row
// prints and the canonical one the slot prints (`MASK` on a masked stop, whatever its
// word) — so a row keeps ONE size as it turns through the slot, plus the LED and the
// exponent.
function rowEm(stop: HistoryStop, shown: string): number {
  const chars = stop.masked ? MASK.length : Math.max(stop.word.length, shown.length);
  return chars + (stop.best ? LED_EM : 0) + RANK_EM * String(stop.rank).length + NUDGE_EM;
}

// A row stands at the sentence's size; only a row its column cannot hold shrinks — alone,
// to fit, the words modal's rule.
function fit(em: number, column: number, size: number): number {
  return Math.max(ROW_MIN_PX, Math.min(size, (column - SLACK_PX) / em));
}

export default function HistoryWheel({
  model,
  hub,
  hostIndex,
  number,
  lang,
  capital = false,
  onPick,
  onClose,
}: {
  model: HistoryModel;
  // What the tapped control SHOWS — the hole's word and rank as the sentence has them
  // (a pick included).
  // The meter's reading (#301), so the slot row — the hole as the sentence draws it —
  // carries it too; a full meter (an active hole) draws nothing here: the slot is white.
  hub: { word: string; rank: number; meter?: number };
  // The `data-hole-explore` index of the control the wheel turns through.
  hostIndex: number;
  // The hole opens its sentence and carries the capital itself (sentence case, the
  // display rule `Phrase` applies): the slot row is the fourth renderer of that word.
  capital?: boolean;
  // The hole's 1-based sentence position among distinct secrets — the ruler's numbering.
  number: number;
  lang: string;
  // Absent while the board takes no pick (`Game`'s `exploreDisabled`).
  onPick?: (stop: HistoryStop) => void;
  onClose: () => void;
}) {
  // FIRST hook on purpose: it owns `showModal()` (a closed <dialog> is display:none — the
  // measuring below would read a tree with no boxes) and turns every dismissal into the
  // fold.
  const { closing, beginClose, dialogProps } = useModalDismiss('wheel-out');
  const title = holeTitle(lang, number);

  // The rows, farthest first.
  const rows = useMemo(() => wheelOrder(model.stops), [model]);
  const hubIndex = Math.max(
    0,
    rows.findIndex((r) => r.rank === hub.rank),
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLElement | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  // The slot row is drawn with its line box on the word's measured line; its own word can
  // sit a hair off that inside the box (the raised exponent grows the line box), and this
  // is that difference, absorbed by a translate of the whole column.
  const [shift, setShift] = useState({ x: 0, y: 0 });
  const measure = useCallback(() => setAnchor(measureHost(hostIndex)), [hostIndex]);
  useLayoutEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  // Geometry, all off the sentence's own line: a row is one line box tall, and the rows
  // are one GAP apart, so row i sits in the slot at scrollTop = i × pitch.
  const pitch = anchor ? anchor.lineHeight + GAP : 0;

  // THE DRUM (`useDrum`): it owns the position and every gesture, and reports the row in
  // the slot — so the chip travels with the wheel. A position is drawn as the scroller's
  // own `scrollTop`.
  const drum = useDrum({
    ref: scrollRef,
    active: anchor !== null,
    count: rows.length,
    pitch,
    initial: hubIndex,
    write: (px) => {
      if (scrollRef.current) scrollRef.current.scrollTop = px;
    },
  });
  const current = drum.current;

  // Open ON the word: the current word's row in the slot, instantly, before paint — once.
  const opened = useRef(false);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!anchor || !el || opened.current) return;
    opened.current = true;
    drum.jump(hubIndex);
    const wrap = slotRef.current?.querySelector('.hole-word-wrap');
    if (wrap) {
      const w = rect(wrap);
      setShift({ x: anchor.wrap.x - w.x, y: anchor.wrap.y - w.y });
    }
  }, [anchor, drum, hubIndex]);

  // What the fold reads, as it is now — the fold closes over nothing stale.
  const live = useRef({ rows, hubRank: hub.rank, hubWord: hub.word, onPick });
  live.current = { rows, hubRank: hub.rank, hubWord: hub.word, onPick };

  // The pick lands on the FOLD: whatever the slot holds as the dialog closes — by the
  // slot's tap, a tap outside, or Escape, one door for all three — becomes the hole's
  // word, after the overlay is gone.
  // ONCE — it is called from the exit animation's end AND from the dialog's `close`
  // (below), whichever comes first.
  const folded = useRef(false);
  const fold = useCallback(() => {
    if (folded.current) return;
    folded.current = true;
    const { rows: r, hubRank, hubWord, onPick: pick } = live.current;
    const stop = r[drum.peek()];
    // A pick where the slot differs from what the hole shows — by rank, or by WORD at the
    // same rank: a mask just revealed already names its word in the slot while the hole
    // still shows `?????` until the release, when it improves to that word.
    // Confirming a held mask also makes it the latest selection, the one REVEAL submits.
    if (pick && stop && (stop.masked || stop.rank !== hubRank || stop.display !== hubWord)) pick(stop);
    onClose();
  }, [drum, onClose]);
  // THE FOLD LANDS IN THE SAME TASK THAT CLOSES THE DIALOG (user-reported 2026-09-02, "the
  // hole word blinking on wheel close"): `dialog.close()` fires its `close` event on a LATER
  // task, so a fold riding that event lifted the veil one frame after the slot row had
  // gone — one frame with no word at all. Folding here, in the animation-end handler the
  // hook closes the dialog from, and FLUSHED — `animationend` is not a discrete event, so
  // React would otherwise commit its updates on a later task, after the browser has painted
  // the closed dialog over a still-veiled word — commits the unveil (and the pick) before
  // `dialog.close()` runs, so the real word stands in the frame the dialog leaves.
  // `onClose` keeps the fold as its backstop for the paths that never fire the animation.
  const onExitEnd = useCallback(
    (e: React.AnimationEvent) => {
      if (e.target === e.currentTarget && e.animationName === 'wheel-out') flushSync(fold);
      dialogProps.onAnimationEnd(e);
    },
    [dialogProps, fold],
  );

  // The arrow keys move a row; the wheel is a control, and a keyboard is an input.
  // The wheel turning under a focused row carries the focus into the slot (#267) — the
  // pick is the wheel's one tab stop. `preventScroll`: the column IS a scroller, and the
  // drum owns its scrollTop. A wheel turned by a finger moves no focus.
  useEffect(() => {
    if (scrollRef.current?.contains(document.activeElement)) {
      slotRef.current?.focus({ preventScroll: true });
    }
  }, [current]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      drum.glideBy(e.key === 'ArrowDown' ? 1 : -1);
    },
    [drum],
  );

  // A tapped row glides into the slot; the row already there is the way out. A drag that
  // ended on a row is not a tap.
  const turnTo = useCallback(
    (i: number) => {
      if (drum.tap(i) === 'slot') beginClose();
    },
    [beginClose, drum],
  );

  if (!anchor) {
    return createPortal(
      <dialog {...dialogProps} className="wheel-dialog" aria-label={title} onClose={fold} />,
      document.body,
    );
  }

  // The word in the slot is the hole as the sentence draws it — the same markup, so the
  // chip and the exponent are the sentence's own; every other row is the word, plain,
  // with its exponent raised the same way.
  const shown = (stop: HistoryStop) => (capital ? capitalize(stop.display) : stop.display);
  const ems = rows.map((stop) => rowEm(stop, shown(stop)));

  // The column stands on the word's left edge, reaching for the screen's right — or on its
  // right edge, reaching for the screen's left, when the right leaves less than MIN_COLUMN,
  // or when the longest row does not fit on the right and the left has more room. So a row
  // shrinks only when it fits neither side.
  const right = anchor.width - EDGE - anchor.wrap.x;
  const left = anchor.wrap.x + anchor.wrap.w - EDGE;
  const longest = Math.max(0, ...ems) * anchor.fontSize + SLACK_PX;
  const flip = right < MIN_COLUMN || (longest > right && left > right);
  const column = flip ? left : right;
  const inset = flip
    ? Math.ceil(anchor.fontSize * NUDGE_EM) + 2
    : Math.ceil(anchor.fontSize * OVERHANG_EM) + 1;
  const origin = anchor.top - EDGE;
  const height = anchor.height - origin;
  const rowH = anchor.lineHeight;
  // The slot: the word's own line, measured from the top of the scroller. The leading
  // spacer is exactly that, so the first row can reach the slot; the trailing one lets
  // the last row reach it too.
  const slot = anchor.wrap.y - origin;
  const trailing = Math.max(0, height - slot - rowH);

  // ONE size per row, the same in the slot and out of it: the sentence's own.
  const rowStyle = (stop: HistoryStop, i: number): CSSProperties =>
    ({
      height: rowH,
      lineHeight: `${rowH}px`,
      marginBottom: GAP,
      fontSize: `${fit(ems[i], column, anchor.fontSize)}px`,
      '--rank-color': rankHeatColor(stop.rank),
      '--i': Math.abs(i - hubIndex),
    }) as CSSProperties;

  // The foil a hint wears, on its word or on its mask.
  const foil = (stop: HistoryStop) => (
    <span className="wheel-sea" aria-hidden="true">
      <MeterCanvas value={100} delayMs={0} durationMs={0} sea seed={stop.rank} />
    </span>
  );
  const body = (stop: HistoryStop, inSlot: boolean) =>
    inSlot ? (
      <span className="hole">
        <span className="hole-word-wrap" data-focus-box>
          <span className="hole-word">
            {stop.masked
              ? Array.from(MASK).map((ch, k) => (
                  <span key={k} className="hole-letter">
                    {ch}
                  </span>
                ))
              : Array.from(shown(stop)).map((ch, k) => (
                  <span key={k} className="hole-letter">
                    {ch}
                  </span>
                ))}
            {/* The meter as it stands (drawn at once, no travel); nothing once full — the
                slot stays the regular white chip, never the foil — except a MASKED hint,
                whose chip is the foil with nothing on it: the thing to reveal. */}
            {stop.masked ? (
              <span className="hole-meter" aria-hidden="true">
                <MeterCanvas value={100} delayMs={0} durationMs={0} sea seed={stop.rank} />
              </span>
            ) : hub.meter !== undefined && hub.meter < 100 ? (
              <span className="hole-meter" aria-hidden="true">
                <MeterCanvas value={hub.meter} delayMs={0} durationMs={0} />
              </span>
            ) : null}
          </span>
        </span>
        <sup className="hole-rank">{stop.rank}</sup>
      </span>
    ) : (
      // A plain row stands on its own GROUND (user-decided 2026-09-02: "you don't have
      // wheel items over sentence text") — one box around the word AND its exponent, drawn
      // by CSS as the chip is drawn, so the row's letters keep the slot's exact x. A GIVEN
      // row's ground is the sea, on the word alone (the canvas over the word's own white
      // box), its exponent standing outside on the ground. A NAMED row (the meter's
      // stretch) is the plain row in the muted ink: a word the player never typed.
      <span className={`wheel-plain${stop.given ? ' wheel-given' : stop.revealed ? ' wheel-named' : ''}`}>
        <span className="wheel-word">
          {stop.given && foil(stop)}
          {stop.masked ? MASK : stop.word}
        </span>
        <sup className="wheel-rank">{stop.rank}</sup>
      </span>
    );

  return createPortal(
    <dialog
      {...dialogProps}
      className={`wheel-dialog${closing ? ' closing' : ''}${flip ? ' wheel-right' : ''}`}
      aria-label={title}
      onAnimationEnd={onExitEnd}
      onClose={fold}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        // A drag that ended here is not a tap on anything.
        if (drum.endedDrag()) return;
        // The dialog and the scroller's spacers have no content of their own, so a click
        // that lands on one of them landed on nothing in the wheel.
        const el = e.target as HTMLElement;
        const bare =
          el === e.currentTarget ||
          el === scrollRef.current ||
          el.classList.contains('wheel-lead') ||
          el.classList.contains('wheel-trail');
        if (bare) beginClose();
      }}
    >
      <div
        className="wheel-scroll"
        ref={scrollRef}
        style={{
          top: origin,
          // The column stands on the word's edge, INSET on that side by what the rows draw
          // past their box there (padding inside the box, so the rows' text still starts on
          // the word's x and the chip, or the exponent, has room without being clipped).
          ...(flip
            ? { right: anchor.width - (anchor.wrap.x + anchor.wrap.w) - inset, paddingRight: inset }
            : { left: anchor.wrap.x - inset, paddingLeft: inset }),
          width: column + inset,
          boxSizing: 'border-box',
          translate: `${shift.x}px ${shift.y}px`,
        }}
      >
        {/* The room above the first row: the slot's own height off the top, so the first
            row can reach it. */}
        <div className="wheel-lead" style={{ height: slot }} />

        {rows.map((stop, i) => {
          const inSlot = i === current;
          return (
            <button
              key={stop.rank}
              ref={inSlot ? (el) => void (slotRef.current = el) : undefined}
              type="button"
              className={`wheel-row${inSlot ? ' wheel-row-slot' : ''}${stop.best && !inSlot ? ' wheel-row-best' : ''}`}
              style={rowStyle(stop, i)}
              aria-label={inSlot ? t(lang, 'ariaClose') : srRouteStop(lang, { ...stop, word: stop.masked ? null : stop.word })}
              aria-current={inSlot ? 'true' : undefined}
              // The wheel's ONE tab stop is the row in the slot (#267): the arrows turn it.
              tabIndex={inSlot ? 0 : -1}
              onClick={() => turnTo(i)}
            >
              {body(stop, inSlot)}
            </button>
          );
        })}

        <div className="wheel-trail" style={{ height: trailing }} />
      </div>
    </dialog>,
    document.body,
  );
}
