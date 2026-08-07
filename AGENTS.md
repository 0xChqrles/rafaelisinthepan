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
  benchmark/    offline LLM puzzle benchmark harness (#68).
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
    "foret": {                                  //   dq/road: OPTIONAL to consumers (#115)
      "<input-slug>": { "word": "<accented>", "rank": 12, "dq": 231, "road": 1 }, ...
    }
  },
  "source": {                                   // OPTIONAL origin metadata (#5); ACCENTS KEPT
    "kind": "book",                             //   book | movie | music | quote | poem | … (open set)
    "author": "Victor Hugo",
    "work": "Les Misérables"
  },
  "benchmark": [                                // OPTIONAL recorded models (#68/#80/#81);
                                                 //   VARIABLE length; front end filters display
    { "model": "claude-fable-5", "label": "CLAUDE FABLE", "tag": "FABLE",
      "tries": 3, "run": ["bois", "arbre", "forêt"] },
    { "model": "k3", "label": "KIMI K3", "tag": "KIMI",
      "tries": 4, "run": ["nature", "bois", "arbre", "forêt"] },
    { "model": "gpt-5.6-sol", "label": "GPT-5.6", "tag": "GPT",
      "tries": null, "run": ["bois", "arbre", /* …full run through cap… */ "nature"] }
    // may also carry lab-only models (OPUS/SONNET/TERRA/…); the client renders only display
  ]                                              // null tries = DNF; its full run is kept
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
- **`benchmark` is fully OPTIONAL (#68, decided 2026-07-07; schema v2 decided
  2026-07-12 on #68; VARIABLE-LENGTH recorded-set + client-side display filter decided
  2026-07-20 on #81):** when
  present, it is a **variable-length array of EVERY model tested with `--in-place`** (not a
  fixed trio) — **unique `model` id and unique `tag` per entry**, and at least one entry.
  **The display filter lives in the FRONT END, not the schema:** the client renders only its
  fixed display trio — **FABLE (`claude-fable-5`), KIMI K3 (`k3`), and GPT-5.6 Sol
  (`gpt-5.6-sol`)** (decided 2026-07-22, superseding the original Opus/Sonnet/GPT trio) —
  and silently ignores any other recorded (lab-only) model, showing
  whichever **subset** of the three is present (see the `web/src/game/benchmark.ts`
  `DISPLAY_MODEL_IDS` canonical order → stable sprite). Every entry requires the exact
  non-empty `model` id, an honest uppercase full-family `label` (`CLAUDE FABLE`, `KIMI K3`,
  `GPT-5.6` — never ambiguous `CLAUDE`), an uppercase pixel-friendly `tag` of at most 6
  characters (`FABLE`/`KIMI`/`GPT`), `tries` as a positive integer or `null` (DNF at the
  counted-try cap), and `run` as the **selected run's counted display-form guesses in
  submission order**. **`--in-place` upserts one model at a time** (a re-run replaces that
  model's entry; a previously embedded entry that no longer replays the current
  sentence/ranks is pruned) and accepts **only** the canonical config: **median selection,
  persistent session, the current prompt version, and at least `MIN_IN_PLACE_RUNS` (3)
  odd runs** (`--runs` has ONE uniform default of 3 for every model, so omitting it already satisfies
  the gate — Kimi included; there is no per-provider run-count default). Both `--in-place`
  writes — the lab artifact and the puzzle's benchmark array — take an **exclusive advisory
  lock around the whole read-modify-write cycle**, so two overlapping runs accumulate
  instead of the second silently dropping the first's record. `--selection median`
  (default) keeps odd `N` runs sequential/cache-warm and reports the same actual median
  score as full median-of-N (#95). With `k = (N + 1) / 2`, once `k` runs have solved, a
  later run still unsolved at the k-th-smallest solved score stops as lab-only
  `termination="upper_half"`, unless that score is the real cap — then it remains a genuine
  `termination="cap"` DNF; once `N - k + 1` runs are genuine cap DNFs, remaining runs make
  no provider calls and record lab-only `termination="dnf_majority"`. `N = 1` never prunes.
  `--selection best` selects the lowest successful score. Run words retain accents
  exactly as typed/validated and are folded only when replayed; a selected DNF keeps its
  full cap-length run. Cost-pruned attempts (`upper_half`, `dnf_majority`, or best-mode
  `cannot_beat_best`) can never be embedded as DNFs or scores; the selected representative
  remains a genuine solved/cap run. The client can replay this list against the puzzle rank
  maps; play scoring and share output stay unchanged. This model-score anchor superseded
  #57's proposed `par` before `par` was implemented — there is no `par` schema field.
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
- **Every ranked group also carries its real geometry (`dq`, `road`) — #115, decided
  2026-07-25.** Ranks are dense and uniformly spaced by construction, so they erase the
  neighborhood's clumps and cliffs; cosine distance is only available at GENERATION time
  (the client never sees vectors), so generation ships it:
  - **`dq` — the quantized distance to the secret, one byte, per hole.** With `s1` = the
    rank-1 group's similarity and `smin` = the LAST kept group's,
    `dq = round(255 * (s − smin) / (s1 − smin))` → **rank 1 = 255, the farthest kept
    group = 0**, non-increasing in between. The **per-hole affine normalization is
    lossless for consumers**: what they compute are RATIOS of similarity DIFFERENCES,
    which an affine map preserves exactly, so the journey ratio is
    `(dq − dq_start) / (255 − dq_start)` with no floats shipped. Present on **every rank
    ≥ 1 entry** of a newly generated puzzle; **the secret's own entry (rank 0) carries
    NONE** — the terminus is off-scale by nature. A flat span (`s1 == smin`) is a **hard
    error**, never silent all-zero `dq`.
  - **`road` — which cluster of the TRAVELLED neighborhood the group sits in.** The zone
    is the groups **from the hole's start word IN to the secret** — ranks
    `1 .. start_rank`, **the departure included** (decided 2026-07-26, superseding the
    flat top-150 zone): the line is a journey and it begins where the puzzle put the
    player down — **ON one of the roads**, so the start word carries one too and the fork
    lands just before it — while a fork farther out than the departure is a fork of a
    route nobody walks. Because the zone is the departure's rank, **`road` is per-HOLE
    data, not a property of the secret's neighborhood alone**, and it cannot be stamped
    until the start word is chosen (`distances.road_zone`,
    `gen_phrase.annotate_roads`).
    `ROAD_TOP` survives only as the **ceiling** on that zone — the start band tops
    out at 150, well below its value, so it bites only on a start hand-picked outside the
    band, where it keeps the clustering (and the shipped fields) bounded. **What SETS that
    value is Word mode, not this path** (see the single-word artifact schema below): it is
    the word game's range, raised 150 → 250 on 2026-08-07, which changes nothing for a
    sentence hole other than how far a hand-picked far start may road. Deterministic average-linkage
    agglomerative clustering over cosine distance, `k ∈ ROAD_KS` (`{2..6}` since
    2026-08-07), **falling back to ONE road (all `road: 0`) below `ROAD_MIN_SILHOUETTE`** —
    mandatory, because some neighborhoods genuinely have a single facet. Roads are numbered by
    their **closest member's rank**, so the road holding rank 1 is `road: 0`. `--no-roads`
    skips them; **`dq` has no opt-out** — it is part of the schema.
    **Two rules decide WHICH split ships (both decided 2026-08-07, when the wider zone broke
    the old one):**
    - **A road must hold at least `ROAD_MIN_FRACTION` (4%) of the zone.** A smaller cluster is
      an outlier, not a route, and a lane drawn for it advertises a whole road nobody can
      walk. Undersized clusters are **folded into their nearest neighbour** — never dropped,
      every group still gets a road — **before the silhouette is read**, which is what removes
      the metric's incentive to isolate one. A FRACTION, not a count, because the zone is
      `ROAD_TOP` for a word artifact but the DEPARTURE's rank for a sentence hole.
    - **Mean silhouette is the HONESTY GATE, not the ranking: among the splits that clear it,
      the one with the MOST roads wins** (ties → the smaller `k`). Ranking by silhouette does
      not survive a zone this wide — measured over nine real neighborhoods at 250, the top
      score went to `k=2` on eight, and seven of those were one trunk plus a 1–3 word
      straggler. "Several roads lead to the word" is the product claim, so a 2-way cut of 250
      groups says less than the 4-way one beside it at a marginally lower score.
    **`ROAD_KS`'s ceiling is also a FRONT-END commitment:** it caps the road count, so the web
    must be able to paint that many lanes (`LANE_COLORS`, pinned to it by `laneColors.test.ts`
    — widen one without the other and two roads render in the same colour).
  - Both are **GROUP properties**, like `word`/`rank`: every alias key of a lemma group
    carries its group's values, and slug-collision resolution keeps the winning (closest)
    group's. Both are **OPTIONAL to every consumer** (a `--no-roads` puzzle legitimately
    ships no `road`).
- **Slug collisions** (`côté`/`coté` → `cote`): keep the **smallest-rank** entry
  (built closest-first) and display its `word`. Resolved **silently** — generation
  prints no collision output.
- **The `source` schema has no `context`/passage field (removed 2026-07-05).** `build_source`
  takes only `kind`/`author`/`work`; there is no `--context` flag or prompt, `Source` in
  `shared/src/types.ts` carries no `context`, and `SolvedCaption` renders only the kind tag +
  attribution.

### Single-word artifact schema (#154, decided 2026-08-03)

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
    "<input-slug>": { "word": "<accented>", "rank": 12, "dq": 231, "road": 1 }, ...
  }
}
```

- **The inner rank-map semantics are the sentence schema's, UNCHANGED** — same merge
  walk and group semantics (#104/#134/#146), same #133 explicit-form confirmation, same
  donor vectors (#119), same `TOP_K` group cap, same `dq`, same slug-collision rule:
  alias keys per group, `word`/`rank`/`dq`/`road` are GROUP properties, rank 0 is the
  word itself and carries **no `dq`**, every rank ≥ 1 entry carries one. Both commands
  run the **one shared per-secret pipeline** (`gen_phrase.walk_secret`), so a word's
  neighborhood can never differ by which game asked for it.
- **`ranks` is ONE FLAT map** (there is only one word to rank around, so nothing to key
  it by), and there is no `words` / `holes` / `start` / `start_rank`. **No `source`
  either:** attribution belongs to a quoted line, and a lone word quotes nobody.
- **`road` covers the FLAT top-`ROAD_TOP` (250 since 2026-08-07, was 150).** With no start
  word there is no
  departure to cut the zone at, so `ROAD_TOP` stops being merely the CEILING on a hole's
  journey and becomes the zone itself — those groups are Word mode's playing field
  (`distances.road_zone(None)`). This is the ONE deliberate difference from a sentence
  hole's `start_rank`-sized zone. `--no-roads` still opts out; `dq` still cannot.
  **Therefore `ROAD_TOP` is Word mode's RANGE, and the web's `CLAIM_ZONE`
  (`web/src/game/wordGame.ts`) is that same number restated in TypeScript** — the field the
  board draws is exactly the set that carries a road, so the two move TOGETHER or the board
  grows lane-less stations (or refuses to claim ones it drew). `wordGame.test.ts` pins the
  client constant to this file's literal; retuning the range means editing both, and
  **regenerating every word artifact** — one produced at an older ceiling carries roads only
  that far.

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
  `packages/shared`, `packages/web`) and pytest (`packages/generation`,
  `packages/benchmark`). The slug/fold
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
pnpm test        # invariant tests: Vitest (web + shared + backend) + pytest (generation + benchmark)
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
  single source of truth; only the optional `VITE_PLAUSIBLE_DOMAIN` analytics var is passed
  via a repo variable, #60) before `cdk deploy WhippinWebStack`. `workflow_dispatch`
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
