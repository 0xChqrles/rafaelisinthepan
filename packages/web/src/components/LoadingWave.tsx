import type { CSSProperties } from 'react';

// The app's ONE loading shimmer (user-decided 2026-08-18): every "LOADING..."-style
// waiting line plays the same wave — a crest of full ink rolling through letters sunk
// to a fraction of it, looping until the answer arrives (see `.loading-wave`). The wave
// rides OPACITY, so each surface keeps its own ink and face: the status line stays
// accent mono, the standing slot's RANKING... stays the pixel label it resolves into
// (via `letterClass`). Screen readers get the plain string; the letter boxes are
// decoration.
export default function LoadingWave({ text }: { text: string }) {
  return (
    <>
      <span className="sr-only">{text}</span>
      <span className="loading-wave" aria-hidden="true">
        {Array.from(text).map((ch, i) => (
          <span key={i} style={{ '--i': i } as CSSProperties}>
            {ch}
          </span>
        ))}
      </span>
    </>
  );
}
