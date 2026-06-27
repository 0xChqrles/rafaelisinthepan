import { useEffect } from 'react';

// Floating indicator shown over a hole on a non-improving guess: the distance
// number when the word is in the hole's rank map, or "MISS" when it was too far.
// TODO(anim): polish. Ideas: rise + fade, scale punch, color by magnitude
// (small rank = accent, large = red), sound.
export default function FloatingHit({
  id,
  value,
  color,
  miss = false,
  onDone,
}: {
  id: number; // identifies this hit so the parent can clear it (multi-hit safe)
  value: number;
  color: string;
  miss?: boolean; // too far for this hole -> "MISS" instead of a distance
  onDone?: (id: number) => void;
}) {
  useEffect(() => {
    const t = setTimeout(() => onDone && onDone(id), 900);
    return () => clearTimeout(t);
  }, [id, onDone]);

  return (
    <span className="floating-hit" style={{ color }}>
      {miss ? 'MISS' : `-${value}`}
    </span>
  );
}
