import { AVATAR_CELLS, AVATAR_SIZE } from './avatar';

// The union OUTLINE of an avatar's filled cells, as one SVG path: every boundary —
// outer edges and holes alike — contour-traced into a closed loop, collinear runs
// merged. A rect per cell meets its neighbours in interior edges, and two shapes
// meeting on an edge can antialias a hairline seam between them; a union outline has
// no interior edges, so there is nothing to seam.
//
// It is a TRACER and not the cheaper alternatives — one `<path>` carrying a rect
// subpath per cell, or `shape-rendering="crispEdges"` on a rect per cell — because
// user-decided 2026-08-19, after the seam was chased through both: those two do not
// render the same on every browser, where an outline with no interior edges has
// nothing left to disagree about. Keep the tracer.
//
// The directed edges keep the interior on the RIGHT of the walk, so outer loops wind
// clockwise on screen and holes counter-clockwise — the default nonzero fill rule
// subtracts the holes by construction.
export function avatarOutlinePath(cells: readonly number[], cell: number): string {
  // The grid's WIDTH is the avatar's, not the array's, so a wrong-length array would
  // read across rows and draw a plausible wrong picture. Refuse instead: `Avatar`
  // catches it and renders nothing.
  if (cells.length !== AVATAR_CELLS) {
    throw new Error(`avatarOutlinePath: expected ${AVATAR_CELLS} cells`);
  }
  const n = AVATAR_SIZE;
  const v = n + 1; // the vertex grid is one wider than the cell grid
  const filled = (x: number, y: number) =>
    x >= 0 && x < n && y >= 0 && y < n && cells[y * n + x] === 1;

  // Every filled cell contributes one unit edge per side that faces an empty cell (or
  // the outside), keyed by start vertex. A vertex where two filled cells meet only
  // diagonally carries two outgoing edges — resolved in the walk below.
  const edges = new Map<number, number[]>();
  const add = (from: number, to: number) => {
    const list = edges.get(from);
    if (list) list.push(to);
    else edges.set(from, [to]);
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!filled(x, y)) continue;
      const nw = y * v + x; // the cell's top-left vertex
      if (!filled(x, y - 1)) add(nw, nw + 1); // top side, walked rightward
      if (!filled(x + 1, y)) add(nw + 1, nw + 1 + v); // right side, downward
      if (!filled(x, y + 1)) add(nw + 1 + v, nw + v); // bottom side, leftward
      if (!filled(x - 1, y)) add(nw + v, nw); // left side, upward
    }
  }

  // The walk's own turning sense (the way a single cell's four edges chain), as key
  // deltas: right -> down -> left -> up. Only ever asked mid-walk, so `dir` is always
  // one of those four.
  const turn = (dir: number) => (dir === 1 ? v : dir === v ? -1 : dir === -1 ? -v : 1);

  // Chain the edges into loops. Vertices are visited smallest-first, so each loop
  // starts at its top-most left-most vertex — always a corner of the loop, never
  // mid-run, which is what lets the collinear merge skip a wrap-around pass.
  const parts: string[] = [];
  for (const start of [...edges.keys()].sort((a, b) => a - b)) {
    for (let list = edges.get(start); list && list.length > 0; list = edges.get(start)) {
      const pts: number[] = [start];
      let dir = 0;
      let cur = start;
      do {
        const cands = edges.get(cur)!;
        let next: number;
        if (cands.length === 1) {
          next = cands[0];
          edges.delete(cur);
        } else {
          // Two ways out: two filled cells touch here only diagonally. Turn the way
          // the walk always turns, which hugs the region the walk came along — the
          // two regions keep separate loops and the loops never cross.
          const idx = cands.indexOf(cur + turn(dir));
          // The turned edge is always there: a loop begins at its smallest vertex key,
          // and at a diagonal touch one of the two out-edges always leads to a smaller
          // key, so that loop has already been walked and drained — a start vertex can
          // never hold two candidates, and mid-walk the turn is the arriving region's
          // own next side. Taking the OTHER edge would cross the loops and fill the
          // wrong pixels with nothing to show for it, so this fails loudly instead.
          if (idx < 0) throw new Error('avatarOutlinePath: no turn out of a shared vertex');
          next = cands[idx];
          cands.splice(idx, 1);
        }
        const step = next - cur;
        if (step === dir) pts[pts.length - 1] = next;
        else pts.push(next);
        dir = step;
        cur = next;
      } while (cur !== start);
      pts.pop(); // the loop closed back onto its start; Z draws that return
      parts.push(
        pts
          .map((k, i) => `${i === 0 ? 'M' : 'L'}${(k % v) * cell} ${Math.floor(k / v) * cell}`)
          .join('') + 'Z',
      );
    }
  }
  return parts.join('');
}
