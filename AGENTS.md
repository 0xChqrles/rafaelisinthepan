# AGENTS.md — Whippin AI (daily sentence-reconstruction game)

> Agent guidance is split by scope (reorganized 2026-08-03): this ROOT file holds
> everything repo-wide — architecture, engineering principles, the cross-package
> contracts, testing policy, workflow — and each package keeps its own
> `packages/<pkg>/AGENTS.md` with the guidance specific to it. A package file always
> assumes this one: read this file first, then the file of the package you touch.
> Every `CLAUDE.md` (root and per-package) is a symlink to its sibling `AGENTS.md`,
> so Claude Code and Codex read the same content — edit the **AGENTS.md**.
>
> The **code is ground truth.** If a rule here ever contradicts the code, trust the
> code and surface the conflict (see *Discrepancies to confirm* at the end) rather
> than silently "fixing" either side.

React + Vite + TypeScript front end; Python generation scripts run via `uv` (wired
through `pnpm`). Two languages: **en** (Stanford GloVe `glove.6B.300d`) and **fr**
(fastText `cc.fr.300`).

A **pnpm-workspaces monorepo** (`pnpm-workspace.yaml`; pnpm pinned via the root
`packageManager` field):

```
packages/
  generation/   Python puzzle generation (uv): embeddings -> reduced vectors -> puzzles;
                also writes the vocab existence set into web/public.
  benchmark/    offline LLM puzzle benchmark harness (#68) — LAB-ONLY since 2026-08-12:
                the app no longer displays model results (see the schema section).
  backend/      daily-puzzle backend (#2): ONE handler for Lambda + local serve;
                puzzle store (S3/FS) + publish.
  infra/        AWS CDK app: backend (#3) + web hosting (#21) sibling stacks.
  shared/       cross-cutting TS: slug/fold contract, game-day logic, schema types,
                color ramps, share-card codec.
  web/          React + Vite + TS front end (the game).
```

Each package's detailed file map lives in ITS `AGENTS.md`. Data flow: generation
writes **puzzles** into its own `packages/generation/output/` (then published to the
store the backend reads), and the **vocab** existence set into `packages/web/public/`
(a web asset fetched by the SPA).

## Maintaining these files

Instructions to future agents working in this repo — they govern this file and every
package `AGENTS.md` alike:

- **You are a SCRIBE of the user's decisions, not an author of them.** After completing
  a task, update these files when — and **only** when — the user has **explicitly** decided
  something that changes an invariant, command, schema, or architecture rule recorded
  here. Never record a rule you inferred, assumed, or merely think is a good idea; never
  document a transient or in-progress state as if it were permanent.
- **Two zones, two bars:**
  - *Stable invariants* / *cross-package contracts* and the *Do NOT* lists: edit **only**
    on an explicit, confirmed user decision that changes them. Call out such an edit
    **prominently** in your reply.
  - *Current state / mutable*: may be updated more freely to reflect what now exists.
- **Put a rule at the right SCOPE.** Repo-wide rules, workflow, and anything two or more
  packages must agree on live in THIS file; guidance that concerns a single package lives
  in that package's `AGENTS.md`. Don't duplicate a rule across files — state it once at
  the widest scope it applies to and reference it from the narrower file when needed.
- **Surface every edit.** Never edit these files silently — state in your reply what you
  changed and why. The diff is reviewable; the user keeps the final word.
- **When in doubt, DO NOT edit** — ask, or leave it and mention it. A stale-but-trusted
  file is worse than an unwritten note; an over-eager edit propagates a wrong rule into
  every future session.
- **Keep edits minimal** and consistent with the existing structure — don't restructure
  or re-narrate the whole file.

## Engineering principles (decided 2026-08-03)

User-decided rules with the same bar as the stable invariants. Older notes that
mandated the opposite (notably backward-compatibility mandates) were removed the same
day; where this file still *describes* an existing compatibility layer in the code,
that is state, not a rule to imitate — these principles win.

- **Do not preserve backward compatibility.** Remove obsolete paths instead of adding
  compatibility layers, fallbacks, or migrations.
- **Choose the simplest implementation that fully meets the current requirements.**
  Avoid speculative abstractions, configuration, and indirection.
- **Grow the system in layers.** Start from the smallest version that works end to
  end, and add each new capability on top of a product that already works. Never trade
  a working product for unfinished complexity.
- **Keep components modular and concerns clearly separated.**
- **Prefer established, well-maintained libraries** when they reduce overall
  complexity or improve reliability. Do not reimplement common functionality without a
  clear reason.
- **Lean on the dependencies already in the project** before writing your own
  implementation or adding packages. Do not assume a library lacks a capability
  without checking its documentation and types.
- **Make architectural decisions for the long term.** Do not accept a stopgap that
  only works for now and is meant to be replaced later.

---

## Cross-package contracts

These are decided and verified against the code. Treat them as load-bearing. They span
package boundaries, which is why they live here; each package's own invariants live in
its `AGENTS.md`.

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
  "holes": [                                    // one entry per occurrence, sorted by pos
    { "pos": 1,
      "secret": { "word": "attends", "slug": "attends" },  // the pure word only
      "start":  { "word": "...",   "slug": "..." },
      "start_rank": 87,
      "prefix": "t'",                           // OPTIONAL display text before the blank
      "suffix": "" }                            // OPTIONAL display text after the blank
  ],
  "ranks": {                                    // keyed by SECRET slug
    "foret": {                                  //   dq: OPTIONAL to consumers (#115)
      "<input-slug>": { "word": "<accented>", "rank": 12, "dq": 231 }, ...
    }
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
- Authoring selects exactly **3 distinct secret slugs**. If a selected slug appears more
  than once in the sentence, generation emits one complete hole per occurrence while
  keeping one shared rank map and one shared start hint for that slug. Therefore `holes`
  may contain more than three entries, but `ranks` still has exactly three selected-secret
  keys; each occurrence keeps its own `pos`, display form, `prefix`, and `suffix`.
- **`prefix` / `suffix` are OPTIONAL, display-only hole affixes** (a leading clitic like
  `t'` / `l'` or opening punctuation, and trailing punctuation). They keep the blanked
  word's surroundings on screen **without** touching the secret: the player still types
  only the word and **slug/fold are unchanged**. Omitted when empty. The front renders
  them around the blank; they come from
  the **static** puzzle (not the persisted round state).
- Every `{word, slug}` carries **both**, even when `slug == word` (no conditional
  shortcuts).
- **`source` is fully OPTIONAL (#5):** the whole object may be absent AND every
  sub-field (`kind`/`author`/`work`) is independently optional, so partial
  metadata is valid. Values are
  **display forms** (accents kept, never slugged); `kind` is an **open** union (known
  values documented, but a new kind is allowed). Consumed by the solved screen (#8).
- **`benchmark` was REMOVED from the schema (user-decided 2026-08-12).** From #68
  through #81 a puzzle could embed recorded LLM runs and the front end rendered a
  display trio (standings lineup mid-game, leaderboard dialog on the solved screen).
  The user retired the feature: it took screen space, cost real money and curation time
  per puzzle, and the planned comparison story is other players' scores ("you beat x%
  of users", a separate future issue). The schema field, its TS types
  (`BenchmarkEntry`/`BenchmarkResults`), the web's parse/display code and its sprite
  assets are deleted; the client simply ignores a stray `benchmark` key on an
  already-published puzzle. **`packages/benchmark` (llm_play.py) is KEPT as lab-only
  tooling for "scientific" reading** — same decision: `--in-place` (the puzzle-JSON
  embed) and the whole `--selection` median/best machinery are gone from the harness
  too; every invocation appends its full session record to the package's `output/`
  lab artifact instead, and nothing writes into a puzzle file. See its own `AGENTS.md`.
  The removal does not resurrect #57's proposed `par` — there is still
  no `par` schema field.
- `ranks` is keyed by **secret slug**; the inner map is keyed by **input slug** →
  `{word, rank}`. The value carries the **canonical accented form** of its group (see
  below), which the front displays — not necessarily the typed form.
- **Inflected forms of one word are ONE ranked group (#104, decided 2026-07-20), and
  a group is a PLAYABLE WORD IDENTITY, ranked by its homograph-free representative
  (#134; group identity refined by #146 on 2026-08-03):** most groups are one
  dictionary lexeme, but the fr inventory first merges source entries that make no
  playable distinction (see below). Its consumer key is therefore **opaque** — the
  `:pos` suffix names the source entry that donated the key, not necessarily every
  paradigm the group carries. Each group reachable from the walk is ranked by its
  **closest embedded form that is not shared with another group** (group-min over
  clean forms). A homograph's vector blends strangers' meanings (`vers` mixes the
  worm's plural with other readings), while an unambiguous form owns its vector
  entirely, even when it diverges from siblings (`lunettes` near an eye secret is
  real sense signal, and its whole group rides that closeness). A group with NO
  clean embedded form still ranks — representative = its closest form of any kind,
  **flagged in generation output** ("take what exists"). Duplicate dictionary
  entries are already one group, so they cannot create false homograph flags.
  **The #133 TTY answer is usage morphology first (#146):** it asks only
  gender/number/conjugation, never which duplicate dictionary filing is intended.
  If that morphology still spans real groups with different typable form families,
  a second identity pick lists each group's **complete forms** (`fil : fil, fils`
  versus `fils : fils`); choices whose differences are all outside the reduced
  vocabulary collapse because they produce identical solve keys. The stored/CLI
  cell vocabulary stays unchanged. Off a TTY `--form MOT=TRAIT` is still required,
  and a real remaining shared cell requires #144's qualified
  `MOT=LEXÈME/TRAIT`; a bare typed trait keeps the fail-closed rule.
  Every reduced-vocab form of a group is one of its keys (typing `privées` finds —
  and displays — `privé`); an ambiguous form (`portes` → porte/porter, `bois` →
  bois:nc/boire:v) keys to whichever group ranked **closest** — a homographic
  surface is only a KEY, never a group of its own. Keys are assigned closest-first:
  **a group left with no key dissolves and consumes no rank**, and **a group's
  display is its closest OWNED form**, so what the map prints types back at that
  group's own rank. The secret is group 0 and **claims the group the author
  confirmed**; `rouges` now claims merged `rouge:nc`, so `rouge` solves it, while a
  confirmed `fils:nc` still does NOT claim `fil:nc`. The fallback stays fail-closed:
  an unconfirmed homograph claims one group only when the surface names exactly one,
  and `mois` must never claim `moi:nc`. Because the claim needs the answer, the
  #133 question fires **BEFORE the walk** (off a TTY `--form` is read there; the
  selector confirms at commit, before the start band renders, with hover provisional).
  **A borrowed vector (#119) still claims only what the secret and donor SHARE**
  (decided 2026-07-30): `--donor` names a surface/vector, not a group, and a
  confirmed group is honoured only inside that shared set. Merging is
  filter-then-cap: `TOP_K` counts **surviving groups**, so ranks stay compacted. Two
  selected secrets in one full identity group are still rejected at generation —
  deliberately separate from the narrower group-0 claim.
- **Rank semantics:** secret = `rank 0` (perfect); nearest word group = `1`; larger =
  farther. Alias keys share their group's rank.
- **Every ranked group also carries its real geometry (`dq`) — #115, decided
  2026-07-25.** Ranks are dense and uniformly spaced by construction, so they erase the
  neighborhood's clumps and cliffs; cosine distance is only available at GENERATION time
  (the client never sees vectors), so generation ships it.
  - **`dq` — the quantized distance to the secret, one byte, per hole.** With `s1` = the
    rank-1 group's similarity and `smin` = the LAST kept group's,
    `dq = round(255 * (s − smin) / (s1 − smin))` → **rank 1 = 255, the farthest kept
    group = 0**, non-increasing in between. The **per-hole affine normalization is
    lossless for consumers**: what they compute are RATIOS of similarity DIFFERENCES,
    which an affine map preserves exactly, so the journey ratio is
    `(dq − dq_start) / (255 − dq_start)` with no floats shipped. Present on **every rank
    ≥ 1 entry** of a newly generated puzzle; **the secret's own entry (rank 0) carries
    NONE** — the terminus is off-scale by nature. A flat span (`s1 == smin`) is a **hard
    error**, never silent all-zero `dq`. **`dq` has no opt-out** — it is part of the schema.
  - It is a **GROUP property**, like `word`/`rank`: every alias key of a lemma group
    carries its group's value, and slug-collision resolution keeps the winning (closest)
    group's.
  - **The semantic ROAD clustering that shipped beside it was REMOVED (user-decided
    2026-08-12).** From #115 through 2026-08-11 every ranked group also carried a `road`
    — which cluster of the travelled neighborhood it sat in — drawn by the route map as
    coloured lanes. The map was replaced by the guess-history modal (2026-08-10) and the
    tutorial's themes lesson by the rarity ladder (2026-08-11), which left the field with
    no reader anywhere. The schema field, `distances.py`'s clustering (`cluster_roads`,
    `road_zone`, the `ROAD_*` constants), `gen_phrase.annotate_roads` + `--no-roads`, and
    the web's lane machinery are all deleted. A stray `road` key on an already-published
    puzzle is simply ignored at parse.
- **Slug collisions** (`côté`/`coté` → `cote`): keep the **smallest-rank** entry
  (built closest-first) and display its `word`. Resolved **silently** — generation
  prints no collision output.
- **The `source` schema has no `context`/passage field (removed 2026-07-05).** `build_source`
  takes only `kind`/`author`/`work`; there is no `--context` flag or prompt, `Source` in
  `shared/src/types.ts` carries no `context`, and `SolvedCaption` renders only the kind tag +
  attribution.

### Single-word artifact schema (#154, decided 2026-08-03; `freq` added by #163 on 2026-08-08)

The SECOND puzzle type: one word and its ranked neighborhood, with no sentence around
it. Produced by `packages/generation/scripts/gen_word.py` (`pnpm gen:word`), typed as
`WordPuzzle` in `shared/src/types.ts`. It exists because "one word + its ranked
neighborhood" is what the reworked onboarding and Word mode play on, and the only way
to get one used to be authoring a 3-secret sentence and throwing two thirds of it away.

```jsonc
{
  "lang": "fr",
  "word": { "word": "phare", "slug": "phare" },   // accented display form + its slug
  "ranks": {                                       // ONE FLAT map — no per-secret keying
    "<input-slug>": { "word": "<accented>", "rank": 12,
                      "dq": 231, "freq": 8412 }, ...
  }
}
```

- **The inner rank-map semantics are the sentence schema's, UNCHANGED** — same merge
  walk and group semantics (#104/#134/#146), same #133 explicit-form confirmation, same
  donor vectors (#119), same `TOP_K` group cap, same `dq`, same slug-collision rule:
  alias keys per group, and every annotation an artifact carries is a GROUP property;
  rank 0 is the word itself and carries **no `dq`**, every rank ≥ 1 entry carries one.
  Both commands run the **one shared per-secret pipeline** (`gen_phrase.walk_secret`), so a word's
  neighborhood can never differ by which game asked for it.
- **`freq` — the group's CORPUS RARITY, this artifact's own annotation (#163, decided
  2026-08-08).** The **1-based position, in the frequency-ordered EXISTENCE SET (distinct
  slugs), of the group's MOST FREQUENT OWNED KEY**: 1 = the commonest word the game
  admits, larger = rarer. The reduced file preserves the source embedding's frequency order
  (`reduce_embedding` streams it and keeps survivors in place); `annotate_freq` walks that
  order and the first occurrence of each slug fixes its existence-set position. This is a
  READ of a position, not a computation, over the exact slugged + deduplicated population
  written to `web/public/vocab/<lang>.json` and loaded into the browser's `vocabSet`.
  The most frequent OWNED KEY — the commonest thing a player can TYPE to claim the group:
  its commonest inflection rather than its representative (a lexeme's rarity is felt at
  its commonest form), but never a surface another group owns — pricing `boire` by
  `bois`'s position would grade a rare lexeme by a word that can only ever claim the
  tree, and a min over unowned surfaces only ever errs CHEAPER. The walk has settled
  ownership closest-first (#104/#134), so the pricing reads the rank map's keys. A
  GROUP property like the rest, stamped by rank (`gen_word.annotate_freq`), so alias keys
  repeat it and slug-collision resolution keeps the winning group's, both by construction.
  Present on **every** entry the group can reach, **rank 0 included** — unlike `dq`, whose
  absence there is about the scale being off at the terminus; a word has a frequency
  wherever it sits. Absent only for a group with no key in the existence set (the secret
  of a borrowed vector, #119, whose slug embeds nothing), so consumers treat it as
  OPTIONAL — per entry: a map with NO `freq` anywhere is a stale pre-#163 artifact whose
  every claim would silently grade at the COMMON floor, and the web REFUSES it at parse
  (`parseWordPuzzle`) per the no-back-compat rule.
  **Emitted by `gen_word.py` ONLY** — a sentence puzzle carries none: nothing there
  consumes it and those maps are already ~500 KB gzipped. **The WEB maps `freq` → a named
  RARITY GRADE and its bonus seconds, never generation** (`web/src/game/wordGame.ts`
  `rarityOf` / `bonusSeconds`), so every tuning iteration is a web-only constant change
  with no artifact republish. **Since 2026-08-10 the grade is also what the board says about
  each station; since 2026-08-11 it says it in the station WORD'S COLOUR on one trunk**
  (below), which is what let the semantic clustering leave this artifact entirely: one
  shipped number now carries both what a claim PAYS and how its stop is painted. It reads
  the value as a **FRACTION OF THE CORPUS**, not as an absolute rank — the vocabularies are
  very different sizes (en 75k, fr 128k), and measured
  on real artifacts, absolute cutoffs put the average claim 55% apart between the two
  languages. That is why the field ships as a corpus position and the client owns the
  denominator: the shipped number is a fact about the corpus, and what counts as rare is a
  product decision the web is free to retune.
- **`ranks` is ONE FLAT map** (there is only one word to rank around, so nothing to key
  it by), and there is no `words` / `holes` / `start` / `start_rank`. **No `source`
  either:** attribution belongs to a quoted line, and a lone word quotes nobody.
- **No semantic clustering (decided 2026-08-10).** Word mode's board draws one trunk and
  paints each station word by **RARITY** — the `freq` grade above. How that grade is
  presented is the WEB's (`web/src/game/wordBoard.ts`), and it needs nothing else stamped:
  `freq` is already on every entry. `dq` still has no opt-out.
  **The web's `CLAIM_ZONE` (`web/src/game/wordGame.ts`) is pinned to NOTHING in
  generation:** `dq` runs to the map's own `TOP_K` edge, so Word mode's range is the
  client's own tuning knob, movable with **no republish** and no regeneration.

### Day-addressed routing & the game day

- **Routing (#6), date-addressed (decided 2026-07-05, replacing the #42 version-in-URL
  scheme):** the **client computes the active game day itself** — `shared/src/day.ts`
  (moved from the backend) is the ONE 22:00-ET DST-correct day definition, used by the
  web, the handler, and `publish`. Normal play is **ONE fetch**:
  `GET <VITE_API_BASE_URL>/?lang=<lang>&date=<YYYY-MM-DD>[&mode=word]` with the
  client-computed
  `activeDate`. **`mode` names WHICH daily (#156):** absent or `sentence` = the sentence
  puzzle, `word` = the #154 single-word artifact; anything else → 400. Everything below —
  day-addressing, the future guard, the 404, the caching — is identical for both, and each
  reads its own store key (`<date>.<lang>.json` / `<date>.<lang>.word.json`).
  **Every query string the handler reads MUST also be in the CloudFront cache policy's
  allowList** (`infra/lib/backend-stack.ts`): with no origin request policy on that
  behavior, CloudFront forwards to the origin exactly the cache-key values, so an unlisted
  parameter both collapses two responses onto one year-long edge entry AND never reaches
  the Lambda at all. That is three packages agreeing on one list, which is why it is
  recorded here; `pnpm backend:dev` has no CDN in front of it and can never show the
  disagreement.
  The server serves **any past day** (the archive is date-addressed —
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
  `noPuzzle`** (NO PUZZLE TODAY), any other failure → `error`. **The `?puzzle=` file
  override was REMOVED (decided 2026-07-19):** the front ALWAYS loads the day's puzzle
  from the backend — there is no client-side file/URL override. To test a specific puzzle
  locally, publish it into the local store (`pnpm puzzle:publish`) and point the front at
  the local backend. Consequently `usePuzzle`'s `dayNumber` is **always a real number**
  (never `null`), which is why `Game`/`App` no longer carry override/null-day branches
  (`SolvedScreen`'s `dayNumber` is a plain `number` too since 2026-08-03: the null it used
  to accept was the TUTORIAL's, whose ending moved onto the route map with #155 — a lesson
  has no score, so it no longer borrows the solved screen). `VITE_API_BASE_URL` (see
  `web/.env.example`) configures the backend base and is required for `pnpm dev` /
  `pnpm build`; the frontend must not silently use its own origin as the backend.
  `usePuzzle` exposes `dayNumber` for persist (#7) / already-solved (#9).

### Live score collection (#169, decided 2026-08-13; per-player rows + identity #187, decided 2026-08-18)

- **Player identity is a secret key, no accounts (#187):** the client generates a random
  128-bit secret on first need (the first score POST), keeps it in localStorage
  (`web/src/identity.ts`), and sends it in the POST body — it is simultaneously the ID
  and the password. The server derives `publicId` = first 10 bytes of
  SHA-256(secret), base32 (16 chars) on every authenticated call and **stores nothing
  secret** — no registration, no stored credentials. The derivation lives in
  **`shared/src/identity.ts`** because it is a cross-package contract: the web generates
  and sends the secret, the backend keys every stored row by the derived publicId, and a
  drift forks one key into two identities. No unique usernames (a lost key would freeze
  the name forever); losing localStorage loses the identity — accepted, the remedy is
  the copyable-key backup (#188), which doubles as device linking. Anti-cheat stance:
  **assume heavy cheating and design so it doesn't matter** — global rankings are
  untrusted by design, trust comes from the friends graph (#189), and the percentile is
  the one public stat that survives faking.
- The ONE backend handler also owns the daily score population:
  `GET|POST /scores?lang=<lang>&date=<YYYY-MM-DD>&mode=<sentence|word>`; unlike the
  puzzle route, **`mode` is required**. POST takes `{ secret, score, turnstileToken }`
  (the secret travels in the **body**, never a query string — the `/scores` behavior
  contract below is untouched), verifies Turnstile server-side, validates the score
  against that published daily/mode, derives the publicId, and writes **ONE row per
  `(date, lang, mode, publicId)` with a conditional put — first write wins**: the daily
  can't be replayed, so a second submission is never legitimate; it changes nothing,
  consumes no IP allowance, and is answered 200 with the STORED row's standing. The
  response is the UPDATED histogram so the caller's score is already included. GET is
  the read-only twin for solved revisits. The puzzle route's malformed-param and future
  +1-day guards apply; a population is never created for an unpublished puzzle.
  **Production POST callers must SHA-256 the exact UTF-8 body bytes they send and put the
  lowercase hex digest in `x-amz-content-sha256`.** The body must not be reserialized after
  hashing. This is a hard CloudFront-OAC/Lambda-URL contract: Lambda rejects an unsigned
  POST before the handler runs. The score behavior forwards the header and CORS allows it;
  local `backend:dev` has no OAC and therefore cannot surface a missing hash.
- **The histogram is DERIVED from the day's rows at read time (#187), subsuming the #169
  bucket counters** — per-player rows are a strict superset, and two stores answering
  the same question would drift, so the counter items and the fixed bucket edges are
  gone (no-back-compat rule). The response keeps the shape the solved screen consumes
  (`{ buckets, total, bucket }`, inclusive ranges) with the bands now **one exact band
  per distinct recorded score, ascending** — a day partition is small, one Query +
  compute in the handler. An empty population is honestly `buckets: []`.
- **Score limits are gameplay limits, not a generic integer cap.** Sentence mode counts
  unique vocabulary-valid tries, so its ceiling is the language's existence-set size.
  Word mode counts claimed groups, so its ceiling is the distinct claimable ranks in that
  artifact, bounded by the ONE shared `WORD_CLAIM_ZONE` constant
  (`shared/src/scores.ts`, consumed by web + backend). The bands the API returns are
  derived from the recorded rows (#187); consumers render the ranges returned by the API
  rather than restating them.
- The hashed-IP dedup stays as a **volume sanity floor** under the per-player rows: POST
  dedups by `HMAC-SHA256(client IP, server secret)` and **never stores a raw IP**.
  Up to **5** recorded rows are allowed per `(date, lang, mode, ipHash)`; the dedup item
  expires after 48 hours. Its conditional count update and the row's first-write-wins
  conditional put are one DynamoDB transaction, so a capped/failing/duplicate request
  cannot change just one half (and a refused duplicate consumes no allowance). What is
  retained is the score row — `(date, lang, mode)` partition, `publicId` sort key,
  `score` + `submittedAt` — keyed by the derived publicId, no personal data.
- **The client IP the dedup hashes arrives in `VIEWER_IP_HEADER` (`shared/src/scores.ts`),
  stamped by a CloudFront viewer-request FUNCTION — corrected 2026-08-16, superseding
  "the origin-request policy forwards CloudFront's trusted viewer address".** That older
  rule cannot be implemented: a /scores POST needs two things at the origin and NO single
  header mode carries both.
  - The viewer's `x-amz-content-sha256` (OAC cannot sign a Lambda-URL POST without it) can
    never be named in an allow-list — CloudFront rejects the whole policy ("The parameter
    Headers contains x-amz-content-sha256 that is not allowed", verified against the live
    API) — so it only arrives via a mode that forwards viewer headers wholesale.
  - `CloudFront-Viewer-Address` is a GENERATED header, which AWS adds only for the
    allow-list and "all viewer headers + CloudFront headers" modes — never for `allExcept`,
    documented as "all other HTTP headers IN VIEWER REQUESTS". The "+ CloudFront headers"
    mode would carry both, but it also forwards the viewer Host, and Lambda validates the
    SigV4 signature against the Function URL's own domain — breaking the POST it enables.
  So the policy stays on `allExcept: Host` (AWS's Lambda-URL-safe mode) and the function
  supplies the address as an ordinary viewer header that mode already carries. It is
  unspoofable because the function OVERWRITES it from CloudFront's own read of the TCP
  peer. **Three packages agree on that ONE header name**, which is why it lives in
  `shared`: infra writes it, the backend reads it, and a drift is a 500 on every score
  POST that no local run and no synthesized template can reproduce.
- `/scores` has its OWN zero-TTL CloudFront behavior because the histogram is live; it must
  never inherit the puzzle's year-long `s-maxage`. Its query allowList is exactly the three
  parameters the handler reads (`lang`, `date`, `mode`), and its origin-request policy
  carries the viewer-supplied `x-amz-content-sha256` outside the cache key. Local
  `backend:dev` uses the same handler with an in-memory counter store and an explicitly
  local accept-all Turnstile verifier.

### Player profile (#188, decided 2026-08-18)

- **Non-unique display name + a 10×10 palette pixel avatar, hung off #187's identity.**
  The ONE handler serves `GET /profile?id=<publicId>` (the public row: name + avatar —
  what a board renders, and what a freshly linked device loads; 404 = never customized)
  and `POST /profile` with `{ secret, name, avatar }` — an authenticated upsert keyed by
  the DERIVED publicId, a separate write path from scores. The `/scores` behavior rules
  re-apply: zero-TTL CloudFront behavior, query allowList = exactly the ONE parameter the
  handler reads (`id`), `x-amz-content-sha256` over the exact body bytes on a production
  POST. No Turnstile and no IP dedup here — the secret is the auth, and an overwritten
  own-row is not an attack surface.
- **The avatar is TWO COLOURS — a background and a foreground, nothing else
  (user-decided 2026-08-19, superseding the 3-ink first cut), and its codec is a
  cross-package contract** (`shared/src/avatar.ts`): palette byte + 100 cells at 1
  bit/pixel = 14 bytes, base64url, exactly 19 chars, canonical-form-only decode.
  `AVATAR_PALETTES` is FIVE `{bg, fg}` pairs (append-only — the byte is an index),
  and **their colours are the USER'S OWN DRAWINGS: palette PNGs at the repo root**
  (decided 2026-08-19, closing several review rounds of hand-tuned duos) — 16×16
  tiles, each a 10×10 tree drawing whose SKY is the background and whose TREE is the
  foreground. The `AVATAR_PALETTES` array is the canonical record of those
  extractions (the PNGs are per-revision deliverables — the latest, `/palette.png`,
  redrew the last two duos), asserted verbatim by the palette pin test: to change a
  colour, draw and re-extract, never retune a hex freehand. **The picker swatch shows the GROUND (decided 2026-08-19, superseding the
  foreground swatches): you select a ground, and its ink comes with it — a swatch is
  always ONE colour, the palette IS the choice.** The web encodes and renders (SVG);
  the backend decodes to validate and moderate. **The web renders it as ONE TRACED
  UNION-OUTLINE PATH** (`web/src/components/avatarOutline.ts`, user-decided
  2026-08-19): a rect per cell antialiases a hairline seam where two of them meet, and
  the two cheaper answers — rect subpaths inside one `<path>`, and
  `shape-rendering="crispEdges"` — do not render the same on every browser, where an
  outline has no interior edges left to disagree about.
- **The display NAME's charset is a cross-package contract** (`shared/src/name.ts`,
  user-decided 2026-08-19: "the server should apply the same rules"): a name is
  **alphanumerics and underscores, case kept, at most 16 characters**, and everything
  else a player types becomes `_`. **ACCENTS are FOLDED, not underscored** — `Zoé` is
  `Zoe` and `Éléonore` is `Eleonore`, via the decompose-and-strip pipeline `fold()`
  already runs; the first cut mapped them to `_` with the punctuation, which spelled
  `Zo_` on the one language half this game is written for. The pipeline NORMALIZES
  (NFKD) before mapping, so NFC and NFD spellings of one name cannot store as two
  values, and it maps per CODE POINT, so one astral character costs one underscore
  rather than one per surrogate half. `sanitizeName` is IDEMPOTENT, which is what
  lets a valid name be defined as **one the sanitizer leaves alone** (`isValidName`) —
  one function owns the rule, with no second spelling of it to drift.
  The WEB sanitizes every value it writes (the initial read, keystrokes, a
  composition's commit, the save body); the BACKEND REFUSES a non-conforming name with
  the shape 400 rather than rewriting one nobody typed. The old server-side rule (trim,
  then a code-point cap and a control/format-character check) is subsumed and GONE:
  whitespace, punctuation and zero-width characters are all things the sanitizer would
  change. Empty stays valid — the avatar alone is a profile.
- **Moderation is best-effort ON WRITE, by decided stance:** a normalized banned-strings
  name filter (`backend/src/nameFilter.ts`, asked only whether a TERM is banned — the
  charset is the shared rule above, applied first) and an exhaustive swastika template
  match over rotations,
  reflections, scales, positions and polarity (`backend/src/avatarModeration.ts`) — each
  rejecting with its own error code (`name_rejected` / `avatar_rejected`). Symbolic by
  design: the real containment is the friends graph (#189).
- **The key backup affordance is DESIGNED but NOT SURFACED (user-decided 2026-08-19):**
  the copyable-key/paste-to-link UI was removed from the profile editor (web `/profile`
  route; #190 wires the editor into the leaderboard screen), and `adoptPlayerSecret`
  went with it (no consumer). The decided remedy for a lost identity is still a
  copyable-key backup that doubles as device linking — where that UI lives is an open
  decision, not this editor.

### Friends graph (#189, decided 2026-08-19)

- **MUTUAL edges from a ONE-CLICK invite link, and the graph is the leaderboard's TRUST
  BOUNDARY** (#190's default board). Global rankings are untrusted by design — the anti-cheat
  stance of #187 — so what a player is shown first is the people they chose. Mutual rather
  than follows: a group converges on identical lists with N link shares instead of N² and
  nobody is forgotten, with zero request/accept friction (the link holder consented by
  sharing it, the clicker by clicking).
- **The link is `<site>/i/<publicId>` — a plain SPA route, not an API one**
  (`web/src/langs.ts` `pathForInvite`, `web/src/screens/FriendInvite.tsx`): opening it records
  the edge with the CLICKER's key and continues into the game, so ONE link is both "add me"
  and "come play". A brand-new visitor's key is generated on that first need (#187), so the
  edge lands before their first game — this is also the invite funnel. The id is validated at
  PARSE, so a broken link is an unknown path rather than a request. **The RESULT share link
  (`/s/<token>`) is deliberately NOT the carrier:** it is CDN-cached for a year on a cache key
  of `lang`/`date`/`mode`, so an inviter parameter would either fragment that cache per player
  or — unlisted, with no origin request policy on that behavior — never reach the origin at all.
- **The graph is SERVER-side** precisely because the sender's device is not present at click
  time: only a stored edge lets one click benefit both sides. It follows the DERIVED publicId,
  so restoring a key restores the friends with it — nothing to migrate. (Its side benefit is
  the pre-launch analytics: edges plus score rows answer how many players arrive by invite,
  whether friended players retain better, and how big groups get.)
- **ONE route, POST-only: `POST /friends`** — `{secret}` reads your list, `{secret, add}` links,
  `{secret, remove}` unlinks, and EVERY call answers `{ friends: [publicId] }`, so a client is
  never left guessing what a write did. Every call is a POST because the secret is the auth and
  it travels in the BODY, never a query string (#187) — which is also why the READ is a POST:
  the server resolves YOUR edges, and there is no way to ask without proving who you are. The
  route reads NO query parameter, and its CloudFront behavior says exactly that with an EMPTY
  allow-list (the three-package contract above — the day it grows one, it has to be named there
  too). Zero-TTL behavior like `/scores`; a production POST needs `x-amz-content-sha256` over
  the exact body bytes.
- **Storage: one row per DIRECTION** — `friends#<publicId>` partition, sort key = the friend's
  id, `createdAt` kept from the FIRST link. Both rows are written, and both deleted, in ONE
  DynamoDB transaction, so a half-edge is unrepresentable. Removal is SYMMETRIC (no one-sided
  hide until someone actually asks for one) and idempotent.
  **Both rows are written on EVERY accepted link, a re-click included** — a store can read the
  caller's own partition but not the friend's, so "I already hold this edge" is no evidence the
  other half exists, and an early return on it would leave a missing half missing for good. The
  writes being unconditional (with `if_not_exists` on `createdAt`) is what lets the same call
  repair a pair from either side, and it is why the transaction needs no idempotency token.
- **The cap is `FRIENDS_MAX` = 200 per player, enforced on BOTH sides of a link.** The link is a
  bearer "add me" token, so someone who posts theirs publicly can be spam-added by strangers;
  removal covers the annoyance and the cap bounds both the griefing and the board read's size.
  No expiry/rotation machinery at this scale. It is COUNTED off the rows, never kept in a
  counter item: a second store answering the same question drifts (the histogram's rule), and a
  cap is a BOUND, not an invariant — simultaneous clicks may overshoot it by one, which costs
  nothing. A pair already linked is settled BEFORE the cap, so a full player can still re-open a
  link they already accepted.
- Self-add is refused (`self_link`): opening your own link is a mistaken click, not an edge.

### Leaderboard reads (#190, decided 2026-08-18)

- **ONE route `/board`, addressed per `(day, lang, mode)` like everything else** (the
  puzzle route's malformed-param 400s and future +1-day guard apply; no puzzle-store
  read — a population only exists for a published daily, so an unpublished day honestly
  answers the empty board). Two faces:
  - `GET /board?lang=&date=&mode=[&id=<publicId>]` — the **GLOBAL top 50, anonymous**
    (untrusted by design, #187: decorative, nothing treats it as truth). `id` is the
    caller's PUBLIC id — never the secret, so it may travel in the query — and widens
    the answer with a below-the-cut window. **Nothing BINDS `id` to the caller, and
    that is deliberate:** anyone holding a publicId can read that player's window
    (score, rank, profile) for any served day. publicIds are broadcast by design —
    an invite link IS one (#189) — and a stranger holding one can already reach the
    same scores by accepting that link, so the read adds no capability the graph did
    not. The TRUSTED surface is the POST.
  - `POST /board { secret }` (+ the same query) — the **FRIENDS board, the trusted
    surface**: the server resolves YOUR edges (#189) plus yourself, so the read proves
    who is asking — the secret in the BODY, the /friends rule. Production POST needs
    `x-amz-content-sha256` over the exact body bytes (the OAC contract). **A friend
    with no recorded score today is still named** (user-decided 2026-08-20): the
    response's `waiting` list carries them (profile-dressed, no score/rank; sorted by
    publicId; never the caller themselves, and always empty on the global board) and
    the web draws them under ONE "not played yet" section caption — an edge is a
    person the caller chose, never a row to silently drop.
- **The ranking rules are shared pure functions** (`shared/src/leaderboard.ts`,
  contract-tested): competition-style tie ranks (equal ranks, never a fake ordering —
  ties ordered by publicId only for deterministic ROW order), the PLAIN top-50 cut
  (user-decided 2026-08-20, superseding the issue's straddling-tie collapse: at most
  50 rows, a tie crossing the boundary shows its inside members as ordinary rows at
  the shared rank, nothing folded), and
  the own-row ±2 neighbor window (sent only when the caller's row is not
  visible in the cut, minus any row the cut already shows). The backend applies them and attaches
  each row's public profile (#188: `name` may be empty and `avatar` null — for a player
  who never customized one, AND for a profile row whose read FAILED, which dresses the
  same way rather than failing a board whose scores all answered; the client draws the
  ASSIGNED identity for both, a pseudonym + a generated mark derived from the publicId);
  the web renders what the API returned.
- **Zero-TTL CloudFront behavior with all FOUR query params in its allowList**
  (`lang`/`date`/`mode`/`id` — the same three-package contract as `/scores`: the day
  the handler reads a fifth, it has to be named in `infra/lib/backend-stack.ts` too).
- **The screen's entry is a header icon on the right of the game routes, reachable
  BEFORE playing** (the issue's decided entry point, superseding the earlier "enters
  from the solved screen's standing line" note recorded in the web AGENTS): the screen
  is also where a player customizes their profile (#188) and shares their invite link
  (#189), neither of which requires having played. The solved screen keeps its compact
  percentile — that stat never requires visiting this screen. The entry is on the
  ACTIVE day's routes only: a board is the active day's, so offering it from an
  archive replay would swap the day under the player and its exit would land them on
  today, ending the archive session.

---

## Testing

- **WRITE tests when a change touches a CONTRACT:** the slug/fold contract, the
  per-puzzle JSON schema, scoring / score-accumulation logic, rank/collision logic,
  `reduce_embedding` filtering, or date/`dayNumber` routing. Assert against the SPEC in
  this file, **not** the implementation — a test that just mirrors the code proves nothing.
- **DON'T add tests for cosmetic/visual work** (layout, animation feel, styling, copy),
  trivial wiring, or config. Coverage for its own sake is discouraged.
- **A failing invariant test is a real regression — fix the CODE, never weaken the test**
  to make it pass.
- **Run `pnpm test` before a contract-touching task is done.** It runs Vitest (TS:
  `packages/shared`, `packages/web`, `packages/backend`, `packages/infra`) and pytest
  (`packages/generation`, `packages/benchmark`). The slug/fold
  case table is **one shared fixture** (`packages/shared/fixtures/slug-cases.json`)
  consumed by BOTH languages — add a case there, never on one side only.

## Working an issue

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

---

## Do NOT (repo-wide)

- **Don't fold/slug a displayed form, and don't display a slug.**
- **Don't let `slug()` and `fold()` diverge.**
- **Don't lemma-merge anywhere except `gen_phrase`'s merge walk (#104)** — the front
  and the benchmark harness only LOOK UP alias keys, never re-group; and **don't
  silently skip a missing lemma table** — error out (`--no-lemmas` to opt out
  explicitly).

Each package `AGENTS.md` carries its own Do-NOT list for rules scoped to it.

---

## Commands

Uses **pnpm** (workspaces in `pnpm-workspace.yaml`, version pinned via the root
`packageManager` field). Each root script runs from the repo **root** (it delegates to
the right workspace via `pnpm --filter`) or from inside the package directly. Unlike
`npm`, **pnpm forwards args straight to the script — do NOT add a `--` separator** (a
literal `--` is passed through and breaks `gen_phrase.py`'s arg parsing).

```bash
pnpm install     # installs all workspaces
pnpm test        # invariant tests: Vitest (web + shared + backend + infra) + pytest (generation + benchmark)
pnpm typecheck   # tsc --noEmit
```

Domain commands — wordlist/reduce/gen (generation), bench (benchmark),
publish/inventory/backend:dev (backend), dev/build (web), cdk synth/diff/deploy
(infra) — are documented in the owning package's `AGENTS.md`.

---

## Current state / mutable

*(Safe to update without touching the invariants above.)*

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
  single source of truth; receives the **required public** `VITE_TURNSTILE_SITE_KEY` repo
  variable, with `vite.config.ts` rejecting any production build that would silently ship
  score collection disabled; and receives the optional `VITE_PLAUSIBLE_DOMAIN` analytics
  repo variable, #60)
  before `cdk deploy WhippinWebStack`. `workflow_dispatch`
  `stacks` input forces
  `changed`|`web`|`backend`|`all` (default `changed`).
  **The backend deploy INVALIDATES `/*` on the API distribution after `cdk deploy`**
  (decided 2026-07-26): puzzle responses carry a year-long `s-maxage`, so shipping the
  Lambda alone leaves every already-cached `(date, lang, Accept-Encoding)` entry answering
  from the edge with the OLD body — a response-changing deploy would reach nobody who had
  already loaded that day. This also covers `/og` and `/s`, so a card-render change no
  longer needs the by-hand invalidation that used to be required. It needs
  `cloudfront:CreateInvalidation` on the deploy role (`deploy-role-stack.ts`); that stack is
  human-deployed by design, so an `AccessDenied` there means running
  `pnpm --filter @whippin/infra deploy:auth` once and re-running the job (the Lambda has
  already deployed at that point — only the purge is missing). Web deploys already
  invalidate via `BucketDeployment`.
  - **Keep the pipeline in sync with the architecture.** `ci.yml` is self-maintaining
    (`pnpm -r --if-present` fans out to every workspace's `test`/`typecheck`), but
    `deploy.yml` is **hardcoded** and does NOT auto-cover changes. When you **add/rename
    a package** or **add/change a CDK stack** (`packages/infra/bin/app.ts`), update
    `deploy.yml` to match: the `dorny/paths-filter` mapping (which package paths trigger
    which stack — remember `shared`-like libs consumed by a stack must fan out to it),
    the per-stack deploy jobs, and the `workflow_dispatch` `stacks` options. A new
    deployable stack with no job/filter entry will silently never deploy.

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

*(Resolved 2026-08-12: former discrepancies #1-#3 — the 2:00 timer prose, the README's
2-word `gen:phrase` example, and the stale `.codex/skills/whippin-game`. The skill was
DELETED (it targeted a design three schemas ago); the other two had already been fixed in
the files themselves, leaving only these notes to retire. Sentence mode still has no
timer; Word mode's clock (#163) is its own rule, not this one.)*

*(Resolved 2026-08-12: former discrepancy #4 — a sentence puzzle's `road` fields with no
consumer anywhere. The user decided to remove the clustering and the web's lane drawing
together; `dq` stays, since the history line is spaced by it. See the schema bullet above.)*

*(Resolved 2026-08-11: former discrepancy #5 — the tutorial teaching THEMES/routes the
game no longer draws. The user re-arced the onboarding: the tutorial now teaches only
the modes' shared core concepts (semantic distance, word rarity), and each mode's own
rules moved onto that mode's pre-game gate.)*
