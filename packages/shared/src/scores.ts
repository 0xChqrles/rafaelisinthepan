// Word mode's claimable field (#163), shared with the backend score validator (#169).
// A client/server drift here would either reject a real score or admit an impossible one.
export const WORD_CLAIM_ZONE = 1_000;
