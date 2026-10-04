// A TRAVEL from one box to the next in the house's motion — whole pixels and HARD STEPS, eased
// out — for the boards' controls (the tab row's chip, the period switch's brackets): `steps`
// frames, each `frameAt(e)` for the share `e` (0–1) of the way made, held until the next.
// `frameAt` rounds its own lengths to whole pixels.
export function travelFrames(steps: number, frameAt: (e: number) => Keyframe): Keyframe[] {
  const frames: Keyframe[] = [];
  for (let k = 0; k <= steps; k += 1) {
    const t = k / steps;
    frames.push({ ...frameAt(1 - (1 - t) * (1 - t)), offset: t, easing: 'steps(1, end)' });
  }
  return frames;
}
