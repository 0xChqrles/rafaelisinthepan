import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { INFINITY_GLYPH, dateForDayNumber, isBonusRef, type PuzzleRef } from '@whippin/shared';
import MeterCanvas, { type MeterShape } from './MeterCanvas';
import Strike from './Strike';
import { BURST_ART } from './strikeArt';
import RunHeat, { type HeatKeepOut } from './RunHeat';
import RunRuler from './RunRuler';
import { COUNT_GLINT_CELL_PX } from './foil';
import { COUNT_EM, COUNT_ROWS, capCorners, countInk, countSize, glyphBoxes, inkEms } from './countCells';
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
// (`countCells.ts` `countSize`), decided on the mount's SMALL viewport (`svh`: a phone's
// toolbar collapsing on scroll must not resize what has landed) and re-measured only when
// the column's width changes; its box is its INK, so it centres on what it prints. Nothing
// is scaled by a transform.
//
// THE COUNT IS THE METER: it is drawn cell by cell on the face's own glyph pixels
// (`digitMasks.ts`, laid out by `countCells.ts`) by a SHAPED `MeterCanvas`. While the tally
// counts, its digits charge with the meter's ordered-dither fill, as far as the
// reconstruction had reached at the try being written (never past 99); the landing fills
// them, ONE BLAST in the meter's cobalt goes off from behind the whole number (`Blast`), and
// on the blast's impact the cobalt DISSOLVES into the holographic FOIL (`foil.ts`
// `paintCountFoil`: dithered on the house's 2px cell, one slab), glints taking turns on the
// digits' cap-line corners. While the tally runs, the digits it has not reached stand as the
// odometer's zeros in the slate. A round that ENDED UNSOLVED wears no shine: a plain white
// `∞` on the count's own pixel grid. A settled result is BORN in the foil.
//
// The screen adds ONE thing the still card cannot: THE RUN'S HEAT (`RunHeat`), the ruler's
// own inks rising off it as an ordered dither, as tall as each try's reconstruction got —
// the climb the count is the length of, behind the count. The count and its unit stand in a
// CLEARING of it (`keepOut`): the field thins to bare ground round each digit's ink and the
// unit.
//
// THE REVEAL DRAWS THE CARD (classes the screen drives, `SolvedScreen`'s DRAW_MS): `drawn`
// — the brackets travel out to the corners, the edition types, the ruler's empty track is
// wiped across, the count's zeros blink in; then the tally fills the ruler behind a white
// write head, its ticks stamping down, the heat rising off it and the meter charging; on
// `landed` the number stamps, the heat surges, the brackets LOCK ON (their arms reach out
// along the frame and draw back in whole steps — never in over what they hold) and the
// meter, full, blasts and dissolves. Every box is laid out from frame one, so nothing that
// has landed moves.

// The card goes WIDE (the desktop's sizes) on a column this wide.
const WIDE_PX = 552;
// A phone whose SMALL viewport is this short or shorter keeps the count a step smaller, for
// SHARE's sake.
const SHORT_PX = 640;
// The meter's fill follows the tally this closely (each written try re-aims it).
const CHARGE_MS = 90;
// Where in the blast the foil begins — on its impact frames (Hole's own 60%).
const FOIL_IN_BURST_MS = BURST_ART.ms * 0.6;
// THE CLEARING in the heat: bare for CLEAR_PX round each digit's ink box, the heat returning
// over one of the face's pixels; round the unit, bare for UNIT_CLEAR_PX then returning over
// UNIT_RAMP_PX — long enough to read as a clearing, its corners rounded by the distance.
const CLEAR_PX = 4;
const UNIT_CLEAR_PX = 2;
const UNIT_RAMP_PX = 18;
// The heat's cells (RunHeat's own).
const HEAT_CELL_PX = 2;
// THE BLAST: the burst sheet's frame (`burst.png`, 53×66), its impact ink centred 44% down
// the frame; the stencil keeps it BLAST_GAP px off each digit's ink box (a ray through a
// digit's notch would garble the glyph), BLAST_TEXT_GAP px off the unit and the edition's
// type, and BLAST_EDGE px above the ruler's ticks (which overhang the bar by TICK_OVERHANG).
const BURST_W = 53;
const BURST_H = 66;
const BURST_INK_Y = 0.44;
const BLAST_GAP = 8;
const BLAST_TEXT_GAP = 6;
const BLAST_EDGE = 4;
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

// THE COUNT AS A SHAPE for the meter: `pad` (the odometer's unreached zeros) then `live`,
// every glyph the face's own pixels at `size`. The meter is kept to the LIVE digits' ink; the
// zeros stand in the slate under it. Glints stand on the live digits' cap-line corners.
function countShape(masks: readonly DigitMask[], pad: string, live: string, size: number): MeterShape {
  const px = size / COUNT_EM;
  const text = pad + live;
  const ink = countInk(masks, text);
  // ONE path, filled once: the clip is a `destination-in`, and every separate fill would
  // keep only its own cell.
  const cells = (from: number, to: number, ctx: CanvasRenderingContext2D) => {
    ctx.beginPath();
    for (let gx = from * COUNT_EM; gx < to * COUNT_EM; gx += 1) {
      for (let gy = 0; gy < COUNT_ROWS; gy += 1) {
        if (ink(gx, gy)) ctx.rect(gx * px, gy * px, px, px);
      }
    }
    ctx.fill();
  };
  return {
    key: `${pad}|${live}|${size}`,
    clip: (ctx) => {
      ctx.fillStyle = '#fff';
      cells(pad.length, text.length, ctx);
    },
    base: (ctx) => {
      const style = getComputedStyle(ctx.canvas);
      ctx.fillStyle = style.getPropertyValue('--rail').trim();
      cells(0, pad.length, ctx);
      ctx.fillStyle = style.getPropertyValue('--fg').trim();
      cells(pad.length, text.length, ctx);
    },
    spots: capCorners(ink, pad.length, text.length, px, COUNT_GLINT_CELL_PX),
    inside: (x, y) => {
      const gx = Math.floor(x / px);
      return gx >= pad.length * COUNT_EM && ink(gx, Math.floor(y / px));
    },
  };
}

// THE METER'S SEQUENCE on the count: the fill follows the tally — the furthest the
// reconstruction had got by the try being written, never past 99 — the landing fills it, it
// BLASTS, and on the blast's impact it recedes into the foil. A reduced-motion reveal skips
// the blast (its sheet would park on a frame); a settled result is born in the foil.
function useMeterRun({
  on,
  settled,
  landed,
  shownCount,
  trajectory,
}: {
  on: boolean;
  settled: boolean;
  landed: boolean;
  shownCount: number;
  trajectory: number[];
}) {
  const charged = on && (settled || landed);
  const reach = useMemo(() => {
    let best = 0;
    return trajectory.map((pct) => (best = Math.max(best, pct)));
  }, [trajectory]);
  const charge = charged ? 100 : shownCount > 0 ? Math.min(99, reach[shownCount - 1] ?? 0) : 0;
  const [burst, setBurst] = useState(false);
  const [full, setFull] = useState(false);
  const onFull = useCallback(() => {
    if (prefersReducedMotion()) setFull(true);
    else setBurst(true);
  }, []);
  useEffect(() => {
    if (!burst) return undefined;
    const id = window.setTimeout(() => setFull(true), FOIL_IN_BURST_MS);
    return () => window.clearTimeout(id);
  }, [burst]);
  return {
    // Keyed on the settled frame: a result that lands settled (rehydrated, or fast-forwarded)
    // is BORN in the foil — no charge, no recede to replay.
    key: settled ? 'settled' : 'live',
    value: settled ? 100 : charge,
    sea: settled || full,
    burst: burst && !settled,
    onFull,
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

// THE BLAST: the full meter's burst, ONCE, from behind the whole number, at the whole scale
// that spans the frame; clipped to the frame above the ruler's ticks, and STENCILLED off
// what it must not cover — each digit's ink box grown by BLAST_GAP, the unit and the
// edition's type with a gap — so the rays visibly leave the number's edges.
function Blast({
  frameRef,
  topRef,
  runRef,
  numRef,
  unitRef,
  masks,
  text,
  px,
}: {
  frameRef: RefObject<HTMLDivElement>;
  topRef: RefObject<HTMLDivElement>;
  runRef: RefObject<HTMLDivElement>;
  numRef: RefObject<HTMLSpanElement>;
  unitRef: RefObject<HTMLSpanElement>;
  masks: readonly DigitMask[] | null | undefined;
  text: string;
  px: number;
}) {
  const [geo, setGeo] = useState<{ box: Rect; at: { x: number; y: number }; scale: number; mask: string } | null>(null);
  // Measured once, on the landing: the blast is one blow.
  useLayoutEffect(() => {
    const frame = frameRef.current?.getBoundingClientRect();
    const bar = runRef.current?.querySelector('.run-bar')?.getBoundingClientRect();
    const num = numRef.current?.getBoundingClientRect();
    if (!frame || !bar || !num) return;
    const box = { x: 0, y: 0, w: frame.width, h: Math.max(0, bar.top - frame.top - TICK_OVERHANG - BLAST_EDGE) };
    const origin = { left: frame.left, top: frame.top };
    const n = within(num, origin);
    const unit = unitRef.current ? within(unitRef.current.getBoundingClientRect(), origin) : null;
    const texts = Array.from(topRef.current?.querySelectorAll('.solved-card-typed') ?? [], (el) =>
      within(el.getBoundingClientRect(), origin),
    );
    const scale = Math.max(4, Math.ceil(box.w / BURST_W));
    const at = {
      x: Math.round(n.x + n.w / 2 - (BURST_W * scale) / 2),
      y: Math.round(n.y + n.h / 2 - BURST_H * scale * BURST_INK_Y),
    };
    // The stencil, at the device's resolution so its edges land on whole pixels.
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(box.w * dpr));
    canvas.height = Math.max(1, Math.round(box.h * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, box.w, box.h);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    const g = BLAST_GAP;
    const digits = masks ? digitRects(masks, text, px) : [{ x: 0, y: 0, w: n.w, h: n.h }];
    for (const d of digits) ctx.rect(n.x + d.x - g, n.y + d.y - g, d.w + 2 * g, d.h + 2 * g);
    for (const r of unit ? [unit, ...texts] : texts) {
      ctx.rect(r.x - BLAST_TEXT_GAP, r.y - BLAST_TEXT_GAP, r.w + 2 * BLAST_TEXT_GAP, r.h + 2 * BLAST_TEXT_GAP);
    }
    ctx.fill();
    setGeo({ box, at, scale, mask: `url(${canvas.toDataURL()})` });
  }, []);
  if (!geo) return null;
  return (
    <span
      className="solved-card-blast"
      aria-hidden="true"
      style={
        {
          left: geo.box.x,
          top: geo.box.y,
          width: geo.box.w,
          height: geo.box.h,
          WebkitMaskImage: geo.mask,
          maskImage: geo.mask,
          '--blast-x': `${geo.at.x}px`,
          '--blast-y': `${geo.at.y}px`,
          '--blast-w': `${BURST_W * geo.scale}px`,
          '--blast-h': `${BURST_H * geo.scale}px`,
        } as CSSProperties
      }
    >
      <Strike id={1} art={BURST_ART} color="var(--accent)" />
    </span>
  );
}

export default function SolvedCard({
  puzzleRef,
  lang,
  guessCount,
  shownCount,
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
  shownCount: number; // the tally's current value (the ruler, the heat and the meter fill off it)
  trajectory: number[];
  solvedAt: (number | null)[];
  unfinished: boolean; // ended unsolved: `∞`, no shine
  drawn: boolean; // the card's drawing beat
  landed: boolean; // the tally has reached its count on a PLAYED reveal
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
  // padding does not change; the size off the hero's, which it does.
  const [fit, setFit] = useState({ count: 64, wide: false });
  const short = useMemo(() => smallViewportHeight() < SHORT_PX, []);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const hero = heroRef.current;
    if (!root || !hero) return undefined;
    const measure = () => {
      const w = hero.clientWidth;
      if (!w) return;
      const wide = root.clientWidth >= WIDE_PX;
      const count = countSize(w, ems, wide, short);
      setFit((prev) => (prev.count === count && prev.wide === wide ? prev : { count, wide }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    ro.observe(hero);
    return () => ro.disconnect();
  }, [ems, short]);

  const bonus = isBonusRef(puzzleRef);
  // Today's own number is the desktop device frame's corner serial too: where that frame
  // shows, the card does not print it twice (CSS, `.today`). An archive day's or a bonus's
  // number differs, and stays.
  const today = useToday();
  const isToday = !bonus && puzzleRef.dayNumber === today;
  const edition = bonus ? `N.${puzzleRef.bonusId}` : `N.${puzzleRef.dayNumber}`;
  const label = bonus ? 'BONUS' : dateForDayNumber(puzzleRef.dayNumber);
  const unit = t(lang, !unfinished && guessCount === 1 ? 'try' : 'tries');

  const meter = useMeterRun({ on: !unfinished, settled, landed, shownCount, trajectory });

  // While the tally counts, the digits it has not reached yet stand as zeros — an odometer —
  // so the number fills its box from the first frame.
  const live = String(shownCount);
  const pad = shownCount < guessCount ? '0'.repeat(Math.max(0, digits - live.length)) : '';
  const text = pad + live;
  const masks = useDigitMasks();
  // Drawn as cells once the glyphs are in; while they are being decoded the digits wait
  // unseen. A failed decode sets the count as type.
  const cells = !unfinished && masks !== null;
  const shape = useMemo(
    () => (!unfinished && masks ? countShape(masks, pad, live, fit.count) : null),
    [unfinished, masks, pad, live, fit.count],
  );
  const px = fit.count / COUNT_EM;

  // THE CLEARING: round what stands in the heat, read off the laid-out boxes and cached until
  // one of them (or the digits the tally shows) changes.
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
                <span className="solved-card-live">
                  {pad && (
                    <span className="solved-card-pad" aria-hidden="true">
                      {pad}
                    </span>
                  )}
                  {live}
                </span>
                {shape && (
                  <MeterCanvas
                    key={meter.key}
                    value={meter.value}
                    delayMs={0}
                    durationMs={CHARGE_MS}
                    sea={meter.sea}
                    seed={5}
                    shape={shape}
                    onFull={meter.onFull}
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
            filled={shownCount}
            surge={landed && !settled}
            still={settled}
            keepOut={keepOut}
            keepOutKey={`${text}|${fit.count}|${masks ? 1 : 0}`}
          />
          <RunRuler trajectory={trajectory} solvedAt={solvedAt} filled={shownCount} />
        </div>

        {meter.burst && (
          <Blast
            frameRef={frameRef}
            topRef={topRef}
            runRef={runRef}
            numRef={numRef}
            unitRef={unitRef}
            masks={masks}
            text={String(guessCount)}
            px={px}
          />
        )}
      </div>

      {children}
    </div>
  );
}
