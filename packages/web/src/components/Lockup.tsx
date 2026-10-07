import { forwardRef } from 'react';
import PixelMark from './PixelMark';

// THE LOCKUP: the pixel mark in the accent with WHIPPIN AI beside it — what a screen with no
// header wears where the header's title would stand (the onboarding invitation's header row,
// the signed-out screen's and the streak celebration's frame). The surface places and sizes
// it through `className`; the ref is the streak celebration's, which fades its furniture in.
const Lockup = forwardRef<HTMLDivElement, { className: string }>(function Lockup({ className }, ref) {
  return (
    <div ref={ref} className={className}>
      <PixelMark />
      <span>WHIPPIN AI</span>
    </div>
  );
});

export default Lockup;
