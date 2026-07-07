# AGENTS.md — Whippin AI (daily sentence-reconstruction game)

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
      reduce_embedding.py     raw .vec/.txt -> *_reduced file (the ONLY filter+cap stage) + vocab
      build_wordlist.py       offline builder: sources -> wordlist/<lang>.txt.gz (hors-dico ref, #38)
      build_vocab.py          reduced vectors -> web/public/vocab/<lang>.json (escape hatch; no re-reduce)
      slug.py                 stdlib-only: slug() contract + write_vocab (shared by reduce + gen_phrase)
      embedding_neighbors.py  shared load/vocab/matrix/cosine-rank logic
      glove_neighbors.py      en paths + derived .kv cache (thin wrapper over the above)
      french_neighbors.py     fr paths + derived .kv cache (thin wrapper)
      start_word.py           start/hint-word selection (rank band 50-150)
      gen_phrase.py           one sentence -> one self-contained puzzle JSON
    embedding/<lang>/...      raw + *_reduced vectors + derived .kv caches
    wordlist/<lang>.txt.gz    versioned hors-dico reference wordlist (#38); .cache/ gitignored
    output/word/<lang>/<s1>_<s2>_<s3>.json   generated puzzles (gitignored; publish to store/S3)
    pyproject.toml, uv.lock   Python project (uv)
  backend/                    daily-puzzle backend (pkg @whippin/backend, #2)
    src/
      handler.ts              createHandler() — the ONE day/404/CORS/Puzzle logic (Lambda + local)
      store.ts                PuzzleStore interface (date+lang -> Puzzle | null)
      s3Store.ts, fsStore.ts  store impls: S3 (prod) and local FS (#17), both read the same key
      layout.ts               storeKey() — the <date>.<lang>.json key shared by readers + publish (#17/#4)
      serve.ts                local HTTP server: Function-URL⇄HTTP adapter over createHandler (#17)
      publish.ts              place a generated puzzle into local store (default) or S3 (#17/#4)
      index.ts                Lambda entrypoint (s3Store + env config)
    .local-store/<date>.<lang>.json  local puzzle store (gitignored) read by serve/fsStore
  infra/                      AWS CDK app: backend (#3) + web hosting (#21) sibling stacks (pkg @whippin/infra)
    bin/app.ts                CDK app entry — WhippinBackendStack + WhippinWebStack (cdk.json runs it via `npx tsx`)
    lib/backend-stack.ts      BackendStack: private S3 + Lambda(Fn URL) + CloudFront; opt api.<domain> (ACM+Route53); us-east-1
    lib/web-stack.ts          WebStack (#21): private S3 (SPA) + CloudFront(OAC) + ACM + Route53; apex; us-east-1
    cdk.json                  CDK config (app command, context)
  shared/                     cross-cutting TS consumed by web (pkg @whippin/shared)
    src/slug.ts               fold() — the slug/fold contract (byte-identical to slug())
    src/day.ts                the ONE 22:00-ET DST-correct game-day logic (client + server + publish)
    src/types.ts              per-puzzle schema types (Puzzle, Hole, RankMap, …)
    src/heat.ts               heatColor() — heat ramp (rank exponents, heat grid, share card)
    src/progressColor.ts      progressColor() — progress ramp (progress bar, selector badge); shares ramp.ts
    src/index.ts              re-exports
  web/                        React + Vite + TS front (pkg @whippin/web)
    src/
      hooks/useVocab.ts       fetch+cache the per-language existence Set (once per session)
      hooks/usePuzzle.ts      fetch the client-computed day's puzzle (+ ?puzzle= file override)
      api.ts                  backend client: puzzleUrl/todayUrl, ?puzzle= override, 404->NO PUZZLE
      i18n.ts                 UI chrome strings (en+fr), t(lang, key); parity type-enforced
      tutorial/               onboarding (#51): Tutorial.tsx + data scripts/<lang>.ts
      screens/Game.tsx        the guess loop, hole state (imports fold from @whippin/shared)
      game/scoring.ts         s(rank), holeProgress, computeProgress
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
  applies, in order: drop **single-letter** (counted by character so `à`/`é` count as
  one), drop **stopword**, then drop **hors-dico** (see below). The cap counts
  **survivors**: it keeps passing words until `TOP_N = 400000` have PASSED, then stops
  reading. Order is **filter-THEN-cap** → output has exactly `TOP_N` words (or fewer + a
  warning if the source is exhausted), *not* "200k minus rejects".
- **`hors-dico` is rule 3, applied LAST to EVERY survivor** (#38): drop a word that is not
  in the language's versioned reference wordlist `wordlist/<lang>.txt.gz`. It compares the
  **pre-slug** token (lowercase, accents kept). Because that list is lowercase and
  letters+hyphens only (built by `build_wordlist.py` via `token_pattern`), hors-dico
  **subsumes the old `uppercase` and `non-alphabet` rules** — an uppercase / digit / markup
  token simply isn't in the list — so those two rules were removed. There is **NO frequency
  exemption**: even the single most frequent token is dropped if it isn't a dictionary word.
  The wordlist is built offline (Lexique/SCOWL ∪ Hunspell); the pipeline only **reads** the
  committed file, and a **missing** wordlist is a hard error (skip only with `--no-dico`).
- **The two morphological rules that remain (`single-letter`, `stopword`) exist precisely
  because hors-dico *can't* cover them:** their targets ARE valid dictionary entries the
  wordlist would otherwise keep — Hunspell/SCOWL ship every single letter `a`–`z`, and
  stopwords are real words. They run before hors-dico so attribution stays clean.
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

Python `slug()` (`packages/generation/scripts/slug.py`, the stdlib-only shared module
imported by BOTH `gen_phrase.py` and `reduce_embedding.py`) and JS `fold()`
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
  "words": ["tu", "t'attends", "rien,"],       // full sentence tokens, ACCENTS + PUNCTUATION KEPT
  "holes": [                                    // sorted by pos ascending
    { "pos": 1,
      "secret": { "word": "attends", "slug": "attends" },  // the pure word only
      "start":  { "word": "...",   "slug": "..." },
      "start_rank": 87,
      "prefix": "t'",                           // OPTIONAL display text before the blank
      "suffix": "" }                            // OPTIONAL display text after the blank
  ],
  "ranks": {                                    // keyed by SECRET slug
    "foret": { "<input-slug>": { "word": "<accented>", "rank": 12 }, ... }
  },
  "source": {                                   // OPTIONAL origin metadata (#5); ACCENTS KEPT
    "kind": "book",                             //   book | movie | music | quote | poem | … (open set)
    "author": "Victor Hugo",
    "work": "Les Misérables"
  }
}
```

- **`words[]` holds full display tokens with PUNCTUATION and APOSTROPHES kept** (only
  lowercased): `["tu", "t'attends", "rien,"]`, so the stored array reproduces the
  sentence. Generation locates each secret **inside** its token by slug on the token's
  word-cores (apostrophes/punctuation are separators; `arc-en-ciel` is one core), and
  splits it into the pure `secret` word plus the display text around it.
- **`prefix` / `suffix` are OPTIONAL, display-only hole affixes** (a leading clitic like
  `t'` / `l'` or opening punctuation, and trailing punctuation). They keep the blanked
  word's surroundings on screen **without** touching the secret: the player still types
  only the word and **slug/fold are unchanged**. Omitted when empty, so a hole with no
  affixes stays byte-compatible. The front renders them around the blank; they come from
  the **static** puzzle (not the persisted round state).
- Every `{word, slug}` carries **both**, even when `slug == word` (no conditional
  shortcuts).
- **`source` is fully OPTIONAL (#5):** the whole object may be absent AND every
  sub-field (`kind`/`author`/`work`) is independently optional, so partial
  metadata is valid and a puzzle without `source` stays byte-compatible. Values are
  **display forms** (accents kept, never slugged); `kind` is an **open** union (known
  values documented, but a new kind is allowed). Consumed by the solved screen (#8).
- `ranks` is keyed by **secret slug**; the inner map is keyed by **input slug** →
  `{word, rank}`. The value carries the **accented** word so the front can show the
  accented form of what was typed.
- **Rank semantics:** secret = `rank 0` (perfect); nearest neighbor = `1`; larger =
  farther.
- **Slug collisions** (`côté`/`coté` → `cote`): keep the **smallest-rank** entry
  (built closest-first) and display its `word`. Resolved **silently** — generation
  prints no collision output.

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
    origin (`useVocab`), so it is written straight into web `public/`. **`reduce`
    emits it in the same pass** (from the words it keeps — the vocab is a pure function
    of those, so no vector reload; `--no-vocab` to skip). `gen_phrase` still rewrites it
    as a side effect, and `pnpm vocab:<lang>` (`build_vocab.py`) rebuilds it from an
    existing reduced file without re-reducing. All three go through the one shared
    `slug.write_vocab`, so the output is identical.
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
as `<tries> TRIES` at game end (the unit is NAMED — on the solved screen, the share
card, and the share text — because "SCORE" alone reads as points to maximize when
lower is better; singular `TRY` at 1). Like the rest of the UI chrome the label is
localized (fr: `ESSAIS`/`ESSAI`, decided 2026-07-06); the unit stays named in every
language.

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
  push, and open a PR with `gh pr create` that references the issue without auto-closing
  it (use `Refs #N`, not `Closes #N`, unless the user explicitly asks for auto-close).
  Do **NOT** merge, close, or replace the PR, and do **NOT** manually close the issue —
  the human reviews and decides when PRs and issues close.
- **Do not brand branches or PR titles with the agent/tool name.** Use descriptive
  names like `issue-N-short-slug` and `Add favicon metadata`, not `codex/...` or
  `[codex] ...`.
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
- **Don't re-add `uppercase` / `non-alphabet` rules** — hors-dico subsumes them (the
  wordlist is lowercase + letters/hyphens only), and **don't drop `single-letter` /
  `stopword`**, which it can't (their targets are valid dictionary entries).
- **Don't re-introduce a frequency exemption** — hors-dico applies to every survivor.
- **Don't move `hors-dico` before the morphological rules** — it runs LAST so report
  attribution stays clean.
- **Don't silently skip a missing hors-dico wordlist** — error out (use `--no-dico` to
  opt out explicitly); and don't re-filter against the wordlist anywhere downstream.
- **Don't skip the cache mtime check** in `load_vectors`.
- **Don't inject a missing target word** into the vocab in `gen_phrase` — error out.

---

## Commands

Uses **pnpm** (workspaces in `pnpm-workspace.yaml`, version pinned via the root
`packageManager` field). Each root script runs from the repo **root** (it delegates
to the right workspace via `pnpm --filter`) or from inside the package directly. The
generation scripts are scoped to `@whippin/generation`; reduce/gen paths below are
relative to `packages/generation/`. Unlike `npm`, **pnpm forwards args straight to
the script — do NOT add a `--` separator** (a literal `--` is passed through and
breaks `gen_phrase.py`'s arg parsing).

```bash
pnpm install                    # installs all workspaces (web + shared)

# 0. (Re)build the hors-dico reference wordlist ONCE per language (offline, #38). The
#    committed wordlist/<lang>.txt.gz is already versioned — only rerun to refresh sources.
#    Needs `unmunch` (hunspell-tools; `brew install hunspell`) for the Hunspell union, or
#    pass --skip-hunspell for the Lexique/SCOWL-only union.
pnpm wordlist:fr      # Lexique ∪ Hunspell fr  -> wordlist/fr.txt.gz
pnpm wordlist:en      # SCOWL   ∪ Hunspell en  -> wordlist/en.txt.gz

# 1. Reduce ONCE per language (slow, offline). Build the *_reduced source of truth AND,
#    in the same pass, web/public/vocab/<lang>.json (the front's existence set — commit it).
#    Reads wordlist/<lang>.txt.gz for the hors-dico rule (--no-dico to skip; --no-vocab
#    to skip the vocab write). This is the one command for a language's derived data.
pnpm reduce:fr        # embedding/fr/cc.fr.300.vec -> cc.fr.300_reduced.vec + vocab/fr.json
pnpm reduce:en        # embedding/en/glove.6B.300d.txt -> glove.6B.300d_reduced.txt + vocab/en.json

# 2. (Escape hatch) Rebuild ONLY the vocab from an existing reduced file, without a slow
#    re-reduce — e.g. if the committed vocab/<lang>.json got lost.
pnpm vocab:fr         # -> packages/web/public/vocab/fr.json

# 3. Generate a puzzle per game (fast; first run for a language builds the .kv cache).
#    Puzzle -> packages/generation/output/word/<lang>/ (then `pnpm puzzle:publish` it).
#    NOTE: gen:phrase ALSO rewrites web/public/vocab/<lang>.json as a side effect.
pnpm gen:phrase "<sentence>" --lang fr --words a b c   # exactly 3 words (no `--`)

# Local backend harness (@whippin/backend, #17) — no AWS creds needed.
pnpm puzzle:publish <puzzle.json> [--day YYYY-MM-DD] [--s3]  # default: local + active day; --s3 -> the deployed bucket (stack output)
pnpm puzzle:inventory [--s3] [--days N] [--langs en,fr] [--ci]  # publish-buffer coverage (#61); reports + exits 0 by default, --ci exits 1 on any (day,lang) gap for cron/CI
pnpm backend:dev                # local server (GET /?lang=, /today) on :8787 over the local store

# Front end (@whippin/web)
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
  `TOP_K = 10000` (gen), start-rank band `50–150` (`start_word.py`).
- **`gen_phrase` is fully interactive on a TTY (#5).** Anything not passed as a flag is
  prompted: the **sentence** (positional, now optional), **`--lang`**, and the optional
  **source metadata** — `--kind` (offers `KNOWN_KINDS` numbered, but free text is
  accepted), `--author`, `--work`. The holes come from `--words` when given, else from the
  interactive selector (below); the source/lang flags are not re-prompted when given, and
  **non-TTY (piped/batch) runs keep working with flags only** — no prompt ever blocks them,
  and their output is identical to before (missing sentence/`--words` off-TTY is a clear
  error, and `--lang` still defaults to `en`). Source metadata is asked **after** the holes
  are chosen, so a bad word errors before any metadata is entered; blank answers are
  dropped (`build_source`) so no empty `source` key is written.
- **Interactive hole selector (decided 2026-07-05, `select_holes_interactive`).** WITHOUT
  `--words` on a TTY, the three holes are chosen with a small raw-mode (`termios`/`tty`
  cbreak) full-screen selector instead of typing words. `extract_candidates` lists the
  selectable words — each token's first word-core whose **display form is in `Vset`**;
  because reduction already strips stopwords / single letters / non-dictionary tokens,
  "in `V`" **is** the content-word filter (no separate stopword list), so `l'animal` offers
  only `animal` and punctuation/stopwords are non-selectable. ←/→ navigate the content
  words; the hovered word's **full start-word band** (`start_band`, ranks 50–150) is
  previewed live (its neighbor ranking computed once per word and **cached**). **Enter**
  commits the hovered word, then a **number + Enter** picks its start word (**Esc** cancels
  back to navigation, **Ctrl-C** aborts). Three commits end it. The produced `holes`/`ranks`
  are **identical in shape** to the `--words` path (`build_rank_map` + `_make_hole` are
  shared). `--words` (or off-TTY) **skips** the selector entirely (`holes_from_words`,
  behaviour unchanged), so batch/CI is unaffected. `< 3` selectable words → clear error.
- **Editable phrase prompt (decided 2026-07-05).** `gen_phrase` `import`s `readline`, so
  on a TTY every prompt is a line editor (arrow keys move within the line). The **sentence**
  is the exception to "flags aren't re-prompted": in interactive mode it is **always** shown
  in an editable prompt **pre-loaded with the flag value** (if any) — `_prefill_tty` injects
  the phrase into the tty input queue via the `TIOCSTI` ioctl (libedit's `set_startup_hook`/
  `set_pre_input_hook` prefill is a no-op on macOS), so a portion can be tweaked with the
  arrows and **Enter accepts it unchanged**. Prefill is best-effort: off-TTY, without
  `readline`, or where `TIOCSTI` is unavailable/blocked, the prompt just starts empty (typed
  fresh). Non-TTY runs are unchanged.
- **The `source` schema has no `context`/passage field (removed 2026-07-05).** `build_source`
  takes only `kind`/`author`/`work`; there is no `--context` flag or prompt, `Source` in
  `shared/src/types.ts` carries no `context`, and `SolvedCaption` renders only the kind tag +
  attribution. Puzzles without a `source` stay byte-compatible as before.
- **Start-word selection on the `--words` path** (`gen_phrase.choose_start`): used by
  `holes_from_words` (the interactive selector picks starts inline instead). On a TTY it
  lists the rank-band candidates (numbered, each with its rank) and reads a choice — Enter
  keeps the random default, a number picks a candidate, any other word is accepted only if
  it is in that hole's rank map (matched by slug) else reprompts. The band logic, schema,
  and downstream `start`/`start_rank` are unchanged; non-TTY (piped/batch) runs silently
  keep the random default, so generation output is identical to before when not interacting.
- **Data present:** `generation/embedding/fr/cc.fr.300_reduced.vec` (+ `.kv` cache
  built), `generation/embedding/en/glove.6B.300d_reduced.txt` (+ `.kv` cache built).
  `web/public/vocab/{en,fr}.json` exist.
- **Hors-dico wordlists (#38):** `generation/wordlist/{fr,en}.txt.gz` are committed —
  `fr` = Lexique ∪ Hunspell fr (~169k forms), `en` = SCOWL(≤60,US) ∪ Hunspell en_US
  (~91k). Built by `build_wordlist.py`; source downloads cache in `wordlist/.cache/`
  (gitignored). Tests use the small fixture `tests/fixtures/dico.fr.txt`.
- **Puzzles:** generated into `generation/output/word/<lang>/` (gitignored), then
  published to the store (`pnpm puzzle:publish`). They are no longer kept under
  `web/public/word` — the front serves the day's puzzle from the backend (#6).
- **Routing (#6), date-addressed (decided 2026-07-05, replacing the #42 version-in-URL
  scheme):** the **client computes the active game day itself** — `shared/src/day.ts`
  (moved from the backend) is the ONE 22:00-ET DST-correct day definition, used by the
  web, the handler, and `publish`. Normal play is **ONE fetch**:
  `GET <VITE_API_BASE_URL>/?lang=<lang>&date=<YYYY-MM-DD>` with the client-computed
  `activeDate`. The server serves **any past day** (the archive is date-addressed —
  decided 2026-07-07, #53, superseding the earlier symmetric ±1-day window that refused
  the archive) but the **future only within +1 day** of its own active day (clock-skew
  tolerance around the 22:00 flip; a pre-published buffer day at +2 or beyond → 404). An
  unpublished past day falls through to the normal missing-puzzle 404. Because the URL names the day, the persisted
  `dayNumber(date)` always matches the served puzzle — the old `/today`→puzzle pair and
  its 22:00-flip race are gone. **Caching:** the puzzle is served
  `max-age=300, s-maxage=31536000` — the CDN holds a (date, lang) entry effectively
  forever, and `pnpm puzzle:publish --s3` **invalidates `/*` on the API distribution**
  after upload, so a republished correction reaches the edge immediately and browsers
  within ~5 min on a normal reload. `date` missing/malformed → 400 (protocol violation).
  `/today` remains as a **diagnostic** (server's date/dayNumber/reset info, `no-store`);
  the client no longer reads it — `useToday` computes the day locally with no fetch, and
  the `PuzzleStore.version()` / S3 `HeadObject` plumbing was removed. A backend **404 →
  `noPuzzle`** (NO PUZZLE TODAY), any other failure → `error`. Test overrides:
  `?puzzle=<path|url>` loads a static file directly (kept, but the app still requires a
  configured backend base). `VITE_API_BASE_URL` (see `web/.env.example`) configures the
  backend base and is required for `pnpm dev` / `pnpm build`; the frontend must not
  silently use its own origin as the backend. `usePuzzle` exposes `dayNumber` for
  persist (#7) / already-solved (#9).
- **Onboarding tutorial (#51, redesigned 2026-07-06):** the tutorial **never starts
  without an action**. A first visit (persisted `onboarded` unset) lands on an
  **invitation** (`tutorial/Invite.tsx`, standing in for the loading screen: "New to
  the game? …" + TUTORIAL / SKIP — either sets the flag, so a veteran on a new
  device is one SKIP from playing). The header's `?` re-opens it as a **replay**.
  The tutorial **keeps the app header** (decided 2026-07-06, superseding the earlier
  header-less design): the flag (left) opens the **language screen — the ONE
  language-switching gesture everywhere** (no per-context flag behavior; decided
  2026-07-06 superseding a brief direct-toggle). The open-tutorial state is
  **transient store state** (`tutorialOpen: 'first' | 'replay' | null`, NOT
  persisted), so it survives the /select round-trip: picking a language returns INTO
  the tutorial in that language. Centre reads **"TUTORIAL"**, and the right control
  is a **fast-forward that SKIPS the whole tutorial** (`assets/icons/skip.svg`, →
  `onDone`) — a header affordance, NOT a coach-box `×` (which read as "close this
  box only"). Skip is available on both the first run and replays. The tutorial
  itself is **two-stage**, in the REAL game components. **Screen contract:**
  explanations in a TOP box (typewritten like a game dialog — `tutorial/CoachText.tsx`,
  app-bg + surface border — with inline markup so words look like what they are
  in-game: `[[b:]]` blue secret, `[[w:word^rank]]` gold + heat exponent, `[[m:]]`
  coldest heat, `[[n:]]` heat number); INTERACTIONS at the bottom (mix button, then
  keyboard), no modals/NEXT. **Stage
  1** is a single word, concept-first: the secret is SHOWN (blue); **MIX** shakes it
  to −1, **MIX AGAIN** fast-rolls to −10, **MIX EVEN MORE** rolls to −100 — landing
  on the start word (the demo explains where start words come from), where the
  button gives way to the keyboard (`tutorial/MixWord.tsx` is the display-only
  widget; Tutorial owns the animation); three gated guesses then show distance
  (farther, no move), MISS, and improvement, each rolling straight into the next
  prompt (no after-panels); finally the player types back to the secret with the
  REAL vocabulary (`useVocab` loads in the tutorial), nudged with the answer after 3
  straight MISSes. **Stage 2** is an easy two-hole sentence played **unguided** —
  its rank maps are stocked so the obvious first guesses land on BOTH holes, so
  multi-hole broadcast is discovered, not told; solving it ends the tutorial
  **wordlessly** (the tray swaps to `N TRIES` + PLAY TODAY'S PUZZLE; copy is
  deliberately terse throughout, no under-the-hood talk). The tutorial is
  **data-driven**:
  boards, ranks, guesses and steps live in `web/src/tutorial/scripts/{en,fr}.ts`
  (copy keys in `i18n.ts`) and `tutorial/scripts.test.ts` guards the lesson arc.
  Gated steps use synthetic vocab/prefix sets (the keyboard's existing contract);
  free steps use the real sets. The tutorial writes NOTHING to `rounds`; the store
  `migrate` (v2) grandfathers any blob with prior play state so veterans never see it
  uninvited. Replay via the header `?`; `?tutorial=1` forces it; a `?puzzle=`
  override suppresses the first-visit invitation.
- **App header (decided 2026-07-06):** a fixed **topbar** (`components/TopBar.tsx`) —
  flag (language) left, a centered title, a right-hand control — full-bleed with a
  thin `--surface` bottom border separating it from the app; the **progress bar sits
  in its own full-width row below it** (no more flag/`?` squeezing the bar on
  mobile). The game fills it with the day's puzzle id (`#<dayNumber>`) + help `?`;
  the tutorial fills it with "TUTORIAL" + the skip fast-forward. The flag ALWAYS
  opens the language screen. The topbar is the extension point for future chrome
  (streaks, stats, …).
- **Language screen (redesigned 2026-07-06):** headed by the **logo** (blue pixel
  glyph, 3×/2× its native 22px — language-neutral, and the app's ONE in-app branding
  spot), NOT a "select language" title (the cards self-explain, and a title would
  have to guess the user's language on the screen where it is unknown). One **card**
  per language — a full-opacity flag + the language's **native** name
  (`LANGS[].native`; never translated) — in a vertical list that scales to any number
  of languages, with the app's standard brighten-on-hover/press (no dimmed flags).
  The old NEW/%/✓ badges are gone: today's status is a thin **strip on the card's
  bottom edge** — absent = not started, partial = reconstruction % on the progress
  ramp, full **gold** = solved (the solved-word gold). The card's aria-label speaks
  the status.
- **UI chrome is localized + a11y'd (decided 2026-07-06):** `web/src/i18n.ts` holds every
  UI string in **en + fr** (`t(lang, key)`; the `satisfies` clause makes a missing
  translation a type error, so parity needs no test). Game screens resolve strings with
  the **puzzle's** language; the selector (no puzzle) uses the same resolution as the `/`
  redirect. `<html lang>` is kept in sync by App. Guess feedback is mirrored to a
  `.sr-only` polite live region (`srHoleResult`), animations honor
  `prefers-reduced-motion` (durations collapse to ~0 — never `animation: none`, several
  swaps advance on `animationend`; delays are kept so the floating numbers still show),
  and every control has a visible `:focus-visible` outline. The missing-puzzle screen
  wording owns that the state is **abnormal** (a publish that did not happen). The pixel
  font is **self-hosted** (`web/src/assets/fonts/PressStart2P.woff2`, `@font-face` in
  `index.css` — no Google Fonts request). The solved screen shows a **NEXT PUZZLE IN
  HH:MM:SS** countdown (`secondsUntilNextReset`, hidden on `?puzzle=` overrides).
- **SVG icons (pattern to follow):** monochrome UI icons live as `.svg` files under
  `web/src/assets/icons/` and are imported as **inline React components** via
  `vite-plugin-svgr` — `import Icon from '../assets/icons/name.svg?react'` (the `?react`
  query is what returns a component; a plain import would return a URL string). Rendering the
  SVG **into the DOM** (not via `<img src>`) is what lets it inherit color, so:
  - **Icons paint with `fill="currentColor"`** and carry **no hardcoded color** — the SVG
    root sets `fill="currentColor"` once and every child inherits it. Color/greyed/theme
    states then come **only** from the consuming element's CSS `color` (e.g. the control
    keys' `.kb-control` / `.kb-enter` / `.kb-greyed`). Never bake a hex/`fill` into an icon
    meant to tint with its surroundings.
  - **Strip the editor cruft.** Keep only `xmlns`, `viewBox`, `fill="currentColor"`, and the
    shape elements. **Remove** the `<?xml …?>` prolog, `id`/`data-name` (Illustrator layer
    junk), and intrinsic `width`/`height` (size in CSS instead; `viewBox` preserves aspect
    ratio — a fixed `width`/`height` would fight the CSS size). This is what "remove the
    useless attributes" means for any new icon.
  - **Size in CSS, keep the aspect ratio.** Give the icon a class and set **one** dimension
    (here `.kb-icon { height: 30%; width: auto }`) so `viewBox` scales the other; prefer a
    key-relative unit so it tracks responsive sizing without per-breakpoint rules. For
    pixel-art glyphs add `shape-rendering: crispEdges` to match the pixel font.
  - **Accessibility:** the SVG is **decorative** — pass `aria-hidden` on the component and
    let the surrounding `<button>`'s `aria-label` name the control.
  The type for `?react` imports comes from the `vite-plugin-svgr/client` reference in
  `web/src/vite-env.d.ts`; the plugin is registered **before** `react()` in `vite.config.ts`.
- **On-screen keyboard (#36):** the guess input has **no native `<input>`** — the old
  focus/refocus dance is gone, so the mobile soft keyboard never opens. `WordInput` is
  now just the visual prompt + a **window `keydown`/`paste` listener** for the physical
  keyboard (desktop); the `components/Keyboard.tsx` on-screen keyboard feeds the **same**
  input actions. Both drive one **folded-slug** `input` state in `Game` via three shared
  actions — `appendChar` (validated), `deleteChar`, `replaceInput` (Up/Down history
  recall, sourced from the round's **persisted** `tried` list so recall survives reload) —
  plus `submit`. Keys are `[a-z]` + dash + backspace + Enter (no accent keys; physical
  accents/ligatures are `fold()`-ed to slug chars, dash special-cased since `fold('-')==''`).
  **Live validation:** `useVocab` now also builds a **prefix `Set`** (`game/keyboard.ts`
  `buildPrefixSet` — every prefix of every vocab word; a flat Set, not a trie, per the
  issue) cached beside `vocabSet`; a letter/dash is greyed when
  `canExtend(prefixSet, input, char)` is false, Enter is greyed unless `vocabSet.has(input)`,
  and a greyed-key tap shakes (no input change). Backspace is always active. **Layout** is
  the ONE fixed **QWERTY** (`game/keyboard.ts` `KEYBOARD_ROWS`): the AZERTY alternative and
  the persisted `layout` preference were **removed** (explicit decision, 2026-07-05); the
  store's `migrate` silently drops the retired `layout` key from older persisted blobs.
  Keys are a uniform fixed size (not flex-grown), each row centered; the last row is
  the **enter icon** + letters + dash + the **backspace icon** sized like letters so it fits
  the keyboard width exactly. The two control keys render `assets/icons/{enter,back}.svg` as
  inline SVG components (see **SVG icons** below), not text; the button `aria-label`
  (`enter` / `backspace`) is what names them.
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
- **CDK stack (#3):** `packages/infra` (`@whippin/infra`) provisions the backend
  with AWS CDK v2 — one `BackendStack` (`lib/backend-stack.ts`) defining: a **private** S3
  puzzle bucket (all public access blocked, TLS enforced, `RETAIN`; its **name** is
  **CloudFormation-generated, NOT hardcoded** — a fixed physical S3 name is an anti-pattern
  (global-uniqueness collisions, and with `RETAIN` a teardown orphans it so the next deploy
  collides). Nothing consumes the literal name: the Lambda reads `bucket.bucketName` and
  `puzzle:publish` discovers it via the `PuzzleBucketName` output — the stack stays the single
  source of truth for the name, just through the output rather than a `puzzles.<domain>` literal),
  a **`NodejsFunction`**
  that bundles `backend/src/index.ts` with esbuild (ESM, `@aws-sdk/*` left external) and
  carries `PUZZLE_BUCKET`/`ALLOWED_ORIGIN`, and a **CloudFront** distribution in front of an
  **IAM-auth Function URL via OAC** (only CloudFront may invoke it). The Lambda gets
  **read-only** S3 (`bucket.grantRead`) and a **reserved concurrency of 10** (cost/abuse
  ceiling for the unauthenticated `/og` render until WAF is warranted). Cache policy keys
  on path + the `lang` **and `date`** query strings and honours the origin
  `Cache-Control` — the puzzle endpoint **requires `date`** (400 otherwise) and is served
  `max-age=300, s-maxage=31536000` (CDN holds it until `puzzle:publish --s3` invalidates);
  `/today` (diagnostic) is `no-store`; maxTtl = 365 days.
  Outputs: `ApiUrl` (→ `VITE_API_BASE_URL`), `PuzzleBucketName` (#4 upload target),
  `FunctionUrl`, `DistributionDomainName`. Commands: `pnpm infra:synth` / `infra:diff` /
  `infra:deploy` (root) or `pnpm --filter @whippin/infra <synth|deploy|diff|destroy>`;
  deploy needs AWS creds + a bootstrapped account. **App deploys go through CI** (PR →
  `ci.yml` → merge → `deploy.yml`); `main` is branch-protected (enforce_admins, require
  PR + the "Typecheck + test" check, strict). So the local `deploy`/`deploy:app` scripts
  are **guarded** by `scripts/guard-local-deploy.mjs`: they refuse unless `CI` is set (CI
  runs `cdk deploy` directly, unaffected) or **`ALLOW_LOCAL_DEPLOY=1`** is passed
  (deliberate break-glass). `synth`/`diff`/`destroy`/`deploy:auth` (the by-hand
  WhippinDeployStack bootstrap) are unguarded. **`-c domainName=<apex>` defaults to
  `whippin.ai`** (`bin/app.ts`), so every cdk command works with no flag; it drives the
  API/site domains and `WebStack` (override `-c domainName=<other>`
  for a different deployment). The API gets the stable custom domain `api.<domain>` (override
  label via `-c apiSubdomain=`): Route53 zone `fromLookup`, a DNS-validated **ACM** cert
  in-stack, distribution alias + **A/AAAA**; `ApiUrl` = `https://api.<domain>`. CORS
  `allowedOrigin` **defaults to the site origin**
  `https://<domain>` (override `-c allowedOrigin=`). The CDK app also defines a sibling
  `WebStack` (below) — pass a stack name to target one. **Both stacks pinned to `us-east-1`**
  (the backend was migrated from `eu-west-1`; tear the old stack down — see infra README).
- **Web hosting stack (#21):** `lib/web-stack.ts` `WebStack` (`WhippinWebStack`) — a sibling
  of `BackendStack`, independently deployable (`cdk deploy WhippinWebStack`), **pinned to
  `us-east-1`** (CloudFront's ACM cert must live there). Hosts the built SPA
  (`packages/web/dist`) on a **private** S3 bucket (`DESTROY` + auto-delete; build is
  reproducible) served only via **CloudFront + OAC** over HTTPS, with **SPA fallback**
  (403/404 → `/index.html`, 200). Two `BucketDeployment`s split cache lifetimes (hashed
  `assets/*` immutable-1yr, everything else `no-cache`) and **invalidate `/*`** on deploy —
  so `pnpm build` must run **before** deploy (missing `dist` → warn + skip upload). Custom
  domain comes from `-c domainName=<apex>` (**defaults to `whippin.ai`** in `bin/app.ts`): it
  looks up the existing Route53 zone (`fromLookup`), issues a DNS-validated **ACM** cert, sets
  the distribution alias to `<siteSubdomain>.<domain>` (`siteSubdomain` default **`""` = apex**;
  set e.g. `play`), and adds **A/AAAA** aliases. (The stack keeps a defensive no-domain
  branch — `*.cloudfront.net`, no ACM/Route53 — only for direct construction.) Wiring: build the web with
  `VITE_API_BASE_URL=https://api.<domain>` (the backend `ApiUrl`); the backend's CORS origin
  defaults to this site's `SiteUrl` (`https://<domain>`). Outputs: `SiteUrl`,
  `SiteBucketName`, `DistributionId`, `DistributionDomainName`.
- **Package manager:** pnpm, pinned via the root `packageManager` field
  (`pnpm@11.9.0`). `pnpm-workspace.yaml` lists the workspaces and uses `allowBuilds`
  to approve `esbuild`'s postinstall (its native binary), which pnpm blocks by default.
- **CI/CD (#33):** two GitHub Actions workflows under `.github/workflows/`
  (docs in `.github/workflows/README.md`). `ci.yml` — on PR→`main` and push to `main`,
  sets up pnpm/Node 22/uv+Python 3.12 and runs `pnpm -r --if-present run typecheck` +
  `pnpm test` (intended as a **required status check**; branch protection on `main` is a
  manual repo-admin step). `deploy.yml` — on push to `main` and `workflow_dispatch`,
  authenticates to AWS via **GitHub OIDC** (repo secret `AWS_DEPLOY_ROLE_ARN`, no
  long-lived keys) and deploys **only the changed stack(s)** via `dorny/paths-filter`
  (`shared`/`infra`/root-deps fan out to both; `generation` deploys nothing). Web deploy
  runs `pnpm build` (reads `VITE_API_BASE_URL` from the committed `.env.production` — the
  single source of truth; only the optional `VITE_PLAUSIBLE_DOMAIN` analytics var is passed
  via a repo variable, #60) before `cdk deploy WhippinWebStack`. `workflow_dispatch`
  `stacks` input forces
  `changed`|`web`|`backend`|`all` (default `changed`).
  - **Keep the pipeline in sync with the architecture.** `ci.yml` is self-maintaining
    (`pnpm -r --if-present` fans out to every workspace's `test`/`typecheck`), but
    `deploy.yml` is **hardcoded** and does NOT auto-cover changes. When you **add/rename
    a package** or **add/change a CDK stack** (`packages/infra/bin/app.ts`), update
    `deploy.yml` to match: the `dorny/paths-filter` mapping (which package paths trigger
    which stack — remember `shared`-like libs consumed by a stack must fan out to it),
    the per-stack deploy jobs, and the `workflow_dispatch` `stacks` options. A new
    deployable stack with no job/filter entry will silently never deploy.
- **Analytics (#60, decided 2026-07-07):** privacy-first, cookieless **Plausible** — no
  cookies, no consent banner (the developer is in France, GDPR-relevant).
  An explicit, **user-approved EXCEPTION** to the no-third-party-origin stance (same
  rationale that self-hosts the pixel font); proxying the endpoint through our own domain
  is a possible later step. **`web/src/analytics.ts` is the ONLY module that knows
  Plausible exists:** it uses the official `@plausible-analytics/tracker` package
  (follow-up decision 2026-07-07, replacing manual `script.js` injection) and
  `initAnalytics()` (called once from `main.tsx`) loads/initializes the tracker **only
  when `VITE_PLAUSIBLE_DOMAIN` is set** (else nothing). `track(event, props)` initializes
  the same tracker if needed, stringifies low-cardinality props at the Plausible boundary,
  and is a **silent, never-throwing no-op** when unconfigured. **Env-gated:**
  `VITE_PLAUSIBLE_DOMAIN` is a GitHub **repo variable**
  (like `VITE_API_BASE_URL`) set ONLY on the CI prod deploy (`deploy.yml` web build) and
  deliberately **NOT** in `.env.production`, so dev/preview/local `pnpm build` stay fully
  inert. The web CloudFront CSP (`infra/lib/web-stack.ts`) allows `https://plausible.io`
  in `connect-src` for the tracker endpoint; `script-src` stays `'self'` because the
  tracker is bundled. **Exactly three events** (low-cardinality props only — **NEVER** a typed
  word/guess): `solve {lang, tries, day, archive:'no'}` — the play-solve transition in
  `Game.tsx` (NOT rehydration; skipped on a `?puzzle=` override; `archive` hardcoded
  `'no'` until the archive ships); `share {method:'native'|'clipboard'}` — `SolvedScreen`
  success paths; `tutorial {action:'start'|'finish'|'skip'}` — invite accept / PLAY
  finish / skip (fast-forward or invite SKIP). Plus automatic pageviews.
- The `.codex/skills/whippin-game/` skill + `validate_game_data.mjs` describe a
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

3. **`.codex/skills/whippin-game/` is entirely stale.** Its `SKILL.md`,
   `references/game-contract.md`, and `scripts/validate_game_data.mjs` target a
   superseded design: a single `public/game_data.json` with per-language
   multi-phrase arrays, a non-existent `scripts/build_game_data.py`, plain integer
   ranks (`ranks[secret][word] = int`, not `{word, rank}`), ASCII-only normalization
   that **drops dashes** (`replace(/[^a-z]/g,'')`, contradicting the dash-keeping
   `fold()`), no slug/accents split, and a 2:00 timer. The validator validates the
   old shape. Decide: update them to the current schema or remove them.
