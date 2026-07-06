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

function renderSeg(s: Seg, budget: number, key: number) {
  const take = Math.max(0, Math.min(budget, s.text.length));
  const shown = s.text.slice(0, take);
  if (s.kind === 'plain') return <Fragment key={key}>{shown}</Fragment>;
  if (s.kind === 'blue') {
    return (
      <span key={key} className="rt-blue">
        {shown}
      </span>
    );
  }
  if (s.kind === 'miss') {
    return (
      <span key={key} style={{ color: heatColor(0) }}>
        {shown}
      </span>
    );
  }
  if (s.kind === 'num') {
    return (
      <span key={key} style={{ color: rankHeatColor(s.rank, TEXT_HEAT_SCALE) }}>
        {shown}
      </span>
    );
  }
  // Hint word: gold, then its exponent types on in the heat color of its rank.
  const sup = `-${s.rank}`;
  const supTake = Math.max(0, Math.min(budget - s.text.length, sup.length));
  const rankStyle: CSSProperties & Record<'--rank-color', string> = {
    '--rank-color': rankHeatColor(s.rank, TEXT_HEAT_SCALE),
  };
  return (
    <span key={key} className="rt-word">
      {shown}
      {supTake > 0 && (
        <sup className="hole-rank" style={rankStyle}>
          {sup.slice(0, supTake)}
        </sup>
      )}
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
