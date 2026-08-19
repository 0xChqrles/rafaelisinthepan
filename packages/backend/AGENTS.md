# AGENTS.md — @whippin/backend (daily-puzzle backend)

> Package-scoped guidance. The root `AGENTS.md` applies here too and holds the
> contracts this server implements — the per-puzzle JSON schema it serves and the
> day-addressed routing protocol (date rules, future-skew guard, 404 semantics, CDN
> caching) — plus the testing policy and the issue/PR workflow. Read it first.
> The share routes (`/s/<token>`, `/og/<token>.png`) render tokens from the shared
> `shareCard` codec; their product behavior is described in the solved-result bullet
> of `packages/web/AGENTS.md`.

## File map

```
  backend/                    daily-puzzle backend (pkg @whippin/backend, #2)
    src/
      handler.ts              createHandler() — the ONE day/404/CORS/Puzzle logic (Lambda + local)
      store.ts                PuzzleStore interface (date+lang -> Puzzle | null)
      s3Store.ts, fsStore.ts  store impls: S3 (prod) and local FS (#17), both read the same key
      scores.ts               /scores GET+POST route: params, auth (publicId), Turnstile,
                              range, HMAC, derived histogram, response
      scoreLimits.ts          puzzle-aware possible-score limits (per-mode ceilings)
      scoreStore.ts           score storage contract; day/dedup keys + 5/48h constants
      dynamoScoreStore.ts     prod atomic transaction + strongly-consistent day-partition Query
      memoryScoreStore.ts     process-local implementation for backend:dev/tests
      profile.ts              /profile GET+POST route (#188): auth (derived publicId), name +
                              avatar validation, moderation, upsert
      profileStore.ts         player-row storage contract (player#<publicId> partition)
      dynamoProfileStore.ts   prod GetItem read + UpdateItem upsert (createdAt via if_not_exists)
      memoryProfileStore.ts   process-local implementation for backend:dev/tests
      friends.ts              POST /friends (#189): auth, list/add/remove, self-add + cap refusals
      friendStore.ts          mutual-edge storage contract; friends#<publicId> partition + FRIENDS_MAX
      dynamoFriendStore.ts    prod one-transaction link/unlink (both directions) + consistent Query
      memoryFriendStore.ts    process-local implementation for backend:dev/tests
      nameFilter.ts           #188 banned-strings display-name MODERATION (normalize + substring); the charset is shared/name.ts
      avatarModeration.ts     #188 best-effort swastika template match on the decoded grid
      turnstile.ts            Cloudflare Siteverify + explicit local accept-all verifier
      layout.ts               storeKey() — the <date>.<lang>.json key shared by readers + publish (#17/#4)
      serve.ts                local HTTP server: Function-URL⇄HTTP adapter over createHandler (#17)
      publish.ts              place a generated puzzle into local store (default) or S3 (#17/#4)
      config.ts               env names + one decrypted SSM GetParameters read
      index.ts                Lambda entrypoint (S3/Dynamo stores + async secret initialization)
    .local-store/<date>.<lang>.json  local puzzle store (gitignored) read by serve/fsStore
```

---

## Commands

```bash
# Local backend harness (@whippin/backend, #17) — no AWS creds needed.
pnpm puzzle:publish <puzzle.json> [--day YYYY-MM-DD] [--s3]  # default: local + active day; --s3 -> the deployed bucket (stack output). Sentence puzzles AND #154 word artifacts (#156): the artifact type is detected from the file's SHAPE and routed to its own key.
pnpm puzzle:inventory [--s3] [--days N] [--langs en,fr] [--mode sentence|word] [--ci]  # publish-buffer coverage (#61); --mode word probes the #156 word-artifact buffer; reports + exits 0 by default, --ci exits 1 on any (day,lang) gap for cron/CI
pnpm backend:dev                # local server (puzzles + /scores + /profile + /friends + /today) on :8787; FS puzzles, in-memory scores/profiles/friends, local Turnstile accept-all
```

---

## Current state / mutable

*(Safe to update without touching the invariants above.)*

- **Score collection (#169; per-player rows + identity #187):** the ONE handler serves
  `GET|POST /scores?lang=&date=&mode=sentence|word`; `mode` is mandatory. A successful
  response is `{ buckets: [{ min, max, count }], total, bucket }`, inclusive ranges
  **derived at read time from the day's per-player rows** (one exact ascending band per
  distinct recorded score; an empty population is `buckets: []`); `bucket` is the
  caller's RECORDED score's index on POST and `null` on GET (a revisiting client already
  knows its persisted score). Every response is `no-store`. POST takes
  `{ secret, score, turnstileToken }`: it authenticates by deriving the publicId from
  the player key (shared `identity.ts` — a malformed key is a 400, nothing secret is
  ever stored), requires an integer score + nonempty Turnstile token, uses one
  Cloudflare Siteverify call, reads the published puzzle, and rejects an impossible
  score (sentence: 1..the exact committed language vocab size; Word: 0..the artifact's
  distinct ranks inside shared `WORD_CLAIM_ZONE`). It HMACs the trusted client address —
  read from shared `VIEWER_IP_HEADER`, which a CloudFront viewer-request function stamps
  (see the root `AGENTS.md` for why the origin-request policy cannot carry it) — and
  hands only the digest to `ScoreStore`. A value that is not a bare IP is no identity at
  all: `clientIp` returns null and the POST fails rather than dedup a submission under a
  parsed fragment. `dynamoScoreStore` writes ONE transaction — the conditional
  5-count/48h-TTL dedup update plus the first-write-wins conditional put of the
  `(date, lang, mode, publicId)` row — using a hash of the one-use token as DynamoDB's
  idempotency token; its following strongly-consistent day-partition Query guarantees
  the returned histogram includes the caller. A second submission from the same player
  is `already_recorded`: nothing changes, no allowance is consumed, and the 200 reports
  the STORED row's standing. The sixth distinct-player write per IP is a no-mutation
  429. Local serve swaps in `memoryScoreStore`, a random per-process HMAC key and
  `localTurnstileVerifier`; restart clears local scores. Production config requires
  `SCORE_TABLE`, `TURNSTILE_SECRET_PARAMETER`, and `IP_HMAC_SECRET_PARAMETER` in addition
  to the puzzle settings. On first use, `index.ts` resolves both SecureStrings with ONE
  decrypted SSM `GetParameters` call and retains only their values in memory; a failed read
  is discarded so the next invocation retries. The HMAC key must contain 32+ bytes.
  Production POST also requires `x-amz-content-sha256`, the lowercase hex SHA-256 of the
  exact UTF-8 body bytes: CloudFront OAC needs it before the handler can run. The score
  behavior forwards it and CORS allows it; local serve has no OAC and cannot verify this
  production-only boundary.

- **Player profile (#188):** the ONE handler also serves `GET /profile?id=<publicId>`
  (public row: `{ publicId, name, avatar }`; 400 malformed id, 404 never customized) and
  `POST /profile` `{ secret, name, avatar }` — the authenticated upsert keyed by the
  DERIVED publicId (shared `identity.ts`), a separate write path from scores. Every
  response is `no-store`. The write validates the name against the SHARED charset rule
  (`shared/src/name.ts` `isValidName` — alphanumerics and underscores, ≤16, empty
  allowed; user-decided 2026-08-19, replacing the local trim + code-point cap +
  control/format check, which it subsumes) and the avatar (shared `avatar.ts` decode),
  then moderates: `nameFilter.ts` → 400 `name_rejected`, `avatarModeration.ts` → 400
  `avatar_rejected`. It REFUSES a non-conforming name rather than sanitizing one nobody
  typed, and stores what it was sent VERBATIM — there is no trim any more, so the stored
  row and the editor's baseline are the same string. Storage is the score table — partition `player#<publicId>`, sort key
  `profile`, `name`/`avatar`/`createdAt`/`updatedAt` (`dynamoProfileStore`; local serve
  swaps in `memoryProfileStore`). **The GET is a STRONGLY CONSISTENT read** (the score
  Query's rule, for the same read-after-write reason): the editor adopts what comes back
  as both its contents and its save baseline, so an eventually consistent read could
  hand a player the profile they just replaced — or, after a first save, a 404 saying
  they never customized one. No Turnstile, no IP dedup: the secret is the auth and
  the only row you can write is your own. Production POST needs `x-amz-content-sha256`
  like the score POST (same OAC boundary); the `id` query must stay in the CloudFront
  profile behavior's allowList (root `AGENTS.md` contract).

- **Friends graph (#189):** the ONE handler also serves `POST /friends` — and ONLY POST
  (a GET is a named 405): the player key authenticates in the BODY, so there is no way to
  ask for a list without proving whose it is. `{secret}` reads the caller's edges,
  `{secret, add}` records the mutual link an invite-link click makes, `{secret, remove}`
  deletes both sides; every call answers `{ friends: [publicId] }` and every response is
  `no-store`. `add` refuses a self-link (400 `self_link`) and the cap (409 `friend_limit`,
  `FRIENDS_MAX` = 200, checked on BOTH sides); a re-click and a remove of a non-friend are
  ordinary 200s. Storage is the score table again — `friends#<publicId>` partition, sort key
  = the friend's id, `createdAt` via `if_not_exists` (`dynamoFriendStore`; local serve swaps
  in `memoryFriendStore`). The pair is ONE `TransactWriteItems` in both directions, so a
  half-edge is unrepresentable, and the writes are unconditional and idempotent — which is
  why the transaction needs no `ClientRequestToken` and why it heals a half-edge instead of
  reporting the pair linked and leaving it one-sided. Every Query is STRONGLY CONSISTENT
  (the profile read's rule: the call answers with the list it just wrote), and the cap is
  COUNTED off those rows rather than kept in a counter item — see the root `AGENTS.md` for
  why a bound may be overshot by a simultaneous click and an invariant may not. This is the
  only route that DELETES, which is why the table grant gained `dynamodb:DeleteItem`. The
  route reads NO query parameter; the CloudFront `friends*` behavior forwards none, and the
  day it reads one, that behavior has to name it (root `AGENTS.md` contract). Production
  POST needs `x-amz-content-sha256` like every other write here.
- **Word mode's daily artifact (#154/#156):** the ONE puzzle endpoint also serves the
  single-word artifact under `mode=word` (`GET /?lang=&date=&mode=word`; absent/
  `sentence` = the sentence puzzle, anything else = 400) with identical day-addressing,
  404 semantics, caching and compression. **A new query parameter here is only half the
  change:** the CDN cache policy (`infra/lib/backend-stack.ts`) has to list it too, or
  CloudFront both collapses the two responses onto one year-long edge entry and — having no
  origin request policy — strips the parameter before this handler ever sees it. See the
  routing contract in the root `AGENTS.md`; `backend:dev` has no CDN and cannot show it. The
  store key is
  `<date>.<lang>.word.json` (`layout.storeKey(date, lang, 'word')`), read by
  `PuzzleStore.getWordPuzzle` in both store impls; `publish` detects the artifact type
  from the JSON shape (`holes` = sentence, `word` + flat `ranks` = word) and routes it
  to that key, and `inventory --mode word` probes the word buffer. The share routes
  additionally decode Word mode's v5 token (`decodeWordResult`) into its own card
  (`renderWordCardPng`) and share page. The token carries the accented display word and
  the per-rarity claim counts, so the card draws the day's word (alone, in the game's
  solved blue — no node square since 2026-08-11) and its rarity chip row without a store
  lookup (the page title's claim count is the counts' sum, `wordShareScore`); its
  click-through lands on
  `/<lang>/word/<date>`.
- **Puzzle responses are content-negotiated AT THE ORIGIN (#123/#124, decided
  2026-07-26).** A puzzle is megabytes of rank maps (#104's alias expansion roughly tripled
  them), and Lambda refuses a response **envelope** over ~6.29 MB with a 413 the caller only
  ever sees as a bare 502 — the size to check is the envelope, not the body, because the body
  is escaped into it (every `"` costs a second byte, ~18% on quote-dense JSON). So
  `respond.ts` `jsonCompressed()` compresses the puzzle with the best coding the client
  accepts — **brotli preferred, gzip fallback**, `q=0` honoured, a refusal outranking a `*`
  wildcard (RFC 9110 §12.5.3), 1 KB floor. **Brotli is not optional politeness:** CloudFront
  normalizes `Accept-Encoding` down to the br/gzip the viewer offered *and forwards it to the
  origin*, so `br` can arrive alone; it also prefers brotli for viewers that offer it and
  passes an already-encoded origin response straight through, so a gzip-only origin would
  hand browsers MORE bytes than the CDN's own compression did. Two rules for anyone editing
  this: **`Vary` must be APPENDED, not overwritten** (the CORS `Vary: Origin` has to survive
  alongside `Accept-Encoding`), and the handler owns an **envelope-size guard** that answers
  a still-too-large payload with a named `payload_too_large` 500 **and `console.error`s it** —
  the log line is not decoration, it is the only thing that reaches CloudWatch, because a
  handler that RETURNS an error status is a SUCCESSFUL invocation (Errors metric 0, clean log
  group). The guard budgets ~8 KB below the cap since it models the runtime payload rather
  than measuring it.
- **Local backend harness (#17):** `pnpm backend:dev` runs the **same `createHandler`**
  as the deployed Lambda over a local filesystem store (`fsStore`), so the day/404/CORS/
  `Puzzle` behaviour is identical to prod with no AWS creds. `pnpm puzzle:publish
  <file>` places a generated puzzle into the store — **local by default**, `--s3`
  to push real S3, `--day YYYY-MM-DD` to target a game day (defaults to the
  active 22:00-ET day). `--s3` always targets the ONE bucket the infra package deploys —
  `publish` reads its name (and the API `DistributionId`) from the outputs of
  `WhippinBackendStack` (us-east-1) via CloudFormation `DescribeStacks` (#4), so the infra
  code is the single source of truth and there is **no bucket flag/env**. After the upload
  it **invalidates `/*` on the API distribution** (the date-addressed puzzle URL is
  CDN-cached long, so a republish must purge it; needs `cloudformation:DescribeStacks` +
  `cloudfront:CreateInvalidation`
  + the SDKs `@aws-sdk/client-cloudformation`/`client-cloudfront`; the bucket is addressed in us-east-1 where the
  stack is pinned). Store key (shared by readers + writer in `backend/src/layout.ts`,
  identical for local FS and S3): flat `<root>/<date>.<lang>.json` — fully determined by
  (date, lang), so the stores GetObject/readFile it directly (no list+filter) and it
  stays listable by a date prefix; root defaults to `backend/.local-store` (gitignored),
  override via `PUZZLE_STORE`. Point `VITE_API_BASE_URL=http://localhost:8787` and
  `pnpm dev` plays end-to-end (including 404 → NO PUZZLE). Runs TS via `tsx`
  (backend devDep).
