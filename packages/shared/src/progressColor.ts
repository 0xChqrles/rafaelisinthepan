// The progress-% ramp: colors the top progress bar, the language selector's % badge, and
// every run ruler's per-try cells (each try's reconstruction %) — on the solved screen, in
// the leaderboard, and on the backend-rendered share card, which is cross-cutting precisely
// so the card matches the on-screen ruler exactly. Its plain-text twin `progressEmoji` lives
// right below the stops, so the share text's emoji row can never drift from the ramp it
// stands in for. The rank exponents use heat.ts instead — a single ramp was tried and
// reverted (decided 2026-07-05). Both ramps share the one interpolator in ramp.ts.
// `progress` in [0,100] (clamped to the stops).
import { rampColor, type RampStop } from './ramp';

const PROGRESS_STOPS: RampStop[] = [
  { v: 15, color: [35, 132, 242] }, // blue
  { v: 30, color: [42, 210, 235] }, // cyan
  { v: 40, color: [35, 220, 145] }, // green
  { v: 50, color: [244, 194, 31] }, // gold
  { v: 60, color: [238, 103, 78] }, // coral
  { v: 70, color: [239, 79, 151] }, // pink
  { v: 80, color: [219, 36, 200] }, // magenta
  { v: 90, color: [136, 60, 235] }, // violet
  { v: 100, color: [70, 66, 232] }, // indigo
];

// rgb() color interpolated on the ramp for a progress value (%).
export function progressColor(progress: number) {
  return rampColor(PROGRESS_STOPS, progress);
}

// The ramp in EMOJI (decided 2026-07-25) — what the share text prints where no card image
// renders (SMS, plain-text clients). It must read as the same ramp as the ruler it stands
// in for, so each band is the emoji nearest the stop(s) it covers, cut at the midpoint
// between them. Unicode has no cyan square, so blue carries blue+cyan.
const PROGRESS_EMOJI = [
  { below: 35, emoji: '🟦' }, // blue -> cyan
  { below: 45, emoji: '🟩' }, // green
  { below: 55, emoji: '🟨' }, // gold
  { below: 65, emoji: '🟧' }, // coral
  { below: 75, emoji: '🟥' }, // pink
] as const;
// The tail is the one judgement call. The ramp closes on indigo, which sits about as near
// 🟦 as 🟪 — but 🟦 would make a finished run's last square identical to an untouched one's
// first, and the row must never read backwards. So the tail stays purple.
const PROGRESS_EMOJI_TOP = '🟪'; // magenta -> violet -> indigo

// The emoji standing in for a progress value (%) — progressColor's plain-text counterpart.
export function progressEmoji(progress: number): string {
  for (const { below, emoji } of PROGRESS_EMOJI) if (progress < below) return emoji;
  return PROGRESS_EMOJI_TOP;
}
