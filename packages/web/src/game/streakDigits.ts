export interface StreakDigitSlot {
  from: string;
  to: string;
  changed: boolean;
}

// Right-align the before/after values into stable wheel slots. A rollover may add a leading
// slot (9 -> 10); the empty previous character still reserves that slot while the new digit
// rolls in from above. Unchanged slots are explicitly marked so the UI never moves them.
export function streakDigitSlots(previous: number, next: number): StreakDigitSlot[] {
  const from = String(previous);
  const to = String(next);
  const width = Math.max(from.length, to.length);
  const paddedFrom = from.padStart(width, ' ');
  const paddedTo = to.padStart(width, ' ');

  return Array.from({ length: width }, (_, index) => ({
    from: paddedFrom[index],
    to: paddedTo[index],
    changed: paddedFrom[index] !== paddedTo[index],
  }));
}

// An odometer carry starts at the least-significant changed digit, then travels left.
// Starting at one interval (rather than zero) gives even a single changed digit a beat
// after the previous value's hold.
export function streakDigitDelays(
  slots: readonly StreakDigitSlot[],
  staggerMs: number,
): number[] {
  const delays = Array<number>(slots.length).fill(0);
  let changedOrder = 1;

  for (let index = slots.length - 1; index >= 0; index -= 1) {
    if (!slots[index].changed) continue;
    delays[index] = changedOrder * staggerMs;
    changedOrder += 1;
  }

  return delays;
}
