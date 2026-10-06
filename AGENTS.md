# AGENTS.md — Whippin AI (daily sentence-reconstruction game)

> This ROOT file holds everything repo-wide: architecture, engineering principles, the
> cross-package contracts, testing policy, workflow. Each package keeps its own
> `packages/<pkg>/AGENTS.md` with the guidance specific to it and ASSUMES this one: read this
> file first, then the file of the package you touch. Every `CLAUDE.md` (root and
> per-package) is a symlink to its sibling `AGENTS.md` — edit the **AGENTS.md**.
>
> The **code is the strongest source of truth.** Where a file here disagrees with the code,
> fix the file to say how the code works now, and name the edit in your reply.
>
> This file records how the system works: the rule, its exact constants and where they live,
> and one line of why when the why is what stops an agent undoing it. Implementation detail
> and product/UX narrative live in the package files.

React + Vite + TypeScript front end; Python generation scripts run via `uv` (wired through
`pnpm`). Two languages, made the same way (#317): **en** (fastText `cc.en.300`) and **fr**
(fastText `cc.fr.300`). A **pnpm-workspaces monorepo** (`pnpm-workspace.yaml`; pnpm pinned via the
root `packageManager` field):

```
packages/
  generation/   Python puzzle generation (uv): embeddings -> reduced vectors -> puzzles;
                also writes the vocab existence set into web/public.
  benchmark/    offline LLM puzzle benchmark harness (#68) — LAB-ONLY: never writes into a puzzle.
  curation/     headless sentence curation (#260/#262): a shelf of epubs and song files -> ONE
                candidate puzzle via gen_phrase, Claude on the subscription choosing, code
                enforcing. Never publishes.
  backend/      daily-puzzle backend (#2): ONE handler for Lambda + local serve; puzzle store
                (S3/FS) + publish; every live route (/scores /profile /groups /board /round
                /history /devices /link) and the share/group preview pages.
  infra/        AWS CDK app: backend (#3) + web hosting (#21) + WhatsApp bot (#236) sibling stacks.
  shared/       cross-cutting TS: slug/fold contract, game-day logic, schema types, scoring,
                identity, codecs. Every module is the ONE source of truth for its concern.
  web/          React + Vite + TS front end (the game).
  whatsapp-bot/ the WhatsApp group scoreboard bot (#236). Consumes shared; nothing depends on it.
```

Data flow: generation writes **puzzles** into `packages/generation/output/` (then
`pnpm puzzle:publish` places them in the store the backend reads), and the **vocab**
existence set into `packages/web/public/vocab/<lang>.json` plus its metadata into
`packages/shared/src/vocab.generated.json`. **`packages/generation/published.jsonl` is the
PUBLISH LEDGER (user-decided 2026-09-08): one JSON line per SENTENCE puzzle published to
S3 — `day` (the game day served), `lang`, `publishedAt`, `revision`, `source`, `sentence`
(`words[]` joined) and `holes` as `{secret, word, start, startRank}` — appended by
`pnpm puzzle:publish --s3` and by nothing else (a local publish is a test bed, a bonus is
no day),
GITIGNORED — the BUCKET is the truth and the file its local,
readable copy, rebuilt on any machine by `pnpm puzzle:ledger --s3` — and the ONE record
the curator's archive (secret cooldown, secret/start pair blacklist, works, sentences,
artist cooldown) reads; it reads nothing else, and refuses to run without the file.
Written by `backend/src/ledger.ts`, read by `curation/scripts/shelf.py`; a corrected day
keeps its last line.** Each package's file
map lives in ITS `AGENTS.md`.

## Maintaining these files

- **You are a SCRIBE of the user's decisions, not an author of them.** Update these files
  when the user has **explicitly** decided something that changes an invariant, command,
  schema or architecture rule, or when a file disagrees with the code as it stands (the
  header's rule). Never record a rule you inferred or think is a good idea; never document a
  transient state as permanent.
- **Two zones, two bars.** *Stable invariants / cross-package contracts / Do-NOT lists*: edit
  only on an explicit, confirmed user decision or to match the code as it stands — never to
  match a change you are making — and call the edit out prominently in your reply. *Current state / mutable*: may be updated to reflect what now exists.
- **Put a rule at the right SCOPE.** Repo-wide rules, workflow and anything two or more
  packages must agree on live HERE; single-package guidance lives in that package's file.
  State a rule once, at the widest scope it applies to; reference it from narrower files.
- **Record how it works now, not its history.** A rule, its constants, its location, and one
  line of why when the why matters. Never what was decided before, reverted, or when; no
  measurements, review chronology, or rejected alternatives — except a rejected alternative
  an agent would plausibly re-propose, in one line.
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
  "source": {                                   // OPTIONAL, every field optional
    "kind": "book", "author": "Victor Hugo", "work": "Les Misérables",
    "excerpt": { "before": ["…", "…"], "after": ["…"] },   // #270: the RAW text around the line
    "url": "https://…"                          // #270: a music day's track page
  },
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
  forms; `kind` is an open union. Consumed by the solved screen.
- **`source.excerpt` is the RAW text around the sentence (#270, user-decided 2026-09-07;
  it reverses the earlier "no `context` field" rule):** `{before: string[], after:
  string[]}`, at most `EXCERPT_WINDOW` (8, `curation/sentences.py`) sentences each side —
  the curator's model choosing where the page starts and ends (decided 2026-09-08) —
  display forms, never generated prose, never the sentence itself (that is `words[]`); both
  arrays present whenever the key is. The curator emits it for a BOOK; a song carries NONE
  (lyrics are a licensed product; reaffirmed 2026-09-08); a hand-authored puzzle may carry
  none. Hashed into `revision` like any content; the derivation slice and the share card
  carry no excerpt. **`source.url`** is a music day's track page, display-only (an ordinary
  link on the solved page, never an embed). Written only by `gen_phrase`
  (`--before`/`--after`/`--url`); the web refuses a malformed excerpt or a non-web url.
- **No `benchmark` field, no `road` field, no `par` field** (removed 2026-08-12). Consumers
  ignore a stray key on an already-published puzzle. `packages/benchmark` never writes into a
  puzzle file.
- **`ranks`**: secret slug → input slug → `{word, rank, dq}`. `word` is the group's canonical
  accented display form (what the front displays, not necessarily what was typed). **Rank
  semantics:** secret = `0`; nearest group = `1`; larger = farther. Alias keys share their
  group's rank.
- **The RANKING PROVIDER may differ by artifact (#308, user-decided 2026-09-19):** a
  single-word artifact ranks by the static embedding; a SENTENCE puzzle (BY DEFAULT: French
  since 2026-09-20, English since #317, 2026-09-25 — each language asked in its own words;
  `--static` opts out) keeps the static walk as retrieval and ORDERS its `TOP_K` groups by
  the sense the sentence gives the secret, judged by TypeSafe's hosted Jev model (one
  Score per candidate, then a pairwise round-robin over the front; `dq` from the judge's
  geometry; no blend). Same groups, same keys rule, same schema — the web and the
  backend cannot tell a contextual map from a static one, and a puzzle carries no model
  name or score; the judge's scores live in a gitignored sidecar beside the puzzle that
  replays byte-for-byte. The two artifacts therefore no longer promise the same lexical
  group the same neighborhood. Rules and constants: generation `AGENTS.md`.
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

### Single-word artifact schema (#154)

One word and its ranked neighborhood — what the onboarding tutorial's board is cut from.
Produced by `packages/generation/scripts/gen_word.py` (`pnpm gen:word`), typed `WordPuzzle`
in `shared/src/types.ts`, pruned into `web/src/tutorial/scripts/<lang>.word.json` by
`web/scripts/prune-word-map.mjs`. Never published or served (`puzzle:publish` refuses it).

```jsonc
{
  "lang": "fr",
  "word": { "word": "phare", "slug": "phare" },
  "ranks": {                                       // ONE FLAT map
    "<input-slug>": { "word": "<accented>", "rank": 12, "dq": 231 }, ...
  }
}
```

- **Inner rank-map semantics are the sentence schema's, unchanged**, produced by the ONE
  shared per-secret pipeline (`gen_phrase.walk_secret`): merge walk, #133 confirmation,
  donors, `TOP_K`, `dq`, collisions. Rank 0 carries no `dq`. Always the STATIC order:
  a word has no sentence, so #308's contextual rerank never applies here.
- **One flat `ranks`**; no `words`/`holes`/`start`/`start_rank`/`source`.

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
  `GET <VITE_API_BASE_URL>/?lang=<lang>&date=<YYYY-MM-DD>`. Store key `<date>.<lang>.json`.
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
| `/` (puzzle) | `lang`, `date`, `bonus` | **CACHE POLICY** allowList: the cache key, and — with no origin-request policy — exactly what reaches the Lambda |
| `/scores` | `lang`, `date`, `id` | origin-request allowList, **caching DISABLED** |
| `/board` | `lang`, `date`, `id` | same |
| `/round` | `lang`, `date`, `bonus` | same |
| `/history` | `lang`, `month` | same |
| `/profile` | `id` | same |
| `/groups` | `id` | same |
| `/devices`, `/link` | none (empty allowList) | same |

- **The PUZZLE route is CACHED** (`max-age=300, s-maxage=31536000`): an unlisted parameter
  both collapses two responses onto one year-long edge entry and never reaches the origin.
- **The eight LIVE routes have caching disabled**, each with its own origin-request policy
  (its query allowList plus the Lambda-URL-safe `allExcept: Host` headers) and `no-store`
  answers; an unlisted parameter never reaches the origin. The day a handler reads a new
  parameter, name it in that policy too.
- **A live route's CORS PREFLIGHT is answered at the EDGE** (user-decided 2026-10-05): every
  live behavior carries a viewer-request CloudFront Function that answers `OPTIONS` itself —
  a 204 with `shared/src/cors.ts`'s `preflightHeaders` for the configured origin — so the
  permission check in front of a live POST never reaches the Lambda (WebKit asks again every
  ten minutes, whatever the max-age). On the four behaviors that stamp `VIEWER_IP_HEADER`
  (`/scores`, `/round`, `/devices`, `/link`; below) it is that same function, answering
  first. The handler answers the
  same shared headers wherever a preflight does reach it (`backend:dev`, the puzzle route).
  A new live behavior wears one of the two functions.
- **The share page (`/s/*`), the cards (`/og/*`) and the group invite preview (`/g/*`) are
  NOT live routes**: they are CACHED behaviors on the WEB distribution (`infra/lib/web-stack.ts`)
  handed to the API origin — a year for content-addressed share tokens, 300s for the group
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
  (the append whose pre-read finds nothing), the link code SEND. A
  group write is authenticated, bounded by `GROUPS_MAX`, and not gated. Tokens
  are prefetched into a two-slot single-use queue so a brand-new player's first PLAY (bootstrap
  + round creation = two challenges, deliberately) costs no visible wait. Local: accept-all
  verifier.
- **Clients act on the error CODE, never on the status alone.** What a given code means —
  a verdict that closes a conversation (`round_solved`, `round_given_up`), a wait
  (`too_fast`), an input to correct (`bad_code`), a confirmation to advance to
  (`would_erase`, `would_switch`) — is each route's own contract, recorded in its section below. What is universal: a 5xx, a transport
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
  effect** (user-decided 2026-08-24). Five triggers, each a single primary-button tap that
  chains its real action behind the bootstrap and reports failure on the full-screen
  `ErrorScreen` (no retry button; the player returns to the button): the rules gate's **PLAY** ·
  **joining a group** · **creating a group** (its INVITE then shares) ·
  profile **SAVE** · the link flow's **SEND CODE**. Consequences: the game shows the full rules gate
  whenever the device has no account (archive days included); the engine never mints — an
  append resolves the identity it holds or stands down; a tokenless leaderboard /
  profile editor renders a LOCAL PLACEHOLDER identity from a persisted seed
  (`gameStore.localSeed`, publicId-shaped); **the username is decided locally, then deployed**:
  on acquiring an account the client stores the placeholder name + mark as the profile, only
  into an account with NO stored row (`createOnly: true`; a lost race is 409 `profile_exists`,
  settled) — whichever button deployed it, profile SAVE included, whose own write into an
  account with no row stores the fields the player was shown (the placeholder's where
  untouched), so no deploy swaps the face. Group invites are gated on neither side.
- **NO TOKEN MEANS NO PRIVATE FETCH**: a tokenless device knows its server state is empty and
  publishes ready-and-empty round/history state without calling `/round` or `/history`.
- **First bootstrap is ONE origin-wide critical section** (Web Lock over re-read → mint/persist
  pending token → bootstrap → commit); a pending token in storage is retried, not replaced. No
  Web Locks → fail before minting.
- **Local state follows the identity that owns it** (`web/state/identityScope.ts`): the first
  acquisition clears nothing; an `accountId` change clears the outbox, transient round
  loads and private summaries; a `deviceId`-only change clears nothing (no local state is
  owned by a device alone); binding an email changes neither. Persisted state is tagged
  with its owner; every in-flight private request captures the `(accountId, deviceId)` epoch
  and is aborted/ignored if it changes. Persisted game state lives behind ONE transactional
  IndexedDB record
  (`web/state/gamePersistence.ts`); localStorage holds only the device token / tombstone.

### Sentence round: server-owned log, outbox, derived score (#201/#203/#214)

- **The server owns game state from the first guess**, linked or not. **`POST /round?lang=&date=`**:
  `{token, puzzle}` reads (404 = none for THIS revision), `{token, puzzle, guesses}` appends,
  `{token, puzzle, giveUp: true}` GIVES UP (below; 400 beside `guesses` or a
  `turnstileToken`). Every answer — refusals included — carries the full stored state of the
  PUZZLE ASKED ABOUT (`{guesses, createdAt, progress, solved, gaveUp, …}`), never a different
  revision's log. Archive
  days sync exactly like today's. The record NAMES its `puzzle` revision; an append carrying a
  different one REPLACES the log (a republish restarts the round; a solved-day credit already
  earned is kept).
- **The server stores folded strings, in order, never indices.** Validation asks the
  contract: a guess is one `fold()` leaves alone, at most `maxSlugLength`. The server READS
  the log (#203) but never interprets it on the way in.
- **Bounds are cross-package constants** (`shared/src/scores.ts`): **`ROUND_GUESS_CAP` = 500**
  raw entries per round, enforced inside the append's own condition (as ROOM — DynamoDB
  conditions have no arithmetic); **`ROUND_WRITE_MIN_MS` = 1000 ms** between writes per player
  **per round**, one spelling for the server's condition and the web's pacing, which paces
  from the previous ANSWER, not the send. Refusals: 429 `too_fast` (+`Retry-After: 1`, exposed
  by CORS), 409 `round_full`, 409 `round_solved`, 409 `round_given_up`. Nothing is partially
  appended.
- **Local storage is an OUTBOX (#214).** Three values kept apart: **SERVER STATE** (raw log +
  `solved` + `gaveUp`, in memory only), **OUTBOX** (unacknowledged folded guesses, revision-qualified —
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
  `round_solved` and 409 `round_given_up` adopt the frozen result SERVER-ONLY (deduped by
  identity), discard the outbox, close (a mount read showing either does the same). **An
  UNKNOWN outcome (transport, 5xx, malformed) READS before writing again** — appends are
  at-least-once. Any other 4xx closes. The GIVE-UP goes out only once the outbox is FLUSHED
  (the log it freezes holds every try); its unknown outcome re-reads too, and only the read
  answers it — a give-up is never re-sent behind the player's back.
- **Derived scores (#203): the client never claims a score.** `progress` and write-only-true
  `solved` are stored on the round row in the append's own mutation, derived from stored log +
  batch; after the write the handler re-derives from the RETURNED log and, on disagreement,
  issues one retried, progress-monotonic corrective write (the last chance to record a solve).
  **A solved round refuses further appends** (`attribute_not_exists(#solved)`) so a recorded
  score never changes; **so does a given-up one** (`attribute_not_exists(#gave)` in the same
  condition — the player has been shown the sentence); the refused device adopts AND closes.
  Classification order: solved → given up → cap → interval. The readings are shared
  (`shared/src/scoring.ts`: `s`/`holeProgress`, `rankCount`, `guessKey`, `countTries`) so the
  screen and the leaderboard cannot disagree over one log.
- **What the server LOADS:** every append reads the day's **derivation slice** (every key at
  or below each hole's `start_rank`, + `n`/`start_rank`; ~300× smaller than the puzzle),
  produced by `pnpm puzzle:publish` beside the sentence puzzle (SENTENCE ONLY), written FIRST,
  carrying the same `revision`; a solve reads the FULL artifact for `countTries`. **The slice
  is read FRESH; the full artifact is held in the Lambda's memory KEYED BY ITS REVISION**
  (`backend/src/puzzleReads.ts`, at most two entries by store key, least recently used out):
  every read first learns the current revision fresh — the append's own slice, or a fresh
  slice read on the boards — and reuses the parsed artifact only when it carries that
  revision, else reads it fresh and checks it names the same one. Why: the live ranking reads
  the full artifact at guess cadence and the API runs on 10 concurrent Lambdas; a published
  version's content never changes, so an entry keyed by it never goes stale and a
  correction simply misses. The slice fetch runs concurrently with the round read. **A
  missing slice or a revision mismatch is the day-addressed 404** — no degraded mode.
- **Authoritative SOLVED comes only from the server flag.** The board may complete locally
  while the solving append is in flight; the result, leaderboard, streak and `solve` event wait
  for confirmation. A solve confirmed by THIS device's batch is fresh (celebrated); one learned
  from a mount read or a `round_solved` refusal is adopted history (shown, never celebrated).
- **A ROUND THAT ENDS UNSOLVED PRINTS `∞`** — given up, or capped; ONE reading,
  `roundEnded` (`shared/src/scores.ts`: `!solved && (gaveUp || raw log ≥ ROUND_GUESS_CAP)`,
  read by the web round, the group board and the #211 month read — the last through its
  facts form `endedUnsolved`, `capped` from a one-entry probe; one rule; the archive keeps an
  over day's date and never draws the `∞` — its look is the web `AGENTS.md`'s). **`solved`
  wins** over both. No leaderboard
  row, streak, celebration or `solve` event; answer + source shown; shareable, and that share
  is NOT counted in the `share` event (share ÷ solve stays the liked-day signal).
  - **THE CAP**: exactly `ROUND_GUESS_CAP` raw entries, derived, never stored. `round_full`
    at the cap is logged server-side as puzzle-curation signal; a client already at the cap
    spends no request.
  - **THE GIVE-UP** (user-decided 2026-10-02: "a way to give up and reveal the sentence"):
    STORED, `gaveUp` on the round row, write-only-true, set by ONE conditional UpdateItem
    (`#p = :puzzle AND attribute_not_exists(#solved)`, version bump; no slice, no Turnstile,
    no pacing) — 200 with the state, idempotent; 409 `round_solved` when a solve won; 404
    with no record of this puzzle. Only a republish's restart removes it. Offered only once
    the round holds a guess (the record exists).
  - The `∞` glyph is pixel-art SVG path data in `shared/glyphs.ts` (Press Start 2P has none;
    the OG card loads no system fonts), used by `cardSvg.ts` and the web.
- **Share token v6** is the result format (capped flag + numeric score + trajectory +
  ticks; a capped token carries no ticks — the flag means ENDED UNSOLVED, given up or capped,
  so the card and the bot never tell the two apart); **v7** is a BONUS puzzle's (below): the bonus id
  in the day's place, the same payload. `decodeLegacyShareTarget` recognizes ONLY
  versions 1 and 2 (a named list); every other version — the retired Word mode's 3–5
  included — is a flat 404.
- **Storage**: the score table, partition `round#<publicId>`, sort key
  `<lang>#sentence#<date>` (language first so a month is one Query; `sentence` is a fixed
  segment, the retired daily `mode`'s, kept so stored rows stay addressable — the score
  rows' `score#<date>#<lang>#sentence` likewise), attributes `guesses`,
  `puzzle`, `createdAt`, `lastWriteAt`, `progress`, `solved`, `gaveUp`, `version`. Per
  PLAYER, not per day: one hot day partition cannot be split. Nothing reads across players.

### Bonus puzzles (user-decided 2026-09-24)

- **A BONUS is a test puzzle outside the calendar, shared by link only** — for friends and
  beta testers: played like an archive day (the rules gate's PLAY deploys the account),
  shareable with its own card, and credited NOTHING (no score row, no streak day, no board,
  no podium). `shared/src/bonus.ts` is the one spelling: the id is **seven digits, no
  leading zero** (`BONUS_ID_PATTERN`); a puzzle's ADDRESS is its day's date or
  **`bonus/<id>`**, which takes the date's slot in the store key (`bonus/<id>.<lang>.json`
  + its slice), in the round row's sort key, and in `PuzzleRef` (`{dayNumber} | {bonusId}`).
- **Wire**: `?bonus=<id>` stands in for `date` on `/` and `/round` (both CloudFront lists
  name it); a malformed id is 400; no future guard (a bonus is out when published). The
  page is `/<lang>/bonus/<id>`.
- **Nothing reads a bonus address as a date**: `onTime` asks `isBonusAddress` first, so a
  bonus is never on time — the one check both rewards pass through. The history month
  query and the ledger's key pattern never meet one.
- **Publish**: `pnpm puzzle:publish <file> --bonus [--s3]` mints a fresh id (never one the
  store holds) and prints the link; `--bonus <id>` republishes it (a correction keeps the
  link). Exclusive with `--day`; never a ledger line.
- **Share token v7** (`BONUS_SHARE_VERSION`) carries the bonus id (24 bits) in place of
  the day; the card, the share page and the headline say `BONUS <id>`, and the click opens
  the bonus. The WhatsApp bot never counts a v7 share.
- **The web**: its own round key (`b:<id>:<lang>`, kept by the outbox cap), never the
  active day, and no `solve`/`share` analytics (the share rate is a day's).

### Server-backed player history (#211, decided 2026-08-23)

- **`POST /history?lang=[&month=]` → `{ days, solvedDays }`** serves the archive
  calendar and the streak for EVERY identity. `month` optional (the game screen wants only
  the collection); body `collection: false` skips the solved-day read (the archive, since
  2026-08-28). No `date` in its allowList.
- **The calendar has no storage of its own**: one Query over `<lang>#sentence#<month>-`,
  projected to `progress`/`solved`/`gaveUp` and ONE probe of the log at its last slot under
  the cap (`guesses[ROUND_GUESS_CAP − 1]`, present only at the cap — the log never leaves the
  store), PAGED, never revision-scoped; each day answers `{date, progress, solved, over}`,
  `over` the shared `endedUnsolved` made on the server (the web never holds the log). Client
  keeps an IN-MEMORY cache only and revalidates when a month comes on screen. **Loading is a
  THIRD status (unknown), never "not started"**; a failed read says so and offers to ask again.
- **The STREAK stores the per-language SOLVED-DAY COLLECTION** on `player#<publicId>` /
  `history#<lang>` (never a counter — the week row needs the days), credited idempotently by
  the solving append (bounded by `MAX_SOLVED_DAYS`), private read only. **Both ends only ever
  ADD** (set insert + trim by naming the overflow; the client merges, never replaces). A
  rebuildable cache of the round rows: crediting is a logged, non-fatal side effect. A
  republish never removes a credited day; solving the correction cannot add it twice.
- **ON TIME means ON THE DAY; late has no gradations** (user-decided 2026-08-23). A round
  earns the streak credit AND the leaderboard row only when the day played IS the day it was
  played on: ONE server predicate (`rounds.ts` `onTime`), judging a solve by the landing
  append's arrival. A round on the server's TOMORROW (a fast clock, inside the +1-day skew
  window) is an ordinary round, and its solve is not on time either. The client makes no
  comparison: the confirming answer carries the verdict (`credited`); a collection not yet
  arrived credits and celebrates nothing.
- Unmetered private read; Turnstile does not fit a navigation read. Monitor, act on the
  account; a separate summary row is the lever if read amplification becomes material.

### Email account linking (#204, decided 2026-08-26)

- **Email is the account's backup: a 6-DIGIT CODE, never a magic link.** ONE engine,
  **`POST /link`**: `{token}` reads what the account is saved as (and drains a queued group
  departure — the resume path; also answers the account's `createdAt`); `{token, email,
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
  supported language of the active day, where the adopting account holds no RECORDED
  PLAY (`guesses.length > 0`, ONE predicate on source and destination)
  and the leaving one does, the round row and its score row MOVE, and a moved sentence solve
  credits the collection. Never extended past the active day; two real logs never merge.
- **GROUP DEPARTURE (#271, replacing the friend merge)**: a deleted account LEAVES EVERY
  GROUP it was in — its memberships are dropped, never carried onto the adopting account.
  A membership can land between a read and the commit, so the drop is a durable, idempotent,
  RESUMABLE job (`depart#<to>` / `from#<from>`) drained after the commit by `GroupStore.leaveAll`,
  which re-reads until the partition is empty; the answer's `departurePending` says whether it
  is done and the client resumes the drain. Until it drains, a board dresses the ghost as
  gone (dropped); accepted.
- **The core commits identity AND the active day's play in ONE transaction**: consume the
  challenge, move the device item, delete the left account's row + profile row, persist the
  departure job, and every planned round/score move conditioned on a per-row `version` (round) /
  `stamp` (score) unchanged since planning. The solved-day credit follows as a logged side
  effect. Backend `AGENTS.md` holds the versioning model.
- **A deleted account stops being rendered everywhere**: `GET /profile?id=` → 410
  `account_gone` (distinct from 404 "never customized", which is dressed with the assigned
  identity); `/board` and the `/g/` preview DROP the row; a join by the deleted account is
  refused inside the store's own transaction. `web/src/api.ts` `readProfile` is the ONE place the four answers are told
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
  `/account/signin`; SEND CODE is a deploy trigger; **a link signs the account's
  OTHER devices out** when the left account is deleted (they fail the account-existence check).
  The erase crossroads names what does NOT survive: *Your groups and the rest are lost.*
- **Infra**: SES domain identity with EasyDKIM in the API's hosted zone; `ses:SendEmail` on
  every identity of the account (`identity/*` — a verified RECIPIENT is an identity the send is
  authorized against too, 2026-09-12) and one `ses:FromAddress`. **By hand, never automated**: SES sandbox exit,
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
  design so it doesn't matter** — global rankings are decorative, trust is the group.
- **`GET /scores?lang=&date=&id=`** is READ-ONLY (a POST is 405). The
  histogram is DERIVED from the day's per-player rows at read time: `{ buckets, total,
  bucket }`, one exact band per distinct score, ascending; empty population → `buckets: []`;
  `bucket` is the CALLER's band (`bucket: null` when the population holds no row for them —
  never a number match). No client reads it any more (the user's call to retire it).
- **The score row is written by the ROUND route** (the solving append),
  ONE row per `(date, lang, publicId)` carrying the `revision`, **only when `onTime`**.
  First write wins within a revision; a new revision replaces the row (no new IP allowance).
  Population reads do not filter by revision (accepted).
- **Volume floor**: the write dedups by `HMAC-SHA256(client IP, server secret)` (never a raw
  IP): at most **5** rows per `(date, lang, ipHash)`, dedup item TTL 48h, counted and
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
  swastika template match (`avatar_rejected`). Symbolic; the group is the containment. A
  GROUP NAME takes the same filter and the same charset (`shared/src/name.ts`) at its own
  cap of 20 (`GROUP_NAME_MAX_LENGTH`, user-decided 2026-09-14), never empty.
- The copyable-key backup UI was removed (2026-08-19); #204's email link is the backup.
- **A RESULT SHARE WEARS ITS PLAYER'S FACE, AND CARRIES NO INVITE (decided 2026-09-05;
  made unconditional and invite-free 2026-09-10).** The result screen signs every share
  with the device's account, `/s/<token>/<publicId>` (`shared/src/invite.ts` `sharePath`):
  the card wears the player's mark and name, the page title names them, the page is served
  at the invite's 300s TTL, and the click opens the shared day exactly as a plain link does
  — no landing, no ADD FRIEND. There is no control and no anonymous option (the AS drum
  under SHARE was retired 2026-09-10). The TOKEN is untouched (no codec change; the bot
  reads a signed share as a plain one and strips the id with the link). No account → the
  plain `/s/<token>`, content-addressed and year-cached. A deleted signer falls back to the
  PLAIN share (the score was never the part that went away). The signed card signs QUIETLY
  — the count stays the card's subject: the player's mark, small, and their name beside it,
  on the top row before the day; the result it draws is the plain card's
  (`shared/src/cardSvg.ts`).

### Groups (#271, user-decided 2026-09-07; they REPLACED the #189 friends graph — no back-compat)

- **A GROUP is a named set of members with an invite link; the group is the trust
  boundary and the leaderboard's social unit** (a pair of friends is a group of two).
  `POST /groups`: `{token}` lists mine, `{token, create: true, name}` creates (creator is a
  member; answers `created`), `{token, join}` joins by group id, `{token, leave[,
  successor]}` leaves (the SUCCESSION below), `{token, remove, member}` removes (the OWNER
  only, 403 `not_creator`; never oneself). Every answer carries `{ groups: [{id, name,
  createdBy, joinedAt, members[]}] }` as they now stand — `createdBy` read off the GROUP
  row (it changes hands), a membership whose group row is gone dropped.
  `GET /groups?id=` is a group's PUBLIC face `{id, name, createdBy, members: [{publicId,
  name, avatar}]}` (a gone account dropped; 404 `unknown_group`) — the landing's read and
  what the preview renders. Caps in `shared/src/scores.ts`: **`GROUPS_MAX` = 10** per player
  (409 `group_limit`), **`GROUP_MEMBERS_MAX` = 50** per group (409 `group_full`), COUNTED off
  rows (a bound, not an invariant). Name = the player name's charset (`shared/src/name.ts`,
  ONE pipeline) at the GROUP's cap — **`GROUP_NAME_MAX_LENGTH` = 20** (user-decided
  2026-09-14; `sanitizeGroupName` / `isValidGroupName`, the web sanitizing what is typed,
  the backend refusing what is not already sanitized) + the banned-strings filter, never
  empty. Ids are `GROUP_ID_PATTERN` (the public id's shape).
- **Invite** `<site>/g/<groupId>` — a SERVER-rendered preview (name + member marks + app
  name, `GET /og/g/<groupId>.png`, cached 300s) that `location.replace`s onto the SPA
  landing `/join/g/<groupId>`, whose JOIN tap records the membership (never the load); a
  member already skips the landing onto the group's board. Paths live in
  `shared/src/invite.ts` (infra routes `/g/*` to the API origin, backend serves, web builds
  + parses). A link naming no group expires (404). **A result share carries NO group** — the
  2026-09-10 "share carries no invite" decision stands over the issue's earlier drum.
- **Storage**: `group#<id>` / `group` (name, createdBy, createdAt) + ONE membership as TWO
  rows in one transaction — `group#<id>` / `member#<publicId>` and `player#<publicId>` /
  `group#<id>` (the latter denormalizing the immutable NAME only, so the list is one Query;
  the owner is the group row's fact). A create asserts the creator's account, a join
  asserts the account AND the group row; a leave deletes both rows unconditionally AND, in
  the SAME transaction, does what the succession rule says to the group row. Nothing reads
  across players outside a group's member list.
- **THE SUCCESSION RULE (user-decided 2026-09-14; `successionFor`, `backend/src/
  groupStore.ts`, ONE spelling for the route and the departure):** a member whose leaving
  EMPTIES the group DELETES it (its link then 404s; no lingering empty groups); an OWNER
  leaving a group of TWO hands it to the other member; an OWNER leaving a group of THREE OR
  MORE must NAME a member as `successor` (409 `successor_required` until they do; a
  non-member named is the same refusal); a member who is not the owner hands nothing over.
  A leave must commit only while the membership and ownership it was decided from still
  stand; a concurrent join must not be erased, and a departed member must not become owner.
  The web asks the successor on the leave's full-screen confirmation.
- **A deleted account leaves every group**: the link flow's departure job (above), under
  the same rule with nobody choosing — its owned groups go to the OLDEST other membership.
  A stale leave re-reads and applies the succession rule again, never falling back to bare
  row deletes; a membership whose group row is gone is deleted by the next list.

### Leaderboard reads (#190/#206/#271)

- **`/board`** per `(day, lang)`: `GET …[&id=]` = the GLOBAL top 50, anonymous
  (`id` widens with the caller's below-the-cut window; unbound to the caller, deliberately);
  `POST {token, group}` = the group's DAY board, the trusted surface (403 `not_member` for a
  group the caller is not in — an unknown group answers the same); `POST {token, group,
  period: 'week' | 'month'}` = the PERIOD board; `POST {token, standing: true}` = where the
  caller stands today in EACH of their groups (`{standings: [{group, rank, of}]}`, only the
  groups they hold a recorded row in); `POST {token, live: true}` = the LIVE read (below).
  Ranking rules are shared pure functions
  (`shared/src/leaderboard.ts`): competition tie ranks, the plain top-50 cut, the ±2 own-row
  window, `standingIn`. Rows dressed with profiles (a missing or FAILED profile read dresses
  blank → assigned identity; a GONE account is dropped). That fallback is for OTHER players'
  faces: the player's OWN face as the web reads it for itself (the header's key, `/account`,
  the email flow's lead, the race line) never takes the assigned identity for a failed read —
  it rests on the still stipple until read again (user-delegated 2026-10-06; web
  `AGENTS.md`, `AccountFace`).
- **THE PERIOD RULE (`rankPeriod`, ONE spelling for both ends and any later consumer):** each
  day of the range is ranked on its own and pays PODIUM POINTS 3 / 2 / 1 to the first three
  RANKS (a shared first pays both 3; the next rank is then third); then SOLVED DAYS (days with
  a recorded score); then the TOTAL of the scores (fewer tries first); publicId last as a
  row order. Rows equal on all three share a rank.
  The range is `periodRange` (`shared/src/groups.ts`): the calendar WEEK, Monday first, and
  the calendar MONTH, both ending on the day addressed. The read is the day board's own
  exact-key batch once per day of the range — score rows only, so a late, capped or given-up
  round counts for nothing (#211's on-time rule already decided which rows exist). Not done,
  deliberately: ALL-TIME and the median/outsider stats (an aggregate row per (group, member)
  written by the solving append — the second step, once a group asks).
- **Three states on the day board**: `waiting` (a member with neither a round nor a score;
  never the caller), **`playing`** (#206: a round for the CURRENT revision and no score row —
  exact `countTries` over the FULL artifact of the current revision, stored `progress`, ordered by the shared
  `orderPlaying` with NO rank number; members only; a failed read fails the
  POST), finished. A round that ENDED UNSOLVED (`roundEnded`: given up, or capped) stays in
  `playing` marked **`over`** — `∞` in the tries slot, its % muted, ordered after every live
  row (`orderPlaying`), so a member who gave up never reads as a live rival. A solve with no
  score row (late, IP-refused) stays IN PROGRESS unmarked — accepted. The caller's own
  playing row never defeats the just-you ghost.
- **THE SOLVED SCREEN'S BOARDS (user-decided 2026-10-02): how the player's day compares,
  UNDER SHARE, on the ACTIVE day only** (never an archive day or a bonus — the live read is
  the active day's). Tabs, a row of names (a sideways swipe on the lines turns them too):
  each of the player's groups — the group last opened (`gameStore.lastGroupId`) first, then
  the others; a group where nobody but the player has a row is skipped — then **GLOBAL**,
  the day's global board, under the board screen's own name for it (one name across the
  app). **A player none of whose groups holds anybody else** (no group, or only groups of
  one — read off the groups list the play screen already holds, never off an unknown one
  nor one being read again)
  **gets ONE SEAT tab before GLOBAL, and the box opens on it**: the board screen's bare `NO
  GROUP`, else their group of one by name (the one last opened, else the one joined last).
  Its panel is their own line over ONE call — CREATE GROUP (the board's own `GroupCreate`)
  or that group's INVITE (`/g/<id>`, `tracked: false`) — done IN PLACE by that call alone; a
  tap anywhere else on the seat opens the board's group tab. A group whose other members
  have not played is still skipped, and a result SHARE still carries no group. The groups
  come off the LIVE read below (no read
  of their own), and only off an answer read after the round ended (one asked during play
  lacks the score the solve recorded); GLOBAL is ONE anonymous `GET /board?…&id=<publicId>`
  per result display (score rows + profiles, no artifact), identity-fenced, a failure
  dropping the tab silently. Each tab is the boards' own reading (`web/src/game/resultBoards.ts`): a group's
  members who recorded a score ranked by `rankBoard` over that group's member list, then its
  playing members by `orderPlaying`; the whole day when it fits the box (6 rows), else the
  podium + the player's ±1 window + up to two playing rows, the box's room still left filled
  by the next rows down the ranking and then more playing rows (never a half-empty box
  beside a `+N`), + a `+N` of the rest. **The player's
  own row comes from their own result, never a guess:** ranked only when the server
  recorded their score; `∞` among the ended when the round ended unsolved; an unranked
  finished row when solved with no recorded score (late, IP-refused) — never a false rank.
  GLOBAL invents nothing (no recorded score: the top of the board alone). One fixed box whatever it
  holds, so nothing that has landed moves: a box left with nothing to show goes only while
  the page under it has not landed, and stays, empty, once it has. A tap opens that board (a group becomes the group
  last opened); no analytics event. `POST /board {token, standing: true}` still answers,
  with no consumer (retiring it is a separate call).
- **THE LIVE READ (`POST /board {token, live: true}`, the shared `LiveBoard`): EVERY group
  the caller is in, MERGED** — `{groups: [{id, name, members}], rows, playing}` over the
  deduplicated UNION of their members (the caller included): `rows` = the members with a
  recorded score today (dressed, `score`, NO rank — a rank belongs to ONE group, so the client
  ranks each group itself with `rankBoard` over the rows its member list names), `playing` =
  the day board's own section over the union (`over` included, `orderPlaying`'s order). The
  day board's pieces, read ONCE per call — one score batch, one round batch, ONE artifact
  read, one profile per member; members-only by construction (the caller's own
  memberships, each kept only while its member list names the caller); a gone account dropped
  from rows, playing and the member lists; a caller in no group answers empty with no
  artifact read. Date-addressed (no bonus). **Its consumers read ONE client module,
  `web/src/state/liveBoard.ts`: the play screen's RACE LINE and the solved screen's group
  boards — never a read of their own.** It is asked when the round's server state lands or
  changes (round start, each acknowledged append, the answer confirming a solve or a
  give-up) and when the tab comes back, only on the ACTIVE day, with an account, for a player
  in a group with somebody else — and **THROTTLED in that one module: at most ONE read per
  `LIVE_REFRESH_MS` (10 s), one flight at a time, a request inside the window served ONCE at
  its end (never dropped) — save ONE: the read asked by the answer that ENDS the round on
  screen (a solve or a give-up confirmed) goes at once (still behind a flight already out),
  so the result's group boards are built from a post-end answer without waiting out the
  window**. Why the throttle lives client-side and nowhere else: the read is at guess cadence
  against 10 Lambdas. Nothing polls an idle player: the triggers above are the whole list.
  The race line is an ORDER, never a rank (#206):
  finished members first (fewest tries), then the playing ones by `orderPlaying` with the
  player's own entry taken from the screen (their live % and tries), the ended-unsolved last;
  it reads LEFT TO RIGHT FROM BELOW TO ABOVE — the one just behind, the player, the one just
  ahead (the two behind on the left when the player leads, the two ahead on the right when
  they trail).
- Entry: the header's crown on every game surface (archive days included since 2026-08-31),
  the race line's tap during play, and the solved screen's boards.

### The WhatsApp bot boundary (#236, decided 2026-09-03)

- **`packages/whatsapp-bot` lives inside the monorepo and OUTSIDE the game runtime.** It may
  import `@whippin/shared`; nothing imports it. A consumer of the PUBLIC share-token contract,
  never a source of game truth: no WhatsApp identity on an account, no share-encoding change
  for it, no LLM deciding a score or a rank. A WhatsApp group is NOT a #271 group (it reads
  share tokens, never a membership); #271 left it untouched. Its config may NAME one
  (`whippinGroup`, user-decided 2026-09-14), whose invite link (`shared/src/invite.ts`
  `groupInvitePath`) the morning reminder prints after reading only its public face
  (`GET /groups?id=`) — the invite contract has a fourth consumer, and still no membership read.
  It also LINKS the tutorial's levels (user-decided 2026-10-02): which levels exist, in which
  languages, and their paths are `shared/src/tutorial.ts`, the table the web teaches from —
  the bot answers a question about how the game works with the level's page.
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
- The podium ranking is the bot's own dense ordering, not `shared/src/leaderboard.ts`'s.
  Everything else: its `AGENTS.md`.

---

## Testing

- **WRITE tests when a change touches a CONTRACT**: slug/fold, the puzzle schemas, scoring
  and score accumulation, rank/collision logic, `reduce_embedding` filtering, date/`dayNumber`
  routing, the shared ranking/history/email rules. Assert against the SPEC in this file, not
  the implementation.
- **DON'T add tests for cosmetic/visual work**, trivial wiring or config.
- **A failing invariant test is a real regression — fix the CODE, never weaken the test.**
- **Run `pnpm test` before a contract-touching task is done**: Vitest (`shared`, `web`,
  `backend`, `whatsapp-bot`, `infra`) + pytest (`generation`, `benchmark`, `curation`). Slug cases go in the ONE shared
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
pnpm test        # invariant tests: Vitest (shared, web, backend, whatsapp-bot, infra) + pytest (generation, benchmark, curation)
pnpm typecheck   # tsc --noEmit
```

Domain commands — wordlist/reduce/gen (generation), bench (benchmark), curate/shelf:lyrics (curation),
publish/inventory/backend:dev (backend), dev/build (web), cdk synth/diff/deploy (infra),
bot:start/pair/cli/groups (whatsapp-bot) — are documented in the owning package's `AGENTS.md`.

---

## Current state / mutable

- **Package manager:** `pnpm@11.9.0`; `pnpm-workspace.yaml` uses `allowBuilds` to approve
  `esbuild`'s postinstall.
- **The PRIVACY NOTICE describes what this repo STORES (#229):** `/privacy`
  (`web/src/screens/privacyDoc.ts`), both languages, every category the backend keeps and why
  (account email, hashed device token + parsed user-agent, guess logs, scores, groups,
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
  optional `VITE_UMAMI_WEBSITE_ID`. The backend deploy needs `OPERATOR_EMAIL` and
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
