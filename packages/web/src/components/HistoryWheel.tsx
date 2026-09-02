import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { rankHeatColor } from '@whippin/shared';
import type { HistoryModel, HistoryStop } from '../game/history';
import { wheelOrder } from '../game/wordWheel';
import { holeTitle, srRouteStop, t } from '../i18n';
import useDrum from '../hooks/useDrum';
import useModalDismiss from '../hooks/useModalDismiss';

// The hole WHEEL (user-decided 2026-09-01 — the day's fifth approach, after the history
// modal's line, a radial net with lines twice revised, and a plain stack; the brief was
// "item-by-item scrolling, beautiful, works well on mobile"): tap a hole and its place in
// the sentence becomes a fixed SLOT, and the words already found for it stand in ONE column
// that scrolls THROUGH that slot with mandatory snap — a picker drum. Farther words above,
// closer words below; the word in the slot wears the hole's own chip at the sentence's own
// size, the others stand plain and smaller; and the word in the slot when the wheel FOLDS
// is the pick. Tap a row and it glides into the slot; tap the slot, anywhere outside the
// column, or Escape, and it folds. THE PICK LANDS ON THE FOLD, NEVER WHILE THE WHEEL IS
// OPEN (user-reported 2026-09-01): a pick swaps the real hole beneath — its scramble, and
// a word of another length reflows the sentence, moving the hole to another line under a
// slot that stays put. So the sentence under the wheel is FROZEN, the slot row stands in
// for the word at its measured place, and the hole swaps with its usual choreography once
// the overlay is gone. EVERY word is a row, the words behind the start included — "you
// should be able to select far words" (user-decided 2026-09-01, third pass, retiring the
// dashed rule and the dim those rows wore for one pass): a far word is a word the player
// found, and reading the sentence with it is the wheel's whole point.
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
// `revealed` dress on the solved stage, the hole's TRUE position marked with an LED when
// the slot holds a pick, the exponent in the shared heat colour — as a real superscript,
// the hole's own — and the modal contract (`useModalDismiss`). It stays a native <dialog>
// because the sentence and the keyboard under it must be inert; it is the PuzzleSelect's
// kind (a thing hanging off a control that stays on screen), so a tap outside closes it.

// The screen margin the column keeps, and the air between rows.
const EDGE = 8;
const GAP = 6;
// The chip's overhang past the word, in em of the sentence (`.hole-word::before`'s 0.2em),
// plus a pixel of slack: the column is inset by this on the word's own side so the slot
// row's chip — and the plain rows' grounds — are not clipped by the scroller's edge
// (user-reported 2026-09-02: "when you click on a hole word, the left padding disappears").
const OVERHANG_EM = 0.2;
// The room a column needs on the word's right before it stands on the word's RIGHT edge
// instead — a word near the right edge of a phone leaves nothing to left-align on.
const MIN_COLUMN = 160;
// A row that is not in the slot is drawn at this fraction of the sentence's size — a peer
// of the word, quieter than it (user feedback 2026-09-01: same-size rows read too big).
const ROW_SCALE = 0.8;
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

// Press Start 2P advances exactly 1em per glyph, so the size at which a word fits its
// column is arithmetic.
function fit(word: string, column: number, max: number): number {
  return Math.max(ROW_MIN_PX, Math.min(max, (column - 12) / Math.max(1, word.length)));
}

export default function HistoryWheel({
  model,
  hub,
  hostIndex,
  number,
  lang,
  onPick,
  onClose,
}: {
  model: HistoryModel;
  // What the tapped control SHOWS — the hole's word and rank as the sentence has them
  // (a pick included), or the secret at rank 0 on the solved stage.
  hub: { word: string; rank: number };
  // The `data-hole-explore` index of the control the wheel turns through.
  hostIndex: number;
  // The hole's 1-based sentence position among distinct secrets — the ruler's numbering.
  number: number;
  lang: string;
  // Absent once the round is over: the solved stage's words are trophies, not slots.
  onPick?: (stop: HistoryStop) => void;
  onClose: () => void;
}) {
  // FIRST hook on purpose: it owns `showModal()` (a closed <dialog> is display:none — the
  // measuring below would read a tree with no boxes) and turns every dismissal into the
  // fold.
  const { closing, beginClose, dialogProps } = useModalDismiss('wheel-out');
  const title = holeTitle(lang, number);

  // The rows, farthest first — plus, on the solved stage, the secret itself as the last
  // row: the slot holds the answer there, and the answer is never a stop.
  const rows = useMemo(() => {
    const order = wheelOrder(model.stops);
    if (model.solved && model.secret) {
      order.push({
        rank: 0,
        dq: null,
        display: model.secret,
        word: model.secret,
        start: false,
        best: false,
        behind: false,
        revealed: false,
      });
    }
    return order;
  }, [model]);
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
  const live = useRef({ rows, hubRank: hub.rank, onPick });
  live.current = { rows, hubRank: hub.rank, onPick };

  // The pick lands on the FOLD: whatever the slot holds as the dialog closes — by the
  // slot's tap, a tap outside, or Escape, one door for all three — becomes the hole's
  // word, after the overlay is gone.
  // ONCE — it is called from the exit animation's end AND from the dialog's `close`
  // (below), whichever comes first.
  const folded = useRef(false);
  const fold = useCallback(() => {
    if (folded.current) return;
    folded.current = true;
    const { rows: r, hubRank, onPick: pick } = live.current;
    const stop = r[drum.peek()];
    if (pick && stop && stop.rank !== 0 && stop.rank !== hubRank) pick(stop);
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

  // The column stands on the word's left edge — or, when the word sits too near the right
  // edge for a column to stand there, on its right edge.
  const flip = anchor.width - EDGE - anchor.wrap.x < MIN_COLUMN;
  const column = flip ? anchor.wrap.x + anchor.wrap.w - EDGE : anchor.width - EDGE - anchor.wrap.x;
  const inset = Math.ceil(anchor.fontSize * OVERHANG_EM) + 1;
  const origin = anchor.top - EDGE;
  const height = anchor.height - origin;
  const rowH = anchor.lineHeight;
  // The slot: the word's own line, measured from the top of the scroller. The leading
  // spacer is exactly that, so the first row can reach the slot; the trailing one lets
  // the last row reach it too.
  const slot = anchor.wrap.y - origin;
  const trailing = Math.max(0, height - slot - rowH);
  const small = anchor.fontSize * ROW_SCALE;

  const rowStyle = (stop: HistoryStop, inSlot: boolean, i: number): CSSProperties =>
    ({
      height: rowH,
      lineHeight: `${rowH}px`,
      marginBottom: GAP,
      fontSize: `${fit(inSlot ? stop.display : stop.word, column, inSlot ? anchor.fontSize : small)}px`,
      '--rank-color': rankHeatColor(stop.rank),
      '--i': Math.abs(i - hubIndex),
    }) as CSSProperties;

  // The word in the slot is the hole as the sentence draws it — the same markup, so the
  // chip and the exponent are the sentence's own; every other row is the word, plain,
  // with its exponent raised the same way.
  const body = (stop: HistoryStop, inSlot: boolean) =>
    inSlot ? (
      <span className={`hole${stop.rank === 0 ? ' resolved' : ''}`}>
        <span className="hole-word-wrap">
          <span className="hole-word">
            {Array.from(stop.display).map((ch, k) => (
              <span key={k} className="hole-letter">
                {ch}
              </span>
            ))}
          </span>
        </span>
        {stop.rank > 0 && <sup className="hole-rank">{stop.rank}</sup>}
      </span>
    ) : (
      // A plain row stands on its own GROUND (user-decided 2026-09-02: "you don't have
      // wheel items over sentence text") — one box around the word AND its exponent, drawn
      // by CSS as the chip is drawn, so the row's letters keep the slot's exact x.
      <span className="wheel-plain">
        <span className="wheel-word">{stop.word}</span>
        {stop.rank > 0 && <sup className="wheel-rank">{stop.rank}</sup>}
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
        if (bare && !closing) beginClose();
      }}
    >
      <div
        className="wheel-scroll"
        ref={scrollRef}
        style={{
          top: origin,
          // The column stands on the word's edge, INSET by the chip's overhang on that side
          // (padding inside the box, so the rows' text still starts on the word's x and the
          // chip has room to overhang without being clipped).
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
              className={`wheel-row${inSlot ? ' wheel-row-slot' : ''}${stop.revealed ? ' wheel-row-revealed' : ''}${
                stop.best && !inSlot ? ' wheel-row-best' : ''
              }`}
              style={rowStyle(stop, inSlot, i)}
              aria-label={inSlot ? t(lang, 'ariaClose') : srRouteStop(lang, stop)}
              aria-current={inSlot ? 'true' : undefined}
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
