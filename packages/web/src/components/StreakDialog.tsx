import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ComponentPropsWithRef, ComponentType } from 'react';
import { animated, to, useReducedMotion, useSpring, useSprings } from '@react-spring/web';
import { useGameStore } from '../state/gameStore';
import { streakTransition, weekView } from '../game/streak';
import { streakDigitDelays, streakDigitSlots } from '../game/streakDigits';
import { t } from '../i18n';

const NO_SOLVED_DAYS: number[] = [];

const FADE_MS = 200;
const DISMISS_FADE_MS = 200;
const PREVIOUS_HOLD_MS = 500;
const DIGIT_STAGGER_MS = 90;
const OLD_DIGIT_SPRING = { mass: 1, tension: 150, friction: 26 };
// The incoming digit must not overshoot THROUGH the baseline the way a raw spring does:
// falling from above, a spring settles by first dipping BELOW its rest point (reads as
// sinking through the floor). Instead it lands and takes ONE small hop, like a tile
// dropped on a surface — drop (accelerating) → a short rebound above the line → settle
// back onto it — scripted as three fixed phases so it's a single controlled bounce, not
// a residual oscillation.
const DIGIT_DROP_MS = 170; // fall from above onto the baseline (ease-in, gravity-like)
const DIGIT_HOP_MS = 90; // baseline → the small rebound peak (ease-out)
const DIGIT_SETTLE_MS = 120; // rebound peak → rest back on the baseline
// Rebound height, in em of the digit. Small AND within the slot's glyph headroom (the
// pixel glyph sits well inside its 1em box), so the hop is never clipped by the odometer
// slot's `overflow: hidden`.
const DIGIT_BOUNCE_EM = 0.1;
const easeInQuad = (t: number) => t * t;
const easeOutQuad = (t: number) => 1 - (1 - t) * (1 - t);
const APPEAR_SPRING = { mass: 0.7, tension: 280, friction: 18 };
// The tile animates TWO decoupled values — `flip` (rotation) and `lift` (height) — so it
// can complete its half-turn WHILE airborne: phase 1 rises and fully flips it, a short
// hang holds it above the screen on its completed face, then phase 2 drops it straight
// down and slams it through the plane, launching the wave. The rise and the fall also
// need opposite spring characters: one spring can't be slow going up AND land hard.
const DAY_RISE_SPRING = { mass: 1, tension: 150, friction: 20 }; // brisk decelerating rise
const DAY_RISE_MS = 300; // rise + full rotation (a fixed beat, not the spring's settle tail)
const DAY_HANG_MS = 150; // the airborne pause on the completed face before the drop
const DAY_SLAM_SPRING = { mass: 1, tension: 210, friction: 13 }; // ~20% undershoot: hard landing
// The eye sees contact slightly before the height reaches 0 (the last px are sub-visual).
// Fire the wave at this descending height so its beat zero is the visual contact; the
// latch makes it fire once even as the undershoot keeps values below the threshold.
const DAY_CONTACT_LIFT = 0.06;
const DAY_WAVE_STAGGER_MS = 65;
const DAY_PREP_SPRING = { mass: 0.6, tension: 340, friction: 26 };
const DAY_BOUNCE_SPRING = { mass: 0.75, tension: 300, friction: 11 };

// A tile catches light as it nears the player: its fill brightens toward this tint at its
// closest point and fades back on the way down. The wave tiles rise far less than the
// flipped tile (a scale pop, no Z-lift), so their glow is capped well below full.
const FLAME_GLOW_COLOR = '#8fa0ff';
const WAVE_POP_SCALE = 1.2; // the pop peak — maps to the wave's brightest moment
const WAVE_GLOW_MAX = 0.45; // waved tiles never approach the flip's brightness

// Mix FROM --flame (not a hardcoded base) toward the bright tint by `t` in [0,1], so the
// glow stays correct if the flame color is ever swapped per milestone tier while still
// landing on the exact target at t = 1.
function flameGlow(t: number): string {
  const pct = Math.max(0, Math.min(1, t)) * 100;
  return `color-mix(in srgb, var(--flame), ${FLAME_GLOW_COLOR} ${pct}%)`;
}

// React Spring v9 targets the React 18 runtime used here, while this repo intentionally
// carries the newer React 19 type packages. Their intrinsic-element definitions disagree,
// so contain that interop mismatch here while retaining each element's normal DOM props.
type AnimatedIntrinsicProps<Tag extends keyof React.JSX.IntrinsicElements> = Omit<
  ComponentPropsWithRef<Tag>,
  'style'
> & { style?: Record<string, unknown> };
const AnimatedDialog = animated.dialog as unknown as ComponentType<
  AnimatedIntrinsicProps<'dialog'>
>;
const AnimatedDiv = animated.div as unknown as ComponentType<AnimatedIntrinsicProps<'div'>>;
const AnimatedSpan = animated.span as unknown as ComponentType<AnimatedIntrinsicProps<'span'>>;

// A fresh daily solve changes player-level progression, so that moment gets a full-screen
// temporal sequence instead of competing with the sentence result. Game controls when this
// mounts: active-day transition only, never archive, tutorial, override, or rehydration.
export default function StreakDialog({
  lang,
  solvedDay,
  previewPreviousStreak,
  onDismiss,
}: {
  lang: string;
  solvedDay: number;
  previewPreviousStreak?: number;
  onDismiss: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dismissingRef = useRef(false);
  const mountedRef = useRef(false);
  const titleId = useId();
  const reducedMotion = useReducedMotion();

  const solvedDays = useGameStore((state) => state.solvedDays[lang] ?? NO_SOLVED_DAYS);
  const previewDays = useMemo(() => {
    if (previewPreviousStreak == null) return null;
    const previewLength = Math.min(previewPreviousStreak + 1, 7);
    return Array.from({ length: previewLength }, (_, index) =>
      solvedDay - previewLength + index + 1,
    );
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
  const slots = useMemo(
    () => streakDigitSlots(previousStreak, streak),
    [previousStreak, streak],
  );
  const digitDelays = useMemo(
    () => streakDigitDelays(slots, DIGIT_STAGGER_MS),
    [slots],
  );
  const completedWaveIndices = useMemo(() => {
    const solvedIndex = week.cells.findIndex((cell) => cell.dayNumber === solvedDay);
    return week.cells
      .map((cell, index) => ({ cell, index }))
      .filter(({ cell }) => cell.solved && cell.dayNumber !== solvedDay)
      .sort(
        (a, b) =>
          Math.abs(a.index - solvedIndex) - Math.abs(b.index - solvedIndex),
      )
      .map(({ index }) => index);
  }, [solvedDay, week.cells]);
  const previousLayerOffset = -(slots.length - String(previousStreak).length) / 2;

  const [numberFinal, setNumberFinal] = useState(false);
  const [flameShown, setFlameShown] = useState(false);
  const [dayComplete, setDayComplete] = useState(false);
  const [hintMounted, setHintMounted] = useState(false);
  const [dismissEnabled, setDismissEnabled] = useState(false);

  const [screenSpring, screenApi] = useSpring(() => ({ opacity: 0 }));
  const [numberSpring, numberApi] = useSpring(() => ({ opacity: 0 }));
  const [flameSpring, flameApi] = useSpring(() => ({ opacity: 0, y: 14, scale: 0.78 }));
  const [weekSpring, weekApi] = useSpring(() => ({ opacity: 0, y: 10 }));
  const [dayFlipSpring, dayFlipApi] = useSpring(() => ({ lift: 0, flip: 0 }));
  const [dayWaveSprings, dayWaveApi] = useSprings(
    week.cells.length,
    () => ({ scale: 1 }),
    [week.cells.length],
  );
  const [hintSpring, hintApi] = useSpring(() => ({ opacity: 0, y: 10, scale: 0.96 }));
  const [oldDigitSprings, oldDigitApi] = useSprings(
    slots.length,
    () => ({ opacity: 1, y: 0, immediate: true }),
    [slots.length],
  );
  const [newDigitSprings, newDigitApi] = useSprings(
    slots.length,
    (index) => ({
      opacity: slots[index].changed ? 0 : 1,
      y: slots[index].changed ? -1.05 : 0,
      immediate: true,
    }),
    [slots],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const dismiss = useCallback(() => {
    if (dismissingRef.current) return;
    dismissingRef.current = true;
    void (async () => {
      await Promise.all(
        screenApi.start({
          opacity: 0,
          immediate: Boolean(reducedMotion),
          config: { duration: DISMISS_FADE_MS },
        }),
      );
      if (mountedRef.current) onDismiss();
    })();
  }, [onDismiss, reducedMotion, screenApi]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || streak <= 0) {
      onDismiss();
      return undefined;
    }

    let cancelled = false;
    const waitIds = new Set<number>();
    const resolveWaits = new Set<() => void>();
    const immediate = Boolean(reducedMotion);
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        let id = 0;
        const finish = () => {
          waitIds.delete(id);
          resolveWaits.delete(finish);
          resolve();
        };
        resolveWaits.add(finish);
        id = window.setTimeout(finish, immediate ? 0 : ms);
        waitIds.add(id);
      });
    const stopped = () => cancelled;

    // StrictMode replays effects in development, so reset every controller before opening.
    setNumberFinal(false);
    setFlameShown(false);
    setDayComplete(false);
    setHintMounted(false);
    setDismissEnabled(false);
    screenApi.set({ opacity: 0 });
    numberApi.set({ opacity: 0 });
    flameApi.set({ opacity: 0, y: 14, scale: 0.78 });
    weekApi.set({ opacity: 0, y: 10 });
    dayFlipApi.set({ lift: 0, flip: 0 });
    dayWaveApi.set(() => ({ scale: 1 }));
    hintApi.set({ opacity: 0, y: 10, scale: 0.96 });
    oldDigitApi.set(() => ({ opacity: 1, y: 0 }));
    newDigitApi.set((index) => ({
      opacity: slots[index].changed ? 0 : 1,
      y: slots[index].changed ? -1.05 : 0,
    }));

    dialog.showModal();
    dismissingRef.current = false;

    void (async () => {
      // 1. The full-screen surface fades over the solved sentence with no visible content.
      await Promise.all(
        screenApi.start({ opacity: 1, immediate, config: { duration: FADE_MS } }),
      );
      if (stopped()) return;

      // 2. Reveal and hold the previous streak in the secondary color.
      await Promise.all(
        numberApi.start({ opacity: 1, immediate, config: { duration: FADE_MS } }),
      );
      if (stopped()) return;
      await wait(PREVIOUS_HOLD_MS);
      if (stopped()) return;

      // 3. Roll changed slots from right to left like an odometer carry. Each changed digit
      // gets its own delayed spring; unchanged slots receive no update and remain still.
      await Promise.all([
        ...oldDigitApi.start((index) =>
          slots[index].changed
            ? {
                opacity: 0,
                y: 1.05,
                delay: immediate ? 0 : digitDelays[index],
                immediate,
                config: OLD_DIGIT_SPRING,
              }
            : null,
        ),
        ...newDigitApi.start((index) => {
          if (!slots[index].changed) return null;
          if (immediate) return { opacity: 1, y: 0, immediate: true };
          // Drop onto the baseline, then a single small rebound. The delay (the odometer
          // carry stagger) rides the first phase, so the bounces cascade right-to-left.
          return {
            to: async (next: (props: Record<string, unknown>) => Promise<unknown>) => {
              await next({
                opacity: 1,
                y: 0,
                delay: digitDelays[index],
                config: { duration: DIGIT_DROP_MS, easing: easeInQuad },
              });
              if (stopped()) return;
              await next({ y: -DIGIT_BOUNCE_EM, config: { duration: DIGIT_HOP_MS, easing: easeOutQuad } });
              if (stopped()) return;
              await next({ y: 0, config: { duration: DIGIT_SETTLE_MS, easing: easeOutQuad } });
            },
          };
        }),
      ]);
      if (stopped()) return;
      setNumberFinal(true);
      await wait(20); // commit the whole-number foreground color before the next beat
      if (stopped()) return;

      // 4. Bring the existing animated sprite in above the now-final number — and, on the
      // same beat, drop the flame-indigo shadow off the digits (the flame's cast light).
      setFlameShown(true);
      await Promise.all(
        flameApi.start({
          opacity: 1,
          y: 0,
          scale: 1,
          immediate,
          config: APPEAR_SPRING,
        }),
      );
      if (stopped()) return;

      // 5. Reveal the week with this solve deliberately still unfilled.
      await Promise.all(
        weekApi.start({ opacity: 1, y: 0, immediate, config: APPEAR_SPRING }),
      );
      if (stopped()) return;

      // 6. Turn today's neutral tile over: rise + full half-turn in the air, a hang on the
      // completed face, then a straight vertical slam back onto the plane (see constants).
      if (immediate) {
        dayFlipApi.set({ lift: 0, flip: 1 });
        dayWaveApi.set(() => ({ scale: 1 }));
        setDayComplete(true);
      } else {
        // Phase 1 — the tile lifts off and completes its rotation while airborne, then
        // hangs above the screen on its completed face. Fixed beats (not the springs'
        // imperceptible settle tails) keep the rise and the pause deterministic.
        dayFlipApi.start({ lift: 1, flip: 1, config: DAY_RISE_SPRING });
        await wait(DAY_RISE_MS);
        if (stopped()) return;
        await wait(DAY_HANG_MS);
        if (stopped()) return;

        // Phase 2 — the slam. The wave must read as CAUSED by the tile hitting the plane,
        // so it launches off the fall's own trajectory (the first frame at/below the
        // contact height), not on a fixed clock that would drift from the physics.
        // Racing the fall's settle promise guarantees no hang if the spring is stopped.
        let impactSignalled = false;
        let signalImpact = () => {};
        const impact = new Promise<void>((resolve) => {
          signalImpact = resolve;
        });
        const flip = Promise.all(
          dayFlipApi.start({
            lift: 0,
            config: DAY_SLAM_SPRING,
            onChange: (result: unknown) => {
              const lift = (result as { value?: { lift?: number } }).value?.lift;
              if (!impactSignalled && lift != null && lift <= DAY_CONTACT_LIFT) {
                impactSignalled = true;
                signalImpact();
              }
            },
          }),
        );

        // First contact launches the old completion pulse across the other completed
        // days, on ONE rhythm: each tile's squish starts an interval before its pop, and
        // the pops land DAY_WAVE_STAGGER_MS apart — so the impact -> first-pop gap EQUALS
        // the tile -> tile gap (the nearest tile squishes on the impact frame itself).
        // The squish is deliberately not awaited to spring rest: its imperceptible settle
        // tail read as the wave stalling after the landing.
        await Promise.race([impact, flip]);
        if (stopped()) return;
        setDayComplete(true);
        const wave = Promise.all(
          completedWaveIndices.map(async (cellIndex, order) => {
            await wait(order * DAY_WAVE_STAGGER_MS);
            if (stopped()) return;
            dayWaveApi.start((index) =>
              index === cellIndex ? { scale: 0.9, config: DAY_PREP_SPRING } : null,
            );
            await wait(DAY_WAVE_STAGGER_MS);
            if (stopped()) return;
            await Promise.all(
              dayWaveApi.start((index) =>
                index === cellIndex
                  ? { scale: 1, from: { scale: 1.2 }, config: DAY_BOUNCE_SPRING }
                  : null,
              ),
            );
          }),
        );
        await Promise.all([flip, wave]);
        if (stopped()) return;
        dayWaveApi.set(() => ({ scale: 1 }));
      }

      // 7. The final beat: the ending hint ("tap/click anywhere" — pure what-to-do; the
      // game is done, so there is nothing to name as a why). Nothing here is focusable;
      // dismissal arms only after its entrance has fully landed (click/tap/any key — see
      // the dialog), so the instruction is visible before it can be acted on.
      setHintMounted(true);
      await wait(20);
      if (stopped()) return;
      await Promise.all(
        hintApi.start({
          opacity: 1,
          y: 0,
          scale: 1,
          immediate,
          config: APPEAR_SPRING,
        }),
      );
      if (stopped()) return;
      setDismissEnabled(true);
    })();

    return () => {
      cancelled = true;
      waitIds.forEach((id) => window.clearTimeout(id));
      resolveWaits.forEach((resolve) => resolve());
      screenApi.stop();
      numberApi.stop();
      flameApi.stop();
      weekApi.stop();
      dayFlipApi.stop();
      dayWaveApi.stop();
      hintApi.stop();
      oldDigitApi.stop();
      newDigitApi.stop();
      if (dialog.open) dialog.close();
    };
  }, [
    completedWaveIndices,
    hintApi,
    dayFlipApi,
    dayWaveApi,
    digitDelays,
    flameApi,
    newDigitApi,
    numberApi,
    oldDigitApi,
    onDismiss,
    reducedMotion,
    screenApi,
    slots,
    streak,
    weekApi,
  ]);

  return (
    <AnimatedDialog
      ref={dialogRef}
      className={`streak-dialog${dismissEnabled ? ' done' : ''}`}
      style={{ opacity: screenSpring.opacity }}
      aria-labelledby={titleId}
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissEnabled) dismiss();
      }}
      onKeyDown={(event) => {
        // The modal has nothing focusable, so swallow Tab entirely — it can neither move
        // focus into the inert game behind nor onto a hint that would show a ring. Once the
        // ending hint is fully visible, any OTHER key dismisses (the arcade "press any
        // key" idiom, the keyboard twin of tap-anywhere); before that, every dismissal
        // input is ignored so the sequence and the hint entrance can finish. Escape is
        // handled by onCancel and follows the same gate.
        if (event.key === 'Tab') {
          event.preventDefault();
          return;
        }
        if (dismissEnabled && event.key !== 'Escape') dismiss();
      }}
      onClick={(event) => {
        // Once the ending hint is fully visible, the WHOLE screen is the dismiss target
        // (the hint says "anywhere" and must not lie). Before that, no click dismisses.
        if (dismissEnabled) dismiss();
      }}
    >
      <h2 id={titleId} className="sr-only">
        {streak} {t(lang, 'dayStreak')}
      </h2>

      <div
        className="streak-sequence"
        onClick={(event) => {
          if (!dismissEnabled) event.stopPropagation();
        }}
      >
        <div className="streak-flame-slot" aria-hidden="true">
          <AnimatedSpan
            className="streak-flame"
            style={{
              opacity: flameSpring.opacity,
              transform: to(
                [flameSpring.y, flameSpring.scale],
                (y, scale) => `translateY(${y}px) scale(${scale})`,
              ),
            }}
          />
        </div>

        <AnimatedDiv
          className={`streak-number-block${numberFinal ? ' final' : ''}${flameShown ? ' flamed' : ''}`}
          style={{ opacity: numberSpring.opacity }}
          aria-hidden="true"
        >
          <div className="streak-digits" style={{ width: `${slots.length}em` }}>
            <div
              className="streak-digit-layer streak-digit-old-layer"
              style={{ transform: `translateX(${previousLayerOffset}em)` }}
            >
              {slots.map((slot, index) => (
                <span
                  className="streak-digit-slot"
                  key={`old-${index}-${slot.from}-${slot.to}`}
                >
                  <AnimatedSpan
                    className="streak-digit streak-digit-old"
                    style={{
                      opacity: oldDigitSprings[index].opacity,
                      transform: oldDigitSprings[index].y.to((y) => `translateY(${y}em)`),
                    }}
                  >
                    {slot.from === ' ' ? '\u00a0' : slot.from}
                  </AnimatedSpan>
                </span>
              ))}
            </div>
            <div className="streak-digit-layer streak-digit-new-layer">
              {slots.map((slot, index) => (
                <span
                  className="streak-digit-slot"
                  key={`new-${index}-${slot.from}-${slot.to}`}
                >
                  {slot.changed && (
                    <AnimatedSpan
                      className="streak-digit streak-digit-new"
                      style={{
                        opacity: newDigitSprings[index].opacity,
                        transform: newDigitSprings[index].y.to((y) => `translateY(${y}em)`),
                      }}
                    >
                      {slot.to}
                    </AnimatedSpan>
                  )}
                </span>
              ))}
            </div>
          </div>
          <p className="streak-label">{t(lang, 'dayStreak')}</p>
        </AnimatedDiv>

        <AnimatedDiv
          className="week-row"
          aria-hidden="true"
          style={{
            opacity: weekSpring.opacity,
            transform: weekSpring.y.to((y) => `translateY(${y}px)`),
          }}
        >
          {week.cells.map((cell, index) => {
            const isSolved = cell.dayNumber === solvedDay ? dayComplete : cell.solved;
            const className =
              'week-cell' + (isSolved ? ' solved' : '') + (cell.isToday ? ' today' : '');
            return (
              <div key={cell.dayNumber} className={className}>
                <span className="week-label">{weekdayLabels[index]}</span>
                {cell.dayNumber === solvedDay ? (
                  <AnimatedSpan
                    className="week-mark week-mark-flip"
                    style={{
                      transform: to([dayFlipSpring.lift, dayFlipSpring.flip], (lift, flip) => {
                        const z = 48 * lift;
                        const rotation = 180 * flip;
                        // Deliberately theatrical (~1.7x visually with the Z lift at the
                        // hang): the tile must clearly leave the screen. The slam's
                        // negative-lift undershoot then squashes it below 1 and behind the
                        // plane, selling the impact that launches the wave.
                        const scale = 1 + 0.5 * lift;
                        return `perspective(420px) translateZ(${z}px) rotateX(${rotation}deg) scale(${scale})`;
                      }),
                    }}
                  >
                    <span className="week-mark-face week-mark-front" />
                    <AnimatedSpan
                      className="week-mark-face week-mark-back"
                      // Brightens with height: full glow at the apex/hang (lift = 1), back
                      // to resting flame as it slams down (the undershoot clamps at base).
                      style={{ backgroundColor: dayFlipSpring.lift.to(flameGlow) }}
                    />
                  </AnimatedSpan>
                ) : (
                  <AnimatedSpan
                    className="week-mark"
                    style={{
                      transform: dayWaveSprings[index].scale.to((scale) => `scale(${scale})`),
                      // A solved day glows with its pop like the flip tile glows with its
                      // rise, but capped far lower — the scale pop rises much less than the
                      // lifted flip. Unsolved/future days get no inline fill, so their
                      // neutral surface shows through.
                      backgroundColor: cell.solved
                        ? dayWaveSprings[index].scale.to((scale) =>
                            flameGlow(((scale - 1) / (WAVE_POP_SCALE - 1)) * WAVE_GLOW_MAX),
                          )
                        : undefined,
                    }}
                  />
                )}
              </div>
            );
          })}
        </AnimatedDiv>

        <div className="streak-hint-slot" aria-hidden="true">
          {hintMounted && (
            // NOT a button: the celebration has NOTHING focusable, so no focus ring appears
            // and a stray Tab has nowhere to land (the modal traps focus, so it can't reach
            // the game behind). Dismissal is the whole screen — click/tap anywhere (bubbles
            // to the dialog's onClick), any key, or Escape — once its entrance finishes;
            // see the dialog handlers.
            <AnimatedDiv
              className="streak-hint"
              style={{
                opacity: hintSpring.opacity,
                transform: to(
                  [hintSpring.y, hintSpring.scale],
                  (y, scale) => `translateY(${y}px) scale(${scale})`,
                ),
              }}
            >
              {/* The pulse lives on a child: the wrapper's own opacity belongs to the
                  entrance spring, and a CSS animation on the same element would win
                  the cascade over that inline style. */}
              <span className="streak-hint-pulse">
                {t(lang, coarsePointer() ? 'tapAnywhere' : 'clickAnywhere')}
              </span>
            </AnimatedDiv>
          )}
        </div>
      </div>
    </AnimatedDialog>
  );
}

// Touch devices TAP, pointer devices CLICK — same device gate as the share button's
// native-sheet detection (coarse pointer, not API presence).
function coarsePointer(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  );
}

// Monday-first narrow weekday initials, localized for the puzzle language.
function mondayNarrowLabels(lang: string): string[] {
  const fmt = new Intl.DateTimeFormat(lang, { weekday: 'narrow', timeZone: 'UTC' });
  return Array.from({ length: 7 }, (_, index) =>
    fmt.format(new Date(Date.UTC(2024, 0, 1 + index))),
  );
}
