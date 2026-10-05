import { useLayoutEffect, useRef, useState } from 'react';
import { cutAddress } from './addressCut';

// A SAVED ADDRESS ON ONE LINE, cut by WHOLE CHARACTERS when it does not fit (`cutAddress`: the
// local part gives way, the domain stands — `prenom.no…@gmail.com`), so it still reads as the
// player's. ONE dress wherever the area prints the address the account is saved to: under
// `/account`'s masthead name, and on the flow's "Account saved." ending. The line's room is
// counted in the mono's own advance, measured off the address itself; a screen reader is given
// the whole address. The line is a BLOCK as wide as its slot, so its room never depends on
// what it prints.
export default function AddressLine({ address, className = '' }: { address: string; className?: string }) {
  const lineRef = useRef<HTMLSpanElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState<number | null>(null);
  useLayoutEffect(() => {
    const line = lineRef.current;
    const probe = probeRef.current;
    if (!line || !probe || address.length === 0) return undefined;
    const measure = () => {
      const advance = probe.getBoundingClientRect().width / address.length;
      setFit(advance > 0 ? Math.floor(line.clientWidth / advance) : null);
    };
    measure();
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) measure();
    });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(line);
    return () => {
      live = false;
      ro?.disconnect();
    };
  }, [address]);
  return (
    <span ref={lineRef} className={`address-line${className ? ` ${className}` : ''}`}>
      <span ref={probeRef} className="address-line-probe" aria-hidden="true">
        {address}
      </span>
      <span aria-hidden="true">{fit === null ? address : cutAddress(address, fit)}</span>
      <span className="sr-only">{address}</span>
    </span>
  );
}
