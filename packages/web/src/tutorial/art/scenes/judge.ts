import { MUTED, RAIL, RAMP, WHITE, clamp01, rect, rnd, smooth, th } from './kit';
import type { SceneMaker } from './kit';

// ------------------------------------------------------------------------ THE JUDGE
// The round-robin as a REORDERABLE MATRIX: a row per candidate word, a column per opponent,
// in the rough order the first pass graded them. Every duel lands (a white flash) in a wave
// out from the diagonal and settles into the heat ramp — its win probability — while each
// row's score grows in a bar beside it. Then neighbours trade places, round by round, until
// the order is the ranking: calm cobalt above the diagonal, weird red below, the bars a
// staircase, the first three words held. The court is cleared, cell by cell, and it starts
// over.
const judge: SceneMaker = (cols, rows, stage) => {
  const inks = [...RAMP, WHITE, RAIL, MUTED];
  const I_COBALT = RAMP.length;
  const I_WHITE = RAMP.length + 1;
  const I_RAIL = RAMP.length + 2;
  const I_MUTED = RAMP.length + 3;

  // GEOMETRY — [word chips] [matrix] [score bars]. The matrix is as tall as its box allows
  // while the chips and bars still fit beside it; then they take the width left, up to their
  // ideal proportions. The group is centred on what is DRAWN: the widest chip on the left, and
  // on the right the leader's bar, the longest (about BAR_REACH of the column). On a card it
  // stands below the level's number and length in the top corners, and reaches down into the
  // band its foot dithers the art out across, as every card's picture does.
  const BAR_REACH = 0.85;
  const fit = (y0: number, y1: number, x0: number, x1: number, fill: number) => {
    const room = y1 - y0;
    const span = x1 - x0;
    const want = Math.min(room * fill, (span - 10) / 1.8);
    const step = Math.max(4, Math.min(6, Math.round(want / 11)));
    const n = Math.max(6, Math.min(20, Math.floor((want + 1) / step)));
    const size = n * step - 1;
    const gap = step + 1;
    const left = span - 2 * gap - size;
    const labelW = Math.round(Math.min(size * 0.34, left * 0.3));
    const barW = Math.round(Math.min(size * 0.9, left * 0.7));
    const drawn = labelW + gap + size + gap + barW * BAR_REACH;
    const mx = Math.round(x0 + (span - drawn) / 2) + labelW + gap;
    // Centred in its room — and never above it: a box too short for the smallest matrix lets
    // its bottom rows fade into the foot rather than rise into the labels.
    return { step, n, size, gap, labelW, barW, mx, my: y0 + Math.max(0, Math.round((room - size) / 2)) };
  };
  const foot = stage.h < rows;
  const g = foot
    ? fit(12, stage.h - 2, cols * 0.08, cols * 0.92, 1)
    : fit(0, stage.h, cols * 0.1, cols * 0.9, 0.82);
  const { step, n, size, gap, labelW, barW, mx, my } = g;
  const cell = step - 1;
  const bx = mx + size + gap;
  const ex = Math.max(2, cell >> 1); // a held word's exponent

  // THE DUELS — strengths evenly spread, P(a beats b) a logistic of the gap plus a symmetric
  // noise (the judge is not perfectly transitive); ids are then relabelled by final score, so
  // id k IS rank k.
  const s = Array.from({ length: n }, (_, k) => 1 - k / (n - 1) + (rnd(k, 51) - 0.5) * 0.1);
  const raw = s.map((_, a) =>
    s.map((__, b) => {
      if (a === b) return 0.5;
      const noise = (rnd(Math.min(a, b), Math.max(a, b), 52) - 0.5) * 1.8 * (a < b ? 1 : -1);
      return 1 / (1 + Math.exp(-(6 * (s[a] - s[b]) + noise)));
    }),
  );
  const rawScore = raw.map((row, a) => row.reduce((acc, p, b) => acc + (a === b ? 0 : p), 0) / (n - 1));
  const byScore = rawScore.map((_, k) => k).sort((a, b) => rawScore[b] - rawScore[a]);
  const P = byScore.map((a) => byScore.map((b) => raw[a][b]));
  const best = rawScore[byScore[0]];
  // A value's ink on the ramp, dithered between two stops at the MATRIX's own grain (one
  // threshold per duel, never inside a cell), so the gradient is a mosaic of whole cells.
  const heat = (v: number, x: number, y: number) => {
    const at = clamp01(v) * (RAMP.length - 1);
    const e = Math.min(RAMP.length - 2, Math.floor(at));
    return (at - e > th(x, y) ? e + 1 : e) + 1;
  };
  const ink = P.map((row, i) => row.map((p, j) => heat(p, j, i)));
  // Each duel's place in the dissolve (the same ordered dither, at the same grain).
  const gone = P.map((row, i) => row.map((_, j) => th(j + 3, i + 6)));

  // The order the candidates come in: the first pass's (one grade each) — roughly the
  // ranking, with its mistakes, which the tournament then corrects.
  const guess = Array.from({ length: n }, (_, k) => k + (rnd(k, 55) - 0.5) * n);
  const shuffle = guess.map((_, k) => k).sort((a, b) => guess[a] - guess[b]);
  const pos0 = new Array<number>(n);
  shuffle.forEach((id, p) => {
    pos0[id] = p;
  });
  // The words' lengths; the podium's three set so their chips never stack into a glyph.
  const podium = [0.9, 1, 0.7];
  const word = Array.from({ length: n }, (_, k) =>
    Math.max(2, Math.round(labelW * (k < 3 ? podium[k] : 0.35 + 0.65 * rnd(k, 56)))),
  );

  // THE LOOP (seconds).
  const PERIOD = 16;
  const REVEAL0 = 0.6;
  const REVEAL1 = 5.3;
  const FLASH = 0.25;
  const SORT0 = 5.8;
  const SORT1 = 9.6;
  const FADE0 = 14.4;
  const FADE1 = 15.6;

  // THE CORRECTION: an odd-even transposition sort — each round, every out-of-order pair of
  // NEIGHBOURS trades places, row AND column (a candidate is both), so the diagonal stays
  // the diagonal. Only the rounds where something moves are kept; `at[k][id]` is where each
  // candidate stands before round k.
  const at: number[][] = [pos0.slice()];
  {
    const order = shuffle.slice();
    for (let round = 0, still = 0; still < 2 && round < 4 * n; round += 1) {
      let moved = false;
      for (let q = round % 2; q + 1 < n; q += 2) {
        if (order[q] > order[q + 1]) {
          [order[q], order[q + 1]] = [order[q + 1], order[q]];
          moved = true;
        }
      }
      still = moved ? 0 : still + 1;
      if (!moved) continue;
      const pos = new Array<number>(n);
      order.forEach((id, q) => {
        pos[id] = q;
      });
      at.push(pos);
    }
  }
  const rounds = at.length - 1;
  const beat = rounds > 0 ? Math.min(0.8, (SORT1 - SORT0) / rounds) : 1;
  const sorting = rounds * beat;
  // Within a round the rows trade first, then the columns follow — one direction of motion
  // at a time — and the rest of the beat the matrix stands whole.
  const posAt = (id: number, u: number, lag: number) => {
    const v = (u - SORT0) / beat;
    if (v <= 0) return at[0][id];
    if (v >= rounds) return at[rounds][id];
    const k = Math.floor(v);
    return at[k][id] + (at[k + 1][id] - at[k][id]) * smooth((v - k - lag) / 0.4);
  };

  // A duel lands when the wave out from the diagonal (in the order they came in) reaches it.
  const land = Array.from({ length: n }, (_, a) =>
    Array.from({ length: n }, (__, b) => {
      const d = Math.abs(pos0[a] - pos0[b]);
      const f = ((d - 1) / Math.max(1, n - 2)) * 0.82 + rnd(Math.min(a, b), Math.max(a, b), 54) * 0.18;
      return REVEAL0 + (REVEAL1 - REVEAL0) * f;
    }),
  );

  return {
    inks,
    draw(r, t) {
      const u = ((t % PERIOD) + PERIOD) % PERIOD;
      // How much of the court stands: the words arrive, and at the end everything leaves.
      const keep = u > FADE0 ? 1 - clamp01((u - FADE0) / (FADE1 - FADE0)) : clamp01(u / 0.7);
      const row = shuffle.map((_, id) => my + posAt(id, u, 0) * step);
      const col = shuffle.map((_, id) => mx + posAt(id, u, 0.35) * step);

      // The board: a dot in every slot, the diagonal (no word duels itself) drawn over it.
      const dot = cell >> 1;
      for (let p = 0; p < n; p += 1) {
        for (let q = 0; q < n; q += 1) rect(r, mx + q * step + dot, my + p * step + dot, 1, 1, I_RAIL);
      }

      // Weakest first, so a stronger row rising past a neighbour passes over it.
      for (let i = n - 1; i >= 0; i -= 1) {
        const y = row[i];
        let won = 0;
        for (let j = 0; j < n; j += 1) {
          const x = col[j];
          if (i === j) {
            rect(r, x, y, cell, cell, I_MUTED);
            continue;
          }
          const landed = land[i][j];
          if (u < landed) continue;
          won += P[i][j] * smooth((u - landed) / FLASH);
          if (keep > gone[i][j]) rect(r, x, y, cell, cell, u < landed + FLASH ? I_WHITE : ink[i][j]);
        }
        // The word — once ranked, the first three are HELD, each with its exponent: the
        // judge's ranks are the game's.
        if (keep > th(1, i + 3)) {
          const held = i < 3 && u > SORT0 + sorting + 0.5 + i * 0.4;
          rect(r, mx - gap - word[i], y, word[i], cell, held ? I_WHITE : I_RAIL);
          if (held) rect(r, mx - gap + 1, y - 1, ex, ex, I_COBALT);
        }
        // Its score so far: the mean of the duels played, out of all it will play, in the
        // heat of its standing (the nearest stop: a ranking's colours never interleave).
        const mean = won / (n - 1);
        const w = Math.round(mean * barW * smooth(keep * 1.4));
        if (w > 0) rect(r, bx, y, w, cell, Math.round(clamp01(mean / best) * (RAMP.length - 1)) + 1);
      }
    },
  };
};

export default judge;
