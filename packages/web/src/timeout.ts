// A DEADLINE on a fetch, hand-rolled — `AbortSignal.timeout()` is NOT available here.
//
// It is Baseline 2024 (Chrome 103 / Firefox 100 / Safari 16.0), well above Vite 5's browser
// floor (Chrome 87 / Firefox 78 / Safari 14), and the build lowers SYNTAX only: a runtime
// API the target lacks is still missing in the shipped bundle. Worse, it is read as an
// ARGUMENT, so the `TypeError` lands BEFORE `fetch` ever runs — the caller sees a request
// that never left, on a browser where everything else about the app works.
//
// That is not hypothetical, which is why this is a module and not a comment. `versionCheck`
// recorded the rule and hand-rolled its own controller for exactly this reason; the five
// other call sites did not, and on 2026-08-25 the #216 bootstrap took one. From that deploy
// no browser under the floor could create an account — which, since an account is what the
// PLAY gates deploy, meant it could not play at all (reported from production 2026-08-27, an
// iOS 15 iPhone stuck on ACCOUNT SETUP FAILED with a RETRY that could only ever fail again).
// One spelling now, so there is no second copy left to forget it.
//
// The timer is deliberately NOT cleared. The caller holds the Response, not this module, so
// there is no settle to hang a `clearTimeout` on — and aborting a request that has already
// finished is a no-op. That also keeps `AbortSignal.timeout()`'s own semantics, deadline over
// the BODY read included: every caller here awaits `.json()` after the headers land.
export function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  // The GLOBAL `setTimeout`, never `window.setTimeout`: nothing here needs the handle, and
  // callers reach this from modules whose tests stub `window` down to the two or three
  // members they exercise (`localIdentityDeploy.test.ts` hands them a bare object with a
  // fake `localStorage`). A deadline must not be the thing that decides whether their fetch
  // happens at all — which is the same failure mode, one layer down, that this module exists
  // to remove.
  //
  // No abort REASON either: `abort(reason)` is itself Safari 15.4, and no caller reads one —
  // every one of them treats a deadline exactly as it treats a dropped connection.
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}
