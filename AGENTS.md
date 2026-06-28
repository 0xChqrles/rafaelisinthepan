# AGENTS.md — Rafael is in the pan (daily sentence-reconstruction game)

> This file is the single source of agent guidance. `CLAUDE.md` is a symlink to it,
> so Claude Code and Codex read the same content. Edit **this** file.
>
> The **code is ground truth.** If a rule here ever contradicts the code, trust the
> code and surface the conflict (see *Discrepancies to confirm* at the end) rather
> than silently "fixing" either side.

React + Vite + TypeScript front end; Python generation scripts run via `uv` (wired
through `pnpm`). Two languages: **en** (Stanford GloVe `glove.6B.300d`) and **fr**
(fastText `cc.fr.300`).

A **pnpm-workspaces monorepo** (`pnpm-workspace.yaml`; pnpm pinned via the root
`packageManager` field): `packages/web` (the front + served `public/`),
`packages/generation` (the Python scripts + `embedding/` data), and
`packages/shared` (cross-cutting TS: the slug/fold contract + schema types).
Generation writes **puzzles** into its own `packages/generation/output/` (then published
to the store), and the **vocab** existence set into `packages/web/public/` (a web asset).

## Maintaining this file

Instructions to future agents working in this repo:

- **You are a SCRIBE of the user's decisions, not an author of them.** After completing
  a task, update this file when — and **only** when — the user has **explicitly** decided
  something that changes an invariant, command, schema, or architecture rule recorded
  here. Never record a rule you inferred, assumed, or merely think is a good idea; never
  document a transient or in-progress state as if it were permanent.
- **Two zones, two bars:**
  - *Stable invariants* and the *Do NOT* list: edit **only** on an explicit, confirmed
    user decision that changes them. Call out such an edit **prominently** in your reply.
  - *Current state / mutable*: may be updated more freely to reflect what now exists.
- **Surface every edit.** Never edit this file silently — state in your reply what you
  changed and why. The diff is reviewable; the user keeps the final word.
- **When in doubt, DO NOT edit** — ask, or leave it and mention it. A stale-but-trusted
  file is worse than an unwritten note; an over-eager edit propagates a wrong rule into
  every future session.
- **Keep edits minimal** and consistent with the existing structure — don't restructure
  or re-narrate the whole file.

## File map

```
packages/
  generation/                Python generation (run via uv); puzzles -> output/, vocab -> web/public
    scripts/
      reduce_embedding.py     raw .vec/.txt -> *_reduced file (the ONLY filter+cap stage)
      embedding_neighbors.py  shared load/vocab/matrix/cosine-rank logic
      glove_neighbors.py      en paths + derived .kv cache (thin wrapper over the above)
      french_neighbors.py     fr paths + derived .kv cache (thin wrapper)
      start_word.py           start/hint-word selection (rank band 50-150)
      gen_phrase.py           one sentence -> one self-contained puzzle JSON
    embedding/<lang>/...      raw + *_reduced vectors + derived .kv caches
    output/word/<lang>/<s1>_<s2>_<s3>.json   generated puzzles (gitignored; publish to store/S3)
    pyproject.toml, uv.lock   Python project (uv)
  backend/                    daily-puzzle backend (pkg @rafaelisinthepan/backend, #2)
    src/
      handler.ts              createHandler() — the ONE day/404/CORS/Puzzle logic (Lambda + local)
      day.ts                  authoritative time: 22:00-ET DST-correct active day + reset info
      store.ts                PuzzleStore interface (date+lang -> Puzzle | null)
      s3Store.ts, fsStore.ts  store impls: S3 (prod) and local FS (#17), both read the same key
      layout.ts               storeKey() — the <date>.<lang>.json key shared by readers + publish (#17/#4)
      serve.ts                local HTTP server: Function-URL⇄HTTP adapter over createHandler (#17)
      publish.ts              place a generated puzzle into local store (default) or S3 (#17/#4)
      index.ts                Lambda entrypoint (s3Store + env config)
    .local-store/<date>.<lang>.json  local puzzle store (gitignored) read by serve/fsStore
  infra/                      AWS CDK stack provisioning the backend (pkg @rafaelisinthepan/infra, #3)
    bin/app.ts                CDK app entry (cdk.json runs it via `npx tsx`)
    lib/backend-stack.ts      BackendStack: private S3 bucket + Lambda(Fn URL) + CloudFront
    cdk.json                  CDK config (app command, context)
  shared/                     cross-cutting TS consumed by web (pkg @rafaelisinthepan/shared)
    src/slug.ts               fold() — the slug/fold contract (byte-identical to slug())
    src/types.ts              per-puzzle schema types (Puzzle, Hole, RankMap, …)
    src/index.ts              re-exports
  web/                        React + Vite + TS front (pkg @rafaelisinthepan/web)
    src/
      hooks/useVocab.ts       fetch+cache the per-language existence Set (once per session)
      hooks/usePuzzle.ts      ask the backend for today's puzzle (+ ?puzzle= file override)
      api.ts                  backend client: puzzleUrl/todayUrl, ?puzzle= override, 404->NO PUZZLE
      screens/Game.tsx        the guess loop, hole state (imports fold from @rafaelisinthepan/shared)
      game/scoring.ts         s(rank), holeProgress, computeProgress
      game/heat.ts            rank/progress -> heatmap color
      components/Phrase.tsx,Hole.tsx,WordInput.tsx,FloatingHit.tsx  rendering
    public/                   served at site root (web assets + generated data)
      vocab/<lang>.json       full slugged reduced vocab (existence set) — fetched by the SPA
```

---

## Stable invariants

These are decided and verified against the code. Treat them as load-bearing.

### Pipeline — one filter, one source of truth

- **`reduce_embedding.py` is the ONLY place that filters or caps.** It streams the
  frequency-sorted source line by line (never loads a vector), and for each word
  applies, in order: drop if any **uppercase**, drop **single-letter** (counted by
  character so `à`/`é` count as one), drop **non-alphabet** (`^[<class>]+(-[<class>]+)*$`
  = letters + internal hyphens only), drop **stopword**. The cap counts **survivors**:
  it keeps passing words until `TOP_N = 400000` have PASSED, then stops reading.
  Order is **filter-THEN-cap** → output has exactly `TOP_N` words (or fewer + a
  warning if the source is exhausted), *not* "200k minus rejects".
- Output is `<input>_reduced.<ext>` (extension preserved). If the source had a
  `"<count> <dim>"` header, the output header is **recalculated** to the kept count;
  if it had none (GloVe `.txt`), the output has none. The source is never modified.
- **The `*_reduced` file is the single source of truth downstream — already filtered,
  already capped.** Nothing after it re-filters.
- **`build_vocab` is a pure pass-through:** `V = list(kv.index_to_key)` — every word
  of the loaded reduced vectors, in file/frequency order. No regex, no stopwords, no
  truncation. Re-filtering here is a bug.
- **`load_vectors` loads the reduced file whole** (no frequency limit). It goes
  through a binary `.kv` cache whose path derives from the reduced file's path. The
  cache is rebuilt when the `.vec` is **newer** than the `.kv` (mtime check in
  `_cache_is_fresh`), so re-reducing never serves stale vectors. (Edge case: if the
  source `.vec` was deleted to save disk, the cache is trusted.)
- **`gen_phrase`: `kv == V ==` the whole reduced vocab.** No target "repêchage"
  injection. A secret word either survived reduction (it's in `V`) or it can't be
  used — in which case `gen_phrase` **errors clearly** instead of inventing it.

### slug() ⇔ fold() must stay byte-identical (cross-language)

Python `slug()` (`packages/generation/scripts/gen_phrase.py`) and JS `fold()`
(`packages/shared/src/slug.ts`, imported by `web/src/screens/Game.tsx`) MUST produce
the same key. Pipeline: **lowercase → expand ligatures (`œ→oe`, `æ→ae`) → NFKD → drop
combining marks → keep only `[a-z]` and `-` → collapse repeated dashes → trim edge
dashes.** Examples: `été→ete`, `forêt→foret`, `œuf→oeuf`, `peut-être→peut-etre`,
`arc-en-ciel→arc-en-ciel`.

**Accents are for DISPLAY; slug is for COMPARISON.** Never fold/slug a form you
display; never display a slug. Filenames are ASCII slugs; JSON *content* keeps
accents. On the front, `fold()` is applied **only** to the player's raw keystrokes.

### Per-puzzle JSON schema

```jsonc
{
  "lang": "fr",
  "words": ["la", "forêt", "ancienne"],        // full sentence, ACCENTS KEPT
  "holes": [                                    // sorted by pos ascending
    { "pos": 1,
      "secret": { "word": "forêt", "slug": "foret" },
      "start":  { "word": "...",   "slug": "..." },
      "start_rank": 87 }
  ],
  "ranks": {                                    // keyed by SECRET slug
    "foret": { "<input-slug>": { "word": "<accented>", "rank": 12 }, ... }
  }
}
```

- Every `{word, slug}` carries **both**, even when `slug == word` (no conditional
  shortcuts).
- `ranks` is keyed by **secret slug**; the inner map is keyed by **input slug** →
  `{word, rank}`. The value carries the **accented** word so the front can show the
  accented form of what was typed.
- **Rank semantics:** secret = `rank 0` (perfect); nearest neighbor = `1`; larger =
  farther.
- **Slug collisions** (`côté`/`coté` → `cote`): keep the **smallest-rank** entry
  (built closest-first), display its `word`, and **warn** at generation.

### Generation outputs

- **Two outputs, two homes (by purpose):**
  - **Puzzles** — one self-contained file per puzzle at
    `packages/generation/output/word/<lang>/<s1>_<s2>_<s3>.json`, slugs in **sentence
    order** (by `pos`), *not* `--words` order. Same words overwrite. A puzzle is a
    generation **artifact** (gitignored), not a web asset: it is **published** to the
    daily store (local FS or S3) via `pnpm puzzle:publish`; the front gets the day's
    puzzle from the **backend** (#6), never from web `public/`. Override the dir with
    `--out-dir`.
  - **Vocab** — `packages/web/public/vocab/<lang>.json` = the **full** slugged reduced
    vocab (existence set), deduped + sorted, deterministic, **NOT** capped to `TOP_K`.
    This one **stays a web asset**: the SPA fetches `/vocab/<lang>.json` from its own
    origin (`useVocab`), so it is written straight into web `public/`.
- **`TOP_K = 10000` is a generation-only cap:** each secret's rank map = the secret at
  rank 0 plus its `K` nearest. The front is **K-agnostic** — it tests membership in
  the map, never hardcodes 2000.

### Front game loop

- The front fetches `packages/web/public/vocab/<lang>.json` (served at `/vocab/<lang>.json`)
  **once**, builds an immutable `Set`,
  and caches it across puzzles/days (module-level cache in `useVocab`). **Existence
  is decided by this Set, never by a puzzle's rank map.**
- On Enter, `typed = fold(raw)`, then:
  1. **Not in `vocabSet`** → INVALID: red shake + "this word does not exist" under
     the input. No hole reacts.
  2. **In vocab** → **every UNSOLVED** hole (`rank !== 0`) reacts; look up
     `ranks[hole.secret][typed]`. A hole is **WARM** when the entry exists and **TOO
     FAR** otherwise. **Every impacted hole shows a floating indicator** (no
     exceptions — improving holes included):
     - **Warm** (entry exists) → a transient rank **distance number** floats on the
       hole, in the heat color of that distance.
     - **Too far** → the **same** floating + word-shake animation, but it reads
       **"MISS"** instead of a distance (no rank exists beyond top-K), in the coldest
       heat color.
     - **Warm + improves** (entry's rank beats the hole's current rank) → the hole
       **additionally** swaps to the entry's **accented `word`** and lower `rank`,
       but **only when its floating number begins to fade out** (`fadeDelayMs`), so
       the exponent-drop animation reads as the resolution of the number that landed.
  3. A single guess can advance/solve **several** holes. If `typed` is too far for
     **every** unsolved hole, **"MISS" plays on every hole**. Floating distance
     numbers and `"MISS"` feedback **start** consecutively in sentence order,
     `STAGGER_MS = 200ms` apart, but their fade-out phase is synchronized across the
     batch (they disappear together). The rank-improving word/rank replacements all
     fire **together** at that shared fade-out moment.
- **Solved holes (`rank === 0`) are locked:** excluded from the loop and rendered
  solved (accented secret, no exponent).
- **Feedback grammar:** under-the-input message = info about *what you typed* (only
  INVALID uses it now); on-hole floating number/"MISS" = info about *a hole*.

### Progress (`game/scoring.ts`)

For each hole, with `N = number of keys in ranks[secret]`:

```
s(rank)   = 1 - ln(rank + 1) / ln(N + 1)              // s(0) = 1 (solved)
p_hole    = (s(rank) - s(start_rank)) / (1 - s(start_rank))   // 0 at start, 1 solved
progress% = 100 * average(p_hole over holes)
```

### Score

The score is simply the **number of unique tries**. A try is a submitted word that
exists in the per-language vocabulary set, including cold misses and non-improving
warm hits. Repeated guesses are deduped by folded slug (`fold(raw)`), so accent
variants that compare equal count once. Invalid non-words are rejected before
counting. The score is displayed as the large background number during the round and
as `SCORE <tries>` at game end.

### Testing

- **WRITE tests when a change touches a CONTRACT:** the slug/fold contract, the
  per-puzzle JSON schema, scoring / score-accumulation logic, rank/collision logic,
  `reduce_embedding` filtering, or date/`dayNumber` routing. Assert against the SPEC in
  this file, **not** the implementation — a test that just mirrors the code proves nothing.
- **DON'T add tests for cosmetic/visual work** (layout, animation feel, styling, copy),
  trivial wiring, or config. Coverage for its own sake is discouraged.
- **A failing invariant test is a real regression — fix the CODE, never weaken the test**
  to make it pass.
- **Run `pnpm test` before a contract-touching task is done.** It runs Vitest (TS:
  `packages/shared`, `packages/web`) and pytest (`packages/generation`). The slug/fold
  case table is **one shared fixture** (`packages/shared/fixtures/slug-cases.json`)
  consumed by BOTH languages — add a case there, never on one side only.

### Working an issue

When asked to work/implement/do/resolve issue #N:

- **Read it first** with `gh issue view N`, then **implement the actual code** it
  describes. "Resolve/work/do an issue" ALWAYS means write the implementation — never
  just change its GitHub status.
- **Respect every invariant in this file.** If the change touches a contract area,
  write tests per the *Testing* policy and run `pnpm test` before finishing.
- **Branch + PR flow:** create a branch (e.g. `issue-N-short-slug`), commit there,
  push, and open a PR with `gh pr create` that references the issue (put `Closes #N`
  in the body so merging auto-closes it). Do **NOT** merge the PR and do **NOT**
  manually close the issue — the human reviews and merges.
- **Keep the PR description short:** what changed, how to verify, any AGENTS.md edits
  made.

---

## Do NOT

- **Don't re-filter in `build_vocab`** (or anywhere after `reduce_embedding.py`).
- **Don't hardcode `TOP_K` / 2000 in the front** — test map membership instead.
- **Don't fold/slug a displayed form, and don't display a slug.**
- **Don't let `slug()` and `fold()` diverge.**
- **Don't reintroduce `VECTOR_LIMIT` / `VOCAB_SIZE` / `VOCAB_SCAN`** knobs.
- **Don't switch `reduce_embedding.py` to cap-then-filter** (must stay filter-then-cap).
- **Don't skip the cache mtime check** in `load_vectors`.
- **Don't inject a missing target word** into the vocab in `gen_phrase` — error out.

---

## Commands

Uses **pnpm** (workspaces in `pnpm-workspace.yaml`, version pinned via the root
`packageManager` field). Each root script runs from the repo **root** (it delegates
to the right workspace via `pnpm --filter`) or from inside the package directly. The
generation scripts are scoped to `@rafaelisinthepan/generation`; reduce/gen paths below are
relative to `packages/generation/`. Unlike `npm`, **pnpm forwards args straight to
the script — do NOT add a `--` separator** (a literal `--` is passed through and
breaks `gen_phrase.py`'s arg parsing).

```bash
pnpm install                    # installs all workspaces (web + shared)

# 1. Reduce ONCE per language (slow, offline). Build the *_reduced source of truth.
pnpm reduce:fr        # embedding/fr/cc.fr.300.vec      -> cc.fr.300_reduced.vec
pnpm reduce:en        # embedding/en/glove.6B.300d.txt  -> glove.6B.300d_reduced.txt

# 2. Generate a puzzle per game (fast; first run for a language builds the .kv cache).
#    Puzzle -> packages/generation/output/word/<lang>/ (then `pnpm puzzle:publish` it);
#    vocab -> packages/web/public/vocab/<lang>.json (a web asset).
pnpm gen:phrase "<sentence>" --lang fr --words a b c   # exactly 3 words (no `--`)

# Local backend harness (@rafaelisinthepan/backend, #17) — no AWS creds needed.
pnpm puzzle:publish <puzzle.json> [--day YYYY-MM-DD] [--s3 --bucket NAME]  # default: local + active day
pnpm backend:dev                # local server (GET /?lang=, /today) on :8787 over the local store

# Front end (@rafaelisinthepan/web)
pnpm dev                        # dev server (set VITE_API_BASE_URL=http://localhost:8787 for the local backend)
pnpm build                      # production build -> packages/web/dist
pnpm typecheck                  # tsc --noEmit
pnpm test                       # invariant tests: Vitest (web + shared + backend) + pytest (generation)
```

`gen_phrase.py` requires **exactly 3** `--words`; they must appear in the sentence
(matched by slug) and must have survived reduction. Test overrides:
`?puzzle=<path>` forces a file, `?date=YYYY-MM-DD` overrides "today".

---

## Current state / mutable

*(Safe to update without touching the invariants above.)*

- All paths below are under `packages/`. **Tunables:** `TOP_N = 400000` (reduce),
  `TOP_K = 2000` (gen), start-rank band `50–150` (`start_word.py`).
- **Start-word selection is interactive per hole** (`gen_phrase.choose_start`): on a
  TTY it lists the rank-band candidates (numbered, each with its rank) and reads a
  choice — Enter keeps the random default, a number picks a candidate, any other word
  is accepted only if it is in that hole's rank map (matched by slug) else reprompts.
  The band logic, schema, and downstream `start`/`start_rank` are unchanged; non-TTY
  (piped/batch) runs silently keep the random default, so generation output is
  identical to before when not interacting.
- **Data present:** `generation/embedding/fr/cc.fr.300_reduced.vec` (+ `.kv` cache
  built), `generation/embedding/en/glove.6B.300d_reduced.txt` (+ `.kv` cache built).
  `web/public/vocab/{en,fr}.json` exist.
- **Puzzles:** generated into `generation/output/word/<lang>/` (gitignored), then
  published to the store (`pnpm puzzle:publish`). They are no longer kept under
  `web/public/word` — the front serves the day's puzzle from the backend (#6).
- **Routing (#6):** normal play asks the **backend** for today's puzzle —
  `usePuzzle` fetches `GET <VITE_API_BASE_URL>/?lang=<lang>` (puzzle) and `GET
  …/today` (`{ date, dayNumber, … }`). The **server owns the date** (22:00 ET flip);
  the client no longer computes it. A backend **404 → `noPuzzle`** (NO PUZZLE TODAY),
  any other failure → `error`. The old `web/src/puzzleSchedule.ts` / `todayKey()` /
  `PUZZLE_SCHEDULE` are **removed**. Test overrides: `?puzzle=<path|url>` loads a
  static file directly (kept, but the app still requires a configured backend base);
  `?date=` is **dropped** (server owns time). `VITE_API_BASE_URL` (see
  `web/.env.example`) configures the backend base and is required for `pnpm dev` /
  `pnpm build`; the frontend must not silently use its own origin as the backend.
  `usePuzzle` exposes `dayNumber` for persist (#7) / already-solved (#9).
- **Local backend harness (#17):** `pnpm backend:dev` runs the **same `createHandler`**
  as the deployed Lambda over a local filesystem store (`fsStore`), so the day/404/CORS/
  `Puzzle` behaviour is identical to prod with no AWS creds. `pnpm puzzle:publish
  <file>` places a generated puzzle into the store — **local by default**, `--s3
  --bucket` to push real S3, `--day YYYY-MM-DD` to target a game day (defaults to the
  active 22:00-ET day). Store key (shared by readers + writer in `backend/src/layout.ts`,
  identical for local FS and S3): flat `<root>/<date>.<lang>.json` — fully determined by
  (date, lang), so the stores GetObject/readFile it directly (no list+filter) and it
  stays listable by a date prefix; root defaults to `backend/.local-store` (gitignored),
  override via `PUZZLE_STORE`. Point `VITE_API_BASE_URL=http://localhost:8787` and
  `pnpm dev` plays end-to-end (including 404 → NO PUZZLE). Runs TS via `tsx`
  (backend devDep).
- **CDK stack (#3):** `packages/infra` (`@rafaelisinthepan/infra`) provisions the backend
  with AWS CDK v2 — one `BackendStack` (`lib/backend-stack.ts`) defining: a **private** S3
  puzzle bucket (all public access blocked, TLS enforced, `RETAIN`), a **`NodejsFunction`**
  that bundles `backend/src/index.ts` with esbuild (ESM, `@aws-sdk/*` left external) and
  carries `PUZZLE_BUCKET`/`ALLOWED_ORIGIN`, and a **CloudFront** distribution in front of an
  **IAM-auth Function URL via OAC** (only CloudFront may invoke it). The Lambda gets
  **read-only** S3 (`bucket.grantRead`). Cache policy keys on path + the `lang` query and
  honours the origin `Cache-Control` (the 22:00-ET-aligned `s-maxage`); maxTtl = 1 day.
  Outputs: `ApiUrl` (CloudFront, → `VITE_API_BASE_URL`), `PuzzleBucketName` (#4 upload
  target), `FunctionUrl`. Commands: `pnpm infra:synth` / `infra:diff` / `infra:deploy`
  (root) or `pnpm --filter @rafaelisinthepan/infra <synth|deploy|diff|destroy>`; deploy
  needs AWS creds + a bootstrapped account and takes `-c allowedOrigin=<web-origin>`.
- **Package manager:** pnpm, pinned via the root `packageManager` field
  (`pnpm@11.9.0`). `pnpm-workspace.yaml` lists the workspaces and uses `allowBuilds`
  to approve `esbuild`'s postinstall (its native binary), which pnpm blocks by default.
- The `.codex/skills/rafaelisinthepan-game/` skill + `validate_game_data.mjs` describe a
  **superseded** schema (see Discrepancies).

---

## ⚠ Discrepancies to confirm

These need a human decision; I did **not** change code or blindly record the
intended invariant.

*(Resolved 2026-06-22: a guess fills **all** improving holes — the old "at most one
hole" intent was superseded by an explicit decision to treat each impacted secret
consecutively.)*

*(Resolved 2026-06-27: **every** impacted hole now shows a floating distance/MISS —
improving holes included — starting staggered by `STAGGER_MS` and fading out as one
batch. An improving hole's word/rank swap is deferred to the shared fade-out moment
(`fadeDelayMs`) instead of firing immediately/staggered, so the exponent drop resolves
the number that just landed.)*

1. **Timer.** `README.md` and the `.codex` docs describe a 2:00 countdown that
   freezes the score. The current code has **no timer** — a round ends only when all
   holes are solved (shows "SOLVED!"). The recorded invariants don't mention a timer.
   Decide: remove the stale timer references, or reintroduce a timer.

2. **`README.md` `gen:phrase` example passes 2 words, not 3.** The example
   `--words forêt ancienne` would fail: `gen_phrase.py` requires exactly 3
   (`nargs=3`), and filenames are `<s1>_<s2>_<s3>.json`. Fix the README example.

3. **`.codex/skills/rafaelisinthepan-game/` is entirely stale.** Its `SKILL.md`,
   `references/game-contract.md`, and `scripts/validate_game_data.mjs` target a
   superseded design: a single `public/game_data.json` with per-language
   multi-phrase arrays, a non-existent `scripts/build_game_data.py`, plain integer
   ranks (`ranks[secret][word] = int`, not `{word, rank}`), ASCII-only normalization
   that **drops dashes** (`replace(/[^a-z]/g,'')`, contradicting the dash-keeping
   `fold()`), no slug/accents split, and a 2:00 timer. The validator validates the
   old shape. Decide: update them to the current schema or remove them.
