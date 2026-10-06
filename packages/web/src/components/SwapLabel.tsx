import { useState } from 'react';
// (For its side effect: the root's Bayer tiles the words swap through.)
import './bayerTiles';

// A control's WORD CHANGING IN PLACE (SHARE → COPIED and back): the word leaving goes out
// through the dither (`board-dissolve-out`) while the new one comes in through exactly the
// cells it gives up (`board-dissolve`), both in the one cell they share — so the swap reads
// as the thing happening, in hard steps, and moves nothing round it. The first word stands.
export default function SwapLabel({ text }: { text: string }) {
  const [swap, setSwap] = useState<{ now: string; was: string | null; turn: number }>({
    now: text,
    was: null,
    turn: 0,
  });
  // The word changed: the one on screen becomes the leaving one, in this same render (an
  // effect would paint a frame of the new word alone first).
  if (swap.now !== text) setSwap({ now: text, was: swap.now, turn: swap.turn + 1 });
  return (
    <span className="swap-label">
      {swap.was !== null && (
        <span
          key={`was-${swap.turn}`}
          className="swap-out"
          aria-hidden="true"
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget) setSwap((s) => ({ ...s, was: null }));
          }}
        >
          {swap.was}
        </span>
      )}
      <span key={`now-${swap.turn}`} className={swap.turn > 0 ? 'swap-in' : undefined}>
        {swap.now}
      </span>
    </span>
  );
}
