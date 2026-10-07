// THE ROUND ON SCREEN (the game route's, `App`'s `GameRoute`): which puzzle, word list and
// server state the round is drawn from. The three reads are the route's (#214's load order),
// and the round mounts once all three are in — but a READ can come back after it has
// answered: an identity adopted from another tab re-arms the round's read
// (`rearmRoundSync`), and a republished puzzle restarts it (`beginRoundSync`), each putting
// the round's load back to `loading`. Neither may take a round in play off the screen: the
// round keeps what it was drawn from until the next answer replaces it — the same rule that
// makes a recovery read failing behind a live board a sync hiccup, never a played round
// taken away mid-guess. Only a DIFFERENT round (another day, another language) starts over.

export interface RoundOnScreen<P, V, S> {
  roundKey: string;
  puzzle: P;
  vocab: V;
  server: S;
}

// `kept`: what the round was drawn from last (null when nothing was). `live`: what the three
// reads hold now, or null while any of them is out. `roundKey`: the round the route is on.
// Answers what the round is drawn from now — `kept` itself when nothing changed, so the
// caller can store it without a render loop.
export function roundOnScreen<P, V, S>(
  kept: RoundOnScreen<P, V, S> | null,
  live: RoundOnScreen<P, V, S> | null,
  roundKey: string,
): RoundOnScreen<P, V, S> | null {
  if (live !== null) {
    const same =
      kept !== null &&
      kept.roundKey === live.roundKey &&
      kept.puzzle === live.puzzle &&
      kept.vocab === live.vocab &&
      kept.server === live.server;
    return same ? kept : live;
  }
  // A read is out again: the round in play stands on what it had. Another round's leaves —
  // and is forgotten, so coming back to its key later never brings a retired picture back.
  return kept !== null && kept.roundKey === roundKey ? kept : null;
}
