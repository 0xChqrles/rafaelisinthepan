// The PLAY LOG (#214): what a sentence round's client actually plays from.
//
// Since #214 there are three deliberately different values, and keeping them apart is the
// whole design:
//
//   SERVER STATE — the authoritative RAW ordered log and its `solved` flag. Held only in
//     memory, from a read or an answer; never persisted, so there is no acknowledged
//     derived state that could disagree with it.
//   OUTBOX — the folded guesses the server has not acknowledged yet, qualified by the
//     puzzle revision. The ONLY persisted sentence-round state.
//   PLAY LOG — this module: a pure, stable FIRST-OCCURRENCE projection of
//     `server guesses + outbox`, deduplicated by the shared `guessKey`.
//
// The play log drives every client derivation — holes, progress, the unique score, the
// prompt's recall history, the trajectory and the solve moments. The RAW server log drives
// only the storage cap. That distinction is load-bearing: aliases (#104), a second device
// and the read-on-unknown recovery can all put two raw strings in one playable identity, so
// the two lengths genuinely differ, and each number answers a different question.
//
// Nothing here is an authority or a merge watermark. It is a VIEW, recomputed from its two
// inputs, which is why the old reconciliation problem disappeared with the persisted round.

import type { RankMap } from '@whippin/shared';
import { guessKey } from './scoring';

// The two inputs projected into one ordered log: server entries first (they are what the
// population's score is counted over), then the unacknowledged ones in the order they were
// typed, keeping the FIRST spelling of each canonical identity.
export function projectPlayLog(
  serverGuesses: readonly string[],
  outbox: readonly string[],
  keyOf: (typed: string) => string,
): string[] {
  const seen = new Set<string>();
  const log: string[] = [];
  for (const typed of [...serverGuesses, ...outbox]) {
    const id = keyOf(typed);
    if (seen.has(id)) continue;
    seen.add(id);
    log.push(typed);
  }
  return log;
}

// The same projection over a puzzle's rank maps — the identity the score itself is counted
// by (`countTries`), so the screen's headline and the recorded row read one log the same
// way.
export function playLogFor(
  ranks: RankMap,
  serverGuesses: readonly string[],
  outbox: readonly string[],
): string[] {
  return projectPlayLog(serverGuesses, outbox, (typed) => guessKey(ranks, typed));
}

// Presentation-only view for the sentence board while a newly submitted guess's floating
// hit is still in the air. Deferral is keyed by the SAME canonical identity as the play
// log: reconciliation can replace this device's surface with another device's spelling,
// and that spelling must remain held until the animation releases the identity.
export function withoutDeferred(
  ranks: RankMap,
  playLog: readonly string[],
  deferredIdentities: readonly string[],
): readonly string[] {
  if (deferredIdentities.length === 0) return playLog;
  const deferred = new Set(deferredIdentities);
  return playLog.filter((typed) => !deferred.has(guessKey(ranks, typed)));
}

// What of an outbox is still UNACKNOWLEDGED once the server's log is known: every entry
// whose canonical identity the server does not already hold. Used twice, and for one
// reason — the server's log is the acknowledgement, and identity is what "already held"
// means. A raw string comparison would keep re-sending an inflection of a guess the server
// stored under another surface, forever.
//
//   - after an accepted write, on what remains once the sent prefix is dropped;
//   - after an UNKNOWN outcome, whose recovery is one read: a write that committed but
//     lost its answer is invisible except in the log the server hands back.
export function unacknowledged(
  outbox: readonly string[],
  serverGuesses: readonly string[],
  keyOf: (typed: string) => string,
): string[] {
  const held = new Set(serverGuesses.map(keyOf));
  return outbox.filter((typed) => !held.has(keyOf(typed)));
}
