// THE FIGURES' MOTION IS THE HOUSE'S: HARD STEPS, never a glide. A change runs `steps` frames
// over `ms`, each held until the next, its share of the way eased out the way the boards'
// controls travel (`components/travel.ts`): fast, then settling — whole steps either way.
export function easedStep(k: number, steps: number): number {
  const t = k / steps;
  return 1 - (1 - t) * (1 - t);
}

// Calls `frame(k)` for k = 1 … steps, `ms / steps` apart, and returns the cancel.
export function runSteps(steps: number, ms: number, frame: (k: number) => void, delayMs = 0): () => void {
  const timers: number[] = [];
  for (let k = 1; k <= steps; k += 1) {
    timers.push(window.setTimeout(() => frame(k), delayMs + (k * ms) / steps));
  }
  return () => timers.forEach((id) => window.clearTimeout(id));
}
