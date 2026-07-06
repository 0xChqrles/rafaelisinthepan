import { Fragment, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { rankHeatColor } from '../components/Hole';
import { heatColor } from '@whippin/shared';

// The tutorial's explanation text (#51): typewritten like a game dialog, with inline
// markup so words LOOK like what they are in-game:
//   [[b:word]]       the secret/target — blue, the solved color
//   [[w:word^rank]]  a hint word — gold with its heat-colored exponent, like a hole
//   [[m:word]]       a MISS word — the coldest heat color
//   [[n:123]]        a bare number — its heat color
// The FULL text is laid out from the first frame — every character rendered, the
// unrevealed ones merely invisible — so the wrap points are final before the first
// letter shows and a word being "typed" can never jump to the next line mid-word.
// The visible text is aria-hidden (a live region would announce every keystroke of
// the typewriter); callers pass richToPlain() to the screen-reader region instead.

type Seg =
  | { kind: 'plain'; text: string }
  | { kind: 'blue'; text: string }
  | { kind: 'miss'; text: string }
  | { kind: 'word'; text: string; rank: number }
  | { kind: 'num'; text: string; rank: number };

const TOKEN_RE = /\[\[([bwmn]):([^\]]+)\]\]/g;

export function parseRich(copy: string): Seg[] {
  const segs: Seg[] = [];
  let last = 0;
  for (const m of copy.matchAll(TOKEN_RE)) {
    if (m.index > last) segs.push({ kind: 'plain', text: copy.slice(last, m.index) });
    const [, tag, payload] = m;
    if (tag === 'b') segs.push({ kind: 'blue', text: payload });
    else if (tag === 'm') segs.push({ kind: 'miss', text: payload });
    else if (tag === 'n') segs.push({ kind: 'num', text: payload, rank: Number(payload) });
    else {
      const [word, rank] = payload.split('^');
      segs.push({ kind: 'word', text: word, rank: Number(rank) });
    }
    last = m.index + m[0].length;
  }
  if (last < copy.length) segs.push({ kind: 'plain', text: copy.slice(last) });
  return segs;
}

// The screen-reader equivalent: markup stripped, exponents spelled out.
export function richToPlain(copy: string): string {
  return parseRich(copy)
    .map((s) => (s.kind === 'word' ? `${s.text} -${s.rank}` : s.text))
    .join('');
}

// Typewriter budget of a segment: its characters, plus the exponent ("-200") for a
// hint word so the number types on after the word.
function segLen(s: Seg): number {
  return s.text.length + (s.kind === 'word' ? String(s.rank).length + 1 : 0);
}

const TYPE_MS = 18; // per character — brisk, game-dialog pace

// Numbers are colored on the same board scale as the demo (start = 100): 200 lands
// past the cold end, exactly like a far float in-game.
const TEXT_HEAT_SCALE = 100;

const HIDDEN: CSSProperties = { visibility: 'hidden' };

// Every character is ALWAYS rendered — hidden until the budget reaches it — so the
// paragraph's layout (and its wrap points) never changes while the text types on.
// One span per character keeps the browser's normal word-wrapping (breaks still
// happen at the spaces), it just gates each glyph's visibility.
function chars(text: string, budget: number) {
  return [...text].map((ch, i) => (
    // eslint-disable-next-line react/no-array-index-key -- static per copy string
    <span key={i} style={i < budget ? undefined : HIDDEN}>
      {ch}
    </span>
  ));
}

function renderSeg(s: Seg, budget: number, key: number) {
  if (s.kind === 'plain') return <Fragment key={key}>{chars(s.text, budget)}</Fragment>;
  if (s.kind === 'blue') {
    return (
      <span key={key} className="rt-blue">
        {chars(s.text, budget)}
      </span>
    );
  }
  if (s.kind === 'miss') {
    return (
      <span key={key} style={{ color: heatColor(0) }}>
        {chars(s.text, budget)}
      </span>
    );
  }
  if (s.kind === 'num') {
    return (
      <span key={key} style={{ color: rankHeatColor(s.rank, TEXT_HEAT_SCALE) }}>
        {chars(s.text, budget)}
      </span>
    );
  }
  // Hint word: gold, then its exponent types on in the heat color of its rank. The
  // sup is always in the layout too, so even ITS reveal moves nothing.
  const rankStyle: CSSProperties & Record<'--rank-color', string> = {
    '--rank-color': rankHeatColor(s.rank, TEXT_HEAT_SCALE),
  };
  return (
    <span key={key} className="rt-word">
      {chars(s.text, budget)}
      <sup className="hole-rank" style={rankStyle}>
        {chars(`-${s.rank}`, budget - s.text.length)}
      </sup>
    </span>
  );
}

export default function CoachText({ copy }: { copy: string }) {
  const segs = useMemo(() => parseRich(copy), [copy]);
  const total = segs.reduce((n, s) => n + segLen(s), 0);
  // Reduced motion: show the full text at once, no per-character reveal.
  const reduced =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const [shown, setShown] = useState(reduced ? total : 0);
  useEffect(() => {
    if (reduced) {
      setShown(total);
      return undefined;
    }
    setShown(0);
    const id = window.setInterval(
      () =>
        setShown((s) => {
          if (s >= total) {
            window.clearInterval(id);
            return s;
          }
          return s + 1;
        }),
      TYPE_MS,
    );
    return () => window.clearInterval(id);
  }, [copy, total, reduced]);

  let budget = shown;
  return (
    <p className="coach-text" aria-hidden="true">
      {segs.map((s, i) => {
        const el = renderSeg(s, budget, i);
        budget -= segLen(s);
        return el;
      })}
    </p>
  );
}
