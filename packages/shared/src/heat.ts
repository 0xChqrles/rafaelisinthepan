// The app's ONE gradient — WEIRD → CALM (user-decided 2026-08-17, superseding the FLIR
// iron-bow thermal ramp and the crimson→cyan stops before it): solving the sentence is
// RESTORING PEACE to a weird sentence, so the scale runs from uncanny to calm — starting
// at RED (maximally weird, and MISS — user-decided 2026-08-17, extending the scale one
// step beyond the yellow to bring the red MISS back), through amber, salmon and a
// strange rose-orchid, settling into the cobalt ink (peace, the solve). STAMP-INK saturations (retuned same day against the user's
// /inspiration set — vintage offset stamps, riso posters): real printed-ink chroma, not
// arcade neon and not the dusty first cut ("almost creepy") — the calm comes from the
// grain and the print softness, never from draining the colour. It colours the rank exponents, the floating hits, a claim's loot, every
// route row — and every progress surface (the run ruler on screen AND on the share card,
// the share text's emoji row, the archive's day fills, the chooser's status strips), a
// progress % reading STRAIGHT as the scale.
//
// (The iron bow lived for one day: its polynomial, the [130,380] window and the cold
// blue extension are all gone with the metaphor — temperature is no longer what the
// gradient says. What SURVIVED it is structural: ONE ramp for everything, the gradient
// terminating exactly ON the MISS colour, and the 100-exponent cap.)
//
// heat in [0,1]: 0 = weird (far — the MISS terminus), 1 = calm (near the goal / solved).

// Each stop carries its own plain-text stand-in (see `progressEmoji` at the bottom).
// Unicode has no grey square that reads neutral, so ⬜ carries the drained middle.
const CALM_STOPS: { v: number; color: [number, number, number] }[] = [
  { v: 0, color: [255, 61, 46] }, // #ff3d2e red — the WEIRD terminus, and MISS
  { v: 0.22, color: [255, 176, 30] }, // #ffb01e amber
  { v: 0.45, color: [255, 95, 120] }, // #ff5f78 coral — the weirdness warming strange
  { v: 0.7, color: [242, 97, 226] }, // #f261e2 orchid — uncanny, almost settled
  { v: 1, color: [74, 106, 255] }, // #4a6aff the cobalt — peace (the web's --solve: a solved word lands exactly on the scale's calm terminus)
];

// The gradient's WEIRD terminus — and MISS's colour, ONE constant by the standing rule
// ("stop the gradient once you reach the MISS colour", 2026-08-17): a MISS is maximally
// weird — beyond the top-K, no rank at all — and the cap below collapses every far rank
// onto the same terminus, so a 100-away exponent and a MISS differ only by their label.
// The red is vivid on the dark ground (5.6:1 measured), a sibling of the timer's
// `--danger` (30.9 dE — deliberately family: red means "nothing here" again). The whole
// stop set was pushed to FULL chroma on user review 2026-08-17 ("more vivid") — the
// glowy exponents (see the web's .hole-rank text-shadow) are what these inks feed.
export const MISS_COLOR = '#ff3d2e';

function mix(a: number, b: number, t: number) {
  return Math.round(a + (b - a) * t);
}

// rgb() color interpolated on the weird→calm stops for a given heat value (clamped to
// [0,1]). Piecewise-linear between the stops — the interpolation `ramp.ts` used to hold,
// inlined when the iron polynomial briefly replaced stops entirely.
export function heatColor(heat: number) {
  const t = Math.max(0, Math.min(1, heat));
  let from = CALM_STOPS[0];
  let to = CALM_STOPS[CALM_STOPS.length - 1];
  for (let i = 1; i < CALM_STOPS.length; i += 1) {
    if (t <= CALM_STOPS[i].v) {
      from = CALM_STOPS[i - 1];
      to = CALM_STOPS[i];
      break;
    }
  }
  const s = from.v === to.v ? 0 : (t - from.v) / (to.v - from.v);
  const [r1, g1, b1] = from.color;
  const [r2, g2, b2] = to.color;
  return `rgb(${mix(r1, r2, s)}, ${mix(g1, g2, s)}, ${mix(b1, b2, s)})`;
}

// --- a RANK's place on the scale -------------------------------------------------------
// The gradient STOPS at the 100 exponent (user-decided 2026-08-17): a guess 1000 away and
// a guess 100 away are the same level of weird — past 100 there is no "weirder" left to
// say, and the floating number does not improve any hole anyway. And that level IS the
// MISS mustard: the cap collapses every far rank onto the gradient's weird terminus. It
// is the app's ABSOLUTE rank scale: the floating hits, every route row's exponent, a
// claim's loot and the run ruler all read a rank against it, so a rank is the same colour
// wherever it is drawn. (Lives here rather than in the web because the share card renders
// the same bar inside the Lambda and cannot import a component.)
export const HIT_HEAT_CAP = 100;

// Rank -> [0 weird .. 1 calm] (rank 0 = solved = calm). Logarithmic: the colour changes
// quickly near the goal (low ranks) and slowly far away. A rank past `startRank` goes
// negative here and heatColor's clamp holds it at the weird terminus — which is exactly
// the cap rule above. Internal — a rank is coloured through `rankHeatColor`.
function rankHeat(rank: number, startRank: number): number {
  const maxRank = Math.max(1, startRank || rank || 1);
  return 1 - Math.log(rank + 1) / Math.log(maxRank + 1);
}

// rgb() colour of a rank's exponent — the one way the app colours a distance.
export function rankHeatColor(rank: number, startRank: number) {
  return heatColor(rankHeat(rank, startRank));
}

// --- a PROGRESS % on the same scale ----------------------------------------------------
// A reconstruction % (0..100) read STRAIGHT onto the scale: 0% is the weird mustard and
// 100% the calm periwinkle — the same colour a rank-0 exponent wears, so a finished run
// ends on the peace the game restored.
//
// It maps LINEARLY (user-decided 2026-08-16, on the built thing rather than on paper). The
// alternative shipped first: price a % as the DISTANCE STILL TO GO — `100 - n` on the
// exponents' own log scale — which is truer to how the game talks about distance but
// spends almost nothing on a bar: `rankHeat`'s curve is steep near the goal, so ~25% to
// 100% all landed in one band and the ruler read as a single colour with a pip on the
// end. Straight reading spends the WHOLE scale across a run, which is what a bar is for.
const PROGRESS_MAX = 100;
function progressHeat(progress: number): number {
  return Math.max(0, Math.min(PROGRESS_MAX, progress)) / PROGRESS_MAX;
}

// rgb() colour interpolated on the scale for a progress value (%).
export function progressHeatColor(progress: number) {
  return heatColor(progressHeat(progress));
}

// The scale in EMOJI (decided 2026-07-25; re-derived 2026-08-17 with the weird→calm ink
// palette) — what the share text prints where no card image renders (SMS, plain-text
// clients). FOUR coarse bands, 🟥 → 🟨 → 🟪 → 🟦: weirdest, weird, strange, calm — cut
// where the scale's character actually turns (the lavender square is genuinely nearest
// the rose-orchid middle).
const PROGRESS_EMOJI = [
  { below: 15, emoji: '🟥' }, // the weird terminus: red
  { below: 45, emoji: '🟨' }, // amber -> coral
  { below: 75, emoji: '🟪' }, // the strange middle: coral -> rose-orchid
] as const;
const PROGRESS_EMOJI_TOP = '🟦'; // calm

// The emoji standing in for a progress value (%) — progressHeatColor's plain-text twin.
export function progressEmoji(progress: number): string {
  for (const { below, emoji } of PROGRESS_EMOJI) if (progress < below) return emoji;
  return PROGRESS_EMOJI_TOP;
}
