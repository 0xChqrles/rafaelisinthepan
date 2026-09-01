import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { rankHeatColor } from '@whippin/shared';
import type { HistoryModel, HistoryStop } from '../game/history';
import { wheelOrder } from '../game/wordWheel';
import { holeTitle, srRouteStop, t } from '../i18n';
import useModalDismiss from '../hooks/useModalDismiss';
import { prefersReducedMotion } from '../hooks/useScramble';

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
// its feel: "pixel by pixel" → a one-row stepper, "sticky" → native snap, "snapped
// inertia" → a hop-by-hop ratchet, "unstoppable — a small swipe keeps scrolling for
// seconds" → this). The scroller is driven by hand, with no native scrolling
// (`overflow: hidden`, `touch-action: none`): a DRAG follows the finger pixel for pixel;
// on release the drum keeps going on its velocity for a SHORT friction glide — a small
// swipe moves a row or two, a strong one a handful, never for seconds — and lands ON a
// row. A mouse wheel or trackpad moves the drum directly and it snaps to the nearest row
// when the gesture stops; the arrow keys move one row; a tap on a row glides to it.
//
// There is no separate hub any more: the slot row IS the row of the current word, drawn
// at the measured place of the tapped word with the hole's own markup, so nothing sits
// behind it to be revealed by a scroll — the one thing the plain stack got wrong.
//
// What it keeps: the pure model (`buildHistory`; the order is `wheelOrder`, tested), the
// `revealed` dress on the solved stage, the hole's TRUE position marked with an LED when
// the slot holds a pick, the exponent in the shared heat colour — as a real superscript,
// the hole's own — and the modal contract (`useModalDismiss`). It stays a native <dialog>
// because the sentence and the keyboard under it must be inert; it is the PuzzleSheet's
// kind (a thing hanging off a control that stays on screen), so a tap outside closes it.

// The screen margin the column keeps, and the air between rows.
const EDGE = 8;
const GAP = 6;
// The room a column needs on the word's right before it stands on the word's RIGHT edge
// instead — a word near the right edge of a phone leaves nothing to left-align on.
const MIN_COLUMN = 160;
// A row that is not in the slot is drawn at this fraction of the sentence's size — a peer
// of the word, quieter than it (user feedback 2026-09-01: same-size rows read too big).
const ROW_SCALE = 0.8;
const ROW_MIN_PX = 9;
// The drum's physics. A release at v rows/s travels `v × FLING_S` rows (the picker's
// friction, short), capped at `FLING_MAX_ROWS`, snapped to a row, over a glide of
// `GLIDE_BASE_MS` plus `GLIDE_ROW_MS` a row, eased out. A wheel/trackpad delta moves the
// drum by `WHEEL_GAIN` of its pixels and snaps `WHEEL_IDLE_MS` after the last one. A
// drag past the ends stretches by `RUBBER`.
const FLING_S = 0.16;
const FLING_MAX_ROWS = 8;
const GLIDE_BASE_MS = 240;
const GLIDE_ROW_MS = 60;
const GLIDE_MAX_MS = 700;
const SNAP_MS = 200;
const WHEEL_GAIN = 0.6;
const WHEEL_IDLE_MS = 90;
const RUBBER = 0.35;
// A press that travels this far is a drag, not a tap.
const DRAG_PX = 6;

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
  // Which row is in the slot right now — read off the scroll position, so the chip travels
  // with the wheel.
  const [current, setCurrent] = useState(hubIndex);

  const measure = useCallback(() => setAnchor(measureHost(hostIndex)), [hostIndex]);
  useLayoutEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  // Geometry, all off the sentence's own line: a row is one line box tall, and the rows
  // are one GAP apart, so row i sits in the slot at scrollTop = i × pitch.
  const pitch = anchor ? anchor.lineHeight + GAP : 0;

  // Open ON the word: the current word's row in the slot, instantly, before paint — once.
  const opened = useRef(false);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!anchor || !el || opened.current) return;
    opened.current = true;
    drum.current.pos = hubIndex;
    el.scrollTop = hubIndex * pitch;
    setCurrent(hubIndex);
    const wrap = slotRef.current?.querySelector('.hole-word-wrap');
    if (wrap) {
      const w = rect(wrap);
      setShift({ x: anchor.wrap.x - w.x, y: anchor.wrap.y - w.y });
    }
  }, [anchor, hubIndex, pitch]);

  // THE DRUM. Live state goes through a ref so the listeners, attached once, read the
  // wheel as it is now; the drum's own state never re-renders — it writes `scrollTop` and
  // reports the row in the slot.
  const live = useRef({ rows, pitch, current, hubRank: hub.rank, onPick });
  live.current = { rows, pitch, current, hubRank: hub.rank, onPick };
  const drum = useRef({
    pos: 0, // in rows, fractional while moving
    raf: 0,
    // the glide in flight: from → to over `ms`, since `at`
    glide: null as null | { from: number; to: number; at: number; ms: number },
    // the drag in flight
    drag: null as null | { id: number; y0: number; pos0: number; samples: { t: number; y: number }[]; moved: boolean },
  });
  // Whether the press that just ended was a drag (its click must not count as a tap).
  const lastMoved = useRef(false);
  const clampRow = (i: number) => Math.min(live.current.rows.length - 1, Math.max(0, i));
  const paint = useCallback((pos: number) => {
    const el = scrollRef.current;
    const d = drum.current;
    d.pos = pos;
    if (el) el.scrollTop = pos * live.current.pitch;
    setCurrent(clampRow(Math.round(pos)));
  }, []);
  // ONE glide from where the drum is to a row, eased out (fast, then settling) — the
  // picker's deceleration. A new glide replaces the one in flight from its current place.
  const glideTo = useCallback(
    (row: number, ms: number) => {
      const d = drum.current;
      const to = clampRow(row);
      if (prefersReducedMotion() || ms <= 0) {
        d.glide = null;
        paint(to);
        return;
      }
      d.glide = { from: d.pos, to, at: performance.now(), ms };
      const step = (now: number) => {
        const g = d.glide;
        if (!g || d.drag) {
          d.raf = 0;
          return;
        }
        const t = Math.min(1, (now - g.at) / g.ms);
        const eased = 1 - (1 - t) ** 4;
        paint(g.from + (g.to - g.from) * eased);
        if (t >= 1) {
          d.glide = null;
          d.raf = 0;
          return;
        }
        d.raf = requestAnimationFrame(step);
      };
      if (!d.raf) d.raf = requestAnimationFrame(step);
    },
    [paint],
  );
  // Where the drum is heading: the glide's end, or where it stands.
  const heading = () => drum.current.glide?.to ?? Math.round(drum.current.pos);
  const glideBy = useCallback(
    (rows: number) => {
      const to = clampRow(heading() + rows);
      const dist = Math.abs(to - drum.current.pos);
      glideTo(to, Math.min(GLIDE_MAX_MS, GLIDE_BASE_MS + dist * GLIDE_ROW_MS));
    },
    [glideTo],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const d = drum.current;
    // A wheel or trackpad moves the drum directly, pixel for pixel (scaled), and it snaps
    // to the nearest row once the gesture has gone quiet.
    let idle = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (d.drag) return;
      d.glide = null;
      const last = live.current.rows.length - 1;
      const pos = Math.min(last, Math.max(0, d.pos + (e.deltaY * WHEEL_GAIN) / live.current.pitch));
      paint(pos);
      window.clearTimeout(idle);
      idle = window.setTimeout(() => glideTo(Math.round(d.pos), SNAP_MS), WHEEL_IDLE_MS);
    };
    // A finger: the wheel follows it, then flies on its release velocity.
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      window.clearTimeout(idle);
      d.glide = null;
      d.drag = { id: e.pointerId, y0: e.clientY, pos0: d.pos, samples: [{ t: e.timeStamp, y: e.clientY }], moved: false };
      // The move and the release are heard on the window, never captured: pointer capture
      // retargets the CLICK that follows a tap onto the column itself, which the dialog
      // reads as a tap on nothing and folds.
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    };
    const onMove = (e: PointerEvent) => {
      const g = d.drag;
      if (!g || e.pointerId !== g.id) return;
      const dy = g.y0 - e.clientY;
      if (Math.abs(dy) > DRAG_PX) g.moved = true;
      const last = live.current.rows.length - 1;
      let pos = g.pos0 + dy / live.current.pitch;
      // Past either end the wheel stretches, and only a little.
      if (pos < 0) pos *= RUBBER;
      else if (pos > last) pos = last + (pos - last) * RUBBER;
      paint(pos);
      g.samples.push({ t: e.timeStamp, y: e.clientY });
      if (g.samples.length > 6) g.samples.shift();
    };
    const onUp = (e: PointerEvent) => {
      const g = d.drag;
      if (!g || e.pointerId !== g.id) return;
      d.drag = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      lastMoved.current = g.moved;
      // Release velocity off the last few samples, in rows per second.
      const a = g.samples[0];
      const b = g.samples[g.samples.length - 1];
      const dt = (b.t - a.t) / 1000;
      const v = dt > 0.012 ? (a.y - b.y) / live.current.pitch / dt : 0;
      const fling = Math.max(-FLING_MAX_ROWS, Math.min(FLING_MAX_ROWS, v * FLING_S));
      const to = clampRow(Math.round(d.pos + fling));
      const dist = Math.abs(to - d.pos);
      glideTo(to, Math.min(GLIDE_MAX_MS, GLIDE_BASE_MS + dist * GLIDE_ROW_MS));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown);
    return () => {
      if (d.raf) cancelAnimationFrame(d.raf);
      d.raf = 0;
      window.clearTimeout(idle);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [anchor, glideTo, paint]);

  // The pick lands on the FOLD: whatever the slot holds as the dialog closes — by the
  // slot's tap, a tap outside, or Escape, one door for all three — becomes the hole's
  // word, after the overlay is gone.
  const fold = useCallback(() => {
    const { rows: r, current: i, hubRank, onPick: pick } = live.current;
    const stop = r[i];
    if (pick && stop && stop.rank !== 0 && stop.rank !== hubRank) pick(stop);
    onClose();
  }, [onClose]);

  // The arrow keys move a row; the wheel is a control, and a keyboard is an input.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      glideBy(e.key === 'ArrowDown' ? 1 : -1);
    },
    [glideBy],
  );

  // A tapped row glides into the slot; the row already there is the way out. A drag that
  // ended on a row is not a tap.
  const turnTo = useCallback(
    (i: number) => {
      if (lastMoved.current) {
        lastMoved.current = false;
        return;
      }
      if (i === live.current.current) {
        beginClose();
        return;
      }
      glideTo(i, Math.min(GLIDE_MAX_MS, GLIDE_BASE_MS + Math.abs(i - drum.current.pos) * GLIDE_ROW_MS));
    },
    [beginClose, glideTo],
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
      <>
        <span className="wheel-word">{stop.word}</span>
        {stop.rank > 0 && <sup className="wheel-rank">{stop.rank}</sup>}
      </>
    );

  return createPortal(
    <dialog
      {...dialogProps}
      className={`wheel-dialog${closing ? ' closing' : ''}${flip ? ' wheel-right' : ''}`}
      aria-label={title}
      onClose={fold}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        // A drag that ended here is not a tap on anything.
        if (lastMoved.current) {
          lastMoved.current = false;
          return;
        }
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
          ...(flip
            ? { right: anchor.width - (anchor.wrap.x + anchor.wrap.w) }
            : { left: anchor.wrap.x }),
          width: column,
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
