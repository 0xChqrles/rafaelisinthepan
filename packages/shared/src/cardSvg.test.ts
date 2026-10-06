// CONTRACT (light): the share-card SVG (packages/shared/src/cardSvg.ts) must render the
// player's RUN RULER — one cell per counted try on the SHARED heat ramp (so the card
// matches the on-screen ruler), a tick per solved secret with its sentence index under it —
// plus the count (the face's own glyph cells in the foil, or a plain `∞`), the run's heat
// cleared round it, and the day's calendar date.
// Exact positions are cosmetic and not asserted; they get tuned against the rasterized PNG.

import { describe, it, expect } from 'vitest';
import { anonName, defaultAvatar } from './assigned';
import { decodeAvatar, encodeAvatar, AVATAR_CELLS, AVATAR_PALETTES } from './avatar';
import {
  orbitPlaces,
  orbitTrail,
  plusLabelSize,
  plusTile,
  renderCardSvg,
  renderGroupCardSvg,
  runEdges,
  shareHeadline,
  CARD_WIDTH,
} from './cardSvg';
import { dateForDayNumber, dayNumber } from './day';
import { COUNT_ROWS } from './countCells';
import { FOIL_WHITE, foilInkRgb } from './foil';
import { INFINITY_GLYPH } from './glyphs';
import { progressHeatColor } from './heat';
import { GROUP_NAME_MAX_LENGTH, NAME_MAX_LENGTH } from './name';
import { GROUP_MEMBERS_MAX } from './scores';

// The ruler's cells: the run group's rects that are a bar's height (the ticks overhang it).
const BAR = { x: 64, w: 1072, h: 24 };
function cellRects(svg: string): { x: number; y: number; w: number; fill: string }[] {
  const run = /<g class="run"[^>]*>(.*?)<\/g>/.exec(svg)![1];
  return [...run.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="([^"]+)"/g)]
    .filter((m) => Number(m[4]) === BAR.h)
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), fill: m[5] }));
}
// The sentence indices under the ticks, in the order drawn.
const indices = (svg: string) => [...svg.matchAll(/font-size="32"[^>]*>(\d+)</g)].map((m) => m[1]);
// A group's markup, by its class.
const group = (svg: string, name: string) => new RegExp(`<g class="${name}"[^>]*>(.*?)</g>(?=<(?:g class|text|clipPath|/svg))`).exec(svg)?.[1] ?? null;
// The axis-aligned rects a cell path is made of (`M x y h w v h h -w z` runs).
const runs = (d: string) =>
  [...d.matchAll(/M(-?\d+) (-?\d+)h(\d+)v(\d+)h-\d+z/g)].map(([, x, y, w, h]) => ({ x: +x, y: +y, w: +w, h: +h }));
// The count's own ink: its foil's cells — every path of the count but its glitter and glint.
const countInkRects = (svg: string) =>
  [...group(svg, 'count')!.matchAll(/<path d="([^"]+)" fill="[^"]+"\/>/g)].flatMap((m) => runs(m[1]));
// The ink's band, and the font pixel it is COUNT_ROWS of.
function band(svg: string) {
  const ink = countInkRects(svg);
  const top = Math.min(...ink.map((r) => r.y));
  const bottom = Math.max(...ink.map((r) => r.y + r.h));
  return { ink, top, bottom, fpx: (bottom - top) / COUNT_ROWS };
}
// The card's 4px cells a set of runs covers, as "x,y" keys.
const cellKeys = (rects: { x: number; y: number; w: number; h: number }[]) => {
  const keys = new Set<string>();
  for (const r of rects) for (let y = r.y; y < r.y + r.h; y += 4) for (let x = r.x; x < r.x + r.w; x += 4) keys.add(`${x},${y}`);
  return keys;
};

describe('renderCardSvg', () => {
  const data = {
    lang: 'en',
    dayNumber: 123,
    score: 6,
    trajectory: [8, 8, 33, 33, 70, 100],
    solvedAt: [3, 6, 5],
  };

  it('renders one <rect> per counted try (plus the background and one per tick)', () => {
    const svg = renderCardSvg(data);
    const rects = svg.match(/<rect /g) ?? [];
    expect(rects).toHaveLength(1 + data.trajectory.length + 3); // bg + 6 cells + 3 ticks
  });

  it('colors each cell with the SHARED heat ramp (matches the on-screen ruler)', () => {
    const svg = renderCardSvg(data);
    for (const pct of data.trajectory) expect(svg).toContain(`fill="${progressHeatColor(pct)}"`);
  });

  it('marks each solved secret with its sentence index (1..3), in sentence order', () => {
    const svg = renderCardSvg(data);
    expect(indices(svg)).toEqual(['1', '3', '2']); // ticks ordered by try: 3 -> hole 1, 5 -> 3, 6 -> 2
  });

  it('draws no tick for a secret the run never solved', () => {
    const svg = renderCardSvg({ ...data, solvedAt: [3, null, null] });
    expect(svg.match(/<rect /g) ?? []).toHaveLength(1 + 6 + 1);
    expect(indices(svg)).toEqual(['1']);
  });

  it('shows the try count (unit named — lower is better) and the day as its calendar date', () => {
    const svg = renderCardSvg(data);
    expect(svg).toContain('class="count" data-count="6"');
    expect(svg).toContain('>TRIES</text>');
    // The token carries the day INDEX; the card draws the date that index IS — the server's
    // game day in every timezone (dateForDayNumber is dayNumber's inverse), never "#123"
    // and never the reader's local date.
    expect(svg).toContain(dateForDayNumber(123));
    expect(svg).toContain('1970-05-04');
    expect(svg).not.toContain('#123');
  });

  it('names the day by its date — the internal index is only the edition number, as on the screen', () => {
    const day = dayNumber('2026-08-02');
    const svg = renderCardSvg({ ...data, dayNumber: day });
    expect(svg).toMatch(/class="day"[^>]*>2026-08-02<\/text>/);
    expect(svg).toMatch(new RegExp(`class="edition"[^>]*>N\\.${day}</text>`));
    expect(svg.split(String(day))).toHaveLength(2);
    const bonus = renderCardSvg({ ...data, dayNumber: undefined, bonusId: 1234567 });
    // A bonus is no day: named as its headline names it, with no edition number.
    expect(bonus).toMatch(/class="day"[^>]*>BONUS 1234567<\/text>/);
    expect(bonus).not.toContain('class="edition"');
  });

  it('draws a solved count in the FOIL, on the face\'s own cells, its heat cleared round it', () => {
    const trajectory = Array.from({ length: 23 }, (_, i) => Math.min(100, 10 + 4 * i));
    const svg = renderCardSvg({ ...data, score: 23, trajectory, solvedAt: [7, 15, 23] });
    const count = group(svg, 'count')!;
    // The foil's own inks, and white: every fill of the count is one of them.
    const inks = new Set([FOIL_WHITE, ...Array.from({ length: 24 }, (_, k) => k)].map((k) => {
      if (k !== FOIL_WHITE && k % 4 === 0) return null;
      const [r, g, b] = foilInkRgb(k);
      return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    }));
    const fills = [...count.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]);
    expect(fills.length).toBeGreaterThan(2);
    for (const fill of fills) expect(inks.has(fill), fill).toBe(true);
    // The count's ink is the face's 7 cap rows of a whole font pixel.
    const { ink, fpx } = band(svg);
    expect(Number.isInteger(fpx)).toBe(true);
    expect(fpx % 8).toBe(0);
    // The heat wears the run's own inks, and never stands on the count.
    const heat = group(svg, 'heat')!;
    const ramp = new Set(trajectory.map(progressHeatColor));
    for (const [, fill] of heat.matchAll(/fill="([^"]+)"/g)) expect(ramp.has(fill)).toBe(true);
    const cells = [...heat.matchAll(/d="([^"]+)"/g)].flatMap((m) => runs(m[1]));
    expect(cells.length).toBeGreaterThan(50);
    const onInk = cellKeys(ink);
    for (const key of cellKeys(cells)) expect(onInk.has(key), key).toBe(false);
  });

  // A still cannot twinkle: a white cross hanging off the last digit's top right reads as a
  // plus sign ("23+ tries"), and a star cut by the glyph's edge reads as a notch.
  it('keeps the still\'s shine on the count: the glint inside its ink\'s span, every glitter star on its ink', () => {
    for (const score of [10, 23, 47, 99, 137, 499, 500, 1000, 32767]) {
      const svg = renderCardSvg({ ...data, score, trajectory: Array.from({ length: Math.min(score, 600) }, () => 50), solvedAt: [1, 2, 3] });
      const { ink } = band(svg);
      const left = Math.min(...ink.map((r) => r.x));
      const right = Math.max(...ink.map((r) => r.x + r.w));
      const glint = /class="glints" d="([^"]+)"/.exec(group(svg, 'count')!);
      for (const r of glint ? runs(glint[1]) : []) {
        expect(r.x, `${score}`).toBeGreaterThanOrEqual(left);
        expect(r.x + r.w, `${score}`).toBeLessThanOrEqual(right);
      }
      const glitter = /class="glitter" d="([^"]+)"/.exec(group(svg, 'count')!);
      const onInk = cellKeys(ink);
      for (const key of cellKeys(glitter ? runs(glitter[1]) : [])) expect(onInk.has(key), `${score} @${key}`).toBe(true);
    }
  });

  it('is deterministic: the same token draws the same bytes (the edge caches it a year)', () => {
    const trajectory = Array.from({ length: 137 }, (_, i) => Math.min(100, Math.round(i * 0.8)));
    const result = { ...data, score: 137, trajectory, solvedAt: [41, 137, 96] };
    expect(renderCardSvg(result)).toBe(renderCardSvg(result));
    const by = { publicId: 'abcdefghij234567', name: 'Chqrles', avatar: null };
    expect(renderCardSvg(result, by)).toBe(renderCardSvg(result, by));
  });

  it('draws every score a token can carry, its count inside the card', () => {
    for (const score of [1, 9, 10, 99, 100, 499, 500, 1000, 9999, 10000, 32767]) {
      const svg = renderCardSvg({ ...data, score, trajectory: Array.from({ length: score }, () => 50), solvedAt: [1, 2, 3] });
      const ink = countInkRects(svg);
      expect(ink.length).toBeGreaterThan(0);
      expect(Math.min(...ink.map((r) => r.x))).toBeGreaterThanOrEqual(BAR.x);
      expect(Math.max(...ink.map((r) => r.x + r.w))).toBeLessThanOrEqual(BAR.x + BAR.w);
    }
  });

  it('uses the singular for one try', () => {
    expect(renderCardSvg({ ...data, score: 1 })).toContain('>TRY</text>');
    expect(renderCardSvg({ ...data, score: 1 })).not.toContain('>TRIES</text>');
  });

  it('localizes the unit by the token language (fr -> ESSAIS/ESSAI)', () => {
    expect(renderCardSvg({ ...data, lang: 'fr' })).toContain('>ESSAIS</text>');
    expect(renderCardSvg({ ...data, lang: 'fr', score: 1 })).toContain('>ESSAI</text>');
  });

  it('falls back to en for an unknown language', () => {
    expect(renderCardSvg({ ...data, lang: 'zz' })).toContain('>TRIES</text>');
  });

  it('is a well-formed standalone svg at OG dimensions', () => {
    const svg = renderCardSvg(data);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
  });

  it('keeps a long run (300 tries) inside the card, one cell per try, no gaps', () => {
    const trajectory = Array.from({ length: 300 }, (_, i) => (100 * (i + 1)) / 300);
    const svg = renderCardSvg({ lang: 'en', dayNumber: 300, score: 300, trajectory, solvedAt: [120, 240, 300] });
    const cells = cellRects(svg);
    expect(cells).toHaveLength(300);
    for (const { x, w } of cells) {
      expect(w).toBeGreaterThanOrEqual(1); // never a zero-width sliver
      expect(x + w).toBeLessThanOrEqual(CARD_WIDTH);
    }
    // Contiguous: each cell starts where the previous one ended — no seams in the bar.
    for (let i = 1; i < cells.length; i += 1) {
      expect(cells[i].x).toBe(cells[i - 1].x + cells[i - 1].w);
    }
  });

  it('bounds the rect count by the CARD, not by the token (a forged score can not blow it up)', () => {
    // The token's score field holds 15 bits, so a hand-built one can declare ~32k tries and
    // the decoder will hand us that many cells. Below one pixel per cell the extra rects are
    // invisible — they only stack — so the renderer must collapse them instead of asking the
    // rasterizer to draw 32k of them on every /og cache miss.
    const trajectory = Array.from({ length: 32_767 }, (_, i) => (100 * (i + 1)) / 32_767);
    const svg = renderCardSvg({ lang: 'en', dayNumber: 300, score: 32_767, trajectory, solvedAt: [1, 2, 3] });
    const cells = cellRects(svg);
    expect(cells.length).toBeLessThanOrEqual(CARD_WIDTH);
    // Still the same bar: contiguous, every cell at least a pixel, none past the edge.
    for (const { x, w } of cells) {
      expect(w).toBeGreaterThanOrEqual(1);
      expect(x + w).toBeLessThanOrEqual(CARD_WIDTH);
    }
    for (let i = 1; i < cells.length; i += 1) {
      expect(cells[i].x).toBe(cells[i - 1].x + cells[i - 1].w);
    }
    // And it still spans the full bar — collapsing cells must not shorten the run.
    const last = cells[cells.length - 1];
    expect(last.x + last.w).toBe(cells[0].x + BAR.w);
  });

  // #214: a round that ended unsolved (given up, or capped) ends at `∞`. Neither of the card's
  // two faces has such a glyph and the rasterizer loads no other font, so the card DRAWS it
  // from the shared path data — the same path the on-screen result draws, which is why it
  // lives in one module. It wears no foil: the shine is a solve's.
  describe('the CAPPED headline', () => {
    const capped = { ...data, capped: true, solvedAt: [] };
    const infinity = (svg: string) =>
      /class="infinity" transform="translate\((\d+) (\d+)\) scale\((\d+)\)"/.exec(svg)!.slice(1).map(Number);

    it('draws the glyph PATH, plain white, and names no count', () => {
      const svg = renderCardSvg(capped);
      expect(svg).toContain(INFINITY_GLYPH.path);
      expect(svg).toContain(`<path d="${INFINITY_GLYPH.path}" fill="#ffffff"/>`);
      expect(svg).toContain('>TRIES</text>');
      expect(svg).not.toContain('class="count"');
    });

    it('keeps the unit PLURAL — there is no count for a "1" to agree with', () => {
      expect(renderCardSvg({ ...capped, score: 1 })).toContain('TRIES');
      expect(renderCardSvg({ ...capped, score: 1 })).not.toContain('TRY');
      expect(renderCardSvg({ ...capped, lang: 'fr' })).toContain('ESSAIS');
    });

    it('still draws the whole ruler — the cap changes the headline, not the run', () => {
      const svg = renderCardSvg(capped);
      const rects = svg.match(/<rect /g) ?? [];
      expect(rects).toHaveLength(1 + data.trajectory.length); // bg + 6 cells, no ticks
    });

    it('sets the glyph on the COUNT\'s own grid: whole font pixels, centred in the digits\' band', () => {
      const [, gy, cell] = infinity(renderCardSvg(capped));
      // A two-digit count's band, on a card laid out identically.
      const { top, fpx } = band(renderCardSvg({ ...data, score: 58 }));
      expect(cell).toBe(fpx);
      expect(gy - top).toBe(((COUNT_ROWS - INFINITY_GLYPH.height) / 2) * fpx);
    });

    it('keeps the headline inside the card at both the glyph and the word', () => {
      const svg = renderCardSvg({ ...capped, lang: 'fr' }, { publicId: 'abcdefghij234567', name: 'W'.repeat(NAME_MAX_LENGTH), avatar: null });
      const [gx, , cell] = infinity(svg);
      expect(gx).toBeGreaterThan(0);
      expect(gx + INFINITY_GLYPH.width * cell).toBeLessThan(CARD_WIDTH);
      // The unit stands centred under the glyph, inside the card: the mono advances 0.65em a
      // glyph, plus its tracking between glyphs.
      const unit = /<text x="(\d+)" y="\d+" text-anchor="start"[^>]*font-size="(\d+)" letter-spacing="([\d.]+)"[^>]*>ESSAIS<\/text>/.exec(svg)!;
      const [unitX, size, tracking] = unit.slice(1).map(Number);
      const unitW = 6 * 0.65 * size + 5 * tracking;
      expect(Math.abs(unitX + unitW / 2 - (gx + (INFINITY_GLYPH.width * cell) / 2))).toBeLessThanOrEqual(1);
      expect(unitX + unitW).toBeLessThan(CARD_WIDTH);
    });

    it('leaves an ordinary result drawing its number', () => {
      const svg = renderCardSvg(data);
      expect(svg).toContain('data-count="6"');
      expect(svg).not.toContain(INFINITY_GLYPH.path);
    });
  });
});

// CONTRACT (#271): the group card carries THREE things and no fourth — the group's name,
// its members' marks, the app name. What is pinned here is the identity each mark
// resolves, not the layout: a card that drew a member differently from every board row
// would make one person two people, which is the reason `assigned.ts` lives in this
// package at all.
describe('renderGroupCardSvg', () => {
  const id = 'abcdefghij234567';
  const other = 'zwjxqk37xfkvtxqu';

  it('draws the group name and every member mark, stored or assigned', () => {
    const avatar = encodeAvatar(2, new Array<number>(AVATAR_CELLS).fill(0).map((_, i) => (i % 3 === 0 ? 1 : 0)));
    const svg = renderGroupCardSvg({
      name: 'Les_copains',
      members: [
        { publicId: id, name: 'Chqrles', avatar },
        { publicId: other, name: '', avatar: null },
      ],
    });
    // In the chrome's capitals, as the board sets it.
    expect(svg).toContain('>LES_COPAINS<');
    expect(svg).toContain(AVATAR_PALETTES[2].fg);
    const { palette } = decodeAvatar(defaultAvatar(other));
    expect(svg).toContain(AVATAR_PALETTES[palette].fg);
    expect(svg.match(/<clipPath /g)).toHaveLength(2);
  });

  it('says the app name, and nothing else besides the group', () => {
    const svg = renderGroupCardSvg({ name: 'Bureau', members: [{ publicId: id, name: '', avatar: null }] });
    const texts = [...svg.matchAll(/>([^<>]+)<\/text>/g)].map((m) => m[1]);
    expect(texts).toEqual(['BUREAU', 'WHIPPIN AI']);
  });

  it('folds a large group into six tiles: five marks and a +N count', () => {
    const members = Array.from({ length: 9 }, (_, i) => ({
      publicId: `member${String(i).padStart(10, '0')}`,
      name: '',
      avatar: null,
    }));
    const svg = renderGroupCardSvg({ name: 'Big', members });
    expect(svg.match(/<clipPath /g)).toHaveLength(5);
    expect(svg).toContain('>+4<');
  });

  it('keeps the +N count inside its tile, up to the members cap', () => {
    const members = Array.from({ length: GROUP_MEMBERS_MAX }, (_, i) => ({
      publicId: `member${String(i).padStart(10, '0')}`,
      name: '',
      avatar: null,
    }));
    const svg = renderGroupCardSvg({ name: 'Big', members });
    const label = `+${GROUP_MEMBERS_MAX - 5}`;
    const text = new RegExp(`<text x="(\\d+)" y="\\d+" font-family="'Press Start 2P'" font-size="(\\d+)"[^>]*>\\${label}<`).exec(svg)!;
    // The tile is the last one drawn before the lockup: the surface rect the count sits on.
    const tile = /<rect x="(\d+)" y="\d+" width="120" height="120" rx="4" fill="#14151c"\/>/.exec(svg)!;
    expect(Number(text[1])).toBeGreaterThan(Number(tile[1]));
    expect(Number(text[1]) + label.length * Number(text[2])).toBeLessThan(Number(tile[1]) + 120);
  });

  it('keeps the name chip clear of every mark, whatever the count and the name', () => {
    for (let count = 0; count <= 7; count += 1) {
      for (let glyphs = 1; glyphs <= GROUP_NAME_MAX_LENGTH; glyphs += 1) {
        const members = Array.from({ length: count }, (_, i) => ({ publicId: `member${String(i).padStart(10, '0')}`, name: '', avatar: null }));
        const svg = renderGroupCardSvg({ name: 'W'.repeat(glyphs), members });
        const [, cx, cy, cw, ch] = /<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="#ffffff"\/>/.exec(svg)!.map(Number);
        for (const [, tx, ty] of svg.matchAll(/<clipPath id="member\d+"><rect x="(\d+)" y="(\d+)"/g)) {
          const x = Number(tx);
          const y = Number(ty);
          const apart = x >= cx + cw || cx >= x + 120 || y >= cy + ch || cy >= y + 120;
          expect(apart, `${count} members, ${glyphs} glyphs`).toBe(true);
        }
      }
    }
  });

  it('still draws a face for a stored string that will not decode', () => {
    const svg = renderGroupCardSvg({ name: 'X', members: [{ publicId: id, name: '', avatar: 'not-an-avatar' }] });
    const { palette } = decodeAvatar(defaultAvatar(id));
    expect(svg).toContain(AVATAR_PALETTES[palette].bg);
  });

  it('keeps a long name inside the card on ONE line', () => {
    const name = 'W'.repeat(GROUP_NAME_MAX_LENGTH);
    const svg = renderGroupCardSvg({ name, members: [] });
    const size = Number(/font-size="(\d+)"[^>]*>W+<\/text>/.exec(svg)![1]);
    expect(name.length * size).toBeLessThan(CARD_WIDTH);
    expect(svg.match(/<text /g)).toHaveLength(2);
  });
});

// The ORBIT is one drawing on the card and on the invite landing that continues it (web
// `GroupOrbit`): the places, the trail and the `+N` tile are read off these three, never
// re-derived, so the landing stands its marks where the card does at any size.
describe('the orbit pieces', () => {
  it('stands its tiles clockwise from the top on whole pixels, an even count turned half a step', () => {
    const [top, ...rest] = orbitPlaces(3, 200, 300, 150, 180, 60);
    // An odd count: the first tile on the top of the orbit, centred on its axis.
    expect(top).toEqual({ x: 170, y: 90 });
    // Clockwise: the next one to the right of the axis, the last to its left.
    expect(rest[0].x).toBeGreaterThan(170);
    expect(rest[1].x).toBeLessThan(170);
    // An even count stands no tile right over the middle.
    for (const { x } of orbitPlaces(2, 200, 300, 150, 180, 60)) expect(x + 30).not.toBe(200);
    for (const { x, y } of orbitPlaces(6, 200.5, 300.5, 150.5, 180.5, 60)) {
      expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
    }
  });

  it('draws its trail in whole cells of the grid asked for, and never inside a box it clears', () => {
    const tile = { x: 140, y: 80, w: 60, h: 60 };
    const d = orbitTrail({ width: 400, height: 600, cx: 200, cy: 300, rx: 150, ry: 180, cell: 2, clear: [tile] });
    const runs = [...d.matchAll(/M(\d+) (\d+)h(-?\d+)v(\d+)/g)].map((m) => m.slice(1).map(Number));
    expect(runs.length).toBeGreaterThan(0);
    for (const [x, y, w, h] of runs) {
      expect(x % 2 === 0 && y % 2 === 0 && w % 2 === 0 && h === 2).toBe(true);
      const inside = x < tile.x + tile.w && x + w > tile.x && y < tile.y + tile.h && y + h > tile.y;
      expect(inside).toBe(false);
    }
  });

  it('writes the +N count on its checker tile, inside it, at the size asked for', () => {
    const tile = plusTile(10, 20, 60, 45, { size: 16, padX: 0, padY: 4, radius: 0 });
    expect(tile).toContain('>+45<');
    expect(tile).toContain('font-size="16"');
    expect(tile).not.toContain(' rx=');
    const [, x] = /<text x="(\d+)"/.exec(tile)!.map(Number);
    expect(x).toBeGreaterThanOrEqual(10);
    expect(x + 3 * 16).toBeLessThanOrEqual(10 + 60);
    // The cut-out is the label's box and the padding asked for, across and down.
    const [, , , w, h] = /<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="#050507"\/>/.exec(tile)!.map(Number);
    expect([w, h]).toEqual([48, 24]);
  });

  it('sizes the +N count in the card’s proportion to its tile, the one rule for every tile', () => {
    expect(plusLabelSize(4, 120)).toBe(40);
    expect(plusLabelSize(45, 120)).toBe(32);
    expect(plusLabelSize(4, 60)).toBe(20);
    const nine = Array.from({ length: 9 }, (_, i) => ({ publicId: `member${String(i).padStart(10, '0')}`, name: '', avatar: null }));
    expect(renderGroupCardSvg({ name: 'Big', members: nine })).toMatch(/font-size="40"[^>]*>\+4</);
  });
});

// The cards are SVG a browser reads too (the landing draws the `+N` tile inline): every family
// they name has to be one CSS keeps — a bare `Press Start 2P` is not (`2P` is no identifier),
// and a browser drops the whole attribute for its fallback face.
describe('the card’s font families', () => {
  it('names every family as CSS reads it, quoted where it is no identifier', () => {
    const members = Array.from({ length: 9 }, (_, i) => ({ publicId: `member${String(i).padStart(10, '0')}`, name: '', avatar: null }));
    const svgs = [
      renderGroupCardSvg({ name: 'Big', members }),
      renderCardSvg({ lang: 'en', dayNumber: 123, score: 6, trajectory: [8, 8, 33, 33, 70, 100], solvedAt: [2, 5, 6] }),
    ];
    for (const svg of svgs) {
      const families = [...svg.matchAll(/font-family="([^"]*)"/g)].map((m) => m[1]);
      expect(families.length).toBeGreaterThan(0);
      for (const family of families) {
        const bare = /^'[^']+'$/.test(family) ? undefined : family.split(/\s+/).find((word) => !/^[A-Za-z_-][\w-]*$/.test(word));
        expect(bare, family).toBeUndefined();
      }
    }
  });
});

// CONTRACT (user-decided 2026-09-05): a SIGNED share — every share the result screens make
// from a device holding an account — draws the player's mark and name on the result card,
// and a plain share draws neither. The signature is QUIET — the mark small and the name beside
// it, on the top row before the day — so the count stays the subject: signing never changes
// the RESULT drawn, and the widest signature (the profile's own cap) stands between what the
// row holds at its left (the lockup, and a day's edition) and the day.
describe('a signed result card (the share link wearing its player)', () => {
  const id = 'abcdefghij234567';
  const sentence = {
    lang: 'en',
    dayNumber: 123,
    score: 6,
    trajectory: [8, 8, 33, 33, 70, 100],
    solvedAt: [3, 6, 5],
  };

  it('draws the stored name and mark on the sentence card', () => {
    const avatar = encodeAvatar(2, new Array<number>(AVATAR_CELLS).fill(0).map((_, i) => (i % 3 === 0 ? 1 : 0)));
    const svg = renderCardSvg(sentence, { publicId: id, name: 'Chqrles', avatar });
    expect(svg).toContain('>Chqrles<');
    expect(svg).toContain(AVATAR_PALETTES[2].fg);
    // The result is still the card's subject: the count and the date are untouched.
    expect(svg).toContain('data-count="6"');
    expect(svg).toContain(dateForDayNumber(123));
  });

  it('draws the ASSIGNED identity for a player who never customized', () => {
    const svg = renderCardSvg(sentence, { publicId: id, name: '', avatar: null });
    expect(svg).toContain(`>${anonName(id)}<`);
    const { palette } = decodeAvatar(defaultAvatar(id));
    expect(svg).toContain(AVATAR_PALETTES[palette].bg);
    expect(svg).toContain('data-count="6"');
  });

  it('draws no face on a plain share', () => {
    const svg = renderCardSvg(sentence);
    expect(svg).not.toContain('id="sign"');
    expect(svg).not.toContain(anonName(id));
  });

  it('draws the same RESULT signed or not — the count, its heat and the run untouched', () => {
    const signed = renderCardSvg(sentence, { publicId: id, name: 'Chqrles', avatar: null });
    const plain = renderCardSvg(sentence);
    for (const name of ['count', 'heat', 'run']) expect(group(signed, name)).toBe(group(plain, name));
    // The signature stands on the top row, above the count.
    const tile = /<g id="sign" transform="translate\(\d+ (\d+)\)"[^>]*><rect width="(\d+)"/.exec(signed)!;
    expect(Number(tile[1]) + Number(tile[2])).toBeLessThan(band(signed).top);
  });

  it('keeps the widest signature on the top row, between the lockup (and the edition) and the day', () => {
    const name = 'W'.repeat(NAME_MAX_LENGTH);
    for (const result of [sentence, { ...sentence, dayNumber: 20729 }, { ...sentence, dayNumber: undefined, bonusId: 9999999 }]) {
      const svg = renderCardSvg(result, { publicId: id, name, avatar: null });
      // What the row holds at its left: the lockup's name, then a day's edition (a bonus has none).
      const lockup = /<text x="(\d+)"[^>]*font-size="(\d+)" letter-spacing="([\d.]+)"[^>]*>WHIPPIN AI</.exec(svg)!;
      const [lx, ls, lt] = lockup.slice(1).map(Number);
      const edition = /<text class="edition" x="(\d+)"[^>]*font-size="(\d+)"[^>]*>([^<]+)</.exec(svg);
      const leftEnd = edition
        ? Number(edition[1]) + edition[3].length * Number(edition[2])
        : lx + 10 * 0.65 * ls + 9 * lt;
      const tile = /<g id="sign" transform="translate\((\d+) /.exec(svg)!;
      expect(Number(tile[1])).toBeGreaterThan(leftEnd);
      const signedName = new RegExp(`<text x="(\\d+)"[^>]*font-size="(\\d+)" letter-spacing="([\\d.]+)"[^>]*>${name}<`).exec(svg)!;
      const [nameX, size, tracking] = signedName.slice(1).map(Number);
      const day = Number(/<text class="day" x="(\d+)"/.exec(svg)![1]);
      expect(nameX + name.length * 0.65 * size + (name.length - 1) * tracking).toBeLessThan(day);
    }
  });
});

// CONTRACT: a shared result's first line — the message the web composes, the title the
// preview page carries, and the line the WhatsApp bot recognizes to drop a generated share.
describe('shareHeadline — the message\'s first line', () => {
  it('names the day by its CALENDAR DATE, never the internal index', () => {
    const day = dayNumber('2026-08-11');
    expect(shareHeadline({ dayNumber: day }, 12, 'essais')).toBe('Whippin AI 2026-08-11 — 12 essais');
    // The index says nothing to a reader, and the archive URL the link resolves to spells
    // the date — so the message has to spell it too.
    expect(shareHeadline({ dayNumber: day }, 12, 'essais')).not.toContain(String(day));
  });

  it('names a BONUS puzzle by its id — it is no day', () => {
    expect(shareHeadline({ bonusId: 1234567 }, 12, 'essais')).toBe('Whippin AI BONUS 1234567 — 12 essais');
  });

  it('carries a capped round\'s literal ∞ where the count would be', () => {
    expect(shareHeadline({ dayNumber: dayNumber('2026-08-11') }, '∞', 'tries')).toBe(
      'Whippin AI 2026-08-11 — ∞ tries',
    );
  });
});

// The run's cell edges are ONE spelling for the card and the solved screen's ruler (web
// `RunRuler`): whole pixels tiling the bar exactly, so the two draw the same cells and stand
// a solve's tick on the same edge.
describe('runEdges — the ruler\'s cells on whole pixels', () => {
  it('tiles the bar exactly: from 0 to its width, one edge more than the tries', () => {
    for (const [n, width] of [[1, 330], [3, 330], [23, 330], [137, 260], [500, 616]]) {
      const edges = runEdges(n, width);
      expect(edges).toHaveLength(n + 1);
      expect(edges[0]).toBe(0);
      expect(edges[n]).toBe(width);
      for (const edge of edges) expect(Number.isInteger(edge)).toBe(true);
      for (let i = 1; i <= n; i += 1) expect(edges[i]).toBeGreaterThanOrEqual(edges[i - 1]);
    }
  });

  it('gives every try a cell while the bar has a pixel for each', () => {
    const edges = runEdges(23, 330);
    for (let i = 0; i < 23; i += 1) expect(edges[i + 1] - edges[i]).toBeGreaterThanOrEqual(14);
  });

  it('is the card\'s own bar: its cells start on these edges', () => {
    const trajectory = Array.from({ length: 23 }, (_, i) => (100 * (i + 1)) / 23);
    const svg = renderCardSvg({ lang: 'en', dayNumber: 300, score: 23, trajectory, solvedAt: [7, 15, 23] });
    expect(cellRects(svg).map((cell) => cell.x - BAR.x)).toEqual(runEdges(23, BAR.w).slice(0, 23));
  });
});
