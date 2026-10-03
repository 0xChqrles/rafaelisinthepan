// CONTRACT (light): the share-card SVG (packages/shared/src/cardSvg.ts) must render the
// player's RUN RULER — one cell per counted try on the SHARED heat ramp (so the card
// matches the on-screen ruler), a tick per solved secret with its sentence index under it —
// plus the score and the day's calendar date.
// Exact positions are cosmetic and not asserted; they get tuned against the rasterized PNG.

import { describe, it, expect } from 'vitest';
import { anonName, defaultAvatar } from './assigned';
import { decodeAvatar, encodeAvatar, AVATAR_CELLS, AVATAR_PALETTES } from './avatar';
import { renderCardSvg, renderGroupCardSvg, runEdges, shareHeadline, CARD_WIDTH } from './cardSvg';
import { dateForDayNumber, dayNumber } from './day';
import { INFINITY_EM_HEIGHT, INFINITY_GLYPH, PIXEL_INK_LIFT_EM } from './glyphs';
import { progressHeatColor } from './heat';
import { GROUP_NAME_MAX_LENGTH, NAME_MAX_LENGTH } from './name';
import { GROUP_MEMBERS_MAX } from './scores';

// The ruler's cells: the run group's rects that are a bar's height (the ticks overhang it).
const BAR = { x: 64, w: 1072, h: 48 };
function cellRects(svg: string): { x: number; y: number; w: number; fill: string }[] {
  const run = /<g class="run"[^>]*>(.*?)<\/g>/.exec(svg)![1];
  return [...run.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="([^"]+)"/g)]
    .filter((m) => Number(m[4]) === BAR.h)
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), fill: m[5] }));
}
// The sentence indices under the ticks, in the order drawn.
const indices = (svg: string) => [...svg.matchAll(/font-size="32"[^>]*>(\d+)</g)].map((m) => m[1]);

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
    expect(svg).toContain('>6</text>');
    expect(svg).toContain('>TRIES</text>');
    // The token carries the day INDEX; the card draws the date that index IS — the server's
    // game day in every timezone (dateForDayNumber is dayNumber's inverse), never "#123"
    // and never the reader's local date.
    expect(svg).toContain(dateForDayNumber(123));
    expect(svg).toContain('1970-05-04');
    expect(svg).not.toContain('#123');
  });

  it('names the day by its date alone — the internal index appears nowhere', () => {
    const day = dayNumber('2026-08-02');
    const svg = renderCardSvg({ ...data, dayNumber: day });
    expect(svg).toContain('>2026-08-02</text>');
    expect(svg).not.toContain(String(day));
    expect(renderCardSvg({ ...data, dayNumber: undefined, bonusId: 1234567 })).toContain('>BONUS 1234567</text>');
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

  // #214: a capped round ends at `∞`. Neither of the card's two faces has such a glyph and
  // the rasterizer loads no other font, so the card DRAWS it from the shared path data —
  // the same path the on-screen result draws, which is why it lives in one module.
  describe('the CAPPED headline', () => {
    const capped = { ...data, capped: true, solvedAt: [] };

    it('draws the glyph PATH and names no count', () => {
      const svg = renderCardSvg(capped);
      expect(svg).toContain(INFINITY_GLYPH.path);
      expect(svg).toContain('>TRIES</text>');
      expect(svg).not.toContain('>6</text>');
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

    it('sets the glyph in the TYPE\'s own band, on WHOLE cells', () => {
      // Measured off the rasterized card: Press Start 2P reserves descender room under
      // every glyph, so a shape whose bottom sits ON the baseline reads visibly low and
      // short beside the word. The glyph fills the digits' cap height on whole cells (the
      // pixel-art rule), its ink bottom where the digits' is — measured against a card laid
      // out identically, one whose run never solved (no ticks, like a capped one).
      const glyph = (svg: string) => /class="infinity" transform="translate\((\d+) (\d+)\) scale\((\d+)\)"/.exec(svg)!;
      const [, , gy, cell] = glyph(renderCardSvg(capped)).map(Number);
      const size = 160; // the count's font size
      expect(Number.isInteger(cell)).toBe(true);
      expect(Math.abs(INFINITY_GLYPH.height * cell - INFINITY_EM_HEIGHT * size)).toBeLessThanOrEqual(cell / 2);
      const plain = renderCardSvg({ ...data, solvedAt: [null, null, null] });
      const baseline = Number(/<text x="\d+" y="(\d+)"[^>]*font-size="160"/.exec(plain)![1]);
      expect(gy + INFINITY_GLYPH.height * cell).toBe(baseline - Math.round(PIXEL_INK_LIFT_EM * size));
    });

    it('keeps the headline inside the card at both the glyph and the word', () => {
      const svg = renderCardSvg({ ...capped, lang: 'fr' }, { publicId: 'abcdefghij234567', name: 'W'.repeat(NAME_MAX_LENGTH), avatar: null });
      const [, gx, , cell] = /class="infinity" transform="translate\((\d+) (\d+)\) scale\((\d+)\)"/.exec(svg)!.map(Number);
      expect(gx).toBeGreaterThan(0);
      expect(gx + INFINITY_GLYPH.width * cell).toBeLessThan(CARD_WIDTH);
      // The unit stands centred under the glyph, inside the card.
      const unitX = Number(/<text x="(\d+)" y="\d+" text-anchor="middle"[^>]*>ESSAIS<\/text>/.exec(svg)![1]);
      expect(Math.abs(unitX - (gx + (INFINITY_GLYPH.width * cell) / 2))).toBeLessThanOrEqual(1);
      expect(unitX).toBeLessThan(CARD_WIDTH);
    });

    it('leaves an ordinary result drawing its number', () => {
      const svg = renderCardSvg(data);
      expect(svg).toContain('>6</text>');
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
    const text = new RegExp(`<text x="(\\d+)" y="\\d+" font-family="Press Start 2P" font-size="(\\d+)"[^>]*>\\${label}<`).exec(svg)!;
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

// CONTRACT (user-decided 2026-09-05): a SIGNED share — every share the result screens make
// from a device holding an account — draws the player's mark and name on the result card,
// and a plain share draws neither. The mark is the portrait beside the count, the name in
// the title chip under it; signing never changes the RESULT drawn, and the widest
// signature (the profile's own cap) keeps the card's column.
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
    expect(svg).toContain('>6</text>');
    expect(svg).toContain(dateForDayNumber(123));
  });

  it('draws the ASSIGNED identity for a player who never customized', () => {
    const svg = renderCardSvg(sentence, { publicId: id, name: '', avatar: null });
    expect(svg).toContain(`>${anonName(id)}<`);
    const { palette } = decodeAvatar(defaultAvatar(id));
    expect(svg).toContain(AVATAR_PALETTES[palette].bg);
    expect(svg).toContain('>6</text>');
  });

  it('draws no face on a plain share', () => {
    expect(renderCardSvg(sentence)).not.toContain('clipPath');
  });

  it('draws the same RESULT signed or not: the run, rect for rect, only moved', () => {
    const signed = renderCardSvg(sentence, { publicId: id, name: 'Chqrles', avatar: null });
    const plain = renderCardSvg(sentence);
    // The run group (cells, ticks, indices) with every y taken relative to the bar's top.
    const run = (svg: string) => {
      const bar = cellRects(svg)[0].y;
      const group = /<g class="run"[^>]*>(.*?)<\/g>/.exec(svg)![1];
      return group.replace(/y="(\d+)"/g, (_, y) => `y="${Number(y) - bar}"`);
    };
    expect(run(signed)).toBe(run(plain));
    // The whole portrait column — the tile and the name chip under it — clears the ticks.
    const tickTop = cellRects(signed)[0].y - 16;
    const tile = /<clipPath id="sign"><rect x="\d+" y="(\d+)" width="(\d+)"/.exec(signed)!;
    expect(Number(tile[1]) + Number(tile[2])).toBeLessThan(tickTop);
    const chip = /<rect x="\d+" y="(\d+)" width="\d+" height="(\d+)" fill="#ffffff"\/>/.exec(signed)!;
    expect(Number(chip[1]) + Number(chip[2])).toBeLessThan(tickTop);
  });

  it('keeps the widest signature inside the card\'s column, clear of the count', () => {
    const name = 'W'.repeat(NAME_MAX_LENGTH);
    const svg = renderCardSvg(sentence, { publicId: id, name, avatar: null });
    // The name's chip and the portrait start inside the column.
    const chip = /<rect x="(\d+)" y="\d+" width="(\d+)" height="\d+" fill="#ffffff"\/>/.exec(svg)!;
    expect(Number(chip[1])).toBeGreaterThanOrEqual(BAR.x);
    const tile = /<clipPath id="sign"><rect x="(\d+)"/.exec(svg)!;
    expect(Number(tile[1])).toBeGreaterThanOrEqual(BAR.x);
    // The count starts right of the chip, and ends inside the column.
    const count = /<text x="(\d+)" y="\d+" font-family="Press Start 2P" font-size="160"[^>]*>(\d+)</.exec(svg)!;
    expect(Number(count[1])).toBeGreaterThan(Number(chip[1]) + Number(chip[2]));
    expect(Number(count[1]) + count[2].length * 160).toBeLessThanOrEqual(BAR.x + BAR.w);
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
