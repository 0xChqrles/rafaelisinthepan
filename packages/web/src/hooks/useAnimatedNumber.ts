import { useEffect, useRef, useState } from 'react';

// Tween a number toward `target` (ease-out cubic) over `duration` ms.
// Returns the current value, recomputed every frame while it is moving.
// If the target changes mid-flight, smoothly restart from the displayed value.
export default function useAnimatedNumber(target: number, duration = 500) {
  const [value, setValue] = useState<number>(target);
  const currentRef = useRef<number>(target);

  useEffect(() => {
    const from = currentRef.current;
    const to = target;
    if (from === to) return undefined;

    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3; // easeOutCubic
      const next = from + (to - from) * eased;
      currentRef.current = next;
      setValue(next);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return value;
}
