import { useEffect, useRef, useState } from 'react';

type Duration = number | ((from: number, to: number) => number);
type Easing = (progress: number) => number;

export const easeOutCubic: Easing = (progress) => 1 - (1 - progress) ** 3;
export const linearEasing: Easing = (progress) => progress;

// Tween a number toward `target` (ease-out cubic by default) over `duration` ms.
// Returns the current value, recomputed every frame while it is moving.
// If the target changes mid-flight, smoothly restart from the displayed value.
// A duration function can scale the tween from the actual displayed value to the target.
// An easing function can make a caller's displayed steps linear when needed.
export default function useAnimatedNumber(
  target: number,
  duration: Duration = 500,
  easing: Easing = easeOutCubic,
) {
  const [value, setValue] = useState<number>(target);
  const currentRef = useRef<number>(target);

  useEffect(() => {
    const from = currentRef.current;
    const to = target;
    if (from === to) return undefined;

    const durationMs = typeof duration === 'function' ? duration(from, to) : duration;
    if (durationMs <= 0) {
      currentRef.current = to;
      setValue(to);
      return undefined;
    }

    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = easing(t);
      const next = t >= 1 ? to : from + (to - from) * eased;
      currentRef.current = next;
      setValue(next);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, easing]);

  return value;
}
