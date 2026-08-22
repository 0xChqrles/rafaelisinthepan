// Word mode's claimable field (#163), shared with the backend score validator (#169).
// A client/server drift here would either reject a real score or admit an impossible one.
export const WORD_CLAIM_ZONE = 1_000;

// ---- Word mode's ECONOMY, cross-package since #202 -------------------------------------
//
// The clock is the web's tuning knob (game/wordGame.ts owns the rarity ladder), but two of
// its numbers became a client/server contract when the server started stamping the round's
// start and refusing an end-of-run submission that arrives before the run could possibly
// have finished. The wait check is EXACTLY the game's own floor — a run with N claims lasts
// at least `WORD_START_SECONDS + WORD_MIN_BONUS_SECONDS * N` seconds, because Word mode has
// no early finish and every claim buys at least the COMMON rung — so it can never block
// honest play, and it needs no tuning of its own as the ladder moves.
//
// `WORD_MIN_BONUS_SECONDS` is the LADDER'S FLOOR, not a second opinion about it: the ladder
// authors its cheapest rung from this constant and `wordGame.test.ts` pins that no rung pays
// less. Retuning the economy therefore moves this file and deploys the backend with it —
// exactly like WORD_CLAIM_ZONE, and for the same reason.
export const WORD_START_SECONDS = 60;
export const WORD_MIN_BONUS_SECONDS = 4;

// How many MISSES one word round may store (#202). Claims are bounded by the field itself
// (at most `WORD_CLAIM_ZONE` groups exist to claim); everything else a run typed is bounded
// here, which is what keeps a stored round's item small — the two together are ~40 KB of
// slugs. The client truncates its own log to them; the server refuses an over-cap one,
// since a malicious client will not truncate.
export const WORD_MISS_CAP = 500;

// The wall-clock LENGTH of a word run whose claims bought `bonusSeconds`. The deadline is
// `startedAt + wordRunMs(bonus)`, recomputed from the whole log on every write, so the clock
// can never drift away from the guesses that bought it.
export function wordRunMs(bonusSeconds: number): number {
  return (WORD_START_SECONDS + bonusSeconds) * 1000;
}

// The SHORTEST a run that claimed `claims` groups can possibly have lasted — the server's
// end-of-run wait check, derived from the run length above rather than restated, so the
// bound cannot drift from the game it bounds.
export function wordRunFloorMs(claims: number): number {
  return wordRunMs(WORD_MIN_BONUS_SECONDS * claims);
}

// The guess-log sync's two bounds (#201). The server owns each round's ordered try log —
// one item per (date, lang, mode, publicId) — and both numbers are cross-package: the cap
// is enforced inside the append write's own condition (no batch may push the stored log
// past it; at the cap the round stops counting and earns no leaderboard entry), and the
// interval paces the client's coalesced flushes against the server's per-player rate
// condition — two independent spellings of "~1s between guesses" would drift into
// permanent 429s, so there is one.
export const ROUND_GUESS_CAP = 500;
export const ROUND_WRITE_MIN_MS = 1_000;

// The header a CloudFront viewer-request function stamps the connecting viewer's IP into,
// and the ONLY client address the round handler trusts in production (#169). Named here
// because it is a CDN⇔handler contract: infra writes it, the backend reads it, and a
// drift is a silent 500 on live round writes that no local run can reproduce.
//
// It exists because NO single origin-request policy can carry both halves a /round POST
// needs. `CloudFront-Viewer-Address` is a GENERATED header, so only the allow-list and
// "all viewer headers + CloudFront headers" modes can add it — but the viewer's
// `x-amz-content-sha256`, which OAC needs to sign a Lambda-URL POST, can never be named in
// an allow-list (CloudFront rejects the whole policy: "The parameter Headers contains
// x-amz-content-sha256 that is not allowed") and the "+ CloudFront headers" mode also
// forwards the viewer's Host, which breaks that same signature. The policy therefore stays
// on AWS's Lambda-URL-safe `allExcept: Host` mode — which carries every viewer header and
// NO generated one — and the function supplies the address as an ordinary viewer header
// that mode already carries. It is unspoofable because the function OVERWRITES it from
// CloudFront's own read of the TCP peer, whatever the viewer sent under that name.
export const VIEWER_IP_HEADER = 'x-whippin-viewer-ip';
