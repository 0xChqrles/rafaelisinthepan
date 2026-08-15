// Word mode's claimable field (#163), shared with the backend score validator (#169).
// A client/server drift here would either reject a real score or admit an impossible one.
export const WORD_CLAIM_ZONE = 1_000;

// The header a CloudFront viewer-request function stamps the connecting viewer's IP into,
// and the ONLY client address the score handler trusts in production (#169). Named here
// because it is a CDN⇔handler contract: infra writes it, the backend reads it, and a
// drift is a silent 500 on every score POST that no local run can reproduce.
//
// It exists because NO single origin-request policy can carry both halves a /scores POST
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
