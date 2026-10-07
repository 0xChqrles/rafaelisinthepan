import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { DIGIT_MASKS, dateForDayNumber } from '@whippin/shared';
import { coarsePointer, prefersReducedMotion } from '../hooks/useScramble';
import { useSolvedDays } from '../state/history';
import { mondayNarrowLabels, streakTransition, weekView } from '../game/streak';
import { t } from '../i18n';
import { STAR_FRAMES, timeline, wordsAt, type WordsFrame } from './streak/beats';
import { LINK_H, LINK_W, FOIL, FOIL_DEEP, foilInk } from './streak/sprites';
import { RESERVE_BITS, layout, numberCells, numberPlace, pastWeeks } from './streak/geometry';
import type { ClearRect } from './streak/field';
import { orbitScene, type FoilField, type OrbitDay } from './streak/scene';
import { hexToAbgr } from './raster';
import Lockup from './Lockup';

const NO_SOLVED_DAYS: number[] = [];

const DISMISS_FADE_MS = 200;
// The hint's own entrance; dismissal arms once it has landed.
const HINT_IN_MS = 240;
// The raster is drawn on EVERY FRAME THE DISPLAY DRAWS, through the show and at rest: the
// orbits' trails glide a cell at a time, and what is stepped by design (the sparkle, the
// shakes, the flame's flicker) keeps its own steps inside the scene. (A raster stepped on a
// timer — 50ms in the show, 160ms for the drift at rest — read as a stutter, user-reported
// 2026-10-05.)
// Reduced motion holds ONE frame: the settled picture, between two heartbeats.
const STILL_AFTER_SETTLED_MS = 400;
// The device frame's corner brackets (CSS px): the cards' arm, inset by the screen.
const bracketInset = (w: number, h: number) => (Math.min(w, h) >= 600 ? 24 : 16);
const BRACKET_ARM = 24;

// A fresh daily solve changes player-level progression, so that moment gets a full-screen
// temporal sequence instead of competing with the sentence result. Game controls when this
// mounts: active-day transition only, never archive, tutorial, or rehydration.
export interface StreakDialogProps {
  lang: string;
  solvedDay: number;
  previewPreviousStreak?: number;
  onDismiss: () => void;
}

export default function StreakDialog({
  lang,
  solvedDay,
  previewPreviousStreak,
  onDismiss,
}: StreakDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dismissingRef = useRef(false);
  const mountedRef = useRef(false);
  // A touch before the sequence has finished FAST-FORWARDS it to its final frame
  // (user-decided 2026-08-14): the player who has seen the celebration before should not
  // have to sit through it. The show effect assigns the real skip each run; the handlers
  // only ever call through this ref.
  const skipRef = useRef<() => void>(() => {});
  // THE CLOCK: when the celebration began. One clock for every beat — the raster, the foil,
  // the labels, the star, the hint, dismissal — so a fast-forward is only a later start, and
  // a resize redraws the same moment rather than restarting the show.
  const startRef = useRef<number | null>(null);
  const titleId = useId();
  const [reducedMotion] = useState(prefersReducedMotion);
  const [dismissEnabled, setDismissEnabled] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // THE WORDS the clock moves (`wordsAt`): React renders them where they stand; each frame of
  // the show writes only what moves — opacity, a rise, a jolt, a star's frame — so a re-render
  // never undoes a beat.
  const stageRef = useRef<HTMLDivElement>(null);
  const dayRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const unitRef = useRef<HTMLParagraphElement>(null);
  const hintRef = useRef<HTMLParagraphElement>(null);
  const lockupRef = useRef<HTMLDivElement>(null);
  const editionRef = useRef<HTMLSpanElement>(null);
  const cornerRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const starRef = useRef<HTMLSpanElement>(null);
  const crownStarRef = useRef<HTMLSpanElement>(null);
  const [leaving, setLeaving] = useState(false);

  // The language's solved days, held transiently since #211 (the collection is the server's,
  // loaded by the game screen this dialog mounts inside). It is never null here by
  // construction: `Game` only opens the celebration when `noteSolvedDay` INSERTED this day,
  // which it refuses to do on a collection that has not arrived.
  const solvedDays = useSolvedDays(lang) ?? NO_SOLVED_DAYS;
  const previewDays = useMemo(() => {
    if (previewPreviousStreak == null) return null;
    const previewLength = Math.min(previewPreviousStreak + 1, 7);
    return Array.from({ length: previewLength }, (_, index) => solvedDay - previewLength + index + 1);
  }, [previewPreviousStreak, solvedDay]);
  const displayedDays = previewDays ?? solvedDays;
  // Anchor both values to the game day that was solved. This preserves the correct before
  // value at the 22:00 flip, when the wall-clock active day may already be one day ahead.
  const { previous: previousStreak, next: streak } = useMemo(
    () =>
      previewPreviousStreak == null
        ? streakTransition(solvedDays, solvedDay)
        : { previous: previewPreviousStreak, next: previewPreviousStreak + 1 },
    [previewPreviousStreak, solvedDays, solvedDay],
  );
  const week = useMemo(() => weekView(displayedDays, solvedDay), [displayedDays, solvedDay]);
  const weekdayLabels = useMemo(() => mondayNarrowLabels(lang), [lang]);
  // The week as a PRIMITIVE, so a revalidated collection that changes nothing — or a merge
  // that does — can never hand the show a new identity and restart it mid-celebration.
  const weekKey = week.cells
    .map((cell) => (cell.dayNumber === solvedDay ? 'T' : cell.solved ? 'S' : cell.isFuture ? 'F' : 'M'))
    .join('');
  const days = useMemo<OrbitDay[]>(
    () => Array.from(weekKey, (c) => ({ solved: c === 'S', today: c === 'T', future: c === 'F' })),
    [weekKey],
  );
  const todayIndex = weekKey.indexOf('T');
  const hasComet = todayIndex > 0 && weekKey[todayIndex - 1] === 'S';
  // The run reaches Monday from last week: every day to today is in it, and more.
  const carriesIn = todayIndex >= 0 && streak > todayIndex + 1;
  // A FULL WEEK — today is Sunday and the six days before it are solved: the orbit closes
  // through the crown (the juice scales, the words do not).
  const closes = weekKey === 'SSSSSST';
  const weeks = todayIndex >= 0 ? pastWeeks(streak, todayIndex) : 0;
  const edition = dateForDayNumber(solvedDay);

  // The count's glyphs: the pixel face's own digits (shared `DIGIT_MASKS`).
  const counts = useMemo(
    () => ({ from: numberCells(DIGIT_MASKS, previousStreak), to: numberCells(DIGIT_MASKS, streak) }),
    [previousStreak, streak],
  );

  // Everything the picture and its words are placed by: the layout, the beats, where the DOM
  // words stand (CSS px) — and the cells under those words, which the orbits leave bare.
  const plan = useMemo(() => {
    if (!size) return null;
    const { w, h } = size;
    const L = layout(w, h, Math.max(RESERVE_BITS, counts.from.w, counts.to.w), Math.max(counts.from.w, counts.to.w));
    const tl = timeline(hasComet, closes, todayIndex);
    const cell = L.cell;
    const labels = L.labels;
    const today = todayIndex >= 0 ? L.links[todayIndex] : null;
    const todayBox = today ? { cx: today.x * cell, cy: today.y * cell } : null;
    const unitText = t(lang, 'dayStreak');
    // A tracked mono line's half-width, close enough to keep the orbits off it.
    const halfWidth = (text: string, px: number, tracking: number) => (text.length * (0.6 + tracking) * px) / 2;
    const px = (v: number) => v / cell;
    const rect = (x0: number, y0: number, x1: number, y1: number, margin: number, subject = false): ClearRect => ({
      x0: px(x0),
      y0: px(y0),
      x1: px(x1),
      y1: px(y1),
      margin: px(margin),
      subject,
    });
    const linkHalfW = (LINK_W / 2) * cell;
    const linkHalfH = (LINK_H / 2 + 1) * cell;
    const at = numberPlace(L, counts.to);
    const inset = bracketInset(w, h);
    const arm = BRACKET_ARM;
    const lockupTop = h < 500 ? 22 : inset + 16;
    const lockupLeft = inset + 16;
    const clear: ClearRect[] = [
      // The frame: each corner bracket, and the lockup's row along the top.
      rect(inset, inset, inset + arm, inset + arm, 22),
      rect(w - inset - arm, inset, w - inset, inset + arm, 22),
      rect(inset, h - inset - arm, inset + arm, h - inset, 22),
      rect(w - inset - arm, h - inset - arm, w - inset, h - inset, 22),
      rect(lockupLeft, lockupTop, lockupLeft + 22 + 10 + halfWidth('WHIPPIN AI', 13, 0.14) * 2, lockupTop + 22, 18),
      rect(w - lockupLeft - 84, lockupTop, w - lockupLeft, lockupTop + 22, 18),
      // A bare band across the screen behind the hint — down from the initials when the two
      // stand too close for an orbit to pass between them (a phone on its side).
      rect(0, L.hintY - 10, w, L.hintY + 10, 26),
      ...(L.hintY - labels[0].y < 90 ? [rect(0, labels[0].y, w, L.hintY, 12)] : []),
      // The subject: the count, its unit, the week's days and their initials. The orbits thin
      // out well before the count and the chain, so neither is ever knotted into a trail.
      rect(at.x * cell, at.y * cell, (at.x + counts.to.w * L.k) * cell, L.countCy * cell * 2 - at.y * cell, 20, true),
      ...L.links.map((n) =>
        rect(n.x * cell - linkHalfW, n.y * cell - linkHalfH, n.x * cell + linkHalfW, n.y * cell + linkHalfH, 24, true),
      ),
      rect(w / 2 - halfWidth(unitText, L.unitSize, 0.16) - 6, L.unitY - 10, w / 2 + halfWidth(unitText, L.unitSize, 0.16) + 6, L.unitY + 10, 8),
      ...labels.map(({ x, y }) => rect(x - 10, y - 10, x + 10, y + 10, 8)),
      // The crown's flame and its light.
      rect(
        (L.crown.x - L.crown.w * 2.2) * cell,
        (L.crown.y - L.crown.h * 1.45) * cell,
        (L.crown.x + L.crown.w * 2.2) * cell,
        (L.crown.y + 2) * cell,
        12,
        true,
      ),
    ];
    const scene = orbitScene({ L, days, from: counts.from, to: counts.to, weeks, carriesIn, closes, clear, tl });
    return {
      L,
      tl,
      scene,
      labels,
      todayBox,
      crown: { x: L.crown.x * cell, y: (L.crown.y - L.crown.h * 0.55) * cell },
    };
  }, [size, counts, days, hasComet, carriesIn, closes, weeks, todayIndex, lang]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const dismiss = useCallback(() => {
    if (dismissingRef.current) return;
    dismissingRef.current = true;
    setLeaving(true);
    window.setTimeout(
      () => {
        if (mountedRef.current) onDismiss();
      },
      reducedMotion ? 0 : DISMISS_FADE_MS,
    );
  }, [onDismiss, reducedMotion]);

  // OPEN: the native modal over the solved sentence, measured as it opens and on every resize.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || streak <= 0) {
      onDismiss();
      return undefined;
    }
    dialog.showModal();
    dismissingRef.current = false;
    const measure = () => {
      const w = dialog.clientWidth;
      const h = dialog.clientHeight;
      if (!w || !h) return;
      setSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(dialog);
    return () => {
      ro?.disconnect();
      if (dialog.open) dialog.close();
    };
  }, [streak, onDismiss]);

  // THE SHOW: one clock, stepped frames, every beat read off it.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!plan || !canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      // No canvas to draw on: no show — the screen stands, and the first touch leaves.
      dialogRef.current?.style.setProperty('--screen', '1');
      setDismissEnabled(true);
      return undefined;
    }
    const { L, tl, scene, todayBox } = plan;
    const now = () => performance.now();
    startRef.current ??= reducedMotion ? now() - tl.settled - STILL_AFTER_SETTLED_MS : now();
    const elapsed = () => now() - (startRef.current ?? now());

    canvas.width = L.cols;
    canvas.height = L.rows;
    canvas.style.width = `${L.cols * L.cell}px`;
    canvas.style.height = `${L.rows * L.cell}px`;
    const image = ctx.createImageData(L.cols, L.rows);
    const px = new Uint32Array(image.data.buffer);
    const ink = new Uint8Array(L.cols * L.rows);
    const palette = new Uint32Array([0, ...scene.inks.map(hexToAbgr)]);
    // THE FOIL is painted per cell (`foilInk`): the raster says where it is and where on its
    // link each cell sits.
    const foil: FoilField = { u: new Float32Array(ink.length), phase: new Float32Array(ink.length) };
    const foilCells = new Int32Array(ink.length);
    let foilCount = 0;
    const seed = (solvedDay % 997) + 0.5;
    const paintFoilCells = (t: number) => {
      const seconds = t / 1000;
      for (let j = 0; j < foilCount; j += 1) {
        const i = foilCells[j];
        const x = i % L.cols;
        const y = (i - x) / L.cols;
        px[i] = foilInk(x, y, foil.u[i], foil.phase[i], seconds, seed, ink[i] === FOIL_DEEP);
      }
    };

    let armed = dismissEnabled;
    let shownWords = '';
    const paintWords = (w: WordsFrame) => {
      const key = JSON.stringify(w);
      if (key === shownWords) return;
      shownWords = key;
      dialogRef.current?.style.setProperty('--screen', String(w.screen));
      dayRefs.current.forEach((el, i) => {
        if (!el) return;
        el.style.opacity = String(w.days[i]);
        if (i === todayIndex) el.toggleAttribute('data-lit', w.lit);
      });
      for (const [el, v] of [
        [unitRef.current, w.unit],
        [hintRef.current, w.hint],
      ] as const) {
        if (!el) continue;
        el.style.opacity = String(v.o);
        el.style.translate = `0 ${v.dy}px`;
      }
      for (const el of [lockupRef.current, editionRef.current]) if (el) el.style.opacity = String(w.furniture);
      cornerRefs.current.forEach((el, i) => {
        if (!el) return;
        // Each bracket's way in: toward the subject, from its own corner.
        const ix = i % 2 === 0 ? 1 : -1;
        const iy = i < 2 ? 1 : -1;
        el.style.opacity = String(w.corners.o);
        el.style.translate = `${ix * w.corners.inward}px ${iy * w.corners.inward}px`;
      });
      walkStar(starRef.current, w.star);
      walkStar(crownStarRef.current, w.crownStar);
      if (stageRef.current) stageRef.current.style.translate = `${w.shake[0] * L.cell}px ${w.shake[1] * L.cell}px`;
    };
    let raf = 0;
    let stopped = false;

    const draw = () => {
      const t = elapsed();
      ink.fill(0);
      scene.draw(ink, t, foil);
      foilCount = 0;
      for (let i = 0; i < ink.length; i += 1) {
        const v = ink[i];
        px[i] = palette[v];
        if (v === FOIL || v === FOIL_DEEP) {
          foilCells[foilCount] = i;
          foilCount += 1;
        }
      }
      paintFoilCells(t);
      ctx.putImageData(image, 0, 0);

      paintWords(wordsAt(t, tl));

      if (!armed && t >= tl.hint + HINT_IN_MS) {
        armed = true;
        setDismissEnabled(true);
      }
      return t;
    };

    const tick = () => {
      raf = 0;
      if (stopped || document.hidden) return;
      draw();
      raf = window.requestAnimationFrame(tick);
    };
    const wake = () => {
      if (!stopped && !reducedMotion && !document.hidden && !raf) tick();
    };

    // FAST-FORWARD: the clock jumps to the settled frame, which IS the resting picture; the
    // next touch is the tap-anywhere the hint advertises.
    skipRef.current = () => {
      if (dismissingRef.current) return;
      if (elapsed() < tl.settled) startRef.current = now() - tl.settled;
      armed = true;
      setDismissEnabled(true);
      draw();
    };

    if (reducedMotion) {
      draw();
      armed = true;
      setDismissEnabled(true);
    } else {
      tick();
      document.addEventListener('visibilitychange', wake);
    }
    // A backgrounded tab steps no frames; the hint's moment still arms dismissal on time.
    const armTimer = window.setTimeout(
      () => {
        if (!armed && !stopped) {
          armed = true;
          setDismissEnabled(true);
        }
      },
      Math.max(0, tl.hint + HINT_IN_MS - elapsed()),
    );

    return () => {
      stopped = true;
      skipRef.current = () => {};
      window.cancelAnimationFrame(raf);
      window.clearTimeout(armTimer);
      document.removeEventListener('visibilitychange', wake);
    };
    // `dismissEnabled` is read once as the starting state of a re-planned show (a resize
    // after the hint must not disarm it); it must not restart the show by changing.
  }, [plan, reducedMotion, solvedDay, todayIndex]);

  const className = [
    'streak-dialog',
    dismissEnabled && 'done',
    leaving && 'is-leaving',
  ]
    .filter(Boolean)
    .join(' ');

  const stage = plan;
  return (
    <dialog
      ref={dialogRef}
      className={className}
      aria-labelledby={titleId}
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissEnabled) dismiss();
        else skipRef.current();
      }}
      onKeyDown={(event) => {
        // The modal has nothing focusable, so swallow Tab entirely — it can neither move
        // focus into the inert game behind nor onto a hint that would show a ring. Once the
        // ending hint is fully visible, any OTHER key dismisses (the arcade "press any key"
        // idiom, the keyboard twin of tap-anywhere); BEFORE that, the same key FAST-FORWARDS
        // the sequence to its final frame instead (user-decided 2026-08-14). Escape is
        // handled by onCancel and follows the same two-step.
        if (event.key === 'Tab') {
          event.preventDefault();
          return;
        }
        if (event.key === 'Escape') return;
        if (dismissEnabled) dismiss();
        else skipRef.current();
      }}
      onClick={() => {
        // Once the ending hint is fully visible, the WHOLE screen is the dismiss target (the
        // hint says "anywhere" and must not lie). Before that, the same touch fast-forwards
        // the celebration to its final frame.
        if (dismissEnabled) dismiss();
        else skipRef.current();
      }}
    >
      <h2 id={titleId} className="sr-only">
        {streak} {t(lang, 'dayStreak')}
      </h2>

      <div ref={stageRef} className="streak-stage" aria-hidden="true">
        <canvas ref={canvasRef} className="streak-orbit" />
        {stage?.todayBox && (
          <span
            ref={starRef}
            className="streak-star"
            style={{ left: stage.todayBox.cx, top: stage.todayBox.cy, '--star-scale': stage.L.starScale } as CSSProperties}
          />
        )}
        {stage?.tl.close != null && (
          <span
            ref={crownStarRef}
            className="streak-star crown"
            style={{ left: stage.crown.x, top: stage.crown.y, '--star-scale': stage.L.starScale } as CSSProperties}
          />
        )}
        {/* The week's initials under their days; today's in the white title chip. */}
        {stage?.labels.map((at, index) => (
          <span
            key={index}
            ref={(el) => {
              dayRefs.current[index] = el;
            }}
            className={index === todayIndex ? 'streak-day today' : 'streak-day'}
            style={{ left: at.x, top: at.y }}
          >
            {weekdayLabels[index]}
          </span>
        ))}
        {stage && (
          <>
            <p ref={unitRef} className="streak-unit" style={{ top: stage.L.unitY, fontSize: stage.L.unitSize }}>
              {t(lang, 'dayStreak')}
            </p>
            {/* NOT a button: the celebration has NOTHING focusable, so no focus ring appears
                and a stray Tab has nowhere to land. Dismissal is the whole screen — click/tap
                anywhere (bubbles to the dialog's onClick), any key, or Escape — once its
                entrance finishes; see the dialog handlers. */}
            <p ref={hintRef} className="streak-hint" style={{ top: stage.L.hintY }}>
              {t(lang, coarsePointer() ? 'tapAnywhere' : 'clickAnywhere')}
            </p>
          </>
        )}
        {/* The frame's furniture, as on the cards: the lockup and the day's edition. */}
        <Lockup ref={lockupRef} className="streak-lockup" />
        <span ref={editionRef} className="streak-edition">
          {edition}
        </span>
        {(['tl', 'tr', 'bl', 'br'] as const).map((corner, i) => (
          <span
            key={corner}
            ref={(el) => {
              cornerRefs.current[i] = el;
            }}
            className={`streak-corner ${corner}`}
          />
        ))}
      </div>
    </dialog>
  );
}

// A star sheet's frame `f` (hidden outside its walk).
function walkStar(el: HTMLElement | null, f: number) {
  if (!el) return;
  const on = f >= 0 && f < STAR_FRAMES;
  el.style.visibility = on ? 'visible' : 'hidden';
  if (on) el.style.backgroundPositionX = `${(f * 100) / (STAR_FRAMES - 1)}%`;
}
