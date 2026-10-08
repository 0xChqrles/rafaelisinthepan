// THE PROMPT'S REFUSAL: a line the player types on — the guess prompt, the group name, the
// address, the profile name — answers what it cannot take by shaking in the danger ink, for
// the shake's length and not a frame longer. The ink is PART OF the animation, never a class
// taken off at `animationend`: a refusal landing in the frame the last shake ended put that
// class back before the browser saw it go, no shake was left to end, and the line stayed red.
// Each call plays the shake afresh over one still playing. `ink` is the element the text's
// colour is set on, when that is not the line itself (the address's real input).
const SHAKE_X = [0, -6, 6, -4, 4, 0];
const SHAKE_MS = 400;

export function promptShake(line: HTMLElement | null, ink: HTMLElement | null = line): void {
  if (!line || !ink || typeof line.animate !== 'function') return;
  const danger = getComputedStyle(ink).getPropertyValue('--danger').trim();
  line.animate(
    SHAKE_X.map((x) => ({ transform: `translateX(${x}px)`, easing: 'ease-in-out' })),
    { duration: SHAKE_MS },
  );
  ink.animate([{ color: danger }, { color: danger }], { duration: SHAKE_MS });
}
