import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { rankHeatColor } from '../components/Hole';
import type { RankEntry } from '@whippin/shared';

// The mix demo's word (#51, stage 1). Tutorial owns WHICH ladder entry is showing;
// this renders it with the real hole's markup, classes and heat ramp, so it is
// visually indistinguishable from the game. It cannot BE <Hole>: the game has no
// walk-away-from-the-secret mechanic, and the scramble must show raw glyph churn,
// which Hole's blink choreography deliberately prevents.
//
// EVERY press MIXES the word the same way (the slot-machine scramble): its letters
// cycle through random glyphs and settle left-to-right into the new word. The
// exponent is handled with care:
//   - first mix (blue secret -> -1): no exponent yet — it pops in 200ms AFTER the
//     letters settle;
//   - later mixes: the exponent stays on and TICKS through the real intermediate
//     ladder ranks while the letters churn (-2, -3 … -10), landing exactly as the
//     letters settle, then does its pop a beat later;
//   - its slot always reserves the LANDING rank's width (monospace font, ch units),
//     so neither the ticking digits nor the entrance ever shift the centered word.

// Exported so Tutorial can schedule the stop's explanation after the mix resolves.
export const SCRAMBLE_MS = 650;
const SCRAMBLE_TICK_MS = 40;
const EXPONENT_DELAY_MS = 200; // beat between the letters settling and the rank pop
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
  ladder,
}: {
  secret: string; // display form shown solved-blue before any mix
  entry: RankEntry | null; // the mix's LANDING entry (Tutorial sets it per press)
  startRank: number; // heat scale (the ladder's final landing rank)
  ladder: RankEntry[]; // real neighbors, rank ascending — the exponent's tick path
}) {
  // In-flight state: the letter jumble (null = settled), the rank the exponent is
  // ticking through (null = show the landing rank), whether the exponent has had its
  // first entrance yet, and a nonce that replays the pop on each landing.
  const [jumble, setJumble] = useState<string | null>(null);
  const [tickRank, setTickRank] = useState<number | null>(null);
  const [supIn, setSupIn] = useState(false);
  const [pop, setPop] = useState(0);
  const prevEntry = useRef<RankEntry | null>(entry);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  useEffect(() => {
    const prev = prevEntry.current;
    prevEntry.current = entry;
    if (!entry || entry === prev) return;
    timers.current.forEach(clearTimeout);
    timers.current = [];

    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setJumble(null);
      setTickRank(null);
      setSupIn(true);
      return;
    }

    // Letters: the scramble, settling left to right over SCRAMBLE_MS.
    const target = entry.word;
    const started = Date.now();
    setJumble(randomGlyphs(target.length));
    const scrambleId = window.setInterval(() => {
      const p = (Date.now() - started) / SCRAMBLE_MS;
      if (p >= 1) {
        window.clearInterval(scrambleId);
        setJumble(null); // letters settled…
        later(() => {
          setSupIn(true); // (no-op after the first mix)
          setPop((n) => n + 1); // …the exponent pops a beat later
        }, EXPONENT_DELAY_MS);
        return;
      }
      const settled = Math.floor(p * target.length);
      setJumble(target.slice(0, settled) + randomGlyphs(target.length - settled));
    }, SCRAMBLE_TICK_MS);
    timers.current.push(scrambleId);

    // Exponent: from the second mix on, tick through the REAL intermediate ladder
    // ranks, evenly across the scramble, landing with the letters. Holding the
    // PREVIOUS rank until the first tick is what keeps the landing a reveal — the
    // sup must never flash the destination at press time.
    if (prev) {
      setTickRank(prev.rank);
      const path = ladder
        .map((e) => e.rank)
        .filter((r) => r > prev.rank && r <= entry.rank);
      path.forEach((rank, i) => {
        later(() => setTickRank(rank), (SCRAMBLE_MS * (i + 1)) / path.length);
      });
      later(() => setTickRank(null), SCRAMBLE_MS); // hand back to the landing rank
    }
  }, [entry, ladder]);

  // The exponent's slot: rendered whenever there IS an entry, hidden (not
  // unrendered) until its first entrance, and always as wide as the LANDING rank
  // ("-100" = 4ch in this monospace font) — so ticking digits and the entrance
  // never shift the centered word.
  const supHidden = !supIn;
  const shownRank = tickRank ?? entry?.rank ?? 0;
  const rankStyle:
    | (CSSProperties & Record<'--rank-color', string>)
    | undefined = entry
    ? {
        '--rank-color': rankHeatColor(shownRank, startRank),
        visibility: supHidden ? 'hidden' : undefined,
        minWidth: `${String(entry.rank).length + 1}ch`,
      }
    : undefined;

  return (
    <p className="phrase">
      <span className={`hole${entry ? '' : ' resolved'}`}>
        <span className="hole-word-wrap">
          <span className="hole-word">{jumble ?? (entry ? entry.word : secret)}</span>
        </span>
        {entry && (
          <sup
            // Remount per pop so rank-pop replays on every landing.
            key={pop}
            className={`hole-rank${pop > 0 && !supHidden ? ' rank-pop' : ''}`}
            style={rankStyle}
          >
            -{shownRank}
          </sup>
        )}
      </span>
    </p>
  );
}
