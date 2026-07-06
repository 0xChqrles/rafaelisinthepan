import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { rankHeatColor } from '../components/Hole';
import type { RankEntry } from '@whippin/shared';

// The mix demo's word (#51, stage 1). Tutorial owns WHICH ladder entry is showing;
// this renders it with the real hole's markup, classes and heat ramp, so it is
// visually indistinguishable from the game. It cannot BE <Hole>: the game has no
// walk-away-from-the-secret mechanic, and the fast rolls must flash every
// intermediate word, which Hole's blink choreography deliberately prevents.
//
// The FIRST transition (the untouched blue secret -> its 1st neighbor) literally
// MIXES the word: its letters cycle through random glyphs and settle left-to-right
// into the new word, the exponent appearing once the letters have. Later transitions
// (the fast rolls) swap instantly — Tutorial's decelerating cadence is the animation.

// Exported so Tutorial can schedule the stop's explanation after the mix resolves.
export const SCRAMBLE_MS = 650;
const SCRAMBLE_TICK_MS = 40;
const GLYPHS = 'abcdefghijklmnopqrstuvwxyz';

function randomGlyphs(n: number): string {
  let out = '';
  for (let i = 0; i < n; i += 1) out += GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
  return out;
}

export default function MixWord({
  secret,
  entry,
  startRank,
}: {
  secret: string; // display form shown solved-blue before any mix
  entry: RankEntry | null; // current ladder word, or null = the untouched secret
  startRank: number; // heat scale (the ladder's landing rank)
}) {
  // Letter-scramble state: the in-flight jumble shown instead of the word, or null
  // when settled. Only the null -> entry transition scrambles.
  const [jumble, setJumble] = useState<string | null>(null);
  const prevEntry = useRef<RankEntry | null>(entry);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearInterval(timer.current), []);

  useEffect(() => {
    const prev = prevEntry.current;
    prevEntry.current = entry;
    if (!entry || prev) return; // rolls swap instantly; only the first mix scrambles
    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;

    const target = entry.word;
    const started = Date.now();
    setJumble(randomGlyphs(target.length));
    timer.current = window.setInterval(() => {
      const p = (Date.now() - started) / SCRAMBLE_MS;
      if (p >= 1) {
        window.clearInterval(timer.current);
        setJumble(null); // settled: the real word + its exponent take over
        return;
      }
      // Letters settle left to right as the mix resolves.
      const settled = Math.floor(p * target.length);
      setJumble(target.slice(0, settled) + randomGlyphs(target.length - settled));
    }, SCRAMBLE_TICK_MS);
  }, [entry]);

  const rankStyle: (CSSProperties & Record<'--rank-color', string>) | undefined = entry
    ? { '--rank-color': rankHeatColor(entry.rank, startRank) }
    : undefined;

  return (
    <p className="phrase">
      <span className={`hole${entry ? '' : ' resolved'}`}>
        <span className="hole-word-wrap">
          <span className="hole-word">{jumble ?? (entry ? entry.word : secret)}</span>
        </span>
        {entry && jumble == null && (
          <sup className="hole-rank" style={rankStyle}>
            -{entry.rank}
          </sup>
        )}
      </span>
    </p>
  );
}
