// AN ADDRESS CUT TO `fit` CHARACTERS, by whole characters (exact in the mono every address is
// printed in): whole when it fits; else the LOCAL part gives way in its middle-to-end — at
// least three of its characters stand, then `…`, then the whole domain (`prenom.no…@gmail.com`)
// — and when even the domain will not leave that room, the address is cut ONCE in its middle,
// its end standing (`jo@mail.res…ersity.edu`), so the line never starts on `@` and the domain
// never loses its ending. One ellipsis, always.
const ELLIPSIS = '…';
const MIN_LOCAL = 3;

export function cutAddress(address: string, fit: number): string {
  if (address.length <= fit) return address;
  if (fit < 2) return ELLIPSIS.slice(0, Math.max(0, fit));
  const at = address.lastIndexOf('@');
  const domain = at > 0 ? address.slice(at) : '';
  const keep = fit - ELLIPSIS.length - domain.length;
  if (at > 0 && keep >= Math.min(MIN_LOCAL, at)) return address.slice(0, keep) + ELLIPSIS + domain;
  const tail = Math.ceil((fit - ELLIPSIS.length) / 2);
  const head = fit - ELLIPSIS.length - tail;
  return address.slice(0, head) + ELLIPSIS + address.slice(address.length - tail);
}
