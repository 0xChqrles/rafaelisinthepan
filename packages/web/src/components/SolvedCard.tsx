import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { INFINITY_GLYPH, dateForDayNumber, isBonusRef, type PuzzleRef } from '@whippin/shared';
import MeterCanvas, { type MeterShape } from './MeterCanvas';
import Strike from './Strike';
import { BURST_ART } from './strikeArt';
import RunHeat, { type HeatKeepOut } from './RunHeat';
import RunRuler from './RunRuler';
import { COUNT_GLINT_CELL_PX } from './foil';
import { COUNT_EM, COUNT_ROWS, capCorners, countInk, countSize, glyphBoxes, inkEms, reelInk, reelRow } from './countCells';
import { COUNT_END_MS, COUNT_RUN_MS, countFilled, countReels, reelShake, reelStop, reelsText, type CountReel } from './countRun';
import { digitMasksNow, loadDigitMasks, type DigitMask } from './digitMasks';
import useToday from '../hooks/useToday';
import { prefersReducedMotion } from '../hooks/useScramble';
import { t } from '../i18n';

// THE CARD, LIVE: the result IS the share card it sends (shared/cardSvg.ts `renderCardSvg`),
// stood up in the column on the same bare ground with the same furniture — no panel, no well:
// the device frame's corner BRACKETS round exactly what the card shows; the EDITION on the
// top row (`N.<day>` at the left in the pixel face's smallest size, the date at the right in
// its accent, where the card prints it; BONUS and its id for a bonus); the COUNT; and the RUN
// RULER across the whole column, white ticks, pixel indices. SHARE (`children`) stands under
// the frame: the brackets hold the thing you send, the button sends it.
//
// THE SCORE IS THE SUBJECT (user-decided 2026-10-02, on the design's second round: the
// portrait and the name took the emphasis from the score — the boards under it name the
// player). The count stands alone, the biggest thing on the screen, in the pixel face at a
// WHOLE scale — the largest multiple of 8px that fits the hero for this round's final digits
// AND leaves SHARE above the fold (`countCells.ts` `countSize`: the card's room down to the
// stage's fade, less everything in the card but the count), decided on the mount's SMALL
// viewport (`svh`: a phone's toolbar collapsing on scroll must not resize what has landed)
// and re-measured only when the column's width changes; its box is its INK, so it centres
// on what it prints. Nothing is scaled by a transform.
//
// THE COUNT IS THE METER: it is drawn cell by cell on the face's own glyph pixels
// (`digitMasks.ts`, laid out by `countCells.ts`) by a SHAPED `MeterCanvas`. The tally is a
// SLOT MACHINE on those pixels (`countRun.ts`: one fixed length for every score): a REEL per
// digit of the score, each the face's glyphs rolling at a whole font pixel, all spinning from
// almost the same instant and STOPPING LEFT TO RIGHT, each with a snap; on its stop the digit
// SHAKES (whole font pixels, hard steps, drawn into the shape) and gets ITS OWN BURST IN FRONT
// of it (`Bursts`; user-decided 2026-10-03, "the burst animation on each spotted digit") — the
// meter's cobalt round it, white light where it crosses the stopped digits. While it runs,
// the digits charge with the meter's ordered-dither fill, as far as the reconstruction had
// reached at the try the ruler is writing (never past 99); the last stop fills them, and on
// its burst's impact the cobalt DISSOLVES into the holographic FOIL (`foil.ts`
// `paintCountFoil`: dithered on the house's 2px cell, one slab), glints taking turns on the
// digits' cap-line corners. A round that ENDED UNSOLVED wears no shine: a plain white `∞` on
// the count's own pixel grid. A settled result is BORN in the foil.
//
// The screen adds ONE thing the still card cannot: THE RUN'S HEAT (`RunHeat`), the ruler's
// own inks rising off it as an ordered dither, as tall as each try's reconstruction got —
// the climb the count is the length of, behind the count. The count and its unit stand in a
// CLEARING of it (`keepOut`): the field thins to bare ground round each digit's ink and the
// unit.
//
// THE REVEAL DRAWS THE CARD (classes the screen drives, `SolvedScreen`'s DRAW_MS): `drawn`
// — the brackets travel out to the corners, the edition types, the ruler's empty track is
// wiped across, the count's reels blink in on 0; then the tally (`ms`, the run's clock) spins
// and stops the reels and fills the ruler on the same clock behind a white write head, its
// ticks stamping down, the heat rising off it and the meter charging; on `landed` — the last
// stop — the heat surges, the brackets LOCK ON (their arms reach out along the frame and draw
// back in whole steps — never in over what they hold) and the meter, full, dissolves into
// its foil. Every box is laid out from frame one, so nothing that has landed moves.

// The card goes WIDE (the desktop's sizes) on a column this wide, in a small viewport this
// tall: a shorter window keeps the phone's sizes, so its room goes to the count, not to the
// air round it.
const WIDE_PX = 552;
const WIDE_MIN_HEIGHT_PX = 640;
// The meter's fill follows the tally this closely (each written try re-aims it).
const CHARGE_MS = 90;
// Where in the last stop's burst the foil begins — on its impact frames (Hole's own 60%) —
// on the run's clock, which runs to COUNT_END_MS.
const FOIL_IN_BURST_MS = BURST_ART.ms * 0.6;
const FOIL_AT_MS = Math.min(COUNT_END_MS, COUNT_RUN_MS + FOIL_IN_BURST_MS);
// THE CLEARING in the heat: bare for CLEAR_PX round each digit's ink box, the heat returning
// over one of the face's pixels; round the unit, bare for UNIT_CLEAR_PX then returning over
// UNIT_RAMP_PX — long enough to read as a clearing, its corners rounded by the distance.
const CLEAR_PX = 4;
const UNIT_CLEAR_PX = 2;
const UNIT_RAMP_PX = 18;
// The heat's cells (RunHeat's own).
const HEAT_CELL_PX = 2;
// THE STOPS' BURSTS: the burst sheet's frame (`burst.png`, 53×66), its impact ink centred
// 44% down the frame, at the whole scale that makes the frame about BURST_DIGIT_SPAN digits
// wide (never under 2x); the stencil keeps it BURST_TEXT_GAP px off the unit and the
// edition's type (a ray through small type garbles it), and BURST_EDGE px above the ruler's
// ticks (which overhang the bar by TICK_OVERHANG).
const BURST_W = 53;
const BURST_H = 66;
const BURST_INK_Y = 0.44;
const BURST_DIGIT_SPAN = 1.5;
const BURST_TEXT_GAP = 6;
const BURST_EDGE = 4;
const TICK_OVERHANG = 8;

type Rect = { x: number; y: number; w: number; h: number };

// The small viewport's height (`100svh`): the height a phone keeps with its toolbars out,
// which scrolling never changes.
function smallViewportHeight(): number {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:100svh;visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  const h = probe.getBoundingClientRect().height || window.innerHeight;
  probe.remove();
  return h;
}

// THE CARD'S ROOM: how tall the card (SHARE included) may stand on the mount's small viewport
// and keep SHARE above the fold — from its top in the stage it opens (the scroller it is the
// first block of) down to the stage's bottom fade (its padding), less what a toolbar out at
// the mount lends the viewport and takes back.
function cardRoom(card: HTMLElement): number {
  const stage = card.parentElement;
  if (!stage) return Infinity;
  const top = card.getBoundingClientRect().top - stage.getBoundingClientRect().top - stage.clientTop + stage.scrollTop;
  const fade = parseFloat(getComputedStyle(stage).paddingBottom) || 0;
  const lent = Math.max(0, window.innerHeight - smallViewportHeight());
  return stage.clientHeight - top - fade - lent;
}

// The digits' glyphs: at once when the session has decoded them, `undefined` while the
// decode is out (the count waits unseen rather than flash white under its foil), `null` if it
// failed (the count is then set as type).
function useDigitMasks(): DigitMask[] | null | undefined {
  const [masks, setMasks] = useState<DigitMask[] | null | undefined>(() => digitMasksNow() ?? undefined);
  useEffect(() => {
    if (masks !== undefined) return undefined;
    let live = true;
    loadDigitMasks().then(
      (decoded) => live && setMasks(decoded),
      () => live && setMasks(null),
    );
    return () => {
      live = false;
    };
  }, [masks]);
  return masks;
}

// `∞` on the count's own pixel grid: its 9×5 cells are each one pixel of the face at this
// size (an eighth of it).
function InfinityCells({ size }: { size: number }) {
  const cell = size / COUNT_EM;
  return (
    <svg
      className="solved-card-inf"
      viewBox={INFINITY_GLYPH.viewBox}
      width={cell * INFINITY_GLYPH.width}
      height={cell * INFINITY_GLYPH.height}
      aria-hidden="true"
      focusable="false"
    >
      <path d={INFINITY_GLYPH.path} fill="currentColor" />
    </svg>
  );
}

// A line of the pixel face that TYPES itself as the card is drawn, glyph by glyph (the face
// advances exactly 1em a glyph, so `steps(n)` over a clip is one glyph a step).
function Typed({ className, text, delayMs }: { className: string; text: string; delayMs: number }) {
  const n = Math.max(1, Array.from(text).length);
  return (
    <span
      className={`solved-card-typed ${className}`}
      style={
        {
          '--type-n': n,
          '--type-delay': `${delayMs}ms`,
          animationTimingFunction: `steps(${n}, jump-end)`,
        } as CSSProperties
      }
    >
      {text}
    </span>
  );
}

// THE COUNT AS A SHAPE for the meter: its reels where the run has them (`countRun.ts`), every
// glyph the face's own pixels at `size`, each reel's strip at a whole font pixel and each
// reel's slot at its shake (whole font pixels; the canvas bleeds past the box for it). The
// glints stand on the cap-line corners.
function countShape(masks: readonly DigitMask[], reels: readonly CountReel[], size: number): MeterShape {
  const px = size / COUNT_EM;
  const rows = reels.map((r) => reelRow(r.pos));
  const ink = reelInk(masks, rows);
  // ONE path, filled once: the clip is a `destination-in`, and every separate fill would
  // keep only its own cell.
  const cells = (ctx: CanvasRenderingContext2D) => {
    ctx.beginPath();
    reels.forEach(({ dx, dy }, i) => {
      for (let gx = i * COUNT_EM; gx < (i + 1) * COUNT_EM; gx += 1) {
        for (let gy = 0; gy < COUNT_ROWS; gy += 1) {
          if (ink(gx, gy)) ctx.rect((gx + dx) * px, (gy + dy) * px, px, px);
        }
      }
    });
    ctx.fill();
  };
  return {
    key: `${reels.map((r, i) => `${rows[i]}:${r.dx}:${r.dy}`).join(',')}|${size}`,
    clip: (ctx) => {
      ctx.fillStyle = '#fff';
      cells(ctx);
    },
    base: (ctx) => {
      ctx.fillStyle = getComputedStyle(ctx.canvas).getPropertyValue('--fg').trim();
      cells(ctx);
    },
    spots: reels.flatMap(({ dx, dy }, i) =>
      capCorners(ink, i, i + 1, px, COUNT_GLINT_CELL_PX).map(([x, y]): [number, number] => [x + dx * px, y + dy * px]),
    ),
    inside: (x, y) => {
      const gx = Math.floor(x / px);
      const gy = Math.floor(y / px);
      return reels.some(({ dx, dy }, i) => {
        const at = gx - dx;
        return at >= i * COUNT_EM && at < (i + 1) * COUNT_EM && ink(at, gy - dy);
      });
    },
  };
}

// THE METER'S SEQUENCE on the count: the fill follows the ruler — the furthest the
// reconstruction had got by the try being written, never past 99 — the last stop fills it,
// and on that stop's burst's impact it recedes into the foil: on the RUN'S CLOCK (`ms`), the
// one the burst is mounted off, so the dissolve meets the blow whatever the fill's tween
// took. A reduced-motion reveal's clock is at its end at once, so it takes the foil at once;
// a settled result is born in the foil.
function useMeterRun({
  on,
  settled,
  landed,
  ms,
  filled,
  trajectory,
}: {
  on: boolean;
  settled: boolean;
  landed: boolean;
  ms: number;
  filled: number;
  trajectory: number[];
}) {
  const charged = on && (settled || landed);
  const reach = useMemo(() => {
    let best = 0;
    return trajectory.map((pct) => (best = Math.max(best, pct)));
  }, [trajectory]);
  const charge = charged ? 100 : filled > 0 ? Math.min(99, reach[filled - 1] ?? 0) : 0;
  return {
    // Keyed on the settled frame: a result that lands settled (rehydrated, or fast-forwarded)
    // is BORN in the foil — no charge, no recede to replay.
    key: settled ? 'settled' : 'live',
    value: settled ? 100 : charge,
    sea: settled || (charged && ms >= FOIL_AT_MS),
  };
}

// A rect relative to another's top-left.
function within(r: DOMRect, origin: { left: number; top: number }): Rect {
  return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
}
// How far a point is from a rect (0 inside it).
function rectDistance(x: number, y: number, r: Rect): number {
  const dx = Math.max(0, r.x - x, x - (r.x + r.w));
  const dy = Math.max(0, r.y - y, y - (r.y + r.h));
  return Math.hypot(dx, dy);
}
// Each glyph's ink box relative to the count's box, in CSS px.
function digitRects(masks: readonly DigitMask[], text: string, px: number): Rect[] {
  return glyphBoxes(masks, text).map(({ x0, x1 }) => ({ x: x0 * px, y: 0, w: (x1 - x0) * px, h: COUNT_ROWS * px }));
}

// THE STOPS' BURSTS: each reel's stop goes off IN FRONT of its digit — the burst sheet at the
// whole scale that makes it about BURST_DIGIT_SPAN digits wide, centred on the digit's ink,
// clipped to the frame above the ruler's ticks and stencilled off the unit and the edition's
// type. In the meter's cobalt round the number, and over the stopped digits' ink — the same
// cobalt, where a cobalt ray would vanish — in WHITE, a second sheet on the same beat kept
// to their cells AS THEY STAND: one stencil per digit, each a mask layer at its digit's
// shake, so the white recoils with the digit it lights. Measured once, when the run starts
// (the card's boxes are laid out from frame one); each burst is mounted for its one blow from
// its reel's stop (`ms`, the run's clock).
function Bursts({
  frameRef,
  topRef,
  runRef,
  numRef,
  unitRef,
  masks,
  text,
  px,
  ms,
}: {
  frameRef: RefObject<HTMLDivElement>;
  topRef: RefObject<HTMLDivElement>;
  runRef: RefObject<HTMLDivElement>;
  numRef: RefObject<HTMLSpanElement>;
  unitRef: RefObject<HTMLSpanElement>;
  masks: readonly DigitMask[] | null | undefined;
  text: string;
  px: number;
  ms: number;
}) {
  const [geo, setGeo] = useState<{
    box: Rect;
    scale: number;
    field: string;
    bursts: { x: number; y: number }[];
    // Each digit's own cells (none for the count set as type), at rest.
    digits: { mask: string; x: number; y: number; w: number; h: number }[] | null;
  } | null>(null);
  useLayoutEffect(() => {
    const frame = frameRef.current?.getBoundingClientRect();
    const bar = runRef.current?.querySelector('.run-bar')?.getBoundingClientRect();
    const num = numRef.current?.getBoundingClientRect();
    if (!frame || !bar || !num) return;
    const box = { x: 0, y: 0, w: frame.width, h: Math.max(0, bar.top - frame.top - TICK_OVERHANG - BURST_EDGE) };
    const origin = { left: frame.left, top: frame.top };
    const n = within(num, origin);
    const unit = unitRef.current ? within(unitRef.current.getBoundingClientRect(), origin) : null;
    const texts = Array.from(topRef.current?.querySelectorAll('.solved-card-typed') ?? [], (el) =>
      within(el.getBoundingClientRect(), origin),
    );
    // A full glyph's ink is its advance less the blank column.
    const glyphW = (COUNT_EM - 1) * px;
    const scale = Math.max(2, Math.round((BURST_DIGIT_SPAN * glyphW) / BURST_W));
    // A stencil `w`×`h` CSS px, at the device's resolution so its edges land on whole pixels.
    const dpr = window.devicePixelRatio || 1;
    const stencil = (w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void): string | null => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.scale(dpr, dpr);
      ctx.fillStyle = '#fff';
      paint(ctx);
      return `url(${canvas.toDataURL()})`;
    };
    // The cobalt's field: the whole box but the type.
    const field = stencil(box.w, box.h, (ctx) => {
      ctx.fillRect(0, 0, box.w, box.h);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      for (const r of unit ? [unit, ...texts] : texts) {
        ctx.rect(r.x - BURST_TEXT_GAP, r.y - BURST_TEXT_GAP, r.w + 2 * BURST_TEXT_GAP, r.h + 2 * BURST_TEXT_GAP);
      }
      ctx.fill();
    });
    if (!field) return;
    // Each digit's ink box, the burst's centre (the count set as type: its advance).
    const glyphs = masks
      ? digitRects(masks, text, px)
      : Array.from(text, (_, i) => ({ x: i * COUNT_EM * px, y: 0, w: glyphW, h: n.h }));
    const bursts = glyphs.map((g) => ({
      x: Math.round(n.x + g.x + g.w / 2 - (BURST_W * scale) / 2),
      y: Math.round(n.y + n.h / 2 - BURST_H * scale * BURST_INK_Y),
    }));
    // The white's: each digit's cells on its own glyph slot, placed at the slot's rest.
    const ink = masks ? countInk(masks, text) : null;
    const slotW = COUNT_EM * px;
    const slotH = COUNT_ROWS * px;
    const digits = ink
      ? Array.from(text, (_, i) => ({
          mask:
            stencil(slotW, slotH, (ctx) => {
              ctx.beginPath();
              for (let gx = 0; gx < COUNT_EM; gx += 1) {
                for (let gy = 0; gy < COUNT_ROWS; gy += 1) {
                  if (ink(i * COUNT_EM + gx, gy)) ctx.rect(gx * px, gy * px, px, px);
                }
              }
              ctx.fill();
            }) ?? 'none',
          x: n.x + i * slotW,
          y: n.y,
          w: slotW,
          h: slotH,
        }))
      : null;
    setGeo({ box, scale, field, bursts, digits });
  }, [masks, text, px]);
  if (!geo) return null;
  const sheet = (at: { x: number; y: number }, mask: CSSProperties, color: string) => (
    <span
      className="solved-card-burst"
      aria-hidden="true"
      style={
        {
          left: geo.box.x,
          top: geo.box.y,
          width: geo.box.w,
          height: geo.box.h,
          ...mask,
          '--burst-x': `${at.x}px`,
          '--burst-y': `${at.y}px`,
          '--burst-w': `${BURST_W * geo.scale}px`,
          '--burst-h': `${BURST_H * geo.scale}px`,
        } as CSSProperties
      }
    >
      <Strike id={1} art={BURST_ART} color={color} />
    </span>
  );
  const reels = geo.bursts.length;
  // The white over digits 0…i — the stopped ones — each layer where its digit stands now.
  const white = (i: number): CSSProperties | null => {
    if (!geo.digits) return null;
    const layers = geo.digits.slice(0, i + 1);
    const image = layers.map((d) => d.mask).join(', ');
    const position = layers
      .map((d, j) => {
        const [dx, dy] = reelShake(j, reels, ms);
        return `${d.x + dx * px}px ${d.y + dy * px}px`;
      })
      .join(', ');
    const size = layers.map((d) => `${d.w}px ${d.h}px`).join(', ');
    return {
      WebkitMaskImage: image,
      maskImage: image,
      WebkitMaskPosition: position,
      maskPosition: position,
      WebkitMaskSize: size,
      maskSize: size,
    };
  };
  return (
    <>
      {geo.bursts.map((at, i) => {
        const since = ms - reelStop(i, reels);
        if (since < 0 || since >= BURST_ART.ms) return null;
        const lit = white(i);
        return (
          <Fragment key={i}>
            {sheet(at, { WebkitMaskImage: geo.field, maskImage: geo.field }, 'var(--accent)')}
            {lit && sheet(at, lit, 'var(--fg)')}
          </Fragment>
        );
      })}
    </>
  );
}

export default function SolvedCard({
  puzzleRef,
  lang,
  guessCount,
  ms,
  trajectory,
  solvedAt,
  unfinished,
  drawn,
  landed,
  settled,
  children,
}: {
  puzzleRef: PuzzleRef;
  lang: string;
  guessCount: number;
  // The tally's clock: ms since the run began (0 before it starts; `COUNT_RUN_MS` the last
  // stop, `COUNT_END_MS` its shake played out). The reels, their shakes and bursts, the
  // ruler, the heat and the meter's fill all read it (`countRun.ts`).
  ms: number;
  trajectory: number[];
  solvedAt: (number | null)[];
  unfinished: boolean; // ended unsolved: `∞`, no shine
  drawn: boolean; // the card's drawing beat
  landed: boolean; // the tally's last reel has stopped, on a PLAYED reveal
  settled: boolean; // no reveal: the final frame, as a rehydrated result draws it
  children: ReactNode; // SHARE
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const numRef = useRef<HTMLSpanElement>(null);
  const unitRef = useRef<HTMLSpanElement>(null);
  const runRef = useRef<HTMLDivElement>(null);
  const digits = String(guessCount).length;
  // The count's box in ems, on its INK: `∞` is 9 of the count's pixels wide.
  const ems = unfinished ? INFINITY_GLYPH.width / COUNT_EM : inkEms(digits);

  // THE COUNT'S SIZE (see the header). WIDE is read off the card's own width, which its
  // padding does not change, and the mount's small viewport; the size off the hero's width,
  // which it does, and off the height the card can spare the count's box above the fold —
  // read once per run of this effect, under the sizes the card wears (a change of WIDE runs
  // it again), never off a later reflow.
  const [fit, setFit] = useState({ count: 64, wide: false });
  const tall = useMemo(() => smallViewportHeight() >= WIDE_MIN_HEIGHT_PX, []);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const hero = heroRef.current;
    const num = numRef.current;
    if (!root || !hero || !num) return undefined;
    const room = cardRoom(root) - (root.offsetHeight - num.offsetHeight);
    const measure = () => {
      const w = hero.clientWidth;
      if (!w) return;
      const wide = tall && root.clientWidth >= WIDE_PX;
      if (wide !== fit.wide) {
        setFit((prev) => ({ ...prev, wide }));
        return;
      }
      const count = countSize(w, room, ems, wide);
      setFit((prev) => (prev.count === count && prev.wide === wide ? prev : { count, wide }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    ro.observe(hero);
    return () => ro.disconnect();
  }, [ems, fit.wide, tall]);

  const bonus = isBonusRef(puzzleRef);
  // Today's own number is the desktop device frame's corner serial too: where that frame
  // shows, the card does not print it twice (CSS, `.today`). An archive day's or a bonus's
  // number differs, and stays.
  const today = useToday();
  const isToday = !bonus && puzzleRef.dayNumber === today;
  const edition = bonus ? `N.${puzzleRef.bonusId}` : `N.${puzzleRef.dayNumber}`;
  const label = bonus ? 'BONUS' : dateForDayNumber(puzzleRef.dayNumber);
  const unit = t(lang, !unfinished && guessCount === 1 ? 'try' : 'tries');

  // THE TALLY at this instant (`countRun.ts`): how many tries the ruler has written, and
  // where each reel stands — one per digit of the score, resting on 0, so the number fills
  // its box from the first frame.
  const filled = countFilled(guessCount, ms);
  const reels = useMemo(() => countReels(guessCount, ms), [guessCount, ms]);
  const meter = useMeterRun({ on: !unfinished, settled, landed, ms, filled, trajectory });
  const reading = reelsText(reels);
  // The final number: what the box, the heat's clearing and the bursts are laid out on.
  const text = String(guessCount);
  const masks = useDigitMasks();
  // Drawn as cells once the glyphs are in; while they are being decoded the digits wait
  // unseen. A failed decode sets the count as type.
  const cells = !unfinished && masks !== null;
  const shape = useMemo(
    () => (!unfinished && masks ? countShape(masks, reels, fit.count) : null),
    [unfinished, masks, reels, fit.count],
  );
  const px = fit.count / COUNT_EM;

  // THE CLEARING: round what stands in the heat — the final number's digits, whatever the
  // reels show on the way — read off the laid-out boxes and cached until one of them changes.
  const clearCache = useRef<{ key: string; grid: Float32Array } | null>(null);
  const keepOut = useCallback<HeatKeepOut>(
    (canvas) => {
      const num = numRef.current;
      if (!num) return null;
      const c = canvas.getBoundingClientRect();
      const n = within(num.getBoundingClientRect(), c);
      const unitBox = unitRef.current?.getBoundingClientRect();
      const u = unitBox ? within(unitBox, c) : null;
      const cols = Math.floor(c.width / HEAT_CELL_PX);
      const rows = Math.floor(c.height / HEAT_CELL_PX);
      const key = [text, unfinished, Boolean(masks), cols, rows, n.x, n.y, n.w, n.h, u?.x, u?.y, u?.w, u?.h].join('|');
      if (clearCache.current?.key !== key) {
        const grid = new Float32Array(cols * rows);
        const boxes = (!unfinished && masks ? digitRects(masks, text, px) : [{ x: 0, y: 0, w: n.w, h: n.h }]).map(
          (b) => ({ ...b, x: b.x + n.x, y: b.y + n.y }),
        );
        for (let cy = 0; cy < rows; cy += 1) {
          for (let cx = 0; cx < cols; cx += 1) {
            const x = cx * HEAT_CELL_PX + 1;
            const y = cy * HEAT_CELL_PX + 1;
            let m = 1;
            for (const b of boxes) {
              m = Math.min(m, Math.max(0, Math.min(1, (rectDistance(x, y, b) - CLEAR_PX) / px)));
            }
            if (u) {
              m = Math.min(m, Math.max(0, Math.min(1, (rectDistance(x, y, u) - UNIT_CLEAR_PX) / UNIT_RAMP_PX)));
            }
            grid[cy * cols + cx] = m;
          }
        }
        clearCache.current = { key, grid };
      }
      const { grid } = clearCache.current;
      return (x, y) => {
        const cx = Math.min(cols - 1, Math.max(0, Math.floor(x / HEAT_CELL_PX)));
        const cy = Math.min(rows - 1, Math.max(0, Math.floor(y / HEAT_CELL_PX)));
        return grid[cy * cols + cx];
      };
    },
    [text, unfinished, masks, px],
  );

  return (
    <div
      ref={rootRef}
      className={`solved-card${drawn ? ' in' : ''}${landed && !settled ? ' landed' : ''}${fit.wide ? ' wide' : ''}`}
      style={{ '--count': `${fit.count}px`, '--ink-ems': ems } as CSSProperties}
    >
      <div ref={frameRef} className="solved-card-frame">
        <span className="solved-card-bracket tl" aria-hidden="true" />
        <span className="solved-card-bracket tr" aria-hidden="true" />
        <span className="solved-card-bracket bl" aria-hidden="true" />
        <span className="solved-card-bracket br" aria-hidden="true" />

        {/* THE TOP ROW: the edition at the left, the day itself at the right in the accent. */}
        <div ref={topRef} className="solved-card-top" aria-hidden="true">
          <Typed className={`solved-card-edition${isToday ? ' today' : ''}`} text={edition} delayMs={200} />
          <Typed className="solved-card-date" text={label} delayMs={120} />
        </div>

        <div ref={heroRef} className="solved-card-hero">
          {/* THE COUNT over its unit. The hidden final value reserves the box; the live
              tally is overlaid on it, and read by a screen reader. */}
          <div className="solved-card-count">
            {unfinished ? (
              <span ref={numRef} className="solved-card-num">
                <InfinityCells size={fit.count} />
                <span className="sr-only">∞</span>
              </span>
            ) : (
              <span ref={numRef} className={`solved-card-num${cells ? ' cells' : ''}`}>
                <span className="solved-card-ghost" aria-hidden="true">
                  {guessCount}
                </span>
                <span className="solved-card-live">{reading}</span>
                {shape && (
                  <MeterCanvas
                    key={meter.key}
                    value={meter.value}
                    delayMs={0}
                    durationMs={CHARGE_MS}
                    sea={meter.sea}
                    seed={5}
                    shape={shape}
                  />
                )}
              </span>
            )}
            <span ref={unitRef} className="solved-card-unit">
              {unit}
            </span>
          </div>
        </div>

        <div ref={runRef} className="solved-card-run" aria-hidden="true">
          <RunHeat
            trajectory={trajectory}
            filled={filled}
            surge={landed && !settled}
            still={settled}
            keepOut={keepOut}
            keepOutKey={`${text}|${fit.count}|${masks ? 1 : 0}`}
          />
          <RunRuler trajectory={trajectory} solvedAt={solvedAt} filled={filled} />
        </div>

        {!unfinished && !settled && ms > 0 && !prefersReducedMotion() && (
          <Bursts
            frameRef={frameRef}
            topRef={topRef}
            runRef={runRef}
            numRef={numRef}
            unitRef={unitRef}
            masks={masks}
            text={text}
            px={px}
            ms={ms}
          />
        )}
      </div>

      {children}
    </div>
  );
}
