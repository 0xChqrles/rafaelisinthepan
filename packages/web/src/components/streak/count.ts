import { bayerThreshold as th } from '@whippin/shared';
import { CHARGE_MS, CHIP_FADE_MS, CHIP_FLASH_MS, HALO_MS, NOD_MS, PREV_IN_MS, at, clamp01, type Timeline } from './beats';
import { DEEP, GROUND, MUTED, WHITE, type Put } from './sprites';
import { numberPlace, type Layout, type NumberCells } from './geometry';

// THE COUNT — the scene's one big subject (`scene.ts`), each glyph pixel a square of `k`
// cells: the previous count dithers in in the muted ink and heats to white, cell by cell;
// THE LANDING stamps the new count as one frame of a white chip with the number cut out of
// it, unwiped left to right, throwing its light round its strokes as a DEEP dither that cools
// away; today struck makes it NOD one cell. Both counts stand on one top line, so the landing
// never jumps a row.

export interface CountLayer {
  // The landing chip's radius (cells): where the shock and the past weeks' orbits leave from,
  // where the charge's sparks fall to.
  chipR: number;
  draw(put: Put, t: number): void;
}

export function countLayer(L: Layout, from: NumberCells, to: NumberCells, tl: Timeline): CountLayer {
  const { k } = L;
  const fromAt = numberPlace(L, from);
  const toAt = numberPlace(L, to);
  // The landing chip: the new count's box plus a glyph pixel above and below it, a touch
  // more either side (the title chip's proportions).
  const padX = Math.max(2, Math.round(k * 1.25));
  const chip = { x0: toAt.x - padX, y0: toAt.y - k, x1: toAt.x + to.w * k + padX, y1: toAt.y + to.h * k + k };
  const chipR = Math.max(chip.x1 - chip.x0, chip.y1 - chip.y0) / 2;
  const bit = (m: NumberCells, x: number, y: number) =>
    x >= 0 && y >= 0 && x < m.w && y < m.h && m.bits[y * m.w + x] === 1;
  // The halo's field: each cell's distance (cells) to the new count's nearest inked block,
  // over the count's box grown by the halo's reach — measured once.
  const haloR = Math.max(4, Math.round(k * 2.4));
  const halo = {
    x0: toAt.x - haloR,
    y0: toAt.y - haloR,
    w: to.w * k + 2 * haloR,
    h: to.h * k + 2 * haloR,
    d: new Float32Array(0),
  };
  halo.d = new Float32Array(halo.w * halo.h).fill(99);
  for (let gy = 0; gy < to.h; gy += 1) {
    for (let gx = 0; gx < to.w; gx += 1) {
      if (!bit(to, gx, gy)) continue;
      const bx0 = gx * k + haloR;
      const by0 = gy * k + haloR;
      for (let y = Math.max(0, by0 - haloR); y < Math.min(halo.h, by0 + k + haloR); y += 1) {
        for (let x = Math.max(0, bx0 - haloR); x < Math.min(halo.w, bx0 + k + haloR); x += 1) {
          const ox = Math.max(bx0 - (x + 0.5), 0, x + 0.5 - (bx0 + k));
          const oy = Math.max(by0 - (y + 0.5), 0, y + 0.5 - (by0 + k));
          const dd = Math.hypot(ox, oy);
          const j = y * halo.w + x;
          if (dd < halo.d[j]) halo.d[j] = dd;
        }
      }
    }
  }

  return {
    chipR,
    draw(put, t) {
      if (t < tl.impact) {
        const shown = at(t, tl.prevIn, PREV_IN_MS);
        const heat = at(t, tl.charge, CHARGE_MS);
        for (let y = 0; y < from.h * k; y += 1) {
          for (let x = 0; x < from.w * k; x += 1) {
            if (!bit(from, Math.floor(x / k), Math.floor(y / k))) continue;
            const X = fromAt.x + x;
            const Y = fromAt.y + y;
            const v = th(X, Y);
            if (v >= shown) continue;
            // The charge: the old count heats to white, cell by cell, toward the landing.
            put(X, Y, v < heat * heat ? WHITE : MUTED);
          }
        }
        return;
      }
      // The LIGHT the landing throws: a DEEP dither round the new count's strokes, densest
      // against them, cooling away.
      const glow = at(t, tl.impact + CHIP_FLASH_MS, HALO_MS);
      if (glow < 1) {
        const peak = 0.62 * (1 - glow) ** 1.5;
        for (let y = 0; y < halo.h; y += 1) {
          for (let x = 0; x < halo.w; x += 1) {
            const dd = halo.d[y * halo.w + x];
            if (dd <= 0 || dd >= haloR) continue;
            const X = halo.x0 + x;
            const Y = halo.y0 + y;
            if (th(X, Y) < peak * (1 - dd / haloR) ** 1.3) put(X, Y, DEEP);
          }
        }
      }
      // The STAMP: one frame of a white chip with the count cut out of it (the title chip,
      // the app's one emphasis), then UNWIPED left to right in the mark-wipe's eight
      // steps, the front a few cells of dither — the count legible on every frame.
      const fade = Math.floor(at(t, tl.impact + CHIP_FLASH_MS, CHIP_FADE_MS) * 8) / 8;
      // Today struck: the count NODS.
      const nod = t >= tl.light && t < tl.light + NOD_MS ? 1 : 0;
      if (fade < 1) {
        const ramp = Math.max(3, k + 1);
        const front = chip.x0 + (chip.x1 - chip.x0 + ramp) * fade;
        for (let Y = chip.y0; Y < chip.y1; Y += 1) {
          for (let X = chip.x0; X < chip.x1; X += 1) {
            const gx = X - toAt.x;
            const gy = Y - toAt.y;
            const inGlyph = gx >= 0 && gy >= 0 && bit(to, Math.floor(gx / k), Math.floor(gy / k));
            const wiped = th(X, Y) < clamp01((front - X) / ramp);
            if (inGlyph) put(X, Y, wiped ? WHITE : GROUND);
            else if (!wiped) put(X, Y, WHITE);
          }
        }
      } else {
        for (let y = 0; y < to.h * k; y += 1) {
          for (let x = 0; x < to.w * k; x += 1) {
            if (bit(to, Math.floor(x / k), Math.floor(y / k))) put(toAt.x + x, toAt.y + y + nod, WHITE);
          }
        }
      }
    },
  };
}
