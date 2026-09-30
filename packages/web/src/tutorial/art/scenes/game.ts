import {
  AMBER, CORAL, COBALT, CYAN, DEEP, MUTED, ORCHID, RAIL, RED, WHITE,
  clamp01, rnd, smooth, th,
} from './kit';
import type { SceneMaker } from './kit';

// ------------------------------------------------------------------------ THE GAME
// THE GAME, PLAYED: the day's sentence set as dim type — every word its SHAPE, the x-height
// run with its ascenders and descenders, a page seen from arm's length — and three of its
// words HELD: the game's inverted chips, white with the held guess dark in them, each wearing
// its rank as a heat-coloured exponent. Under the page, the prompt. A guess is typed and
// sent, and its rank rises out of its hole and fades; a better one takes the chip, cools the
// exponent from red toward cobalt and charges the meter, the cobalt ordered dither filling in
// behind the word; full, the chip turns to foil, and the word typed right inks it in, cobalt.
// When all three stand solved the page dissolves and the next day's types itself in — three
// days, round and round.

// The inks, indexed from 1.
const INKS = [WHITE, MUTED, RAIL, COBALT, CYAN, ORCHID, CORAL, AMBER, RED, DEEP];
const I_WHITE = 1;
const I_MUTED = 2;
const I_RAIL = 3;
const I_COBALT = 4;
const I_CYAN = 5;
const I_ORCHID = 6;
const I_CORAL = 7;
const I_AMBER = 8;
const I_RED = 9;
const I_DEEP = 10; // the book around the sentence, where a tall card has room for it

// A rank's ink: the heat ramp's nearest stop on the app's own log scale (shared heat.ts:
// capped at 100, rank 0 = the cobalt). One flat ink per number — a dithered digit is noise.
const HEAT_INKS = [I_RED, I_AMBER, I_CORAL, I_ORCHID, I_COBALT];
const HEAT_STOPS = [0, 0.22, 0.45, 0.7, 1];
function rankInk(rank: number): number {
  const h = 1 - Math.log(rank + 1) / Math.log(101);
  let best = 0;
  for (let i = 1; i < HEAT_STOPS.length; i += 1) {
    if (Math.abs(h - HEAT_STOPS[i]) < Math.abs(h - HEAT_STOPS[best])) best = i;
  }
  return HEAT_INKS[best];
}

// Digits, 3×5, row by row.
const DIGITS = [
  '111101101101111', '110010010010111', '111001111100111', '111001111001111', '101101111001001',
  '111100111001111', '111100111101111', '111001001010010', '111101111101111', '111101111001111',
];
const numW = (n: number) => String(n).length * 4 - 1;

// THE TYPE, at two sizes: the x-height, the ascenders' and descenders' reach, a letter's
// advance (its ink and one column), a space, the chip's padding and the line's pitch.
type Metrics = { xh: number; asc: number; desc: number; adv: number; space: number; padX: number; padY: number; pitch: number };
const SMALL: Metrics = { xh: 3, asc: 2, desc: 1, adv: 3, space: 3, padX: 2, padY: 1, pitch: 10 };
const LARGE: Metrics = { xh: 4, asc: 2, desc: 2, adv: 4, space: 4, padX: 3, padY: 1, pitch: 13 };

// A word's shape: its letters, each an x-height one (0), an ascender (1) or a descender (2) —
// about what a line of French or English carries.
type Shape = { n: number; w: number; kind: number[] };
function shapeOf(letters: number, m: Metrics, a: number, b: number): Shape {
  const kind: number[] = [];
  for (let i = 0; i < letters; i += 1) {
    const r = rnd(a, b * 97 + i, 31);
    kind.push(r < 0.26 && kind[i - 1] !== 1 ? 1 : r > 0.9 && kind[i - 1] !== 2 ? 2 : 0);
  }
  return { n: letters, w: letters * m.adv - 1, kind };
}

// THE ROUND, in seconds from the day's start: a guess sent at `t` to hole `h` (0..2, in the
// order they solve) and its rank — 0 is the word itself. A guess that does not beat the
// hole's best still rises and fades; one that does takes the chip, updates the exponent and
// charges the meter; the word, once the meter is full, inks the hole in.
const SCRIPT: readonly { t: number; h: number; rank: number }[] = [
  { t: 4.2, h: 0, rank: 38 },
  { t: 6.8, h: 1, rank: 96 },
  { t: 9.4, h: 2, rank: 254 },
  { t: 12.0, h: 0, rank: 9 },
  { t: 14.6, h: 2, rank: 44 },
  { t: 17.2, h: 1, rank: 17 },
  { t: 19.8, h: 0, rank: 2 },
  { t: 22.4, h: 2, rank: 12 },
  { t: 25.2, h: 0, rank: 0 },
  { t: 27.8, h: 1, rank: 1 },
  { t: 30.4, h: 2, rank: 61 },
  { t: 33.0, h: 2, rank: 3 },
  { t: 35.8, h: 1, rank: 0 },
  { t: 38.4, h: 2, rank: 1 },
  { t: 41.4, h: 2, rank: 0 },
];
const DAY = 49; // one day's life
const INTRO = 2.8; // the page typing itself in
const OUT_AT = 46.4; // the solved page held, then dissolved
const OUT_S = 1.4;
const LAND = 0.25; // a sent guess's rank reaches the exponent
const METER_S = 1.3; // the meter's travel
const FOIL_S = 1.0; // the foil coming over the full meter
const SOLVE_S = 0.9; // the chip giving way to the ink
const FLOAT_S = 2.4; // a landed rank rising and fading
const FULL_RANK = 2; // a best rank at or under this fills the meter
const KEY_S = 0.12; // a typed letter
const HOLD_S = 0.45; // the typed guess held before it is sent

// THE FOIL: the loop of inks — the hole's cyan, the solve's cobalt, the ramp's orchid —
// running diagonally through the chip, drifting, each band dithered into the next; and now
// and then a star, rising in, holding, fading, each on its own clock.
const FOIL = [I_CYAN, I_COBALT, I_ORCHID, I_COBALT];
const FOIL_CYCLE = 1.7; // one loop of the inks, in chip widths
const FOIL_DRIFT = 0.1; // loops a second
const STAR_S = 3.4; // one star's life

// The prompt's chevron, 3×5.
const CHEVRON = '100010001010100';

type Word = { x: number; line: number; shape: Shape; order: number; ink: number };
type Hole = Word & { start: number; seed: number; ceil: number; first: Shape; held: Shape[]; secret: Shape };
type Page = { words: Word[]; holes: Hole[]; n: number; typed: Shape[] };

const game: SceneMaker = (cols, rows, stage) => {
  // THE PAGE: under the card's top labels — its first line's exponents included, which stand
  // above the chips — and above the band its foot fades across.
  const top = stage.h < rows ? 15 : 8;
  const bottom = stage.h < rows ? stage.h - 7 : stage.h - 6;
  const avail = bottom - top;
  const M = cols >= 150 && avail >= 60 ? LARGE : SMALL;
  const box = M.asc + M.xh + M.desc; // a line's box, ascender to descender
  const promptGap = Math.round(M.pitch * 1.6); // the last line's band to the prompt's
  const EXP = 11; // three digits
  const expGap = 1;

  // A few wide lines on a wide card; on a tall one, the page the line was taken from.
  const wide = cols > avail * 2.2;
  // A tall card is filled by the book: as many of its lines as the height holds.
  const room = Math.min(avail, Math.max(46, Math.round(avail * 0.9)));
  const fit = Math.max(2, Math.floor((room - promptGap - box) / M.pitch) + 1);
  const nSent = Math.min(wide ? 3 : 4, fit);
  const nCtx = wide ? 0 : Math.max(0, Math.min(14, fit - nSent));
  const nBefore = Math.ceil(nCtx / 2);
  const nLines = nCtx + nSent;
  const lastSent = nBefore + nSent - 1;
  const blockH = (nLines - 1) * M.pitch + promptGap + box;
  // Centred in its room — and on a card too short to hold it, hung from the top, so it runs
  // down into the fading foot and never up under the labels.
  const band0 = top + Math.max(0, Math.round((avail - blockH) / 2)) + M.asc; // line 0's x-height band
  const bandY = (line: number) => band0 + line * M.pitch;
  const promptBand = bandY(nLines - 1) + promptGap;
  const mx = Math.max(8, Math.round(cols * 0.1));
  const measure = cols - mx * 2;

  // Where the three holes sit: spread over the sentence's lines, and along them a different
  // place each day — never one chip right over another.
  const HOLE_LINES = [0, 1, 2].map((k) => nBefore + Math.min(nSent - 1, Math.round(((k + 0.5) * nSent) / 3 - 0.5)));
  const HOLE_FX = [[0.52, 0.02, 0.5], [0.04, 0.56, 0.1], [0.58, 0.08, 0.54]];

  const LETTERS = [2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 7, 7, 8, 9];
  const makePage = (seed: number): Page => {
    const base = (i: number) => LETTERS[Math.floor(rnd(seed, i, 11) * LETTERS.length)];
    const fxs = HOLE_FX[seed % HOLE_FX.length];
    const targets = [0, 1, 2].map((k) => ({ line: HOLE_LINES[k], fx: fxs[k] }));
    targets.sort((a, b) => a.line - b.line || a.fx - b.fx);
    // Set the stream into lines, ragged as the game sets its sentence. A hole is the word
    // standing at its place — or the last one it still fits after — lengthened to 5–7
    // letters, with its chip's padding and its exponent.
    const placed: { i: number; x: number; line: number; n: number; hole: boolean }[] = [];
    let i = 0;
    let next = 0;
    for (let l = 0; l < nLines; l += 1) {
      let x = 0;
      for (;;) {
        const gap = x > 0 ? M.space : 0;
        let n = base(i);
        let hole = false;
        const target = targets[next];
        if (target && target.line === l) {
          const nh = Math.max(n, 5 + Math.floor(rnd(seed, i, 13) * 3));
          const need = (wn: number) => M.padX * 2 + wn * M.adv - 1 + expGap + EXP;
          const nowFits = x + gap + need(nh) <= measure;
          const laterFits = x + gap + n * M.adv - 1 + M.space + need(nh) <= measure;
          if (nowFits && (x >= target.fx * measure || !laterFits)) {
            hole = true;
            n = nh;
            next += 1;
          }
        }
        const w = n * M.adv - 1;
        const lead = hole ? M.padX : 0;
        const need = gap + lead + w + (hole ? M.padX + expGap + EXP : 0);
        if (x > 0 && x + need > measure) break;
        placed.push({ i, x: mx + x + gap + lead, line: l, n, hole });
        x += need;
        i += 1;
      }
    }
    const holeIdx = placed.filter((p) => p.hole).map((p) => p.i);
    const firstHole = holeIdx[0] ?? 0;
    const lastHole = holeIdx[holeIdx.length - 1] ?? 0;
    // The sentence: from part-way along its first line to part-way along its last, never
    // past a hole; the book around it in the deep ink, where there is room for the book.
    const along = (line: number, fx: number, lo: number, hi: number) => {
      const on = placed.filter((p) => p.line === line && p.i >= lo && p.i <= hi);
      on.sort((a, b) => Math.abs((a.x - mx) / measure - fx) - Math.abs((b.x - mx) / measure - fx));
      return on[0]?.i;
    };
    const s0 = nBefore > 0 ? along(nBefore, 0.15 + rnd(seed, 1) * 0.3, 0, firstHole) ?? firstHole : 0;
    const s1 = along(lastSent, 0.45 + rnd(seed, 3) * 0.3, lastHole + 1, Infinity) ?? lastHole;
    // Without a book after it, the page ends with the sentence; with one, part-way along its
    // last line.
    const endAt = nLines - 1 > lastSent ? along(nLines - 1, 0.55 + rnd(seed, 4) * 0.3, 0, Infinity) ?? Infinity : s1;
    const kept = placed.filter((p) => p.i <= endAt);
    const words: Word[] = [];
    const holeWords: Hole[] = [];
    kept.forEach((p, order) => {
      const w: Word = {
        x: p.x, line: p.line, shape: shapeOf(p.n, M, seed, p.i), order,
        ink: p.i < s0 || p.i > s1 ? I_DEEP : I_RAIL,
      };
      if (!p.hole) words.push(w);
      else {
        holeWords.push({
          ...w, start: 104 + Math.floor(rnd(seed, p.i, 5) * 90), seed: rnd(seed, p.i, 9), ceil: -Infinity,
          first: shapeOf(p.n, M, seed + 41, p.i),
          held: SCRIPT.map((_, k) => shapeOf(p.n, M, seed + 17, p.i * 31 + k)),
          secret: shapeOf(p.n, M, seed + 29, p.i),
        });
      }
    });
    // Where a chip does stand under another, the rank rising out of it stops short of it.
    for (const lo of holeWords) {
      const up = holeWords.find((q) =>
        q.line === lo.line - 1 && lo.x - M.padX < q.x + q.shape.w + M.padX + EXP + 2 && q.x - M.padX < lo.x + lo.shape.w + M.padX + 2);
      if (up) lo.ceil = bandY(up.line) + M.xh + M.desc + M.padY + 2;
    }
    // The order the holes solve in, this day; every guess is typed at its hole's length.
    const turn = [[0, 1, 2], [1, 2, 0], [2, 0, 1]][seed % 3];
    const order = turn.map((k) => holeWords[k]).filter(Boolean);
    const typed = SCRIPT.map((e, k) => {
      const h = order[e.h];
      if (!h) return shapeOf(4, M, seed, k);
      return e.rank === 0 ? h.secret : h.held[k];
    });
    return { words, holes: order, n: kept.length, typed };
  };
  const pages = [0, 1, 2].map(makePage);

  // One hole's state at `tau`: the guess it holds, its best rank, the meter, the foil, the
  // solve.
  const holeAt = (h: number, start: number, tau: number) => {
    let best = start;
    let held = -1;
    let fill = 0;
    let foilFrom = Infinity;
    let solveAt = Infinity;
    let popAt = -Infinity;
    const meter = (rank: number) => (rank <= FULL_RANK ? 1 : clamp01(1 - Math.log(rank + 1) / Math.log(start + 1)));
    for (let k = 0; k < SCRIPT.length; k += 1) {
      const e = SCRIPT[k];
      if (e.h !== h || tau < e.t + LAND) continue;
      if (e.rank === 0) {
        solveAt = e.t + LAND;
        continue;
      }
      if (e.rank >= best) continue;
      const from = best === start ? 0 : meter(best);
      best = e.rank;
      held = k;
      popAt = e.t + LAND;
      fill = from + (meter(best) - from) * smooth((tau - e.t - LAND) / METER_S);
      if (meter(best) >= 1) foilFrom = e.t + LAND + METER_S;
    }
    return {
      best,
      held,
      fill,
      foil: clamp01((tau - foilFrom) / FOIL_S),
      solve: clamp01((tau - solveAt) / SOLVE_S),
      solving: tau >= solveAt,
      pop: tau - popAt < 0.25,
    };
  };

  return {
    inks: INKS,
    draw(r, t) {
      const day = Math.floor(t / DAY);
      const tau = t - day * DAY;
      const page = pages[((day % 3) + 3) % 3];
      // The day's end: the solved page dissolves through the ordered dither.
      const vis = 1 - clamp01((tau - OUT_AT) / OUT_S);
      if (vis <= 0) return;
      const set = (x: number, y: number, ink: number) => {
        if (x < 0 || y < 0 || x >= r.cols || y >= r.rows) return;
        if (vis < 1 && vis <= th(x, y)) return;
        r.ink[y * r.cols + x] = ink;
      };
      // A word's cells: each letter's column of x-height, its ascender or descender the
      // letter's width, and — joined, as the page's words are — the column to the next letter.
      const glyph = (x: number, band: number, s: Shape, fn: (x: number, y: number) => void, joined: boolean, upTo = s.n) => {
        const lw = M.adv - 1;
        const n = Math.min(s.n, upTo);
        for (let i = 0; i < n; i += 1) {
          const lx = x + i * M.adv;
          const k = s.kind[i];
          const y0 = k === 1 ? band - M.asc : band;
          const y1 = k === 2 ? band + M.xh + M.desc : band + M.xh;
          for (let y = y0; y < y1; y += 1) for (let c = 0; c < lw; c += 1) fn(lx + c, y);
          if (joined && i < n - 1) for (let y = band; y < band + M.xh; y += 1) fn(lx + lw, y);
        }
      };
      const word = (x: number, band: number, s: Shape, ink: number, upTo = s.n) =>
        glyph(x, band, s, (xx, yy) => set(xx, yy, ink), true, upTo);
      const number = (n: number, x0: number, y0: number, ink: number, halo: boolean) => {
        const str = String(n);
        for (let pass = halo ? 0 : 1; pass < 2; pass += 1) {
          for (let d = 0; d < str.length; d += 1) {
            const g = DIGITS[str.charCodeAt(d) - 48];
            for (let k = 0; k < 15; k += 1) {
              if (g[k] !== '1') continue;
              const x = x0 + d * 4 + (k % 3);
              const y = y0 + Math.floor(k / 3);
              if (pass === 1) set(x, y, ink);
              else for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) set(x + dx, y + dy, 0);
            }
          }
        }
      };

      // The page types itself in, in reading order.
      const at = (order: number) => 0.2 + (order / page.n) * (INTRO - 0.5);
      for (const w of page.words) if (tau >= at(w.order)) word(w.x, bandY(w.line), w.shape, w.ink);

      page.holes.forEach((w, h) => {
        if (tau < at(w.order)) return;
        const s = holeAt(h, w.start, tau);
        const band = bandY(w.line);
        if (s.solve >= 1) {
          word(w.x, band, w.secret, I_COBALT);
          return;
        }
        const x0 = w.x - M.padX;
        const y0 = band - M.asc - M.padY;
        const cw = w.shape.w + M.padX * 2;
        const ch = box + M.padY * 2;
        const ramp = ch; // the dither's ramp, one chip high, as the game's meter
        const front = s.fill * (cw + ramp);
        const sheet = s.foil * (cw + ramp);
        // The solve inks the word in with the meter's own sweep, taking the chip with it.
        const wipe = s.solve * (cw + ramp);
        const swept = (x: number, y: number) => s.solving && clamp01((wipe - (x - x0)) / ramp) > th(x, y);
        const drift = tau * FOIL_DRIFT + w.seed * 7;
        const cycle = cw * FOIL_CYCLE;
        for (let y = y0; y < y0 + ch; y += 1) {
          for (let x = x0; x < x0 + cw; x += 1) {
            if (swept(x, y)) continue;
            const u = x - x0;
            const tt = th(x, y);
            let ink = I_WHITE;
            if (clamp01((front - u) / ramp) > tt) ink = I_COBALT;
            if (clamp01((sheet - u) / ramp) > tt) {
              const k = (u + (y - y0) * 1.5) / cycle - drift;
              const p = (k - Math.floor(k)) * FOIL.length;
              const i = Math.floor(p);
              ink = p - i > tt ? FOIL[(i + 1) % FOIL.length] : FOIL[i];
            }
            set(x, y, ink);
          }
        }
        // A star in the foil: rising in, holding, fading, arms first.
        if (s.foil >= 1 && !s.solving) {
          const ph = tau / STAR_S + w.seed * 5;
          const c = Math.floor(ph);
          const f = ph - c;
          const sx = x0 + 2 + Math.floor(rnd(c, w.seed * 1e4, 51) * (cw - 4));
          const sy = y0 + 1 + Math.floor(rnd(c, w.seed * 1e4, 53) * (ch - 2));
          if (f < 0.7) set(sx, sy, I_WHITE);
          if (f > 0.08 && f < 0.55) {
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              if (sy + dy >= y0 && sy + dy < y0 + ch) set(sx + dx, sy + dy, I_WHITE);
            }
          }
        }
        // The held word, dark in the chip — the start word, then each better guess; the word
        // itself once it is typed right, the sweep inking it cobalt.
        const held = s.solving ? w.secret : s.held < 0 ? w.first : w.held[s.held];
        const dark = (x: number, y: number) => {
          if (!swept(x, y)) set(x, y, 0);
        };
        glyph(w.x, band, held, dark, false);
        if (s.solving) {
          word(w.x, band, w.secret, I_COBALT);
          glyph(w.x, band, w.secret, dark, false);
        }
        // The exponent at the chip's shoulder, gone once the sweep has crossed the chip.
        if (wipe < cw) number(s.best, x0 + cw + expGap, y0 - 1 - (s.pop ? 1 : 0), rankInk(s.best), false);
      });

      // The guesses landing: each rank rises out of its hole, as the game's floating hit
      // does, and fades through the dim ink.
      for (const e of SCRIPT) {
        const u = (tau - e.t - LAND) / FLOAT_S;
        if (e.rank === 0 || u < 0 || u >= 1) continue;
        const w = page.holes[e.h];
        if (!w) continue;
        const chipTop = bandY(w.line) - M.asc - M.padY;
        const from = chipTop - 6;
        const to = Math.max(w.ceil, chipTop - 6 - Math.round(M.pitch * 0.8));
        const y = from - Math.round((1 - (1 - u) ** 3) * (from - to));
        const x = Math.round(w.x + w.shape.w / 2 - numW(e.rank) / 2);
        number(e.rank, x, y, u > 0.78 ? I_RAIL : rankInk(e.rank), true);
      }

      // THE PROMPT: the chevron, the guess being typed, the cursor after it.
      if (tau >= INTRO - 0.2) {
        const cx = mx;
        const cy = promptBand + Math.floor((M.xh - 5) / 2);
        for (let k = 0; k < 15; k += 1) if (CHEVRON[k] === '1') set(cx + (k % 3), cy + Math.floor(k / 3), I_COBALT);
        let typed = 0;
        let shape: Shape | null = null;
        for (let k = 0; k < SCRIPT.length; k += 1) {
          const s = page.typed[k];
          const from = SCRIPT[k].t - HOLD_S - s.n * KEY_S;
          if (tau >= from && tau < SCRIPT[k].t) {
            typed = Math.min(s.n, Math.floor((tau - from) / KEY_S) + 1);
            shape = s;
          }
        }
        const tx = cx + 3 + M.space;
        if (shape) word(tx, promptBand, shape, I_MUTED, typed);
        const curX = tx + typed * M.adv;
        if (shape || tau % 1.6 < 0.9) for (let y = promptBand - M.asc; y < promptBand + M.xh; y += 1) set(curX, y, I_COBALT);
      }
    },
  };
};

export default game;
