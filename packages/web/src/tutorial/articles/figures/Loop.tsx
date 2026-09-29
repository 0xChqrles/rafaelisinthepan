import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../../../hooks/useScramble';
import useSeen from './useSeen';

// THE TRAINING LOOP: the steps in order, lit one after the other, and back to the first —
// the "on recommence" the text says, shown. Reduced motion: every step at rest, none lit.
const STEP_MS = 1100;

export default function Loop({ steps }: { steps: string[] }) {
  const ref = useRef<HTMLOListElement>(null);
  const seen = useSeen(ref);
  const [lit, setLit] = useState(-1);
  useEffect(() => {
    if (!seen || prefersReducedMotion()) return undefined;
    setLit(0);
    const id = window.setInterval(() => setLit((i) => (i + 1) % steps.length), STEP_MS);
    return () => window.clearInterval(id);
  }, [seen, steps.length]);
  return (
    <ol ref={ref} className="ar-loop">
      {steps.map((step, i) => (
        <li key={step} className={`ar-loop-step${i === lit ? ' lit' : ''}`}>
          <span className="ar-loop-no">{String(i + 1).padStart(2, '0')}</span>
          <span className="ar-loop-text">{step}</span>
        </li>
      ))}
      <li className="ar-loop-back" aria-hidden="true">
        ↺
      </li>
    </ol>
  );
}
