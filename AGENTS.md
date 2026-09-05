# AGENTS.md — Whippin AI (daily sentence-reconstruction game)

> This ROOT file holds everything repo-wide: architecture, engineering principles, the
> cross-package contracts, testing policy, workflow. Each package keeps its own
> `packages/<pkg>/AGENTS.md` with the guidance specific to it and ASSUMES this one: read this
> file first, then the file of the package you touch. Every `CLAUDE.md` (root and
> per-package) is a symlink to its sibling `AGENTS.md` — edit the **AGENTS.md**.
>
> The **code is ground truth.** If a rule here contradicts the code, trust the code and
> surface the conflict rather than silently "fixing" either side.
>
> Compacted 2026-09-05 (user-decided): this file records DECISIONS — the rule, its exact
> constants and where they live, and one line of why when the why is what stops an agent
> undoing it. Implementation detail and product/UX narrative live in the package files.

React + Vite + TypeScript front end; Python generation scripts run via `uv` (wired through
`pnpm`). Two languages: **en** (Stanford GloVe `glove.6B.300d`) and **fr** (fastText
`cc.fr.300`). A **pnpm-workspaces monorepo** (`pnpm-workspace.yaml`; pnpm pinned via the
root `packageManager` field):

```
packages/
  generation/   Python puzzle generation (uv): embeddings -> reduced vectors -> puzzles;
                also writes the vocab existence set into web/public.
  benchmark/    offline LLM puzzle benchmark harness (#68) — LAB-ONLY: never writes into a puzzle.
  backend/      daily-puzzle backend (#2): ONE handler for Lambda + local serve; puzzle store
                (S3/FS) + publish; every live route (/scores /profile /friends /board /round
                /history /devices /link) and the share/invite preview pages.
  infra/        AWS CDK app: backend (#3) + web hosting (#21) + WhatsApp bot (#236) sibling stacks.
  shared/       cross-cutting TS: slug/fold contract, game-day logic, schema types, scoring,
                identity, codecs. Every module is the ONE source of truth for its concern.
  web/          React + Vite + TS front end (the game).
  whatsapp-bot/ the WhatsApp group scoreboard bot (#236). Consumes shared; nothing depends on it.
```

Data flow: generation writes **puzzles** into `packages/generation/output/` (then
`pnpm puzzle:publish` places them in the store the backend reads), and the **vocab**
existence set into `packages/web/public/vocab/<lang>.json` plus its metadata into
`packages/shared/src/vocab.generated.json`. Each package's file map lives in ITS `AGENTS.md`.

## Maintaining these files

- **You are a SCRIBE of the user's decisions, not an author of them.** Update these files
  only when the user has **explicitly** decided something that changes an invariant, command,
  schema or architecture rule. Never record a rule you inferred or think is a good idea; never
  document a transient state as permanent.
- **Two zones, two bars.** *Stable invariants / cross-package contracts / Do-NOT lists*: edit
  only on an explicit, confirmed user decision, and call the edit out prominently in your
  reply. *Current state / mutable*: may be updated to reflect what now exists.
- **Put a rule at the right SCOPE.** Repo-wide rules, workflow and anything two or more
  packages must agree on live HERE; single-package guidance lives in that package's file.
  State a rule once, at the widest scope it applies to; reference it from narrower files.
- **Record the decision, not its history.** A rule, its constants, its location, and one line
  of why. No measurements, review chronology, or rejected alternatives — except a rejected
  alternative an agent would plausibly re-propose, in one line.
- **Surface every edit** in your reply. **When in doubt, DO NOT edit** — ask or mention it.
  Keep edits minimal and consistent with the existing structure.

## Engineering principles (decided 2026-08-03)

User-decided rules with the same bar as the stable invariants.

- **Do not preserve backward compatibility.** Remove obsolete paths instead of adding
  compatibility layers, fallbacks or migrations. (The DB is wiped before launch; persisted
  client state is simply dropped by a persist-version bump.)
- **Choose the simplest implementation that fully meets the current requirements.** No
  speculative abstractions, configuration or indirection.
- **Grow the system in layers**: smallest end-to-end version first, each capability on top of
  a product that already works. Never trade a working product for unfinished complexity.
- **Keep components modular and concerns clearly separated.**
- **Prefer established, well-maintained libraries**; lean on the dependencies already in the
  project before writing your own or adding packages. Check a library's docs/types before
  assuming it lacks a capability.
- **Make architectural decisions for the long term.** No stopgaps meant to be replaced later.

---

## Cross-package contracts

Decided and verified against the code. Load-bearing. Each package's own invariants live in
its `AGENTS.md`; what follows is what two or more packages must agree on.

### slug() ⇔ fold() must stay byte-identical (cross-language)

Python `slug()` (`packages/generation/scripts/slug.py`) and JS `fold()`
(`packages/shared/src/slug.ts`) MUST produce the same key: **lowercase → expand ligatures
(`œ→oe`, `æ→ae`) → NFKD → drop combining marks → keep only `[a-z]` and `-` → collapse
repeated dashes → trim edge dashes.** (`été→ete`, `œuf→oeuf`, `peut-être→peut-etre`.)
The case table is ONE fixture, `packages/shared/fixtures/slug-cases.json`, consumed by both.

**Accents are for DISPLAY; slug is for COMPARISON.** Never fold a form you display; never
display a slug. Filenames are ASCII slugs; JSON content keeps accents. On the front, `fold()`
is applied only to the player's raw keystrokes.

### Per-puzzle JSON schema (sentence)

```jsonc
{
  "lang": "fr",
  "words": ["tu", "t'attends", "rien,"],       // full sentence tokens, ACCENTS + PUNCTUATION KEPT
  "holes": [                                    // one entry per occurrence, sorted by pos
    { "pos": 1,
      "secret": { "word": "attends", "slug": "attends" },  // the pure word only
      "start":  { "word": "...",   "slug": "..." },
      "start_rank": 87,
      "prefix": "t'",                           // OPTIONAL display text before the blank
      "suffix": "" }                            // OPTIONAL display text after the blank
  ],
  "ranks": {                                    // keyed by SECRET slug
    "foret": { "<input-slug>": { "word": "<accented>", "rank": 12, "dq": 231 }, ... }
  },
  "source": { "kind": "book", "author": "Victor Hugo", "work": "Les Misérables" },  // OPTIONAL
  "revision": "<hash>"                          // stamped by puzzle:publish (#203)
}
```

- **`words[]` holds full display tokens, punctuation and apostrophes kept** (lowercased).
  Generation locates each secret inside its token by slug on the token's word-cores and splits
  it into the pure `secret` word plus `prefix`/`suffix` — display-only affixes, omitted when
  empty, that never touch the secret or slug/fold.
- **Authoring selects exactly 3 distinct secret slugs.** A slug appearing more than once
  yields one hole per occurrence (own `pos`/display/affixes) sharing one rank map and one
  start hint; `holes` may exceed three entries, `ranks` has exactly three keys. Two selected
  secrets in one identity group are rejected at generation.
- Every `{word, slug}` carries **both**, even when equal.
- **`source` is fully optional**, every sub-field independently optional; values are display
  forms; `kind` is an open union. There is no `context` field. Consumed by the solved screen.
- **No `benchmark` field, no `road` field, no `par` field** (removed 2026-08-12). Consumers
  ignore a stray key on an already-published puzzle. `packages/benchmark` never writes into a
  puzzle file.
- **`ranks`**: secret slug → input slug → `{word, rank, dq}`. `word` is the group's canonical
  accented display form (what the front displays, not necessarily what was typed). **Rank
  semantics:** secret = `0`; nearest group = `1`; larger = farther. Alias keys share their
  group's rank.
- **A ranked GROUP is a playable word identity (#104/#134/#146; lemma-merged ONLY in
  `gen_phrase`'s merge walk):** inflected forms of one word are one group; the consumer key is
  opaque (a `:pos` suffix names the source entry that donated it). A group is ranked by its
  closest **homograph-free** embedded form; a group with no clean form ranks by its closest
  form of any kind and is flagged in generation output. Every reduced-vocab form of a group is
  one of its keys; an ambiguous surface (`portes` → porte/porter) keys to whichever group
  ranked closest — **a surface is only a KEY, never a group**. Keys are assigned
  closest-first; a group left with no key dissolves and consumes no rank; a group's display is
  its closest OWNED form. `TOP_K` counts surviving groups (filter-then-cap). **The secret is
  group 0 and claims the group the author CONFIRMED** (the #133 form question fires before
  the walk; off a TTY `--form` is required); an unconfirmed homograph claims a group only when
  the surface names exactly one (`mois` never claims `moi:nc`). A borrowed vector (#119,
  `--donor`) claims only what secret and donor share. Authoring mechanics: generation `AGENTS.md`.
- **`dq` — quantized distance to the secret, one byte, per hole (#115).** With `s1` = the
  rank-1 group's similarity and `smin` = the last kept group's,
  `dq = round(255 * (s − smin) / (s1 − smin))`: rank 1 = 255, farthest kept = 0,
  non-increasing. Present on **every rank ≥ 1 entry**; **rank 0 carries none**. A flat span
  (`s1 == smin`) is a hard error. **No opt-out.** A GROUP property like `word`/`rank`.
  Consumers compute ratios of differences, e.g. journey `(dq − dq_start) / (255 − dq_start)`.
- **Slug collisions** (`côté`/`coté` → `cote`): keep the smallest-rank entry, silently.
- **`revision`** is stamped by `puzzle:publish` on the full puzzle AND its derivation slice: a
  hash of the complete content, rank maps included. Identical republish = same value; any
  correction mints a new one and restarts the retired round (see *Sentence round*).

### Single-word artifact schema (#154; `freq` #163)

The second puzzle type: one word and its ranked neighborhood. Produced by
`packages/generation/scripts/gen_word.py` (`pnpm gen:word`), typed `WordPuzzle` in
`shared/src/types.ts`, served under `mode=word`.

```jsonc
{
  "lang": "fr",
  "word": { "word": "phare", "slug": "phare" },
  "ranks": {                                       // ONE FLAT map
    "<input-slug>": { "word": "<accented>", "rank": 12, "dq": 231, "freq": 8412 }, ...
  }
}
```

- **Inner rank-map semantics are the sentence schema's, unchanged**, produced by the ONE
  shared per-secret pipeline (`gen_phrase.walk_secret`): merge walk, #133 confirmation,
  donors, `TOP_K`, `dq`, collisions. Rank 0 carries no `dq`.
- **`freq` — the group's corpus rarity: the 1-based position, in the frequency-ordered
  EXISTENCE SET (distinct slugs), of the group's MOST FREQUENT OWNED KEY** (1 = commonest word
  the game admits). Read off the reduced file's preserved frequency order
  (`gen_word.annotate_freq`), over the exact population written to
  `web/public/vocab/<lang>.json`. An owned key, never a surface another group owns. A GROUP
  property; present on **every** entry, rank 0 included; absent only for a group with no key in
  the existence set (a borrowed-vector secret). A map with NO `freq` anywhere is a stale
  artifact the web REFUSES (`parseWordPuzzle`). **Emitted by `gen_word.py` only.**
- **The WEB maps `freq` → rarity grade + bonus seconds** (`web/src/game/wordGame.ts`
  `rarityOf`/`bonusSeconds`), reading it as a **fraction of the corpus** (en 75k vs fr 128k):
  the shipped number is a corpus fact, what counts as rare is a web tuning. Word mode's board
  paints stations by that grade (`web/src/game/wordBoard.ts`); there is no semantic clustering.
- **One flat `ranks`**; no `words`/`holes`/`start`/`start_rank`/`source`. **`WORD_CLAIM_ZONE`
  (`shared/src/scores.ts`) is pinned to nothing in generation** — `dq` runs to the map's own
  `TOP_K` edge, so the zone moves with no republish.

### Vocab metadata (#200/#201)

- `packages/shared/src/vocab.generated.json` states, per language, what the existence set IS:
  **`vocabSize`** (distinct slugs — also, by its key set, what counts as a supported `lang`),
  **`maxSlugLength`** (caps a STORED GUESS: `/round` refuses a longer string before the store),
  **`embedding`** (the corpus build name, no path/suffix) and **`builtAt`** (UTC, dates the
  corpus build, not the run — an unchanged rebuild leaves the file byte-identical).
- **GENERATED, never hand-written**, by the very call that writes the set (`slug.write_vocab`),
  refreshed by every command that can refresh the set (`reduce`, `gen:phrase`, `vocab:<lang>`).
  It lives in `shared/` so `deploy.yml`'s paths-filter carries a regenerated vocabulary into
  the backend. The web imports it via `shared/src/vocab.ts` (`VOCAB_BUILDS`).

### Day-addressed routing & the game day

- `shared/src/day.ts` is the ONE 22:00-ET DST-correct day definition (web, handler, publish).
  The **client computes the active day itself**; normal play is ONE fetch:
  `GET <VITE_API_BASE_URL>/?lang=<lang>&date=<YYYY-MM-DD>[&mode=word]`. `mode` absent or
  `sentence` = the sentence puzzle, `word` = the word artifact, else 400. Store keys
  `<date>.<lang>.json` / `<date>.<lang>.word.json`.
- The server serves **any past day** (date-addressed archive, #53) and the **future only
  within +1 day** of its own active day (clock-skew tolerance); beyond → 404. `date`
  missing/malformed → 400. Backend 404 → `noPuzzle` (NO PUZZLE TODAY); any other failure →
  `error`. `/today` is a diagnostic only (`no-store`); the client never reads it.
- **Caching:** `max-age=300, s-maxage=31536000`; `pnpm puzzle:publish --s3` and the backend
  deploy both **invalidate `/*`** on the API distribution.
- **No client-side puzzle override** (removed 2026-07-19): the front always loads the day's
  puzzle from the backend; to test a puzzle, publish it into the local store and point the
  front at `pnpm backend:dev`. `usePuzzle`'s `dayNumber` is always a real number.
  `VITE_API_BASE_URL` is required for `pnpm dev` / `pnpm build`; the front never falls back
  to its own origin.

### API routes: two CloudFront policies, and the live routes' shared shape

The API distribution (`infra/lib/backend-stack.ts`) serves its routes under TWO different
policies, and a query parameter a handler reads has to be named in the right one — three
packages agree on each list; `backend:dev` has no CDN and cannot show a drift.

| Route | Forwarded query | Policy |
| --- | --- | --- |
| `/` (puzzle, both modes) | `lang`, `date`, `mode` | **CACHE POLICY** allowList: the cache key, and — with no origin-request policy — exactly what reaches the Lambda |
| `/scores` | `lang`, `date`, `mode`, `id` | origin-request allowList, **caching DISABLED** |
| `/board` | `lang`, `date`, `mode`, `id` | same |
| `/round` | `lang`, `date`, `mode` | same |
| `/history` | `lang`, `mode`, `month` | same |
| `/profile` | `id` | same |
| `/friends`, `/devices`, `/link` | none (empty allowList) | same |

- **The PUZZLE route is CACHED** (`max-age=300, s-maxage=31536000`): an unlisted parameter
  both collapses two responses onto one year-long edge entry and never reaches the origin.
- **The eight LIVE routes have caching disabled**, each with its own origin-request policy
  (its query allowList plus the Lambda-URL-safe `allExcept: Host` headers) and `no-store`
  answers; an unlisted parameter never reaches the origin. The day a handler reads a new
  parameter, name it in that policy too.
- **The share page (`/s/*`), the cards (`/og/*`) and the invite preview (`/i/*`) are NOT
  live routes**: they are CACHED behaviors on the WEB distribution (`infra/lib/web-stack.ts`)
  handed to the API origin — a year for content-addressed share tokens, 300s for the invite
  preview AND for a SIGNED share (`/s/<token>/<publicId>`, `/og/<token>/<publicId>.png`),
  which names a player who can rename or redraw.

The live routes then share:

- **Auth is the DEVICE TOKEN in the BODY** (`{token}`, #216), never a query string — so every
  private route is POST-only (a GET is a named 405), the READ included. `id`/`publicId` in a
  query is always a PUBLIC id and grants nothing.
- **A production POST needs `x-amz-content-sha256`** over the exact UTF-8 body bytes sent
  (OAC); never reserialize after hashing. `backend:dev` has no OAC and cannot show a missing hash.
- **The trusted client address is `VIEWER_IP_HEADER`** (`shared/src/scores.ts`), stamped by a
  CloudFront **viewer-request function** on the `/scores`, `/round`, `/devices` and `/link`
  behaviors and the ONLY address the backend trusts. (CloudFront's generated
  `CloudFront-Viewer-Address` cannot coexist with the OAC-required viewer
  `x-amz-content-sha256` under any single header mode; the function overwrites the header from
  the TCP peer.) Three packages agree on the header name — a drift is a 500 on every gated write.
- **Turnstile sits on the request that CREATES state**: device bootstrap, round creation
  (Word START; the sentence append whose pre-read finds nothing), the link code SEND. Tokens
  are prefetched into a two-slot single-use queue so a brand-new player's first PLAY (bootstrap
  + round start = two challenges, deliberately) costs no visible wait. Local: accept-all verifier.
- **Clients act on the error CODE, never on the status alone.** What a given code means —
  a verdict that closes a conversation (`round_solved`), a wait (`too_early`), an input to
  correct (`bad_code`), a confirmation to advance to (`would_erase`, `would_switch`) — is each
  route's own contract, recorded in its section below. What is universal: a 5xx, a transport
  failure or an unparseable body is NEVER a verdict — it never signs anyone out, never resets
  a round, and on a write whose outcome is unknown the client re-reads before writing again.

### Devices, accounts, and where an account is created (#216, decided 2026-08-23)

- **A device holds a REVOCABLE token; the SERVER assigns the account.** Token contract
  (`shared/src/identity.ts`): 32 random bytes → **exactly 64 lowercase hex**, persisted before
  first use; the server accepts only `^[0-9a-f]{64}$`, rejects a non-canonical value before
  hashing or any read, never normalizes case, never logs the raw token. The client never
  hashes. Storage: ONE item per device keyed `device#<SHA-256(token)>` → account, plus GSI
  `DeviceByAccount` for the device list; auth = base read + the account row must still exist.
  `lastSeenAt` moves at most once a day. The user-agent is parsed SERVER-side into coarse
  fields (`backend/src/userAgent.ts`), so a person recognises their phone; no rename.
- **`POST /devices`**: `{token, turnstileToken}` bootstraps (IDEMPOTENT by token hash),
  `{token}` lists, `{token, revoke, revokeKey}` deletes one device by ONE conditional
  base-table delete (no GSI lookup). Every answer carries `{accountId, deviceId, devices}`,
  never the token. Revoking the calling device is allowed. Surface:
  `web/components/DeviceList.tsx` on `/account`.
- **An arbitrary unknown token never creates an identity**: malformed → 400 `bad_request`;
  well-formed but unknown on a private call → 401 `unknown_device`.
- **Signed out has two authoritative answers** — `unknown_device`, or a self-revocation whose
  returned list no longer holds the caller. Never a 5xx. The client persists a **TOMBSTONE**
  `{signedOut, accountId, deviceId}` in place of the identity (survives reloads, reaches
  sibling tabs, fails bootstrap CLOSED while it stands); the signed-out screen offers
  **RECONNECT** (primary, lifts the tombstone and lands on `/account/signin`) and **SKIP**
  (removes it; the next deploy button mints fresh).
- **AN ACCOUNT IS CREATED ON THE DEPLOY BUTTONS ALONE — never on load, never as a side
  effect** (user-decided 2026-08-24). Six triggers, each a single primary-button tap that
  chains its real action behind the bootstrap and reports failure on the full-screen
  `ErrorScreen` (no retry button; the player returns to the button): sentence gate **PLAY** ·
  Word **PLAY** · **accepting an invite** · **sending an invite link** · profile **SAVE** ·
  the link flow's **SEND CODE**. Consequences: the sentence game shows the full rules gate
  whenever the device has no account (archive days included); the engines never mint — an
  append/submission resolves the identity it holds or stands down; a tokenless leaderboard /
  profile editor renders a LOCAL PLACEHOLDER identity from a persisted seed
  (`gameStore.localSeed`, publicId-shaped); **the username is decided locally, then deployed**:
  on acquiring an account the client stores the placeholder name + mark as the profile, only
  into an account with NO stored row (`createOnly: true`; a lost race is 409 `profile_exists`,
  settled). Invites are gated on neither side.
- **NO TOKEN MEANS NO PRIVATE FETCH**: a tokenless device knows its server state is empty and
  publishes ready-and-empty round/history state without calling `/round` or `/history`.
- **First bootstrap is ONE origin-wide critical section** (Web Lock over re-read → mint/persist
  pending token → bootstrap → commit); a pending token in storage is retried, not replaced. No
  Web Locks → fail before minting.
- **Local state follows the identity that owns it** (`web/state/identityScope.ts`): the first
  acquisition clears nothing; an `accountId` change clears the sentence outbox, transient round
  loads and private summaries; a `deviceId`-only change clears device-owned state (the Word
  round); binding an email changes neither. Persisted state is tagged with its owner; every
  in-flight private request captures the `(accountId, deviceId)` epoch and is aborted/ignored
  if it changes. Persisted game state lives behind ONE transactional IndexedDB record
  (`web/state/gamePersistence.ts`); localStorage holds only the device token / tombstone.

### Sentence round: server-owned log, outbox, derived score (#201/#203/#214)

- **The server owns game state from the first guess**, linked or not. **`POST /round?lang=&date=&mode=`**:
  `{token, puzzle}` reads (404 = none for THIS revision), `{token, puzzle, guesses}` appends.
  Every answer — refusals included — carries the full stored state of the PUZZLE ASKED ABOUT
  (`{guesses, createdAt, progress, solved, …}`), never a different revision's log. Archive
  days sync exactly like today's. The record NAMES its `puzzle` revision; an append carrying a
  different one REPLACES the log (a republish restarts the round; a solved-day credit already
  earned is kept).
- **The server stores folded strings, in order, never indices.** Validation asks the
  contract: a guess is one `fold()` leaves alone, at most `maxSlugLength`. The server READS
  the log (#203) but never interprets it on the way in.
- **Bounds are cross-package constants** (`shared/src/scores.ts`): **`ROUND_GUESS_CAP` = 500**
  raw entries per round, enforced inside the append's own condition (as ROOM — DynamoDB
  conditions have no arithmetic); **`ROUND_WRITE_MIN_MS` = 1000 ms** between writes per player
  **per daily**, one spelling for the server's condition and the web's pacing, which paces
  from the previous ANSWER, not the send. Refusals: 429 `too_fast` (+`Retry-After: 1`, exposed
  by CORS), 409 `round_full`, 409 `round_solved`. Nothing is partially appended.
- **Local storage is an OUTBOX (#214).** Three values kept apart: **SERVER STATE** (raw log +
  `solved`, in memory only), **OUTBOX** (unacknowledged folded guesses, revision-qualified —
  the ONLY persisted sentence state), **PLAY LOG** (pure first-occurrence projection of server
  + outbox, deduped by shared `guessKey`). The play log drives every client derivation; the
  RAW log drives only the cap. Load order: puzzle → drop mismatched outbox → read `/round` →
  hold state → prune outbox → derive → THEN enable input. A failed read is a visible
  loading/retry state, never permission to start from a local mirror. Guesses are judged and
  rendered locally and instantly; the write follows.
- **Outbox writes**: one conversation per round; each write snapshots the outbox and POSTs
  what fits in `room = cap − serverState.guesses.length` (never an over-cap body). On 2xx,
  replace server state and keep only what it does not represent, BY IDENTITY. 429 adopts,
  keeps, paces. 409 `round_full` below the cap = batch overshot another device → adopt, retry
  the fitting prefix; **at the cap with an unsolved log = CAPPED terminal state**. 409
  `round_solved` adopts the frozen result SERVER-ONLY (deduped by identity), discards the
  outbox, closes. **An UNKNOWN outcome (transport, 5xx, malformed) READS before writing
  again** — appends are at-least-once. Any other 4xx closes.
- **Derived scores (#203): the client never claims a score.** `progress` and write-only-true
  `solved` are stored on the round row in the append's own mutation, derived from stored log +
  batch; after the write the handler re-derives from the RETURNED log and, on disagreement,
  issues one retried, progress-monotonic corrective write (the last chance to record a solve).
  **A solved round refuses further appends** (`attribute_not_exists(#solved)`) so a recorded
  score never changes; the refused device adopts AND closes. The readings are shared
  (`shared/src/scoring.ts`: `s`/`holeProgress`, `rankCount`, `guessKey`, `countTries`) so the
  screen and the leaderboard cannot disagree over one log.
- **What the server LOADS:** every append reads the day's **derivation slice** (every key at
  or below each hole's `start_rank`, + `n`/`start_rank`; ~300× smaller than the puzzle),
  produced by `pnpm puzzle:publish` beside the sentence puzzle (SENTENCE ONLY), written FIRST,
  carrying the same `revision`; a solve reads the FULL artifact for `countTries`. **Both are
  read FRESH, no cache**; the slice fetch runs concurrently with the round read. **A missing
  slice or a revision mismatch is the day-addressed 404** — no degraded mode.
- **Authoritative SOLVED comes only from the server flag.** The board may complete locally
  while the solving append is in flight; the result, leaderboard, streak and `solve` event wait
  for confirmation. A solve confirmed by THIS device's batch is fresh (celebrated); one learned
  from a mount read or a `round_solved` refusal is adopted history (shown, never celebrated).
- **THE CAP IS TERMINAL AND PRINTS `∞`**: unsolved with exactly `ROUND_GUESS_CAP` raw entries
  (derived, never stored; server `solved: true` wins over the cap check). No leaderboard row,
  streak, celebration or `solve` event; answer + source shown; shareable (`share` event).
  `round_full` at the cap is logged server-side as puzzle-curation signal; a client already at
  the cap spends no request. The `∞` glyph is pixel-art SVG path data in `shared/glyphs.ts`
  (Press Start 2P has none; the OG card loads no system fonts), used by `cardSvg.ts` and the web.
- **Share token v6** is the sentence format (capped flag + numeric score + trajectory +
  ticks; a capped token carries no ticks). `decodeLegacyShareTarget` recognizes ONLY sentence
  versions 1 and 2 (a named list); Word v5 is decoded by its own decoder first.
- **Storage**: the score table, partition `round#<publicId>`, sort key
  `<lang>#<mode>#<date>` (language first so a month is one Query), attributes `guesses`,
  `puzzle`, `createdAt`, `lastWriteAt`, `progress`, `solved`, `version`. Per PLAYER, not per
  day: one hot day partition cannot be split. Nothing reads across players.

### Word round: two writes, owned by a device (#202/#217)

- **Word mode writes TWICE** on the same `/round` record (`mode=word`) — a 60-second run is
  over before a live board could show it. **START**: Turnstile-gated, stamps `startedAt` from
  the SERVER clock plus **`startedBy`** (device id + parsed user-agent snapshot) in ONE Map;
  condition `attribute_not_exists(#sub) OR #p <> :puzzle`, REMOVE the previous unsubmitted log
  — so a start is a RESTART, and only a SUBMITTED run refuses one (answered 200 with the
  recorded run). The client shows loading and starts its clock only when the reply lands.
  **SUBMIT**: one post carrying the whole log, condition
  `#p = :puzzle AND #by.#dev = :device AND attribute_not_exists(#sub)`; first write wins; a
  repeat is 200 with what was recorded; another device's stamp → 409 `started_elsewhere`
  (adopted, closes). **`submittedAt` is the marker, never the log's length** (a 0-claim run
  records an empty log).
- **Wait check**: refuse (409 `too_early`, waited out by the client) until
  `now − startedAt ≥ WORD_START_SECONDS + WORD_MIN_BONUS_SECONDS × claims`
  (`shared/src/scores.ts` `wordRunMs`/`wordRunFloorMs`); it is the game's own floor — the
  ladder authors its cheapest rung from the constant and `wordGame.test.ts` pins no rung pays
  less — so it can never block honest play. Every answer carries the server's `now`; the
  client anchors an ELAPSED span, never an instant.
- **Caps**: `WORD_CLAIM_ZONE` claims + `WORD_MISS_CAP` (500) misses; claims are validated
  against the day's artifact (in the map, inside the zone, at most the board's distinct
  claimable ranks). Timing is deliberately NOT validated; cheating does not matter here.
  SUBMIT is the one round path that reads the word artifact; START reads no store.
- **The screen picks its phase from the server answer + whether THIS device holds the
  deadline**: submitted → final screen; not started → PLAY; started here with a local
  deadline → resume / submit; anything else → PLAY as a **confirmed RESTART** naming the device
  (*Started on iPhone / Chrome. Starting here ends that run.*, button START OVER). The mount
  read anchors no clock for a run this device does not hold. Cross-device RESUME is not a
  thing; the daily is one-shot only once SUBMITTED; concurrent devices are last-commit-wins
  inside the two conditions.
- **A recorded log settles every local run** (transient; never copied into persisted `tried`),
  ending any live prompt with `min(localDeadline, now)`. Word mode KEEPS its persisted
  clock/outbox (losing it loses the whole run). Word's calendar stays LOCAL (#211 gap,
  explicit). Client engine: `web/state/wordRoundSync.ts`, separate from the sentence engine.
- Not done, deliberately: one-active-round-per-player, per-IP start rate limits.

### Server-backed player history (#211, decided 2026-08-23)

- **`POST /history?lang=&mode=[&month=]` → `{ days, solvedDays }`** serves the archive
  calendar and the streak for EVERY identity. `month` optional (the game screen wants only
  the collection); body `collection: false` skips the solved-day read (the archive, since
  2026-08-28). No `date` in its allowList.
- **The calendar has no storage of its own**: one Query over `<lang>#<mode>#<month>-`,
  projected to `progress`/`solved`, PAGED, never revision-scoped. Client keeps an IN-MEMORY
  cache only and revalidates when a month comes on screen. **Loading is a THIRD status
  (unknown), never "not started"**; a failed read says so and offers to ask again.
- **The STREAK stores the per-language SOLVED-DAY COLLECTION** on `player#<publicId>` /
  `history#<lang>` (never a counter — the week row needs the days), credited idempotently by
  the solving append (bounded by `MAX_SOLVED_DAYS`), private read only. **Both ends only ever
  ADD** (set insert + trim by naming the overflow; the client merges, never replaces). A
  rebuildable cache of the round rows: crediting is a logged, non-fatal side effect. A
  republish never removes a credited day; solving the correction cannot add it twice.
- **ON TIME means ON THE DAY; late has no gradations** (user-decided 2026-08-23). A round
  earns the streak credit AND the leaderboard row only when the day played IS the day it was
  played on: ONE server predicate (`rounds.ts` `onTime`), judging a SENTENCE solve by the
  landing append's arrival and a WORD run by its server-stamped START (its submission is
  deferred by design). The client makes no comparison: the confirming answer carries the
  verdict (`credited`); a collection not yet arrived credits and celebrates nothing.
- Unmetered private read; Turnstile does not fit a navigation read. Monitor, act on the
  account; a separate summary row is the lever if read amplification becomes material.

### Email account linking (#204, decided 2026-08-26)

- **Email is the account's backup: a 6-DIGIT CODE, never a magic link.** ONE engine,
  **`POST /link`**: `{token}` reads what the account is saved as (and drains a queued friend
  merge — the resume path; also answers the account's `createdAt`); `{token, email,
  turnstileToken, lang}` sends a code; `{token, email, code, erase?, leave?, bind?}` verifies
  and links. **The server branches only AFTER the code is verified** (the SEND's answer is
  byte-identical for known and unknown addresses — no enumeration). Endings: address unknown →
  BIND (only with `bind` consent — the RETURNING door never binds; without it 404
  `no_account`); the account's own → nothing to do; another account's → ADOPT, this device
  leaves the one it held. An account carries at most ONE address (a second unknown one → 409
  `account_linked`).
- **The account being left is DELETED only when it carries no email of its own**; one that
  does is simply left, nothing transfers. **Leaving is CONFIRMED either way**: 409
  `would_erase` (`{accountId, target, stakes}`) until the caller names the erased account in
  `erase`; 409 `would_switch` (`{accountId, target}`) until it names the left account in
  `leave`. The erase confirmation is skipped when `stakes.days` (solved days) is 0 — **known
  gap, user's call**: a player with rounds but no solve is erased without a dialog.
- **The ACTIVE-DAY TRANSFER**, only when the left account is being deleted: for every
  supported language × mode of the active day, where the adopting account holds no RECORDED
  PLAY (`guesses.length > 0 || submittedAt exists`, ONE predicate on source and destination)
  and the leaving one does, the round row and its score row MOVE, and a moved sentence solve
  credits the collection. Never extended past the active day; two real logs never merge.
- **FRIEND MERGE**: keep the adopting account's friends, drop the two accounts and duplicates,
  fill remaining capacity oldest-`createdAt` first up to `FRIENDS_MAX`, rewrite BOTH
  directions of every kept edge, delete both edges of a dropped one — no edge ever points at a
  deleted account. Too big for one transaction, so it is a durable, idempotent, RESUMABLE job
  drained after the commit; the answer's `mergePending` says whether it is done and the client
  resumes the drain. A drop-then-reappear window on boards is accepted.
- **The core commits identity AND the active day's play in ONE transaction**: consume the
  challenge, move the device item, delete the left account's row + profile row, persist the
  merge job, and every planned round/score move conditioned on a per-row `version` (round) /
  `stamp` (score) unchanged since planning. The solved-day credit follows as a logged side
  effect. Backend `AGENTS.md` holds the versioning model.
- **A deleted account stops being rendered everywhere**: `GET /profile?id=` → 410
  `account_gone` (distinct from 404 "never customized", which is dressed with the assigned
  identity); `/board` DROPS the row; `/i/` preview → 404; `POST /friends {add}` → 404
  `unknown_player`. `web/src/api.ts` `readProfile` is the ONE place the four answers are told
  apart. Anonymous aggregates (`/scores`) keep counting an orphan score until a sweeper exists.
- **Send**: Turnstile checked BEFORE the allowances; metered per ADDRESS
  (`LINK_SENDS_PER_ADDRESS` = 5) and per IP (`LINK_SENDS_PER_IP` = 20) per rolling hour, keyed
  by `SHA-256(normalized address)`. **A failed send is fail-closed and stays charged**: 503
  `mail_unavailable`, the stored challenge stands until replaced, logged without address, code
  or token. The code is stored as a keyed HMAC; TTL `LINK_CODE_TTL_SECONDS` (10 min);
  `LINK_CODE_MAX_ATTEMPTS` (5) WRONG codes — every counted mismatch is 401 `bad_code` with
  `attemptsLeft` (the fifth answers 0); 409 `code_spent` means the challenge accepts no attempt.
  A correct code spends none (a link legitimately verifies twice).
- **`normalizeEmail` is a cross-package contract** (`shared/src/email.ts`): trim, NFKC,
  lowercase WHOLE; nothing cleverer. `currentStreak`/`bestStreak` live in
  `shared/src/history.ts` so the confirmation and the streak screen print one number.
- **The account's THREE NUMBERS are ONE aggregation over the per-language solved-day
  collections, computed independently by both ends** (`backend/src/accountLink.ts`
  `accountStakes`; `web/src/state/history.ts` `useAccountStats`), and they must agree:
  **`streak` = the MAXIMUM of the per-language live streaks · `best` = the MAXIMUM of the
  per-language best streaks · `days` = the SUM of the collections' sizes.** Never a sum of
  streaks (a streak is a run of days in ONE language). `best` takes no active day: a record
  is a fact about days already played.
- **The account area's product rules** — two doors (`/account/email` SAVE, `/account/signin`
  RETURN) onto one engine where the declared intention shapes the JOURNEY and the server the
  DESTINATION; the crossroads confirmation; the five endings; one purpose per screen
  (`/account`, `/profile`, the flow); the code prompt; the copy rule — are recorded in the
  web `AGENTS.md` (#204 bullet). Since 2026-09-05 the RETURN door has no row on `/account`
  (sign out, then sign in); it is reached through RECONNECT. Repo-wide consequences: RECONNECT lands on
  `/account/signin`; SEND CODE is the sixth deploy trigger; **a link signs the account's
  OTHER devices out** when the left account is deleted (they fail the account-existence check).
- **Infra**: SES domain identity with EasyDKIM in the API's hosted zone; `ses:SendEmail`
  scoped to it and to one `ses:FromAddress`. **By hand, never automated**: SES sandbox exit,
  and the SPF + DMARC TXT records (zone mail policy). `pnpm backend:dev` PRINTS the code to
  its log (`consoleMailer`). `backend/src/mailer.ts` is ONE message shape and must not be
  widened.

### Mail plumbing: bounces, complaints, an inbox (#230, decided 2026-09-03)

- **ONE operator address gates all of it** (`-c operatorEmail=`, no default — public repo;
  CI passes `OPERATOR_EMAIL` and FAILS the backend deploy when unset). It is the SNS
  subscription behind the alarms AND the inbox forward target; unset builds NEITHER.
- **Reputation alarms only**: `AWS/SES` `Reputation.BounceRate`/`ComplaintRate` at AWS's own
  review rates (0.05 / 0.001), Maximum over an hour, **missing data IGNORED** (a paused account
  emits nothing and must not read as recovered), OK actions on. Topic not encrypted (CloudWatch
  cannot publish through the managed key), policy names `cloudwatch.amazonaws.com`. Not done: a
  configuration-set event destination (first-bounce granularity) — the next layer if needed.
- **SES inbound receiving in-stack** (`infra/lib/mail.ts`): apex MX (in CDK — it belongs to
  the receiver the stack provisions), four enumerated aliases `hello@`/`abuse@`/`postmaster@`/
  `dmarc@` (never a catch-all), a private `DESTROY` landing bucket expiring `inbound/` after
  **30 days** (stated as "about 30 days" in the privacy notice — move one, move the other),
  a receipt rule set (S3 THEN Lambda, activated by a custom resource), and the forwarder
  `backend/src/mailForward.ts` (its rules: backend `AGENTS.md`). Forwarder `Errors` and
  `AsyncEventsDropped` alarm onto the same topic. Operator steps in `packages/infra/README.md`
  (confirm subscription, `rua=`, sandbox exit; SPF `-all` and apex-TXT foot-guns).

### Live score collection (#169/#187/#203)

- **Identity stance**: public id `[a-z2-7]{16}` (what `shared/src/assigned.ts` derives a
  pseudonym and mark from); no unique usernames, no registration; **assume heavy cheating and
  design so it doesn't matter** — global rankings are decorative, trust is the friends graph.
- **`GET /scores?lang=&date=&mode=&id=`** is READ-ONLY (a POST is 405); `mode` required. The
  histogram is DERIVED from the day's per-player rows at read time: `{ buckets, total,
  bucket }`, one exact band per distinct score, ascending; empty population → `buckets: []`;
  `bucket` is the CALLER's band (`bucket: null` when the population holds no row for them —
  never a number match).
- **The score row is written by the ROUND route** (the solving append / Word submission),
  ONE row per `(date, lang, mode, publicId)` carrying the `revision`, **only when `onTime`**.
  First write wins within a revision; a new revision replaces the row (no new IP allowance).
  Population reads do not filter by revision (accepted). The Word claim ceiling is a FIELD
  check against `WORD_CLAIM_ZONE`; the sentence score has no claimed number left to bound.
- **Volume floor**: the write dedups by `HMAC-SHA256(client IP, server secret)` (never a raw
  IP): at most **5** rows per `(date, lang, mode, ipHash)`, dedup item TTL 48h, counted and
  created in one transaction. A refused row is logged and swallowed — the answer is about the log.

### Player profile (#188)

- `GET /profile?id=` (public row; 404 never customized; 410 `account_gone`) and
  `POST /profile {token, name, avatar, createOnly?}` (own row only; `createOnly: true` is an
  atomic create, 409 `profile_exists`). No Turnstile, no IP dedup.
- **Avatar = TWO colours** (`shared/src/avatar.ts`): palette byte + 100 cells at 1 bit = 14
  bytes, base64url, exactly 19 chars, canonical-form-only decode. `AVATAR_PALETTES` is
  append-only (the byte is an index) and its colours are the user's own palette PNGs at the
  repo root — to change a colour, draw and re-extract, never retune a hex. Rendered as ONE
  traced union-outline path (`shared/src/avatarOutline.ts`).
- **Name charset** (`shared/src/name.ts`): alphanumerics + underscores, case kept, ≤16;
  accents FOLD (`Zoé→Zoe`), everything else → `_`; NFKD first, per code point; `sanitizeName`
  is idempotent and `isValidName` = "the sanitizer leaves it alone". The WEB sanitizes what it
  writes; the BACKEND REFUSES a non-conforming name (400). Empty is valid.
- Moderation best-effort on write: banned-strings name filter (`name_rejected`), exhaustive
  swastika template match (`avatar_rejected`). Symbolic; the friends graph is the containment.
- The copyable-key backup UI was removed (2026-08-19); #204's email link is the backup.

### Friends graph (#189)

- **MUTUAL edges from a one-click invite link; the graph is the leaderboard's trust
  boundary.** Link `<site>/i/<publicId>` — SERVER-rendered preview (mark + name + app name,
  cached 300s; `GET /og/i/<publicId>.png`) that `location.replace`s onto the SPA landing
  `/join/<publicId>`, whose ADD FRIEND tap records the edge (never the load). Paths live in
  `shared/src/invite.ts` (infra routes `/i/*` to the API origin, backend serves, web builds).
  A deleted sender's link expires (404).
- **A RESULT SHARE CARRIES THE INVITE BY DEFAULT (decided 2026-09-05).** The result
  screens' AS drum — under SHARE, opening on the player, NEVER persisted
  (fresh on every result) — signs the link `/s/<token>/<publicId>` (`shared/src/invite.ts`
  `sharePath`).
  The TOKEN is untouched (no codec change; the bot reads a signed share as a plain one and
  strips the id with the link); the card wears the player's mark and name; the page is
  served at the invite's 300s TTL; the click lands on `/join/<publicId>/<token>`, the
  invite landing showing the result, whose ADD FRIEND records the edge and whose PLAY
  opens the shared day; the SIGNER's own device, and a device already FRIENDS with the
  signer (one `/friends` read), skip the landing and open the day, like a plain link. A deleted signer falls back to the PLAIN share (the score was
  never the part that went away). Toggle OFF = the plain `/s/<token>`, byte for byte,
  still content-addressed and year-cached. The control is the label AS and a ONE-ROW-TALL
  two-row DRUM with a flip chevron (the app's one picker physics) holding the player's mark
  + name or ANONYMOUS, opening on the player, directly under SHARE (a taller drum lost the
  link to the button); never a "share my profile" checkbox (scary), an `AS` checkbox beside a face
  (two squares), a "don't share" opt-out, or an INVITE chip (each tried and retired the same
  day). The signed card centres strip + gap + result as ONE block (the result moves down;
  the plain card is untouched).
- **`POST /friends`**: `{token}` reads, `{token, add}` links, `{token, remove}` unlinks;
  every answer `{ friends: [publicId] }`. Storage: one row per DIRECTION,
  `friends#<publicId>` / friend id, `createdAt` from the first link; both rows written (and
  deleted) in ONE transaction, on EVERY accepted link. **`FRIENDS_MAX` = 200**, checked on
  both sides, COUNTED off rows (a bound, not an invariant). Self-add → `self_link`; a gone
  target → `unknown_player`.

### Leaderboard reads (#190/#206)

- **`/board`** per `(day, lang, mode)`: `GET …[&id=]` = the GLOBAL top 50, anonymous
  (`id` widens with the caller's below-the-cut window; unbound to the caller, deliberately);
  `POST {token}` = the FRIENDS board, the trusted surface. Ranking rules are shared pure
  functions (`shared/src/leaderboard.ts`): competition tie ranks, the plain top-50 cut, the
  ±2 own-row window. Rows dressed with profiles (a missing or FAILED profile read dresses
  blank → assigned identity; a GONE account is dropped).
- **Three states on the friends board**: `waiting` (edge with neither a round nor a score;
  never the caller), **`playing`** (#206: a round for the CURRENT revision and no score row —
  exact `countTries` over the FULL artifact read fresh, stored `progress`, ordered by the shared
  `orderPlaying` with NO rank number; friends only, sentence only; a failed read fails the
  POST), finished. A round that ended without a score (capped, late, IP-refused) stays IN
  PROGRESS — accepted; the fourth state is #224. The caller's own playing row never defeats
  the empty-board ghost.
- Entry: the header's crown on every game surface (archive days included since 2026-08-31).

### The WhatsApp bot boundary (#236, decided 2026-09-03)

- **`packages/whatsapp-bot` lives inside the monorepo and OUTSIDE the game runtime.** It may
  import `@whippin/shared`; nothing imports it. A consumer of the PUBLIC share-token contract,
  never a source of game truth: no WhatsApp identity on an account, no share-encoding change
  for it, no LLM deciding a score or a rank.
- **Its stack is a sibling** (`WhippinBotStack`, `infra/lib/bot-stack.ts`): one Fargate task
  (`desiredCount 1`, stop-before-start — one Baileys session is a correctness rule), a
  bot-owned table, an SQS outbound queue, a podium Lambda with one schedule per group, alarms
  on a connected gauge. The model key is an SSM SecureString (`BOT_LLM_API_KEY_PARAMETER`).
  **Group configs are NOT committed** (a JID names a private conversation): SSM
  `/whippin/bot/groups/<slug>` via `pnpm bot:groups`, snapshotted into the gitignored
  `packages/whatsapp-bot/groups/local/`; `deploy-bot` pulls first, nothing reads SSM at run
  time — **editing SSM does not change production; a deploy promotes it.** The image is built
  from the REPO ROOT against the root `.dockerignore`, whose whitelist must name each
  re-included directory outright — **a new workspace package needs a line there too.**
- The podium ranking is the bot's own dense ordering, not `shared/src/leaderboard.ts`'s. It
  reads both share codecs but RECORDS only sentence results. Everything else: its `AGENTS.md`.

---

## Testing

- **WRITE tests when a change touches a CONTRACT**: slug/fold, the puzzle schemas, scoring
  and score accumulation, rank/collision logic, `reduce_embedding` filtering, date/`dayNumber`
  routing, the shared ranking/history/email rules. Assert against the SPEC in this file, not
  the implementation.
- **DON'T add tests for cosmetic/visual work**, trivial wiring or config.
- **A failing invariant test is a real regression — fix the CODE, never weaken the test.**
- **Run `pnpm test` before a contract-touching task is done**: Vitest (`shared`, `web`,
  `backend`, `infra`) + pytest (`generation`, `benchmark`). Slug cases go in the ONE shared
  fixture, never on one side only.

## Working an issue

When asked to work/implement/do/resolve issue #N:

- **Read it first** (`gh issue view N`), then **implement the actual code** — never just
  change its GitHub status.
- **Respect every invariant in this file**; write tests per the policy above and run
  `pnpm test` when a contract is touched.
- **Branch + PR**: branch `issue-N-short-slug`, commit, push, `gh pr create` referencing the
  issue with `Refs #N` (not `Closes`, unless asked). Do **NOT** merge, close or replace the
  PR, and do **NOT** close the issue — the human decides.
- **No agent/tool branding** in branch names or PR titles. **Keep the PR description
  short**: what changed, how to verify, any AGENTS.md edits.

---

## Do NOT (repo-wide)

- **Don't fold/slug a displayed form, and don't display a slug.**
- **Don't let `slug()` and `fold()` diverge.**
- **Don't lemma-merge anywhere except `gen_phrase`'s merge walk (#104)** — consumers only
  LOOK UP alias keys; and **don't silently skip a missing lemma table** — error out
  (`--no-lemmas` to opt out explicitly).
- **Don't add a query parameter, a header the backend reads, or a route path without naming
  it in `infra/lib/backend-stack.ts` (and `shared/` when three packages read it).**
- **Don't add a second spelling of a shared reading** (scoring, ranking, streak, email,
  name, slug) in a consumer package — import it from `shared`.
- **Don't change what the server stores** (a field, a third party, a retention) without
  changing the privacy notice (`web/src/screens/privacyDoc.ts`).

Each package `AGENTS.md` carries its own Do-NOT list.

---

## Commands

**pnpm** (workspaces in `pnpm-workspace.yaml`, version pinned via `packageManager`). Root
scripts delegate via `pnpm --filter`. **Do NOT add a `--` separator** — pnpm forwards args
straight through, and a literal `--` breaks `gen_phrase.py`'s parsing.

```bash
pnpm install     # installs all workspaces
pnpm test        # invariant tests: Vitest (web + shared + backend + infra) + pytest (generation + benchmark)
pnpm typecheck   # tsc --noEmit
```

Domain commands — wordlist/reduce/gen (generation), bench (benchmark),
publish/inventory/backend:dev (backend), dev/build (web), cdk synth/diff/deploy (infra),
bot:start/pair/cli/groups (whatsapp-bot) — are documented in the owning package's `AGENTS.md`.

---

## Current state / mutable

- **Package manager:** `pnpm@11.9.0`; `pnpm-workspace.yaml` uses `allowBuilds` to approve
  `esbuild`'s postinstall.
- **The PRIVACY NOTICE describes what this repo STORES (#229):** `/privacy`
  (`web/src/screens/privacyDoc.ts`), both languages, every category the backend keeps and why
  (account email, hashed device token + parsed user-agent, guess logs, scores, friends,
  profile, HMAC-of-IP rows, inbound mail for about 30 days, and the provider hosting the
  operator inbox — `PRIVACY_MAILBOX_PROVIDER`, read off `OPERATOR_EMAIL`'s host). Reachable
  from `/account` only. It is what the SES production-access review is pointed at.
- **CI/CD (#33)** — `.github/workflows/` (docs in its `README.md`). `ci.yml` on PRs into and
  pushes to `main`/`dev`: pnpm / Node 22 / uv + Python 3.12, `pnpm -r --if-present run
  typecheck` + `pnpm test` (intended as a required status check). `deploy.yml` on push to
  `main` and `workflow_dispatch` (`stacks`: `changed`|`web`|`backend`|`bot`|`all`): GitHub
  OIDC (`AWS_DEPLOY_ROLE_ARN`), deploys only the changed stack(s) via `dorny/paths-filter`
  (`shared`/`infra`/root deps fan out to all; `generation` deploys nothing). Web build reads
  `VITE_API_BASE_URL` from the committed `.env.production`, requires the public
  `VITE_TURNSTILE_SITE_KEY` variable (`vite.config.ts` rejects a production build without it),
  optional `VITE_PLAUSIBLE_DOMAIN`. The backend deploy needs `OPERATOR_EMAIL` and
  **invalidates `/*` on the API distribution** after `cdk deploy` (puzzle responses carry a
  year-long `s-maxage`; needs `cloudfront:CreateInvalidation` on the human-deployed
  `deploy-role-stack.ts` — `pnpm --filter @whippin/infra deploy:auth`). `deploy-bot` runs
  `pnpm bot:groups pull` first.
  - **`deploy.yml` is hardcoded and does NOT auto-cover changes.** When you add/rename a
    package or add/change a CDK stack, update its paths-filter mapping (libs consumed by a
    stack must fan out to it), the per-stack jobs and the `workflow_dispatch` options. A stack
    with no entry silently never deploys.

---

## ⚠ Discrepancies to confirm

None open. (Every discrepancy recorded before 2026-09-05 was resolved by a user decision and
folded into the sections above.)
