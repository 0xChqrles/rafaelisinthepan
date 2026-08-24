# AGENTS.md — @whippin/backend (daily-puzzle backend)

> Package-scoped guidance. The root `AGENTS.md` applies here too and holds the
> contracts this server implements — the per-puzzle JSON schema it serves and the
> day-addressed routing protocol (date rules, future-skew guard, 404 semantics, CDN
> caching) — plus the testing policy and the issue/PR workflow. Read it first.
> The share routes (`/s/<token>`, `/og/<token>.png`) render tokens from the shared
> `shareCard` codec; their product behavior is described in the solved-result bullet
> of `packages/web/AGENTS.md`. Since #214 a SENTENCE token is **v6** and may be CAPPED:
> `ogCard.renderShareHtml` then titles the result `∞` (the literal character — this page is
> ordinary HTML in the reader's own fonts) while `renderCardSvg` draws the shared PATH data,
> because the one font in the Lambda bundle has no such glyph and the rasterizer runs with
> `loadSystemFonts: false`. No route changed: the version check and the legacy redirect are
> the codec's — but the `/og` route now hands the DECODED result STRAIGHT to the renderer
> (`CardData` IS `ShareResult`). It used to re-list the fields, which is a second declaration
> of one shape and silently drops whatever the codec learns next: it did exactly that with
> `capped`, drawing a try count on a card whose own share page already said `∞`.

## File map

```
  backend/                    daily-puzzle backend (pkg @whippin/backend, #2)
    src/
      handler.ts              createHandler() — the ONE day/404/CORS/Puzzle logic (Lambda + local);
                              also the share routes and #189's invite preview (/i/<publicId>)
      store.ts                PuzzleStore interface (date+lang -> Puzzle | WordPuzzle | PuzzleSlice | null)
      s3Store.ts, fsStore.ts  store impls: S3 (prod) and local FS (#17), both read the same key
      slice.ts                #203's DERIVATION SLICE: build it from a puzzle, read a log against
                              it (progress + solved), its gzip codec and its shape check
      puzzleReads.ts          #203's artifact reads: the slice (every append) and the full
                              puzzle (a solve), BOTH fresh, both gated on the caller's revision
      scores.ts               /scores GET route (READ-ONLY since #203): params, derived histogram
      scoreLimits.ts          the Word field's claim ceiling (the sentence one retired with #203)
      liveRoute.ts            what the LIVE routes share: no-store headers, the JSON-body
                              reader + size cap, #216's device-token check and the
                              `unknown_device` resolution behind it, the (lang, mode,
                              date) + future-skew guard, the trusted viewer address and the
                              Turnstile-token check the gated writes share
      devices.ts              POST /devices (#216): the Turnstile-gated idempotent bootstrap,
                              the sign-out screen's list, and revocation by device id + opaque key
      deviceStore.ts          device/account storage contract; device#<tokenHash> base key,
                              the account GSI, SHA-256(token) and the once-a-day lastSeenAt
      dynamoDeviceStore.ts    prod GetItem auth + ONE create-only transaction for the pair,
                              the index Query and direct conditional base-item revocation
      memoryDeviceStore.ts    process-local implementation for backend:dev/tests (seedable)
      userAgent.ts            what a device IS, read server-side from the User-Agent header
      testDevice.ts           TEST-ONLY: one seeded device and the account it acts as
      scoreStore.ts           score storage contract; day/dedup keys + 5/48h constants
      dynamoScoreStore.ts     prod atomic transaction + strongly-consistent day-partition Query
      memoryScoreStore.ts     process-local implementation for backend:dev/tests
      profile.ts              /profile GET+POST route (#188): device auth -> accountId, name +
                              avatar validation, moderation, upsert
      profileStore.ts         player-row storage contract (player#<publicId> partition)
      dynamoProfileStore.ts   prod GetItem read + UpdateItem upsert (createdAt via if_not_exists)
      memoryProfileStore.ts   process-local implementation for backend:dev/tests
      friends.ts              POST /friends (#189): auth, list/add/remove, self-add + cap refusals
      board.ts                GET|POST /board (#190): global top-50 read + authenticated friends
                              board — shared leaderboard rules over score rows + profiles + edges
      history.ts              POST /history (#211): the PRIVATE player history — one month of
                              (lang, mode) summaries + the language's solved-day collection
      historyStore.ts         solved-day storage contract; the private player#<publicId>
                              partition, history#<lang> sort key
      dynamoHistoryStore.ts   prod NUMBER-SET credit (idempotent ADD) + an ADD/DELETE overflow trim
      memoryHistoryStore.ts   process-local implementation for backend:dev/tests
      friendStore.ts          mutual-edge storage contract; friends#<publicId> partition + FRIENDS_MAX
      dynamoFriendStore.ts    prod one-transaction link/unlink (both directions) + consistent Query
      memoryFriendStore.ts    process-local implementation for backend:dev/tests
      rounds.ts               POST /round (#201/#202/#203): the per-round state — read, sentence
                              append, Word mode's Turnstile-gated start + end-of-run submission;
                              slug + length validation, cap / interval / wait / freeze refusals,
                              the DERIVED progress + solve and the score row they record,
                              full-state answers carrying the server's own clock
      roundStore.ts           round storage contract; round#<publicId> partition, sort key
                              <lang>#<mode>#<date> (#203); the published-version tag +
                              ROUND_GUESS_CAP / ROUND_WRITE_MIN_MS semantics, Word mode's
                              startedAt / first-write-wins log, #203's stored summary and
                              #211's month prefix + projected day summary
      dynamoRoundStore.ts     prod ONE conditional UpdateItem (both bounds in the condition) +
                              consistent classification read on a refusal; the word start's own
                              conditional stamp and the submit's read-then-conditional-write
      memoryRoundStore.ts     process-local implementation for backend:dev/tests
      nameFilter.ts           #188 banned-strings display-name MODERATION (normalize + substring); the charset is shared/name.ts
      avatarModeration.ts     #188 best-effort swastika template match on the decoded grid
      turnstile.ts            Cloudflare Siteverify + explicit local accept-all verifier
      ogCard.ts               resvg-wasm rasterizer + the preview PAGE template (share links + #189 invites)
      layout.ts               storeKey() / sliceKey() — the keys shared by readers + publish (#17/#4/#203)
      serve.ts                local HTTP server: Function-URL⇄HTTP adapter over createHandler (#17)
      publish.ts              place a generated puzzle into local store (default) or S3 (#17/#4),
                              stamping its #203 `revision` and deriving its slice beside it
      config.ts               env names + one decrypted SSM GetParameters read
      index.ts                Lambda entrypoint (S3/Dynamo stores + async secret initialization)
    .local-store/<date>.<lang>.json          local puzzle store (gitignored) read by serve/fsStore
    .local-store/<date>.<lang>.slice.json.gz  its #203 derivation slice, written by publish
```

---

## Commands

```bash
# Local backend harness (@whippin/backend, #17) — no AWS creds needed.
pnpm puzzle:publish <puzzle.json> [--day YYYY-MM-DD] [--s3]  # default: local + active day; --s3 -> the deployed bucket (stack output). Sentence puzzles AND #154 word artifacts (#156): the artifact type is detected from the file's SHAPE and routed to its own key.
pnpm puzzle:inventory [--s3] [--days N] [--langs en,fr] [--mode sentence|word] [--ci]  # publish-buffer coverage (#61); --mode word probes the #156 word-artifact buffer; reports + exits 0 by default, --ci exits 1 on any (day,lang) gap for cron/CI
pnpm backend:dev                # local server (puzzles + /scores + /profile + /friends + /board + /round + /history + /devices + /today) on :8787; FS puzzles, in-memory scores/profiles/friends/rounds/history/devices, local Turnstile accept-all
pnpm board:seed [--friend <publicId|/i/link>]  # fill the RUNNING local server with a #190 board population (in-memory — re-run after a restart)
```

---

## Current state / mutable

*(Safe to update without touching the invariants above.)*

- **Score population (#169; per-player rows + identity #187; READ-ONLY since #203):** the
  ONE handler serves `GET /scores?lang=&date=&mode=sentence|word`; `mode` is mandatory. A
  successful response is `{ buckets: [{ min, max, count }], total, bucket }`, inclusive
  ranges **derived at read time from the day's per-player rows** (one exact ascending band
  per distinct recorded score; an empty population is `buckets: []`), with `bucket` always
  `null` — the read carries no identity, and the client locates its own score in the
  ranges. Every response is `no-store`. A POST is a named **405**: the row is written by the
  ROUND route from the log the server already holds (#203) — and only when that round
  finished ON THE DAY (2026-08-23), so an archive play joins no population and gets
  `bucket: null` here. This file no longer
  authenticates, verifies Turnstile, validates a range or hashes an address —
  `hashClientIp` stays here beside the store contract, but its caller is `rounds.ts`.
  It still reads the published puzzle, so an unpublished daily 404s rather than getting an
  empty population. `dynamoScoreStore` creates a row with ONE transaction — the conditional
  5-count/48h-TTL dedup update plus a create-only put of the `(date, lang, mode, publicId)`
  row. The row and its idempotency token both carry the published `revision`: a second
  submission on that version is `already_recorded`, while a different revision conditionally
  replaces the SAME row in a one-item transaction and consumes no new IP allowance. The
  sixth distinct-player write per IP is a no-mutation refusal, but it cannot block that
  replacement because the population still contains one player. The round route LOGS and
  swallows a genuine cap — the guesses are stored and the answer is about the LOG, so a
  population that could not be written is a missing standing, never a refused append. Per
  the root contract, population reads deliberately retain an old-version row until that
  player solves the correction. Local serve swaps in `memoryScoreStore`, a random
  per-process HMAC key and
  `localTurnstileVerifier`; restart clears local scores. Production config requires
  `SCORE_TABLE`, `TURNSTILE_SECRET_PARAMETER`, and `IP_HMAC_SECRET_PARAMETER` in addition
  to the puzzle settings. On first use, `index.ts` resolves both SecureStrings with ONE
  decrypted SSM `GetParameters` call and retains only their values in memory; a failed read
  is discarded so the next invocation retries. The HMAC key must contain 32+ bytes.

- **Player profile (#188):** the ONE handler also serves `GET /profile?id=<publicId>`
  (public row: `{ publicId, name, avatar }`; 400 malformed id, 404 never customized) and
  `POST /profile` `{ token, name, avatar }` — the authenticated upsert keyed by the ACCOUNT
  the caller's device token resolves to (#216), a separate write path from scores. Every
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
  they never customized one. No Turnstile, no IP dedup: the device token is the auth and
  the only row you can write is your own. Production POST needs `x-amz-content-sha256`
  like every live JSON write (same OAC boundary); the `id` query must stay in the CloudFront
  profile behavior's allowList (root `AGENTS.md` contract).

- **Invite link preview (#189, user-decided 2026-08-20):** the ONE handler also serves the
  invite LINK itself — `GET /i/<publicId>`, the page a chat unfurls, and
  `GET /og/i/<publicId>.png`, the card it unfurls into (mark + name + app name, nothing
  more). The product rules and the reason the SPA landing split off to `/join/<publicId>`
  are in the root `AGENTS.md`. Implementation notes: both resolve BEFORE the puzzle logic
  (the share routes' reason — no lang, no day, nothing to 400 on); the id is matched
  loosely and validated with the shared `PUBLIC_ID_PATTERN`, so a malformed one is a 404
  that never reaches the store; the profile read is best-effort like a board row's, and a
  read that FAILED answers `no-store` where an honest 404 ("never customized") caches for
  300s. `siteOrigin` is what both preview pages bounce to, and `backend:dev` sets NONE:
  the handler falls back to the REQUEST's Host, and the web dev server proxies these
  paths here without rewriting it (`web/vite.config.ts`), so a page served through the
  proxy addresses the app rather than this server. The CDN wiring is the WEB
  distribution's (`infra/lib/web-stack.ts` routes `/i/*` to the API origin beside `/s/*`
  and `/og/*`), not this stack's — and the dev proxy is that list restated, so the two
  move together.
- **Friends graph (#189):** the ONE handler also serves `POST /friends` — and ONLY POST
  (a GET is a named 405): the player key authenticates in the BODY, so there is no way to
  ask for a list without proving whose it is. `{token}` reads the caller's edges,
  `{token, add}` records the mutual link an invite-link click makes, `{token, remove}`
  deletes both sides; every call answers `{ friends: [publicId] }` and every response is
  `no-store`. `add` refuses a self-link (400 `self_link`) and the cap (409 `friend_limit`,
  `FRIENDS_MAX` = 200, checked on BOTH sides); a re-click and a remove of a non-friend are
  ordinary 200s. Storage is the score table again — `friends#<publicId>` partition, sort key
  = the friend's id, `createdAt` via `if_not_exists` (`dynamoFriendStore`; local serve swaps
  in `memoryFriendStore`). The pair is ONE `TransactWriteItems` in both directions, so a
  half-edge is unrepresentable, and the writes are unconditional — which is why the
  transaction needs no `ClientRequestToken`. **Both rows go out on every accepted link, a
  re-click included** (`already_linked` reports the CALLER's list as unchanged, not that
  nothing was written): the store reads the caller's partition and cannot see the friend's,
  so returning early there would leave a missing other half missing for good, and re-writing
  a row that is already present costs two WCUs on a rare path and changes nothing —
  `if_not_exists` keeps the original instant. The cap is likewise only spent on a pair the
  caller does not already hold. Every Query is STRONGLY CONSISTENT
  (the profile read's rule: the call answers with the list it just wrote), and an `add` reads
  the CALLER's partition exactly ONCE: `link` returns `{ outcome, friends }` — the list it
  read to decide the cap plus the single edge its transaction committed — so the route never
  Queries a second time for a list the call is already holding (a genuinely new pair still
  COUNTs the other side's partition, which is a number rather than a list). And the cap is
  COUNTED off those rows rather than kept in a counter item — see the root `AGENTS.md` for
  why a bound may be overshot by a simultaneous click and an invariant may not. This is the
  only route that DELETES, which is why the table grant gained `dynamodb:DeleteItem`. The
  route reads NO query parameter; the CloudFront `friends*` behavior forwards none, and the
  day it reads one, that behavior has to name it (root `AGENTS.md` contract). Production
  POST needs `x-amz-content-sha256` like every other write here.
- **Leaderboard reads (#190):** the ONE handler also serves `/board` — the product
  contract (the two faces, the shared ranking rules, the four-query allowList) lives in
  the root `AGENTS.md`. Implementation notes: `handleBoard` reuses the /scores param
  guards (supported lang, required mode, valid date, +1-day future guard) but reads NO
  puzzle store — a population only exists for a published daily, so an unpublished day
  answers the empty board; GET's optional `id` is validated against
  `PUBLIC_ID_PATTERN` (400 malformed); POST authenticates `{token}` exactly like /friends.
  The param guards, the JSON-body reader and the secret check are the SHARED
  `liveRoute.ts` (below), not a fourth copy. The GLOBAL face reads the day partition
  (`ScoreStore.list`); the FRIENDS face reads `getMany` — the caller's edges plus
  themselves are the exact row keys, so it fetches those (BatchGetItem in prod,
  constant in the day's population) instead of paging every player who played today to
  keep at most `FRIENDS_MAX + 1` rows. Its `UnprocessedKeys` are RETRIED (a dropped key
  is a friend missing from the board, so the read fails loudly rather than silently
  short) with **full-jitter exponential backoff** — an unprocessed response means the
  partition is under pressure, and retrying at full speed spends the whole budget
  before capacity can return, which is how a transient throttle became a 500 on the
  friends board; the jitter is what stops Lambdas throttled together from coming back
  in lockstep. The `wait` is injectable so the schedule is asserted without sleeping. Rows are ranked/cut/windowed by
  `@whippin/shared`'s leaderboard functions, then dressed with profiles — one
  `ProfileStore.get` per DISTINCT id shown, in parallel (bounded: top 50 + a 5-row
  window, or FRIENDS_MAX rows). The friends face also
  answers `waiting`: the caller's edges with no score row today, profile-dressed and
  publicId-sorted (root `AGENTS.md`). Every response is
  `no-store`; a missing profile dresses as `name: ''` / `avatar: null` — **and so does
  one whose READ FAILED** (a per-id `catch`, never `Promise.all`'s fail-fast): the name
  and mark are decoration over rows that already answered, so one throttled `GetItem`
  must not 500 a whole board. An EMPTY stored avatar dresses as `null` for the same
  reason — `''` is not a decodable avatar, and the client's fallback is keyed on null.
  No new store: the route is a pure READ over the score rows, the friend edges and the
  profile rows.
  **The LIVE routes share their plumbing** (`liveRoute.ts`, extracted 2026-08-20 when
  `/board` became the FOURTH byte-identical copy): the `no-store` header, the body
  reader with its 4 KB cap, the `{token}` device resolution, and the `(lang, mode, date)` guard
  triple with the +1-day future skew. **`clientIp` and `requireTurnstileToken` moved here
  from /scores with #202**, when the word round start became the SECOND Turnstile-gated
  write: a route reaching into `scores.ts` for them would make that file a utility module
  for routes it knows nothing about. `hashClientIp` stays in /scores — only the score
  submission dedups by address. A supported language is one the pipeline has built
  a vocabulary for (shared `VOCAB_BUILDS`, #200 — the same record the sentence ceiling
  comes from). The lang check is `Object.hasOwn`, deliberately —
  a bare `map[lang] === undefined` walks the prototype chain, so `constructor` /
  `toString` / `__proto__` pass as "supported languages" and reach the DynamoDB
  partition key. On /scores that hole is masked by the puzzle-store 404 behind it; on
  /board, which reads no puzzle store, it answered a 200, which is what made this one
  spelling rather than four.
  **`pnpm board:seed` (src/seedBoard.ts) is the LOCAL-ONLY population seeder**: run it
  against a live `pnpm backend:dev` to fill the in-memory stores with 60 scored players
  (a tie straddling the top-50 cut included), a few unnamed ones, two unplayed
  profile-only ones, and printed invite links; `--friend <publicId|/i/link>` links a
  handful to your own identity. Re-run after every backend restart (the stores reset —
  that is why it is a script, not a fixture); it copies the newest local fr sentence
  puzzle forward to the active day when that key is missing.

- **Round guess-log sync (#201):** the ONE handler also serves `POST /round?lang=&date=&mode=`
  — the product contract (server-authoritative state, strings-not-indices, the two
  bounds, cap semantics) lives in the root `AGENTS.md`. Implementation notes: POST-only
  like /friends (a GET is a named 405); the shared `requireDayParams` guard triple
  applies. Archive days sync like today's. *(This said the route reads NO puzzle store;
  #203 overturned it for the APPEND — see its own bullet below — and the READ still reads
  none.)* `{token, puzzle}` reads (404 = none yet, and
  also "nothing stored for THIS puzzle" — the tag's whole job, root `AGENTS.md`);
  `{token, puzzle, guesses}` appends. Validation is fail-closed BEFORE the store: a
  `PUZZLE_TAG_SHAPE` tag, then a non-empty string array of at most `ROUND_GUESS_CAP`
  entries, each of at most the language's `maxSlugLength` (#200) and each **left alone by
  `fold()`** — the check asks the shared contract rather than restating its pipeline as a
  local regex, which would be a third spelling free to drift from the two that matter. The
  body cap is this route's own (`readJsonObject`'s optional bound), DERIVED from the cap
  and the longest `maxSlugLength` rather than hand-picked — a coalesced flush of 500 slugs
  legitimately exceeds the default 4 KB live-body cap. Storage is the score table:
  partition `round#<publicId>`, sort key `<lang>#<mode>#<date>` (per PLAYER — the reason is
  in the root `AGENTS.md`; the order is #203's), attributes `guesses` (string list),
  `puzzle`, `createdAt`, `lastWriteAt` (ms epoch), plus #203's `progress`/`solved`. `lastWriteAt` is the ONE Number here because it is the only one
  compared arithmetically in the condition; `createdAt` is a String, and writing it as a
  Number reads back as `''` on every response for the item's whole life. The append is ONE
  conditional UpdateItem whose ConditionExpression carries every bound —
  `(attribute_not_exists(#last) OR #last < :cutoff) AND (attribute_not_exists(#g) OR (size(#g) <= :room AND #p = :puzzle)) AND attribute_not_exists(#solved)`
  (the RESULT may reach the cap, never pass it; the last clause is #203's freeze) — with `ReturnValues: ALL_NEW` so the happy
  path is one call. **Every clause is path-only CONDITION syntax and must stay that way:**
  DynamoDB's condition grammar has NO arithmetic and its whole function list is
  attribute_exists / attribute_not_exists / attribute_type / begins_with / contains /
  size(<path>) — `if_not_exists` and `+` belong to an UPDATE expression, and naming either
  makes the service reject the request with a ValidationException before a single guess is
  stored. Nothing local can catch that (`dynamoRoundStore.test.ts` mocks `send`, and every
  route test runs on `memoryRoundStore`), which is why that suite asserts the expression's
  SHAPE. That is also why the cap is expressed as ROOM (`:room` = the cap minus this batch)
  and why a batch too large for an EMPTY log — which has no size to compare — is refused in
  the store instead. A failed condition reads the item once, consistently, to classify the
  refusal: a record naming a RETIRED puzzle is a restart, so the batch REPLACES the log
  (still inside the write interval, or varying the tag would be a way around it); else
  `round_full` when any batch would overflow the cap — the truer answer, since retrying can
  never succeed — else `too_fast`. **Every refusal ANSWERS with the unchanged stored
  state** (`errorResponse`'s `extra`), which is what the client reconciles against and what
  pays for that read — but only ever the state of the PUZZLE ASKED ABOUT (`stateForTag` in
  both stores): a rate-refused RESTART answers empty rather than handing back the retired
  sentence's log, which the client would adopt as this round's truth. The lost-restart-race
  branch re-reads for the same reason, since what is stored by then may already be this
  puzzle's own fresh log. `round_full` is answered 409, and LOGGED only when the STORED log
  is really at the cap (`[round] round_full: …` — the puzzle-curation signal; the client
  stops after that refusal, so each hit is one honest line). A batch that merely OVERSHOOTS
  a round with room left — another device pushed the log forward while this caller was
  away — refuses the batch rather than the round: it answers 409 with the truth, says so in
  its message, and writes no line, or a racing second device could manufacture
  "unreachable secret" signal, `too_fast` is 429 + `Retry-After: 1` — which `corsHeaders` must EXPOSE, or
  a browser reads null for a header only curl and `backend:dev` ever see. Local serve swaps
  in `memoryRoundStore`; no new env or IAM (the table grant already carried GetItem +
  UpdateItem).
- **Word mode's two round writes (#202):** the same route, `mode=word`. The product
  contract (why the fast game syncs least, the server-stamped clock, the wait check, the
  caps, what is deliberately NOT validated) lives in the root `AGENTS.md`. Implementation
  notes: the route DISPATCHES on the body — `turnstileToken` = START (a 400 on a sentence
  round, which has no clock), `guesses` = append or submit by mode, neither = read. START
  is one conditional UpdateItem (`attribute_not_exists(#started) OR #p <> :puzzle`, with
  `REMOVE #g` so a retired word's log leaves with its clock); a failed condition means this
  word is already running and the ORIGINAL stamp is read back and answered. SUBMIT is the
  one path here that READS A PUZZLE STORE (`getWordPuzzle`) — only the artifact can tell a
  claim from a miss, and both the claim ceiling (`wordScoreMaximum`, distinct ranks) and
  the wait check are priced from that count. The store reads once, consistently, then
  writes under `#p = :puzzle AND attribute_exists(#started) AND attribute_not_exists(#sub)`:
  the wait check is arithmetic (which DynamoDB's condition grammar has none of) and the
  caller has to be told WHICH bound refused it, but first-write-wins is still decided by
  the write's own condition rather than by the read before it. `startedAt` and
  `submittedAt` are STRINGS like
  `createdAt`, and no word path touches `lastWriteAt` (the streaming interval's attribute).
  **Every command's `ExpressionAttributeNames` holds exactly the aliases ITS OWN
  expressions name** — DynamoDB rejects an unused entry, and an undeclared alias, with a
  ValidationException before anything is written, so one union map covering every attribute
  the store knows about fails EVERY write in production while looking perfectly fine
  against a mocked client (it shipped that way once). `dynamoRoundStore.test.ts` runs the
  correspondence check on every command any test issues, in both directions and for values
  too, so a new write path is covered by the tests that already exist.
  **The START answers `resumed`** — false when THAT call stamped the clock, true when it
  joined one already running — because the client cannot otherwise tell whether it is the
  session running the round, and the root `AGENTS.md` records what turns on that.
  **Every answer, refusals included, carries the server's own `now`** — the client anchors
  `now − startedAt`, an elapsed span, which is what makes the visible clock immune to
  device-clock skew. `too_early`/`not_started` are 409s, an over-cap or unclaimable log is
  a 400, a missing artifact the day-addressed 404, a rejected challenge a 403
  `turnstile_rejected` (the shared `requireTurnstileToken`, extracted from /scores when
  this became the second gated write). `HandlerDeps.rounds` is a `RoundHandlerDeps`
  (`{roundStore, turnstile, allowSourceIp?}`) for that gate — the /scores deps' shape.
  **The CORS PREFLIGHT is cached** (`PREFLIGHT_MAX_AGE_SECONDS`, applied on the OPTIONS
  branch and deliberately WITHOUT the live routes' `no-store` — a preflight carries no
  data, and what governs its reuse is `Access-Control-Max-Age`). /round is the first route
  that POSTs continuously, about once a second while a player types, so the default
  few-second preflight cache costs an extra OPTIONS invocation and an RTT stall every few
  writes.

- **Derived scores (#203):** the same route, `mode=sentence`. The product contract (why the
  score stops being claimed, the slice, the loading rule, the freeze, the corrective write,
  the sort-key reorder) lives in the root `AGENTS.md`. Implementation notes: an APPEND now
  fires `rounds.get(..., { consistent: false })` and `loadSlice` CONCURRENTLY — neither
  depends on the other, so the slice fetch hides inside a round trip already being paid for —
  derives from *(stored log + batch)*, and hands the two values to `append`, which writes
  them in its own mutation and carries `attribute_not_exists(#solved)` as a fourth clause of
  the condition it already sends. A missing slice is the day-addressed 404; the READ path
  loads none, so a mount read stays as cheap as it was. After the append, `settleAppend`
  re-derives from the RETURNED log and, on a disagreement, calls `roundStore.settle` behind
  a small bounded RETRY (it is the last chance to record a solve). That write is MONOTONIC
  in `progress` — one comparison clause on its condition, mirrored by the memory store, so a
  settle delayed past a better one is refused rather than parking a stale percentage.
  `parseSlice` checks the rank VALUES too, not only the field shapes, and `encodeSlice` runs
  it before writing: a malformed puzzle then fails loudly at PUBLISH instead of shipping a
  day whose every append answers the day-addressed 404. **NEITHER artifact is cached.** The
  published revision now makes a revision-keyed cache correct, but fresh remains simpler and
  cheap: the small slice fetch overlaps the round read, and the full artifact is loaded only
  on solve. **`publish` stamps a `revision`** on the puzzle and its slice — a hash of the
  complete puzzle content, rank maps included, so an identical republish is a no-op — and
  `loadSlice`/`loadPuzzle` refuse anything that does not name the version the caller sent.
  Publish writes the slice FIRST; the shared revision makes the two-object window fail closed
  as a 404 rather than mixing their contents. **A corrective write that does not land is not claimed** — `settle` REPORTS whether
  the state it asked for is now the stored one, so a declined condition (a concurrent
  republish) is a verdict rather than a success: the answer carries the state as stored, no
  score row is written, and the client keeps its conversation open. **A missing round is CONFIRMED consistently** before
  the round-start challenge is demanded, since the derivation's pre-read is eventually
  consistent and a stale `null` 403s an append the client sent no token with. And
  **`/scores` takes the caller's `id`** so the band it reports is theirs rather than whoever
  else recorded the same number (`buildSlice` also stopped reading `holes[secret]` through
  Object.prototype, which swallowed a `constructor` secret whole). A truth that reads SOLVED
  then records the day's score row — `countTries` over the FULL artifact (`loadPuzzle`), the
  one thing the slice cannot answer — and that write's failures are LOGGED, never surfaced:
  the answer is about the log. `puzzleReads.ts` holds NO state — both reads are fresh, so
  there is nothing to reset between tests and nothing an instance can answer a later
  request from.
  Round CREATION is Turnstile-gated: the sentence round has no START message, so the
  challenge rides the append whose pre-read found nothing (`requireRoundStart`), and a bare
  token with no guesses is a 400 rather than a free challenge to burn. `RoundHandlerDeps`
  therefore carries `scoreStore` + `ipHmacSecret` beside its verifier — explicitly, rather
  than reaching into `deps.scores` for them, which would make that file a utility module for
  a route it knows nothing about. **`round*` gained the CDN's viewer-request function**
  (`infra/lib/backend-stack.ts`): both the gate and the IP-metered score row need a trusted
  address, and its absence there was already a latent 500 on every #202 word round start.
  **`pnpm board:seed` PLAYS the day** now rather than posting numbers: one append per seed
  carrying the puzzle's secrets plus enough distinct misses to land on the score it wants
  (`playthrough`), which is also why it reads the day's puzzle and copies a slice forward
  with it.
- **Server-backed player history (#211):** the ONE handler also serves `POST /history?lang=&mode=[&month=]`
  — the product contract (why it exists after #214, the explicit-loading rule, the streak
  window, the metering stance) lives in the root `AGENTS.md`. Implementation notes: POST-only
  like /friends (a GET is a named 405), the `{token}` body check and the `lang`/`mode` guard
  are the SHARED `liveRoute.ts` (`requireGameParams`, split out of `requireDayParams` because
  this read is addressed by a MONTH rather than a day); `month` is validated against the
  shared `HISTORY_MONTH_PATTERN` and is OPTIONAL, and there is deliberately NO future guard —
  a month past the active day simply holds no rows. The body may carry `collection: false`
  (PR-218 review) to skip the solved-day read entirely — the chooser's month-only shape;
  absent means true. The two reads go out CONCURRENTLY (the
  /round rule): `RoundStore.listMonth` — one Query over the caller's own partition behind the
  `<lang>#<mode>#<YYYY-MM>-` prefix, `ProjectionExpression`-limited to `sk`/`progress`/`solved`
  so the raw guess logs never leave the store, strongly consistent (a player opens the archive
  right after finishing a day) and PAGED — and `PlayerHistoryStore.solvedDays`. Every response
  is `no-store`; a player with nothing played answers `{days: [], solvedDays: []}`, which is an
  ANSWER. **The write is the ROUND route's**: the append that CONFIRMS a solve credits the day
  when the round was played ON THE DAY — `onTime`, ONE predicate, checked once in
  `settleAppend` for BOTH rewards (before the scoring artifact is even loaded, so an
  archive solve never parses a multi-MB puzzle for a row that will not be written) and worn
  by `recordScoreRow` for Word mode, where the judged instant is the run's server-stamped
  START — its submission is deferred by design, so the write's arrival says nothing about
  when the run was played (PR-218 review; see the root `AGENTS.md`). The confirming
  answer carries the verdict (`credited`), which is what the client's celebration rides.
  A late finish earns neither the streak credit nor the leaderboard row (see the root
  `AGENTS.md` on why the flip-edge tolerance had to go, and on what that narrowed for
  archive plays). Its
  failures are LOGGED, never surfaced — the collection is a rebuildable cache of the
  round rows. `dynamoHistoryStore` credits with a NUMBER SET `ADD` under
  `attribute_not_exists(#days) OR size(#days) < :max OR contains(#days, :one)` — condition
  grammar only, the round store's rule — so a re-solve is a silent no-op and only a genuinely
  FULL collection needs trimming. **That trim is TWO SET OPERATIONS, never a rewrite**
  (corrected on review): an unconditional `ADD` returning `ALL_NEW`, then a `DELETE` naming
  exactly the elements now beyond the cap. A read plus `SET #days = <the whole set>` is a
  lost update — two credits for different eligible days read the same 800 and each write back
  a set omitting the other's day — and what it loses is a player's streak. Naming ELEMENTS
  commutes with a concurrent credit, and the ADD's own returned membership is what the trim
  is computed from, so no snapshot can go stale between the two. Concurrent credits may drop
  the same oldest element and leave the collection a day over the cap; the next credit trims
  again. No new env, no new IAM: the table grant already carried Query, GetItem and
  UpdateItem.
- **Devices and the accounts they belong to (#216):** the ONE handler also serves
  `POST /devices` — and ONLY POST (a GET is a named 405). The product contract (the token's
  exact shape, why the base item is keyed by its hash, where an account is created, what
  `unknown_device` means) lives in the root `AGENTS.md`. Implementation notes: the route
  DISPATCHES on the body — `turnstileToken` = BOOTSTRAP, `revoke` + `revokeKey` = sign that
  listed device out, neither = list — and a body carrying bootstrap and either revoke field is
  a 400, the /round rule. BOOTSTRAP verifies one
  Siteverify call against the trusted viewer address, then writes the account row and the
  device row in ONE `TransactWriteItems` of two CREATE-ONLY puts: an account with no device is
  unreachable and a device with no account is unauthenticable, so a half-written pair is not a
  state either side should have to handle. It reads by token hash FIRST, because that is the
  common retry — the answer's own idempotence — and a racing second transaction adopts the
  identity that won rather than throwing. The ids are minted by the ROUTE, from
  `@whippin/shared`, so the store stays a storage contract. AUTHENTICATION
  (`liveRoute.requireDevice`) is a strongly consistent GetItem on `device#<tokenHash>` plus
  the account-existence check, both strongly consistent for the profile read's reason: a
  device that just bootstrapped calls immediately with the token it was handed, and an
  eventually-consistent miss there is `unknown_device` — the one answer that signs a player
  out. The list exposes each projected base-key digest as an opaque, non-authenticating
  `revokeKey`; `revoke` uses it for ONE direct base-table DeleteItem under a condition naming
  the account and device. It performs no second GSI lookup, so propagation lag cannot turn a
  valid sign-out into a silent miss. A failed condition performs one strongly-consistent BASE
  read and returns `absent` or `mismatch`: the route filters an exact `revokeKey` after
  `removed`/`absent` (including a concurrent self-revocation still visible in the GSI), and
  filters nothing after `mismatch`. Throttling, permission and network failures propagate
  rather than pretending the delete succeeded. `touch` swallows its own
  failed condition for the same reason: `lastSeenAt` is a label on a screen, and a race with a
  revocation must not turn into an error the player sees. Storage is the score table again —
  `device#<tokenHash>`/`device` with the two `gsi1*` index attributes, and
  `player#<accountId>`/`account` beside the #188 profile row. No new env; the table grant
  needed no new action, and the index ARN comes along with `Table.grant` once the table has an
  index. Local serve swaps in `memoryDeviceStore` (seedable, which is what lets a route test
  name its caller at module level) and the accept-all verifier; restarting signs every local
  device out, exactly as a wiped table would.
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
