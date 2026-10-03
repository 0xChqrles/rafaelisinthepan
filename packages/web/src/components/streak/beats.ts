// THE STREAK CELEBRATION'S CLOCK — every beat of the show as milliseconds since it began
// (`timeline`), and what the DOM words do at any of those moments (`wordsAt`).
//
// One clock for every beat, so nothing awaits anything: the raster (`scene.ts`), the words,
// the ULTRA star and dismissal all read the same numbers, a fast-forward is just a later `t`
// (the `settled` beat), and reduced motion is one `t` held. The beats run ONE AFTER ANOTHER,
// each where the last one left the eye: today's link pours while the old count heats; the
// number lands (its shock lighting the crown above it); the chain runs on into today, which
// is struck and cools to foil; its light runs back down the chain, lighting each earlier
// day, and up round the orbit to the crown, which flares.

export interface Timeline {
  orbitIn: number; // the week draws itself, Monday to Sunday, then round the top to the crown
  prevIn: number; // the previous count dithers in
  pour: number; // today's link pours in, white-hot, from the bottom up
  charge: number; // the previous count heats, cell by cell
  impact: number; // THE LANDING: the new count stamps in a white chip, the shock goes out
  crown: number; // the shock reaches the pilot: the crown catches
  comet: number; // the chain runs from yesterday's link to today's
  light: number; // today's link is STRUCK (the ultra star), then cools into the foil
  // THE RUN: today's light leaves its link back down the chain, a link every PULSE_STEP_MS,
  // lighting each earlier day nearest first.
  run: number;
  // THE RELAY: … and on round the week's orbit both ways, to meet at the crown — null on a
  // full week, whose closing chain carries it instead.
  relay: number | null;
  // A FULL WEEK (today is Sunday and every day of it is solved): the chain runs on from
  // today up round the crown and down into Monday, CLOSING the orbit — null on any other day.
  close: number | null;
  // … and then the foil runs on from Monday along the chain to Sunday: the whole week foil.
  wave: number | null;
  flare: number; // the light reaches the crown: the flame flares (on a full week, struck by the ultra star)
  hint: number; // TAP ANYWHERE
  settled: number; // nothing left to arrive
}

// ── The beats' lengths, read by the scene and the flame ──────────────────────────────────
export const WEEK_SWEEP_MS = 420;
export const WRAP_SWEEP_MS = 300;
export const PREV_IN_MS = 260;
const POUR_AT = 640;
export const CHARGE_MS = 340;
export const CHIP_FLASH_MS = 50; // one frame
export const CHIP_FADE_MS = 240;
export const ORBIT_DELAY_MS = 30;
export const ORBIT_STAGGER_MS = 45;
export const ORBIT_EXPAND_MS = 620;
export const SHOCK_MS = 620;
export const COMET_MS = 320;
// The raster's step while the show runs (the dialog's frame): sparks re-scatter each one.
export const SHOW_STEP_MS = 50;
// The struck link holds white, then cools into the foil cell by cell, in the dither's order.
export const STRIKE_FLASH_MS = 100;
export const COOL_MS = 380;
// Today struck moves the count: it NODS, one cell down for two frames.
export const NOD_MS = 100;
// The landing's LIGHT: the new count glows out in DEEP dither, glyph-shaped, cooling away
// over HALO_MS — light drawn by dither, never a CSS glow.
export const HALO_MS = 620;
// The run back down the chain: it leaves the struck link after RUN_DELAY_MS and takes
// PULSE_STEP_MS a link; each link it reaches holds white for LIT_FLASH_MS, then is cobalt.
const RUN_DELAY_MS = 60;
export const PULSE_STEP_MS = 70;
export const LIT_FLASH_MS = PULSE_STEP_MS; // one link white at a time: a glint, not a band
// From Monday the relay climbs the orbit's left side to the crown in CLIMB_MS; the right
// side's light takes the whole run to get there, so the two meet.
export const CLIMB_MS = 320;
export const CROWN_MS = 360;
export const CROWN_STEPS = 6;
export const CLOSE_MS = 420;
// A full week's foil: a link every WAVE_STEP_MS from Monday, each white for WAVE_FLASH_MS.
export const WAVE_STEP_MS = 70;
export const WAVE_FLASH_MS = WAVE_STEP_MS;
// The flare: the flame stands this much taller as the light reaches it, settling back in
// whole steps — the relay's a lick, the full week's a blaze.
export const RELAY_FLARE = 0.24;
export const RELAY_FLARE_MS = 440;
export const FLARE = 0.45;
export const FLARE_MS = 700;
// The heartbeat, once all has landed: a glint leaves today's foil and runs back down the
// chain, and as it reaches Monday a faint cobalt pulse leaves the week's orbit.
export const HEARTBEAT_EVERY_MS = 4600;
export const HEARTBEAT_MS = 1700;
export const HEARTBEAT_AFTER_MS = 900;
export const GLINT_MS = 520;

// The show's beats for a week whose today follows a solved day (`hasComet`: the chain runs
// on into it), closes it (`closes`, a full week), and stands at `todayIndex` (Monday 0) — the
// relay's climb waits for the run to reach Monday.
export function timeline(hasComet: boolean, closes = false, todayIndex = 4): Timeline {
  const orbitIn = 140;
  const prevIn = 200;
  const pour = POUR_AT;
  const charge = 980;
  const impact = charge + CHARGE_MS;
  const crown = impact + 50;
  const comet = impact + 380;
  const light = hasComet ? comet + COMET_MS : impact + 420;
  const run = light + RUN_DELAY_MS;
  const relay = closes ? null : run;
  const close = closes ? light + 240 : null;
  const wave = close === null ? null : close + CLOSE_MS;
  const climbFrom = run + Math.max(0, todayIndex) * PULSE_STEP_MS;
  const flare = close === null ? climbFrom + CLIMB_MS : close + CLOSE_MS / 2;
  const hint = wave === null ? flare + 160 : wave + 5 * WAVE_STEP_MS + WAVE_FLASH_MS + 160;
  return { orbitIn, prevIn, pour, charge, impact, crown, comet, light, run, relay, close, wave, flare, hint, settled: hint + 320 };
}

// ── The words' frames ─────────────────────────────────────────────────────────────────────
// What stays DOM — the initials, the unit, the hint, the frame and its furniture, and the
// stars — moves on the SAME clock as the raster: each is a pure reading of `t`, so a
// fast-forward lands every word at once and a held frame is the whole picture.
export interface WordsFrame {
  screen: number; // the whole screen's opacity: it fades in over the game
  days: number[]; // each initial's opacity, Monday first
  unit: { o: number; dy: number }; // DAY STREAK: opacity, CSS px still to rise
  hint: { o: number; dy: number };
  furniture: number; // the lockup and the edition
  corners: { o: number; inward: number }; // CSS px toward the subject (the arrival, less the kick)
  lit: boolean; // today's link is struck, its initial in the title chip
  star: number; // the ultra star's frame on today, -1 outside its walk
  crownStar: number; // … on the crown (a full week)
  shake: readonly [number, number]; // the landing's jolt, cells
}
// The ultra star's one walk (7 frames of 50ms, `strikeArt.ts`).
export const STAR_FRAMES = 7;
const STAR_FRAME_MS = 50;
// The landing's jolt, a frame each.
const SHAKE: readonly (readonly [number, number])[] = [
  [1, -1],
  [-1, 0],
  [0, 1],
];
const SHAKE_FRAME_MS = 50;
// The frame's brackets: in from CORNER_IN_PX inside; kicked KICK_PX outward when the shock
// reaches them, KICK_AFTER_MS after the landing.
const CORNER_IN_PX = 18;
const CORNER_IN_MS = 320;
const KICK_PX = 5;
const KICK_AFTER_MS = 360;
const KICK_MS = 260;
const STILL: readonly [number, number] = [0, 0];
const SCREEN_IN_MS = 200;

export function wordsAt(t: number, tl: Timeline): WordsFrame {
  const rise = (start: number, ms: number, px: number) => {
    const p = at(t, start, ms);
    return { o: p, dy: Math.round(px * (1 - backOut(p))) };
  };
  const walk = (from: number | null) => {
    const f = from === null ? -1 : Math.floor((t - from) / STAR_FRAME_MS);
    return f >= 0 && f < STAR_FRAMES ? f : -1;
  };
  const jolt = Math.floor((t - tl.impact) / SHAKE_FRAME_MS);
  const kickP = (t - tl.impact - KICK_AFTER_MS) / KICK_MS;
  const kick = kickP > 0 && kickP < 1 ? Math.round(KICK_PX * kickShape(kickP)) : 0;
  const cornerP = at(t, 60, CORNER_IN_MS);
  return {
    screen: at(t, 0, SCREEN_IN_MS),
    days: Array.from({ length: 7 }, (_, i) => at(t, tl.orbitIn + 80 + i * 62, 220)),
    unit: rise(tl.prevIn, 280, 6),
    hint: rise(tl.hint, 240, 8),
    furniture: at(t, 120, 280),
    corners: { o: cornerP, inward: Math.round(CORNER_IN_PX * (1 - backOut(cornerP))) - kick },
    lit: t >= tl.light,
    star: walk(tl.light),
    crownStar: walk(tl.close !== null ? tl.flare : null),
    shake: jolt >= 0 && jolt < SHAKE.length ? SHAKE[jolt] : STILL,
  };
}

// The kick's shape over its run, 0–1: out fast to its peak at 30%, back home with a touch of
// overshoot.
function kickShape(p: number): number {
  if (p < 0.3) return p / 0.3;
  const q = (p - 0.3) / 0.7;
  return Math.cos(q * Math.PI * 0.62) * (1 - q);
}

// ── Tweens (the scene's and the flame's too; ease-out cubic is `useAnimatedNumber`'s) ─────
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
// A tween's position at `t`: 0 before `start`, 1 after `start + ms`.
export const at = (t: number, start: number, ms: number) => clamp01((t - start) / ms);
export const backOut = (v: number) => {
  const s = 1.7;
  const k = v - 1;
  return 1 + (s + 1) * k * k * k + s * k * k;
};
export const easeInOutSine = (v: number) => 0.5 - 0.5 * Math.cos(Math.PI * v);
export const smooth = (v: number) => {
  const k = clamp01(v);
  return k * k * (3 - 2 * k);
};
