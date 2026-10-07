import { useEffect, useMemo, useRef, useState } from 'react';
import MeterCanvas from '../../../components/MeterCanvas';
import { prefersReducedMotion } from '../../../hooks/useScramble';
import { useArticleLang } from '../lang';
import { easedStep, runSteps } from './steps';
import useSeen from './useSeen';

// PROBABILITIES AS THE GAME'S METER: one row per word, its bar the hole's own CHARGE
// (`MeterCanvas`, the chip's Bayer fill on 2px cells) charged to its share of the largest, the
// front thinning into the dither the way a chip short of full ends — in the SLATE, never the
// meter's cobalt: cobalt is a found word, and these are a network's guesses that mean nothing
// yet. The rows charge one after another once the figure is on screen, each in CHARGE_STEPS
// hard steps a row behind the one above; under reduced motion they stand charged.
const CHARGE_STEPS = 6;
const FRAME_MS = 60;

export default function Bars({ rows }: { rows: [string, number][] }) {
  const lang = useArticleLang();
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeen(ref);
  const max = Math.max(...rows.map(([, v]) => v));
  const fmt = useMemo(() => new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), [lang]);
  // The charge's frame: row i stands at frame − i of its CHARGE_STEPS.
  const frames = CHARGE_STEPS + rows.length - 1;
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!seen) return undefined;
    if (prefersReducedMotion()) {
      setFrame(frames);
      return undefined;
    }
    return runSteps(frames, frames * FRAME_MS, setFrame);
  }, [seen, frames]);
  return (
    <div ref={ref} className="ar-bars">
      {rows.map(([word, value], i) => {
        const k = Math.min(CHARGE_STEPS, Math.max(0, frame - i));
        return (
          <div key={word} className="ar-bar-row">
            <span className="ar-bar-word">{word}</span>
            <span className="ar-bar-meter" aria-hidden="true">
              <MeterCanvas value={(value / max) * 100 * easedStep(k, CHARGE_STEPS)} delayMs={0} durationMs={0} />
            </span>
            <span className="ar-bar-value">{`${fmt.format(value)} %`}</span>
          </div>
        );
      })}
    </div>
  );
}
