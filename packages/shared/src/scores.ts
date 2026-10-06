// The guess-log sync's two bounds (#201). The server owns each round's ordered try log —
// one item per (date, lang, publicId) — and both numbers are cross-package: the cap
// is enforced inside the append write's own condition (no batch may push the stored log
// past it; at the cap the round stops counting and earns no leaderboard entry), and the
// interval paces the client's coalesced flushes against the server's per-player rate
// condition — two independent spellings of "~1s between guesses" would drift into
// permanent 429s, so there is one.
export const ROUND_GUESS_CAP = 500;
export const ROUND_WRITE_MIN_MS = 1_000;

// ENDED UNSOLVED: a round that is over without a solve — the player GAVE UP (the round row's
// write-only-true `gaveUp`), or the stored RAW log holds the cap. Either way every further
// append is refused, nothing is recorded, and the round ends at `∞`. `solved` WINS: a solve
// accepted as the 500th raw entry, or one that landed beside a give-up (two devices racing),
// is an ordinary solved round.
//
// ONE rule with two input shapes. `endedUnsolved` takes the three FACTS — for a reader that
// holds the cap as a fact rather than the log (the #211 month read, whose store probes one
// entry at the cap's last index and never reads the log); `roundEnded` is the same rule over
// a round's state, log and all, and is defined through it. Read by the web's round screen,
// the group day board (`over`) and the month read alike, so the three cannot disagree.
export function endedUnsolved(facts: { solved: boolean; gaveUp: boolean; capped: boolean }): boolean {
  return !facts.solved && (facts.gaveUp || facts.capped);
}

// A round whose state has not arrived has not ended.
export function roundEnded(
  round: { solved?: boolean; gaveUp?: boolean; guesses: readonly unknown[] } | null | undefined,
): boolean {
  return (
    round != null &&
    endedUnsolved({
      solved: round.solved === true,
      gaveUp: round.gaveUp === true,
      capped: round.guesses.length >= ROUND_GUESS_CAP,
    })
  );
}

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

// GROUPS (#271, user-decided 2026-09-07): a named set of members with an invite link, the
// unit every trusted board is drawn over — a pair of friends is a group of two. Both caps
// are cross-package: the backend refuses past them and the web sizes its tabs and rows
// from them. Counted off the membership rows (a bound, never an invariant — the friends
// graph's rule): two simultaneous joins may land one member over.
export const GROUPS_MAX = 10;
export const GROUP_MEMBERS_MAX = 50;
