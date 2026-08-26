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

### Vocab metadata: what the existence set IS (#200, decided 2026-08-21)

- **Generation states what each language's existence set is, into
  `packages/shared/src/vocab.generated.json`, and the BACKEND reads it there.** The set
  itself (`web/public/vocab/<lang>.json`) is a ~1.6 MB web asset the SPA fetches; the
  server never loads it, but it must bound things by it. Per language: **`vocabSize`**
  (distinct slugs — a sentence score counts distinct vocabulary-valid tries, so this is
  that score's ceiling), **`maxSlugLength`** (the longest key), and the corpus build that
  produced it, **`embedding` + `builtAt`**.
  **`vocabSize` has two readers** — the live routes' sentence ceiling and, by its
  key set, what counts as a supported `lang`. **`maxSlugLength` caps a STORED GUESS
  (#201, decided 2026-08-21):** the `/round` append validates every guess against the
  language's value — a string longer than anything the vocabulary ever held is refused
  before the store is touched.
- **It is GENERATED, never hand-written**, and by the very call that writes the set
  (`slug.write_vocab`, from the same slugs), so the two describe one vocabulary by
  construction — every command that can refresh the set (`reduce`, `gen:phrase`,
  `vocab:<lang>`) refreshes the record with it. A constant pinned by a test would also
  catch drift, but only by asking a human to read a failure and copy a number across;
  until they do, the server enforces a bound the game no longer has.
- **It lives in `packages/shared/` for the DEPLOY mapping:** `deploy.yml`'s paths-filter
  already fans `shared` out to both stacks, so a regenerated vocabulary carries its new
  numbers into the backend through a mapping that exists. Anywhere else and the backend
  keeps a stale value with no signal — the failure the CI/CD note at the end of this file
  warns about.
- **`embedding` names the CORPUS BUILD, not a file** (`corpus_name`: basename, no
  extension, no `_reduced` suffix), so the raw source `reduce` streamed and the reduced
  file the neighbor modules load answer the same name — the record cannot depend on which
  command last ran. **`builtAt` (UTC) dates the corpus build, not the run:** an unchanged
  rebuild keeps the recorded date, so re-running the pipeline over the same corpus leaves
  the committed file byte-identical instead of dirtying every puzzle commit. Recording
  which corpus is live is worth a field because so much of the design is calibrated
  against corpus properties (Word mode's rarity cuts, the measured en-vs-fr gap).
- The web imports it through `shared/src/vocab.ts` (`VOCAB_BUILDS`) like any other shared
  module, but has no reason to read it: it holds the actual set.

### Round guess-log sync (#201, decided 2026-08-21)

- **The server owns game state from the first guess, whether or not an account is ever
  linked.** Local state is a working copy and a write buffer, never the authority — and
  since #214 it is ONLY the write buffer: the persisted sentence round became an OUTBOX of
  unacknowledged guesses, and the board is a projection of (server log + outbox). See the
  #214 section below for the model this bullet's rules now operate inside. —
  authoritative-only-after-link was rejected: scores and friend edges are already
  server-side for unlinked players (#169/#187/#189), so gating the guess log on linking
  would be the odd one out (and would break #206's live friends board). The payoff:
  **there is no migration, ever** — a first account link binds to an account the server
  already holds in full.
- **ONE route, POST-only like /friends** (the auth travels in the BODY — the player secret
  when this was written, the DEVICE TOKEN since #216):
  `POST /round?lang=&date=&mode=` — `{token, puzzle}` reads the caller's stored
  round for that daily (404 = none yet), `{token, puzzle, guesses: [...]}` appends to its
  log. **Every answer carries the full stored state** (`{guesses, createdAt}`) — the
  /friends house style, and **that includes BOTH refusals** — so a write is also a
  reconciliation: the tab computes against stale local state, the server appends to the
  true log and answers with truth, and the tab re-renders correct. It is always the state
  of the PUZZLE ASKED ABOUT: a record naming a different one answers EMPTY, never its own
  log. The client adopts every answer as this round's truth, so a refusal carrying the
  retired sentence's guesses would walk them straight back into the corrected puzzle —
  the tag's whole purpose, undone through the one door left open. (It is also what pays
  for the extra consistent read a refusal costs the store: without a body, that read
  exists only to choose between two status codes, and a client refused mid-sync stays
  stale until its next accepted write.) No sockets, no SSE: an open tab reconciles on its
  own next write. The day-addressed guard triple applies. **Archive days sync exactly like
  today's**, which is what makes a player's full history follow them to a new device.
  *(This bullet said "there is NO puzzle-store read" until #203, which OVERTURNED it: an
  APPEND now reads the day's derivation slice, and a solve the full artifact. The READ
  still reads no store — see the #203 section below.)*
- **The server stores strings, and interpreted nothing until #203.** Guesses are the folded
  forms typed, in order — never indices (an index doesn't fit fr's ~128k vocab in `uint16`,
  misses have no rank-map index at all, and it would bind stored history to a regenerable
  artifact). Validation asks the CONTRACT rather than restating it: a guess
  is one `fold()` leaves alone, at most the language's `maxSlugLength` (#200) — never a
  third regex spelling of slug()/fold(), free to drift from the two that matter.
  *(What #203 changed: the server now READS that log — `guessKey`, the progress formula and
  the score all run server-side. What it still does not do is interpret it on the WAY IN:
  the stored form is unchanged, the client still interprets it for display, and every
  derivation is a pure read of strings the store never inspects.)*
- **The record NAMES ITS PUZZLE (`puzzle`), and a different published revision restarts
  it.** A round key is only (date, lang, mode), so re-publishing keeps the key while the
  puzzle may change. Without the revision the mount read hands the RETIRED puzzle's log
  straight back and undoes the client's reset FOR GOOD: the player plays the correction
  with the old version's words in their history, ruler, share card and score. So a read for
  a different revision is an honest "nothing stored for this one" (404), and an append
  carrying one REPLACES the log rather than growing it. For sentence mode the value is the
  content-derived `revision` stamped by `puzzle:publish` on the full puzzle and its slice;
  it covers the rank maps as well as the sentence, while an identical republish keeps the
  same value. The client forwards it and the server only compares it for equality, which is
  the same "stores strings, interprets nothing" rule the log follows. A pre-revision local
  round is DROPPED, at the persist migration (v13) rather than lazily on mount: it cannot say
  which version it was played against, and matching holes prove nothing about the maps, since
  rank 0 is a GROUP and a correction moves aliases without touching a hole. Adopting one was
  built first and removed as the compatibility layer it is (the standing no-back-compat rule,
  the v7/v11 precedent); every surviving round therefore carries a revision by construction
  and no read path branches on a missing one. Solved days and the streak survive, as they did
  at v7 and v11.
- **The two bounds are cross-package constants** (`shared/src/scores.ts`, the
  `WORD_CLAIM_ZONE` rule): **`ROUND_GUESS_CAP` = 500 guesses per round**, enforced inside
  the append write's own condition (the RESULT may reach the cap, never pass it, so it
  cannot be raced — written as ROOM, `size(log) <= cap - batch`, because DynamoDB's
  condition grammar has no arithmetic and no `if_not_exists`; naming either there is a
  ValidationException on every append, which no mocked client and no memory store can
  reproduce), and **`ROUND_WRITE_MIN_MS` = ~1s between writes per player PER DAILY**
  (corrected 2026-08-21: this said "per player", which the implementation has never been
  — `lastWriteAt` lives on the round item, so one player writing to two dailies at the
  same instant is accepted twice) — one spelling for both the server's rate condition and
  the web's flush pacing, since two independent ones would drift into permanent 429s.
  **The web paces from the previous write's ANSWER, not from its send**, which is what
  makes one constant sufficient: the server compares its OWN receipt instants with a
  strict `<`, so pacing from the send instant leaves the accepted gap at
  `interval + (latency_n − latency_{n−1})` and refuses every request that travels faster
  than its predecessor.
  **Per DAILY is the granularity the bound should have**, which is why the wording moved
  rather than the code. The client paces per ROUND — one flight per round key, each
  timing its own last answer — so a global per-player throttle would make two
  concurrently syncing rounds (an archive day left mid-play, and today's) refuse each
  other about half the time: the two ends measuring different things, which is the exact
  failure one shared constant exists to prevent. It would also cost a second item and a
  transaction on the game's hottest write path, to buy a bound an attacker walks around
  by minting another identity (this route has no Turnstile — see the open question in the
  route's own notes). What a per-daily interval does NOT bound is one identity fanning
  writes across many dates; that is the same unmetered-route question, not this constant's
  job.
- **At the cap the server refuses further appends** (409 `round_full`, logged for review
  — a real player reaching 500 means an unreachable secret, puzzle-curation signal
  available no other way), and **no leaderboard entry exists for that round**.
  *(Two halves of this bullet were OVERTURNED by #214, below: the client does NOT keep
  playing locally — an unsolved round at the cap ENDS, at `∞` — and nothing is "marked
  capped", since the state is DERIVED from the authoritative log the answer carried. The
  bullet's remaining rules — how the batch is sized, why a 409 refuses the BATCH and only
  its carried log says whether it refuses the ROUND, and the curation line — all stand.)*
  The web closes its sync conversation there. There is no client score submission since #203: a capped
  round never acquires the server `solved` fact that launches the population read.
  A row the server already demonstrably recorded remains readable; a local reading must not
  hide what the population itself answered. The cap is also read on the CLIENT side of the
  conversation: the batch is clamped to what still fits, and a round already at the
  cap says so locally instead of spending a doomed request — an over-cap batch takes a
  400, which is not the 409 the engine handles, so it would be re-sent forever while the
  round never reached the capped state at all. **What still fits is measured against the RAW
  stored count, never the merged one** — the two differ whenever the merge collapses two
  devices' guesses into one identity (#104), and the cap counts what is STORED.
  **And a 409 refuses the BATCH: only the log it CARRIES says whether it refuses the
  ROUND.** A batch sized correctly when it was built still overshoots if another device
  under the same key pushed the stored log forward meanwhile — there the round has room
  and simply needs a smaller batch, so the client caps only when the adopted log is really
  at the cap, and the server writes its curation line only then too (a racing second
  device must not be able to manufacture "unreachable secret" signal, and concluding
  "capped" from the status alone would suppress the leaderboard entry of a round that was
  never full — the harshest consequence this design has). *(#214: the capped state is
  re-derived on every mount from the log the READ carries, which is what it used to check a
  persisted flag for — a settled round is never re-opened for a guaranteed 409 and another
  curation line that is reload noise rather than a player hitting the cap.)* A faster write is 429
  `too_fast` (+`Retry-After: 1`, which CORS must EXPOSE or a browser reads null); nothing
  is ever partially appended.
- **The guess is still judged locally and instantly** — a submit must never round-trip
  before the board reacts (Word mode cannot survive the latency; the same reasoning that
  split `useCountdown` from `useDeadlinePassed`). Guess lands → board reacts → POST goes
  out → response reconciles. Failed or slow writes queue and flush with capped backoff;
  durability lives in the persisted OUTBOX (#214), not the queue, so a killed tab catches up
  on its next visit's read. **A write whose outcome is UNKNOWN (a transport error, a 5xx,
  an unparseable body) re-READS before writing again** rather than re-sending: appends are
  at-least-once, so a response lost after the write committed would `list_append` the
  same guesses twice, burning the cap on a duplicate the client's own dedup then hides —
  and an honest player 409'd well under 500 real tries loses the day's leaderboard entry
  while the cap log gains a false curation signal. **A 4xx is a VERDICT, not a hiccup**,
  and closes the conversation: a request this client keeps getting wrong would otherwise
  spin one request every 30 seconds for the tab's life, and on the READ it stalls every
  append behind it, so the guesses reach the server on no visit ever.
- **A solve the SYNC adopts is not a fresh solve.** The server's log can finish the board
  under a screen that is merely watching (a second tab, or another device under the same
  player key), and the solved beats — the `solve` analytics event, the streak, the
  celebration — belong to the play transition alone. `Game` claims them at submit time,
  where it knows the guess closed every hole; `solved` flipping is no longer evidence.
- **A republish resets the round, not its solved-day credit** (user-decided 2026-08-22).
  A broken puzzle is the publisher's error and the streak rewards showing up, so a player
  who solved the retired revision keeps that day. Solving the corrected revision cannot
  claim the day twice: `recordSolve` remains set-like and declines a day already held.
- **Three packages agree on the query allowList** (the standing contract): the round
  CloudFront behavior forwards exactly `lang`/`date`/`mode`
  (`infra/lib/backend-stack.ts`) over the shared zero-TTL/allExcept-Host live shape.
  **Storage is the score table, partitioned per PLAYER** (corrected 2026-08-21, superseding
  the day partition this issue first sketched): partition `round#<publicId>`, sort key
  `<lang>#<mode>#<date>` (REORDERED by #203 from `<date>#<lang>#<mode>` — see its section),
  attributes `guesses` (string list), `puzzle`, `createdAt`,
  `lastWriteAt` — still one item per `(date, lang, mode, publicId)`. A DynamoDB list has
  no partial update, so `list_append` rewrites the whole growing item and a long round's
  writes get progressively more expensive; under a DAY partition every player's writes for
  one daily land on ONE partition key, which adaptive capacity cannot split and a throttle
  there degrades the sync for everyone playing that day. Nothing reads across players
  anyway — /board resolves the caller's friends into exact row keys and fetches those
  (BatchGetItem), the shape a future progress read (#206) takes too.
- **Scope:** sentence mode streams (coalesced writes). Word mode's two-write shape is
  #202, below; the client-claimed score POST was retired for server-derived scores by
  #203, below.
  `RoundSyncContext.mode` stays TYPED `'sentence'` — the route, the URL and the stored item
  are all mode-generic, but the two CONVERSATIONS are not, so Word mode got its own engine
  rather than a widened one (see #202's own note).

### Word mode's round start and end-of-run submission (#202, decided 2026-08-21)

- **Word mode writes TWICE, where sentence mode streams.** The intuition says the opposite
  — fast game, urgent sync — but the fast game benefits LEAST: what syncing buys is the
  live friends board (#206), and that only pays off in sentence mode, where a round sits
  open for hours; a 60-second run is over before anyone opens the board. Write counts are
  roughly a wash between the modes, so VALUE decides the shape, not cost. Both writes land
  on the SAME `/round` record (`mode=word`) — never a separate short-lived item, since the
  submission can arrive hours later on the revisit that finds the run over.
  - **START — a Turnstile-gated write stamping `startedAt` from the SERVER's clock.**
    Server-stamped **not for cheat prevention** (the day's `word.json` is public and anyone
    determined can type its words) but because the wait check below needs an anchor the
    client cannot move: a client-supplied start is simply backdated and the bound
    evaporates. **The client shows "loading…" and starts the visible clock only when the
    reply lands** — starting optimistically on tap means the server stamps `startedAt` an
    RTT LATER and therefore sees LESS elapsed time than the client, so a legitimate run
    submitting right at its deadline is rejected, intermittently, on slow connections only,
    and miserable to diagnose. It also fixes cross-device one-shot: without a server-side
    start, closing the tab mid-run and opening another device shows no round for today and
    begins a fresh one. The write is IDEMPOTENT per puzzle (a second tap, a retry and a
    second device all resume the ONE clock); a record naming a RETIRED word restarts,
    taking its log with it. *(AMENDED by #217, below: the start is no longer idempotent —
    it stamps a fresh clock FOR THE CALLING DEVICE and wipes any run that is not yet
    RECORDED, so the cross-device benefit named here became cross-device RESTART. The
    server-stamped clock and the reason for it are unchanged.)*
  - **SUBMIT — ONE post carrying the whole log**, first-write-wins like a score row (the
    daily is one-shot and cannot be replayed, so a repeat is answered 200 with the log that
    WAS recorded, which is what makes a retry after a lost response safe).
- **The WAIT CHECK: refuse until `now − startedAt ≥ START_SECONDS + MIN_BONUS × claims`.**
  It **can never block honest play**: Word mode has no early finish — the run ends when
  `now > deadline`, and `deadline = startedAt + START_SECONDS + Σbonuses` with every bonus
  ≥ MIN_BONUS — so a run with N claims always takes at least that long. **The check IS the
  game's own floor**, which is why it needs no tuning of its own as the ladder moves, and
  why `WORD_START_SECONDS` / `WORD_MIN_BONUS_SECONDS` are cross-package constants
  (`shared/src/scores.ts`, `wordRunMs`/`wordRunFloorMs`): the ladder AUTHORS its cheapest
  rung from the floor constant rather than restating it, and `wordGame.test.ts` pins that
  no rung pays less. A maxed 1000-claim round therefore cannot be submitted for just over
  67 minutes. Retuning the clock now moves `shared` and deploys the backend with it —
  exactly like `WORD_CLAIM_ZONE`.
- **Every answer carries the server's own `now` beside `startedAt`, and the client anchors
  an ELAPSED SPAN, never an instant.** It holds `Date.now() − (now − startedAt)`, so a
  device whose clock is minutes off still runs a 60-second run, and the request's own
  travel time lands INSIDE the run — the margin that keeps an honest submission clear of
  the wait check. The MOUNT READ applies the same rule, which is what resumes a run started
  elsewhere.
- **Caps: `WORD_CLAIM_ZONE` claims + `WORD_MISS_CAP` (500) misses**, about 40 KB. The
  client truncates its own log to them (only misses can run away — a group can be claimed
  once); the server refuses an over-cap one anyway, since a malicious client will not
  truncate. **Claims are validated against the day's ARTIFACT** — in its rank map, inside
  `WORD_CLAIM_ZONE`, and at most as many as the board actually holds (the same ceiling
  /scores validates a Word score against), counted by DISTINCT rank because aliases share
  a group's. This is the ONE round path that reads a puzzle store; a missing artifact is
  the day-addressed 404. **The TIMING is deliberately not validated**: without per-guess
  arrival stamps there is no way to know 200 claims were not typed over an hour — sentence
  mode is equally unverifiable, and the stance is that cheating does not matter.
- **The WEB keeps its own conversation** (`web/state/wordRoundSync.ts`), rather than the
  widened `roundSync` this issue first sketched: the two shapes share only the transport.
  Word's has three messages instead of two, its START is an ACT whose answer the gate waits
  on, and nothing about it coalesces or paces. A superseded-answer guard, the module-level
  flight map and the capped backoff are the sentence engine's, restated where they genuinely
  apply. **A `too_early` refusal is WAITED OUT** (it is an answer about WHEN, and a clock
  disagreeing by a second can hit it); every other 4xx is a VERDICT that closes the
  conversation.
- **AMENDED by #214 on 2026-08-23: a recorded Word log settles every local run, not only
  an empty one.** The server log is published transiently for the post-mortem; it is never
  copied into persisted `tried`, which is only the acknowledged submission outbox and is
  cleared. Settlement marks the run submitted, caches the authoritative claim count within
  `WORD_CLAIM_ZONE`, and sets every non-null deadline to `min(localDeadline, now)`. That
  immediately ends a still-live prompt without ever reopening an already-finished run. A
  finished day's recorded log therefore follows a new device through the transient mount
  answer; its server deadline is deliberately not adopted into local storage.
- **RETIRED by #217 (below): "a device only WRITES the run it PLAYED", the `resumed` flag,
  the session-scoped `mayWrite`/`startedHere` authority and the per-(round, word)
  qualification of it.** All of it was a workaround for a start stamp that said only THAT a
  clock was running, never WHOSE: a joining device anchored that clock with an empty log,
  died at the bare `START_SECONDS` and would have buried a real run under a first-write-wins
  empty one. The stamp names its device now, so the client asks instead of inferring. What
  survives from that reasoning, because it is what made the whole hazard real: **a joiner's
  clock cannot be priced** — the bonuses live in the playing device's own log until it
  submits, and Word mode streams nothing — which is exactly why a run is not resumable
  across devices and why the honest offer is a restart. The in-flight start map is still
  qualified per (round, WORD), for its own reason: a start still in the air for a retired
  daily must not answer a call about the word that replaced it.
- **The submission's marker is `submittedAt`, never the log's LENGTH.** A run that claimed
  nothing records an EMPTY log, which by length alone is indistinguishable from an
  unsubmitted round: a second submission overwrote it, a retry of it classified as
  `not_started` — which the client treats as a verdict and closes on — and a mount read
  could not see that the day was already recorded. Both stores key `already_submitted` on
  the attribute, the write's own condition is `attribute_not_exists(#sub)`, a restart
  REMOVEs it with the log, and the client marks the round submitted off it.
- **Explicitly NOT done:** "starting an archive round replaces the active one" was
  considered as a flood defence and rejected — identities are free
  (`crypto.getRandomValues`, no registration), so one-active-round-per-player bounds
  nothing (an attacker runs 1095 identities with one active round each) while binding the
  person with exactly one identity and destroying a one-shot daily that can never be
  replayed. Today's run therefore survives archive browsing: it keeps running unattended,
  dies on its own deadline, and submits on the revisit. The bounds that hold ACROSS
  identities are Turnstile at round start and the #169 IP cap. The issue's optional extra
  layer — rate-limiting round STARTS per IP (20/hour) — is **not implemented**: it is a
  second store and a second write on the game's opening tap, for a bound the economics
  already settle (a full parallel attack costs $1–2 in farmed solves to inflict ~1¢/month
  of storage and ~6¢ of writes).
- **Store shape:** the same round item gains `startedAt` — a STRING like `createdAt`, since
  the Number spelling is reserved for the one attribute a DynamoDB CONDITION compares
  arithmetically, and the wait check is compared in the handler after a read it owes the
  caller anyway. Neither word path touches `lastWriteAt`: that attribute exists for the
  streaming interval, and a mode that writes twice a day is not what it bounds. **The
  persist blob is v11, DROPPING every pre-#202 word round** — their clock is a local
  `Date.now()` no server ever saw, their submission would be refused `not_started`, and
  there is no honest way to invent the missing record (the v7 strike-run precedent).

### Derived scores (#203, decided 2026-08-21)

- **With the log server-side (#201), the score stops being something the CLIENT CLAIMS.**
  The server derives it from the log it already holds, so the `/scores` POST, the score's
  range validation, the whole `scoreRecorded` state machine (its retry-until-recorded rule
  included) and its store field are all RETIRED. `/scores` is a READ. What a finished round
  persists instead is `recorded` — a plain "the SERVER holds this round's solve" — read off
  a round answer, never off the local board, which flips a beat earlier.
- **It never needs the vocab existence set.** SOLVED is "every secret slug has a guess at
  rank 0 in its map"; PROGRESS is `s(rank)`, `start_rank` and N per hole; WORD CLAIMS are
  entries at rank ≤ `WORD_CLAIM_ZONE` — all in the puzzle JSON. The only thing the
  vocabulary would buy is rejecting non-words in sentence mode, and that only ever HELPS a
  cheater: the sentence score is unique tries and lower is better, so padding a log makes
  the score worse. Client-side vocab filtering is therefore safe to trust, and a
  multi-megabyte word list never has to reach a Lambda.
- **The readings are CROSS-PACKAGE now** (`shared/src/scoring.ts`): `s`/`holeProgress`,
  `rankCount`, `guessKey` and `countTries` moved out of the web when the server started
  performing them. Two spellings would let the number on screen disagree with the one the
  leaderboard recorded and #211's calendar fills from, over the same log.
- **`progress` and `solved` are STORED on the round row, in the write that appends the
  guesses.** The handler reads the row, derives both from the stored log plus the incoming
  batch, then issues ONE conditional UpdateItem that appends and sets them together — one
  mutation, so nothing can half-fail and no stored summary can disagree with the log beside
  it. The extra read is cheap (a small item; reads price well under writes) and its round
  trip is one the player never feels, since the board has already reacted locally (#201).
  It is EVENTUALLY CONSISTENT: the only things derived from it are `progress`, which
  self-corrects, and `solved`, which is write-only-true; every bound that must not be raced
  lives in the write's own condition.
  **`solved` is only ever written TRUE.** A second device can append between that read and
  that write, so the derived values may describe a log one guess stale — harmless for a
  percentage, fatal for a flag, since writing `false` over a `true` another device just set
  would un-finish a finished day.
- **A solve can be MISSED when two devices append at once, and the append's own answer is
  the fix.** The write is atomic; the read → derive → write SEQUENCE is not, and deriving
  from *(my read + my batch)* misses a solve that exists only in the UNION of two concurrent
  batches (each sees half, each derives `solved: false`, both pass
  `attribute_not_exists(#solved)`). Not an eventual-consistency problem — a strongly
  consistent read behaves identically, since both reads still precede both writes. The
  append returns the merged truth (`ReturnValues: ALL_NEW`), so: **after it returns, derive
  again from the RETURNED log, and when it disagrees issue one small conditional write.**
  **That write raises `progress` and never lowers it** (added on review), the shape `solved`
  gets from being write-only-true: two settles can be in flight at once — this one sits
  behind a retry backoff, and another device's append can land and settle inside it — so the
  later ARRIVAL may carry the older log, and last-writer-wins would park a lower percentage
  on the row for good, since a solved round takes no further append to repair it. Progress
  only rises within one puzzle's life, so refusing a lowering write costs nothing correct,
  and a solve is never refused by it (a solved derivation is exactly 100). **The APPEND is
  deliberately not guarded the same way** — understood and accepted on review: the stored
  percentage can DIP for the moment between the append and its own settle, since the append
  writes what the caller derived from an eventually-consistent read. Guarding it would
  refuse the whole write in that case, dropping a correct guess to protect a value derived
  from it; nothing reads the stored percentage mid-round today, and the settle repairs it
  off the ALL_NEW log in the same request.
  The pre-read STAYS — it is what supplies values to write in the same operation, which is
  what holds this at one read plus one write; the returned item is a VERIFICATION, not a
  replacement. **That corrective write is the LAST chance to record the solve, so it is
  RETRIED rather than fired and forgotten:** once the puzzle is solved the player stops
  guessing, so no later append comes along to notice the omission. The same comparison
  fixes `progress`, whose "the next write corrects it" only holds while there IS a next
  write. Do NOT simply write the derived values back every time — DynamoDB charges an
  update by the whole item size, so a second write per append would double the write cost.
- **A SOLVED round stops accepting appends**, by one more clause on the ConditionExpression
  the append already sends (`AND attribute_not_exists(#solved)`) — no extra read, exactly as
  Word mode's `attribute_not_exists(#sub)` works. **Not an anti-cheat measure** (padding a
  log after the solve only ever worsens the score); what it prevents is a RECORDED SCORE
  SILENTLY CHANGING after it is on the leaderboard, which reads as a bug whoever caused it.
  **The refused device has to do BOTH things, and that is NEW client code** (#201's rules
  answer neither): a plain 4xx closes WITHOUT adopting, leaving a second tab rendering an
  unsolved board with its guesses on screen — the symptom the freeze exists to prevent; a
  409 adopts WITHOUT closing, and `pump` resends immediately with `failures` reset, so with
  no backoff at all. So the `round_solved` 409 is ADOPTED **and** closes. That device's
  unsent guesses are dropped for good — harmless to the score, but never silently on screen.
- **The score row is written by the round path**, from the FULL artifact: the sentence score
  counts UNIQUE TRIES and `guessKey` dedups on a guess's rank in EVERY map, which the slice
  cannot answer. It is the last thing the solving append does, so the answer the client
  adopts is never ahead of the population it is about to read. Word mode's end-of-run
  SUBMISSION records its claim count the same way. **The #169 HMAC-IP volume floor moved
  with the write** (the round path hashes the trusted viewer address), which is why
  `/round` now wears the CDN's viewer-request function too — its absence there was already
  a latent 500 on every #202 word round start.
- **What it LOADS, and how big that is.** A sentence puzzle is 6.44 MB with ~107,000
  rank-map entries; parsing that on every append is not viable, and per-instance caching
  does not rescue it, since `/round` serves any archive day. So publish places a small
  **DERIVATION SLICE** beside each sentence puzzle — every key ranked at or below that
  hole's `start_rank`, plus `n` and `start_rank` per secret. Measured across the 49 fr
  puzzles in the local store: full artifact **median 4.57 MB** (1.29–7.78), slice **median
  14.1 KB** (4.6–65.3) — **332×**. A hole's rank only ever improves from `start_rank`, so
  nothing above it can move the percentage: the slice covers BOTH `progress` and `solved` on
  every append. It is bigger than `start_rank × 3` suggests because a rank is a GROUP with
  several typable spellings (fr averages 2.58 keys per rank, up to 11.1). **Every figure
  here is FRENCH** — the local store holds no real English sentence puzzle, so generate one
  and re-measure before sizing anything on it.
  - **BOTH ARTIFACTS ARE READ FRESH; there is no cache** (settled over two review rounds,
    replacing this issue's own slice cache and one-day artifact cache). The caches were
    removed while a sentence's hole signature was the only revision signal. That signal
    missed the load-bearing fact that **RANK 0 IS A GROUP, NOT A SLUG:** every alias of the
    secret's group sits at rank 0 (measured on the 51 local fr puzzles: 79 of 151 hole
    occurrences carry more than one rank-0 key, worst 27), and a correction that re-runs the
    #104 merge walk can move aliases in and out without touching a hole. A stale slice then
    decides `solved` wrongly in BOTH directions, and neither heals. *(An earlier draft of
    this section claimed `solved` self-heals. It does not; the claim was wrong and is
    retracted here.)* The content-derived published revision below now covers the rank maps,
    so a cache keyed by it could be correct. Fresh reads remain the simpler choice because
    the slice fetch overlaps the round read and the full artifact is loaded only on solve;
    no warm Lambda retains 12–18 MB of parsed puzzle state.
  - **What reading fresh costs:** one ~12.5 KB GET plus a 0.51 ms parse per append, issued
    CONCURRENTLY with the round item's DynamoDB read — so no wall-clock on a request already
    waiting on a comparable round trip — and on the order of $0.60 a month in S3 GETs at
    1,000 players averaging 50 guesses. **The slice still earns its keep:** what #203 measured
    as unviable was PARSING a 6.21 MB artifact per append, and that is exactly what this
    never does. The full artifact is parsed once per round, on the solve.
  - **Measured** (node, `2026-07-25.fr.json`): full 6.21 MB raw / 0.80 MB gzipped / 52.3 ms
    to gunzip+parse / **16.6 MB retained**; slice 66.7 KB / **12.5 KB** gzipped / **0.51 ms**
    / **0.22 MB**. The heap figures are RETAINED measurements (three copies parsed and held,
    then divided) — a single `heapUsed` reading of one parse reports anything between 5 and
    35 MB for the same file. Across all 49 the retained range is 12–18 MB. **Fetch the slice
    CONCURRENTLY with the DynamoDB read** — neither depends on the other, so the slice fetch
    hides inside a round trip already being paid for. It rests GZIPPED (these slugs share
    long prefixes and compress 5.3×).
  - **Produced by `pnpm puzzle:publish`, not generation.** The slice is a pure function of
    the puzzle with no authoring decision in it, and publish is already where an artifact
    becomes a served thing. Two reasons over `gen_phrase.py`: republishing gives an EXISTING
    puzzle its slice where generation would mean regenerating it, and publish is TypeScript
    like the backend that reads it — there is already one cross-language contract to keep in
    step (`slug()` ⇔ `fold()`) and no reason for a second. **SENTENCE ONLY:** Word mode reads
    its artifact once per run at submit, and its round START reads no store at all, which
    matters — that is the one path where the player genuinely waits on a response.
  - **THE ARTIFACTS NAME THEIR REVISION** (user-decided 2026-08-22). Publish removes any
    prior stamp, hashes the complete sentence-puzzle content — rank maps included — and
    writes that `revision` onto BOTH the full puzzle and its slice. Publishing byte-equivalent
    content therefore keeps the version and every round; any real correction mints a new one
    and restarts the retired round. The client forwards the puzzle's revision on every
    request, and both fresh loaders require app, slice and full artifact to agree. Publish
    still replaces two objects, so it writes the slice first; a reader inside that window
    gets the day-addressed 404 on a version mismatch rather than deriving across versions.
    The ordering shortens the fail-closed window, while the shared revision is what makes it
    safe.
  - **A MISSING SLICE IS A MISSING PUZZLE** — the same day-addressed 404. There is no
    degraded mode: either publishing failed or the day was never published. **The production
    backfill completed 2026-08-22, and the archive was cut to August the same day**
    (user-decided): the bucket holds 2026-08-01 onward — 22 sentence objects, each carrying
    its content-derived revision beside a matching slice, plus 13 word artifacts — and every
    July day was deleted with the stray 2027 fixture. Future publication produces both objects
    through the same command. The backend reads the slice straight from the store, not through
    CloudFront, so there is no new route and no cache-policy change.
- **The sort key is REORDERED**, `<date>#<lang>#<mode>` → `<lang>#<mode>#<date>`. It lands
  here rather than in #211, which is what needs it, because this is the first issue to write
  `progress`/`solved` onto round rows and reordering afterwards would mean those rows had
  been written under two schemes. What it buys: #211 reads a calendar as ONE Query over a
  month, and with the date first a month prefix matches every language and every mode — up
  to ~124 rows. A `FilterExpression` does not help (DynamoDB filters AFTER reading, so the
  cost and the 1 MB limit are measured on what is READ). Reordered, `fr#sentence#2026-08-`
  returns about 31 rows, which removes the pagination problem rather than handling it. **No
  migration** — the archive is wiped before launch.
- **The standing is the SERVER's answer about THIS player, not a number match** (corrected
  on review). `/scores` takes the caller's PUBLIC id — the `/board` rule, so it may travel
  in a query — and reports which band is theirs; `id` joins the addressing triple in the
  score behavior's allowList (the three-package contract). Matching a local count against
  the returned bands only ever says "somebody recorded this number": a round whose row the
  IP cap refused, or a Word daily another device submitted first, would borrow an unrelated
  player's rank. A population that holds no row for the caller now answers `bucket: null`,
  and no standing is drawn.
- **A SOLVED round's log is adopted SERVER-ONLY** (corrected on review), where every other
  answer merges the local log under the server's. A frozen round's stored log is final —
  the guesses it refused are never stored — so merging them back would leave the screen
  counting tries the recorded score does not, a headline permanently disagreeing with the
  rank printed beneath it. This is where "dropped for good" actually happens. **It is still
  DEDUPED by canonical identity** on the way in: the stored log is RAW, and two devices can
  each have sent a different surface of one group, so adopting it verbatim puts a raw length
  in the headline against a score `countTries` counted one lower — the same disagreement from
  the other side.
- **Turnstile MOVES to ROUND START** (and to #204's account link). Round creation is
  available to every unlinked visitor, so it carries more weight than it did. Word mode
  already gated its START; the sentence round has no start message, so the challenge rides
  the append that CREATES the record and is verified only there — a later append to an
  existing round costs none. **The token is PREFETCHED** while the puzzle loads and while
  the Word gate is on screen, so it is in hand before the player acts: in Word mode round
  start IS clock start, and a bot check landing exactly then costs real seconds on a
  60-second game.

### Local storage is an OUTBOX; a capped round ends at ∞ (#214, decided 2026-08-23)

- **The game is NETWORK-DEPENDENT, and it says so.** It already requires the day's puzzle;
  it may now also wait for the player's ROUND before becoming interactive. After the puzzle
  supplies its `revision`, the client reads that exact server round: a 404 is a fresh empty
  round, and a FAILED read is a visible loading/retry state — never permission to start from
  a guessed local mirror. Once both reads have settled, guesses are judged and rendered
  locally and instantly, exactly as before: the dependency is on loading AUTHORITATIVE
  STATE, not on the feel of a keypress. Word mode keeps the same rule at its own cadence —
  its run UI waits for the mount read too, which also closes the hazard that PLAY was
  tappable while that read was in flight (a session that starts a run it cannot see becomes
  its writer, #202). *(Since #217 that wait earns its keep differently: the read is where the
  screen learns WHOSE run the daily holds, and PLAY on a day started elsewhere is a RESTART
  the gate has to be able to warn about.)*
- **Three deliberately different values, and keeping them apart is the design.**
  - **SERVER STATE** — the authoritative RAW ordered log and its `solved` flag, held ONLY in
    memory after a read or an answer.
  - **OUTBOX** — the folded guesses the server has not acknowledged, qualified by the puzzle
    revision. **The only persisted sentence-round state.** A mismatched revision drops it.
  - **PLAY LOG** — a pure, stable first-occurrence projection of `server guesses + outbox`,
    deduplicated by the shared `guessKey`.
  The play log drives EVERY client derivation: holes, progress, the unique score, the prompt
  history, the trajectory and the solve moments. The RAW server log drives only the storage
  cap. That distinction stays load-bearing — aliases, another device and the recovery read
  can each put two raw strings in one playable identity. **The old reconciliation problem
  disappears because no acknowledged derived state is persisted**: the projection is not an
  authority or a merge watermark, just a view recomputed from two inputs.
- **Load and play, in order:** fetch and parse the puzzle → drop any persisted outbox whose
  revision differs → read `POST /round` for this revision → hold the returned state in
  memory (404 = empty) → remove outbox entries the server log already represents → derive
  the play log and replay the board → and only then enable input. A new valid guess is
  deduplicated against the play log, appended to the persisted outbox, and immediately
  replayed into the visible board; nothing waits for its write.
- **The local board may complete while the solving append is in flight, but AUTHORITATIVE
  SOLVED comes only from the server flag.** The prompt locks on local completion; the
  result, the leaderboard, the streak and the `solve` event wait for confirmation. A solve
  confirmed by the batch THIS device just played is a fresh solve and earns the normal
  beats; a solve learned from the mount read or a `round_solved` refusal is adopted history
  — shown, never celebrated.
- **Outbox writes** keep one conversation per round and the existing `ROUND_WRITE_MIN_MS`
  pacing. Each write snapshots the outbox (guesses appended in flight stay outside it),
  computes `room = ROUND_GUESS_CAP − serverState.guesses.length`, and POSTs the whole
  snapshot or — near the cap — only its oldest prefix that fits. An over-cap body is never
  sent. On 2xx the transient server state is replaced and the outbox keeps only what the new
  state does NOT represent, BY IDENTITY — which covers the sent prefix and anything else
  that arrived meanwhile, so there is no sent-prefix bookkeeping to keep honest. The four
  recoverable answers: **429 `too_fast`** adopts and keeps the outbox, pacing from this
  answer; **409 `round_full` BELOW the cap** means the batch merely overshot after another
  device moved the raw log, so it adopts and retries the prefix that now fits; **409
  `round_solved`** adopts the frozen result, discards the outbox and closes; **409
  `round_full` with an unsolved raw log AT the cap** enters the capped terminal state,
  discards anything that never fit and closes.
- **An UNKNOWN write outcome still READS.** A transport error, a 5xx or a malformed answer
  may have committed, and an outbox can hold many guesses — so one lost response could
  duplicate a whole batch, burn many raw cap slots and manufacture a false "unreachable
  puzzle" signal. Recovery is ONE round read; whatever the returned log represents leaves
  the outbox and only the remainder is retried. A narrow acknowledgement recovery, not the
  old persisted-round adoption machinery; server-side request idempotency is deliberately
  NOT added for a problem one read already solves more simply.
- **WORD MODE keeps its persisted clock/outbox.** The asymmetry is intentional: losing one
  sentence flush costs a few guesses, while losing an unsubmitted Word outbox loses the
  whole run. #214 removes the persisted sentence `rounds` map, not Word's state — its
  counted guesses accumulate locally for the whole run because Word submits once at the end,
  and a 2xx submission (new or already submitted) adopts server truth.
- **THE CAP IS A TERMINAL STATE, AND IT PRINTS `∞`.** A sentence round is CAPPED when the
  authoritative server state is **unsolved with exactly `ROUND_GUESS_CAP` raw entries** —
  DERIVED, never a stored flag, because local outbox length can never reveal it. Server
  `solved: true` WINS over the cap check, so a legitimate solve accepted as raw entry 500
  stays an ordinary solved round with its leaderboard entry. An unsolved capped round ends
  immediately: no leaderboard entry, no celebration, no streak advance, no `solve` event;
  the answer and the source credit are shown; the displayed score is `∞`; the final
  reconstruction stays an unsolved progress value on summary surfaces; and the result is
  shareable, still firing the existing `share` event. Internally it keeps its numeric UNIQUE
  try count and one ruler cell per canonical play-log entry — the capped flag changes the
  displayed HEADLINE, it does not redefine the ruler as 500 raw storage entries.
- **The glyph is a SHAPE, not text.** Press Start 2P has no `∞`, and the OG card rasterizes
  with `loadSystemFonts: false`, so it ships as pixel-art SVG path data in `shared/`
  (`glyphs.ts`), drawn by both `cardSvg.ts` and the web result in place of
  `.solved-score-num`. ONE path and ONE view box keep the two surfaces identical; the
  plain-text headline and the share page's title use the literal character, where a font is
  not involved.
- **SHARE TOKEN v6.** Sentence share v2 cannot express capped, and versions 3–5 belong to
  Word formats, so the next SENTENCE format is **6** — one capped flag, the numeric unique
  score, the trajectory and the ticks retained. A capped token carries NO solve ticks. With
  `SHARE_VERSION` at 6, `decodeLegacyShareTarget` recognizes ONLY the retired sentence
  versions **1 and 2** (a named list, never a range): it must not treat retired or malformed
  Word versions 3–5 as sentence legacy, valid current Word v5 is still decoded by its own
  decoder first, and invalid Word tokens stay 404.
- **What this REMOVES from sentence mode** (the standing no-back-compat rule): the persisted
  `rounds` materialized-view map and its round-shaped migrations; persisted holes, progress,
  guess count, `recorded` and `capped`; the `pendingFrom`/`serverCount` watermark
  bookkeeping; the authority-bearing `mergeLogs` and the `adopt`/`adoptSolved` split;
  `holesMatchPuzzle` for stored rounds; and the capped-but-still-playing and solved-screen
  `canSubmit` branches. What remains is smaller and explicit: one transient server snapshot,
  one persisted revision-qualified outbox, one pure canonical play-log projection, paced
  prefix writes, and the narrow read-on-unknown recovery. Persisted GAME state — the
  outbox, Word mode's clock/outbox and the device preferences — lives behind ONE
  transactional IndexedDB record since persist v18 (`web/state/gamePersistence.ts`);
  localStorage otherwise retains only the device token (#216 — the player secret until
  then). *(The solved-day
  sets went with the rounds at v15 — #211 moved the collection to the private player row.)*
- **ORDERING — #214 then #211, and they SHIP TOGETHER.** This issue establishes the client
  state model #211's summary readers consume. Removing the persisted sentence rounds (and,
  in #211, `solvedDays`) must NOT reach production before #211 supplies the archive
  calendar, the language chooser and the streak with their server-backed sources: until it
  does, `statusOf` has no producer and every SENTENCE day reads as not started. There is no
  compatibility migration and no local fallback. *(#211 landed with it — see the next
  section; `solvedDays` left the persisted blob at v15.)*

### Server-backed player history (#211, decided 2026-08-23)

- **After #214, a summary surface has no local source left, and it must not invent one.**
  Opening a daily still loads its complete authoritative round, but the archive calendar,
  the language chooser and the streak cannot open every daily to discover what happened.
  This is the read they use instead, and it serves EVERY identity, linked or unlinked:
  after #214 it is the normal source on every device, not a linked-account enhancement.
  *(Future #216 amendment, decided 2026-08-23: once device tokens exist, an identity that
  has never been bootstrapped cannot own server rows, so its calendar, chooser and streak
  are known-empty without a fetch. #211 ships before device tokens and does NOT add that
  tokenless branch.)*
- **ONE route, POST-only like /friends** (the auth travels in the BODY — the DEVICE TOKEN
  since #216 — so nobody can ask for another player's history): `POST /history?lang=&mode=[&month=]` answers
  `{ days, solvedDays }`. The body may carry `collection: false` (PR-218 review) to skip
  the solved-day read — the language chooser wants a month strip and never renders the
  streak, so its read must not spend the collection's consistent GetItem; absent means
  true. **`month` is OPTIONAL, and that is the whole shape of the design:**
  the archive and the chooser want a CALENDAR, while the game screen wants only the
  collection the streak choreography derives its previous value, next value and week row
  from — and making that read spend a month Query would cost a whole calendar per game load.
  **Three packages agree on the query allowList** (the standing contract): the history
  CloudFront behavior forwards exactly `lang`/`mode`/`month` over the shared
  zero-TTL/allExcept-Host live shape. NOT `date`: this read is addressed by a MONTH.
- **The calendar keeps its percentage, and it has NO storage of its own.** #203 already
  writes `progress` and write-once `solved` beside the raw guess log on the round row
  (`round#<publicId>` / `<lang>#<mode>#<date>`), derived from the same log the server scores,
  so #211 adds no second calendar row and no extra per-guess write. **Rejected: a separate
  `cal#…` summary row** — it would bound calendar-read cost but add a real write whenever
  progress moves, so it buys a ceiling rather than a saving. Revisit only if measured reads
  justify it.
- **The month read is ONE Query per (month, language, mode)** behind the `<lang>#<mode>#<month>-`
  sort-key prefix #203 reordered the round key for — about 31 rows, safely inside DynamoDB's
  1 MB response limit. It is PROJECTED down to the summary facts, so a month's raw guess logs
  never cross the wire (read capacity is still measured on the underlying items), and it PAGES,
  because silently rendering a partial month is the one failure a calendar cannot show.
  It is **never scoped to a puzzle REVISION**: the calendar has no way to know which version a
  past day is on, and a corrected round replaces the row on its own first append.
- **Archive days are playable, so a past month is NOT immutable.** The client keeps only an
  IN-MEMORY request cache and REVALIDATES whenever a month becomes the view on screen; nothing
  is persisted as a second source of truth. The language chooser reads the current month and
  selects today's row for each language, under the same rule.
- **LOADING IS EXPLICIT, and it is a THIRD status, not `none`.** A month or a chooser card
  whose summary has not arrived renders as UNKNOWN — never a collection of "not started"
  days, which is a claim, and a false one. There is no localStorage fallback: a month that
  could not be read says so and offers to ask again.
- **The STREAK stores the per-language SOLVED-DAY COLLECTION on the private player row**
  (`player#<publicId>` / `history#<lang>`), in the same logical shape the client gives
  `currentStreak` and `weekView` — never a counter, because `StreakDialog` renders the week
  row and a raw number cannot say whether a streak has since broken. It is updated
  IDEMPOTENTLY when the server CONFIRMS a solve (a set insert on the append that already
  records the score), bounded by `MAX_SOLVED_DAYS`, read only through this private path and
  never through the public `GET /profile?id=`, and held transiently by the client.
  It is a **rebuildable CACHE of the authoritative solved round rows, not a second
  authority**, which is why crediting it is a logged, non-fatal side effect. **A republish
  does not remove a day already credited**: it was the publisher's error, the streak rewards
  showing up, and solving the corrected revision cannot add the same day twice.
  **NOTHING ANYWHERE REPLACES THE COLLECTION — both ends only ever ADD (corrected on
  review).** Within a language it is monotonic, so every write is a set operation on
  ELEMENTS: the server credits with an idempotent insert and trims by naming the overflow,
  and the client MERGES a landing answer into what it holds rather than adopting it whole.
  Replacing loses a solve on either side — a read issued before the solving append lands
  after the client has credited it, and two concurrent credits at the cap each write back a
  set omitting the other's day. A lost solved day is the one thing this collection may never
  do; overshooting `MAX_SOLVED_DAYS` by a day or two while concurrent credits converge is
  the ordinary bound-not-invariant trade `FRIENDS_MAX` already makes.
- **ON TIME means ON THE DAY, and LATE HAS NO GRADATIONS (user-decided 2026-08-23): a
  millisecond late is a decade late.** A round earns the day's rewards — the streak credit
  AND the leaderboard row — only when the day it is playing IS the day it was PLAYED on.
  The rule is ONE predicate on the server (`rounds.ts` `onTime`), worn by both. **Which
  instant it judges is the mode's own (PR-218 review):** a SENTENCE solve is earned by the
  append that lands it, so its instant is that write's arrival; a WORD run's is its
  server-stamped START, because the submission is deferred BY DESIGN — the wait check
  refuses a write before the run's floor (so a run started near 22:00 can only submit past
  the flip) and #202 lets the log arrive on a later revisit, so the arrival says nothing
  about when the run happened, and judging it there dropped the row of a run genuinely
  played on its day. **The streak's client half no longer makes any comparison** (same
  review): the solving append's answer carries the verdict (`credited`), because the
  route's ±1-day skew window lets a fast device clock disagree with the server's — it
  celebrated a streak day the server refused, a phantom the union merge could never remove.
  A sentence carried across the 22:00 flip and finished at 22:00:01 was not finished on
  time; an archive replay never was on time, at any distance; and the two are treated
  identically because they ARE the same thing.
  **It REPLACED a window that tolerated `activeDay - 1`** for that flip-edge — an in-flight
  round finished a few minutes past the reset — plus a second gate at the client
  (`isActiveDay`, the route) to tell that edge from a deliberate archive replay of yesterday.
  The two are NUMERICALLY IDENTICAL, and the only thing that ever separated them was which
  URL the tab was on: knowledge that exists in the browser and nowhere else, so the server
  could never have applied the tolerance honestly. Ruling the edge LATE removes the
  ambiguity instead of arbitrating it — one comparison now answers both, the client's second
  gate is gone, and the two ends cannot drift.
  One refusal is the client's alone: a collection that has NOT ARRIVED credits nothing and
  celebrates nothing, because the choreography counts the previous value off it and there is
  no honest way to guess it. The server still records the solve either way.
- **WORD MODE's calendar stays LOCAL.** #214 deliberately retained Word mode's persisted
  clock/outbox, so this issue's release-blocking replacement is the SENTENCE summaries and
  the streak. The linked-device gap for Word remains explicit: a fresh device cannot
  reconstruct the Word calendar from local state, because an in-progress run's exact
  bonus-adjusted deadline lives on the playing client until submission. A server-backed Word
  month status needs its own product contract and is NOT silently approximated here.
- **METERING:** this is a private, currently unmetered read whose cost scales with the
  caller's played rows. Until real traffic shows otherwise, monitor abnormal usage and act on
  the account rather than add a rate-limiting layer. **Turnstile does not fit a NAVIGATION
  read** — verification would add another external call to every month or chooser load. The
  rejected separate-summary-row design above remains the lever if read amplification becomes
  material.

### Devices: per-device tokens, revocation, and where an account is created (#216, decided 2026-08-23)

- **A device holds a REVOCABLE token; the SERVER assigns the account.** #187's identity was a
  128-bit secret in localStorage, and every device that reached an account held that same
  secret — so there was nothing device-specific to revoke: the only remedy for a leaked
  account was to abandon it, losing the archive, the streak and every friend. **Signing a
  device out has to be possible WITHOUT holding that device**, which requires the device to
  stop holding the account credential and hold a revocable one instead. What is gone:
  `shared/src/identity.ts`'s client-side account derivation (random secret → SHA-256 → public
  id). That removes `crypto.subtle` from paths that need no identity, including an anonymous
  global-board read; it does **not** make an insecure context playable, because every live POST
  still hashes its exact body with `crypto.subtle` for OAC and bootstrap is one of those POSTs.
  `shared/src/assigned.ts` is untouched and keeps deriving the pseudonym and the mark from the
  server-assigned account id. **No back-compat and no migration** — the DB is wiped before
  launch, the standing rule for this epic.
- **THE TOKEN CONTRACT IS EXACT** (`shared/src/identity.ts`): the client generates 32 random
  bytes with `crypto.getRandomValues`, encodes them as **exactly 64 lowercase hexadecimal
  characters**, and PERSISTS that value before sending the first request. The server accepts
  only `^[0-9a-f]{64}$`; it rejects a malformed or non-canonical value **before hashing,
  logging or reading DynamoDB**, it **never normalizes uppercase**, and the raw token is never
  logged. The client never HASHES anything — it mints and sends, and hashing is the server's.
- **ONE DynamoDB item per device**, keyed by `SHA-256(token)` and never by the token itself:
  the hash is deterministic, so authentication is one direct base-table read, and the server
  stores nothing that can authenticate. The one item serves both access patterns — **base key
  `device#<tokenHash>` → device → account** on every authenticated call, and a **GSI
  (`DeviceByAccount`, `player#<accountId>` / `device#<deviceId>`)** for the sign-out screen.
  The security-sensitive path is the BASE item: authentication reads it directly and then
  requires **its account row still to exist** (`player#<accountId>` / `account`). The GSI may
  briefly lag a create or a delete — a cosmetic device-list delay only. Each listed row returns
  the base primary key's digest as an opaque, non-authenticating `revokeKey`; revocation uses it
  for one conditional base-table delete and performs **no GSI lookup**, so index lag can never
  turn a requested sign-out into a silent no-op or keep a token authenticable. A failed delete
  condition is resolved by one strongly-consistent BASE read into **`absent` versus
  `mismatch`**: removed/already-absent rows are filtered from the returned GSI list by their
  exact `revokeKey`, while a mismatch filters nothing. Thus a concurrent self-revocation
  cannot reappear through a stale index row. The account
  check is the backstop for the reverse, rejecting a device item an eventually-consistent
  enumeration missed. **`lastSeenAt` moves at most once a DAY per device** — it rides
  every authenticated call, and `/round` writes about once a second while a player types.
- **Authenticated calls carry the DEVICE TOKEN where they carried the player secret.** Every
  private route (`/profile` POST, `/friends`, `/board` POST, `/round`, `/history`) takes
  `{ token }` in the BODY and resolves it to an account. It costs TWO extra direct reads
  on every authenticated call — the device item, then the account row it names (corrected
  2026-08-25: this said "one"); `/round`'s hot sentence append starts its slice fetch
  BEFORE authentication so the S3 GET hides inside those round trips. The **user-agent is a structured
  object** (device family, OS, browser) parsed **server-side** from the `User-Agent` header —
  the client can lie and the server sees the header anyway — and stored as FIELDS rather than
  a formatted string, so the UI can render icons and change its wording without a migration.
  It is deliberately COARSE (`backend/src/userAgent.ts`): the label exists so a person
  recognises their own phone, no product rule reads it, and what actually matters is the ORDER
  of its checks, since every Chromium browser impersonates the others. No rename affordance:
  "iPhone / Chrome" is enough.
- **AN ACCOUNT IS CREATED ON THE DEPLOY BUTTONS ALONE — never on a page load, never as a
  side effect** (user-decided 2026-08-24, NARROWING the original lazy-on-first-need list:
  the first guess, opening the leaderboard and opening the profile editor are no longer
  triggers). Creating on load turns account creation into an unauthenticated write every
  crawler triggers; creating inside an engine made it a side effect nobody saw. The five
  triggers, each a PRIMARY BUTTON: **the sentence gate's PLAY** · **Word mode's PLAY** ·
  **accepting an invite** (its button — the landing no longer auto-adds on load) ·
  **sending an invite link** · **saving a profile** (the SAVE tap, never the editor
  opening). Each is a SINGLE tap that chains its real action behind the bootstrap, shows a
  clear loading state on the button, and reports failure on the app's ERROR SURFACE — a
  popup on desktop, a bottom sheet on a phone (`web/components/ErrorSheet.tsx`) — saying
  what happened, with TRY AGAIN when retrying can help. Consequences, all deliberate:
  - **The sentence game shows the FULL RULES GATE whenever the device has no account**
    (archive days included), whatever `sentenceRulesSeen` says: its PLAY is the only
    trigger on that screen, and the server owns the log from the first guess, so no guess
    may land before the account exists. The engines never mint — the append and the word
    submission resolve the identity they hold or stand down (`currentRequestIdentity`).
  - **The leaderboard and the profile editor render a LOCAL PLACEHOLDER identity** for a
    tokenless device — a persisted random seed (`gameStore.localSeed`, publicId-shaped)
    that `anonName`/`defaultAvatar` derive the name and mark from. Display-only, never
    sent anywhere; when the account deploys, the server-assigned id takes over and the
    derived face changes once (the server picks the id, so no local value can match). The
    tokenless friends board is the honest empty board without a request.
  - Invites remain gated on NEITHER side (the accepter is by definition a brand-new
    visitor clicking a link — the invite funnel, #189); what changed is WHEN: the tap, not
    the load.
- **NO TOKEN MEANS NO PRIVATE GAME-STATE FETCH.** A puzzle, a calendar or a language summary
  with no local device token KNOWS the player's server state is empty and must not call
  `/round` or the private history routes merely to learn that. It is an ANSWER, not a loading
  state: the round publishes a ready-and-empty authoritative state and the history publishes a
  ready empty month and collection, so no surface breathes behind a request nobody made. The
  first deploy button bootstraps the identity and performs its intended mutation; later
  mounts, now holding a token, read authoritative state normally. This is #216
  implementation work at #214's round boundary and #211's history boundary.
- **TURNSTILE SITS ON THE REQUEST THAT CREATES STATE** — account/device creation, and round
  creation as it already does (#203). The token is generated and stored immediately before the
  bootstrap, and **bootstrap is IDEMPOTENT by token hash**: if the first answer is lost after
  commit, retrying returns the device/account already created rather than minting another
  identity. **A brand-new player's first PLAY therefore spends TWO challenges** — one for
  the bootstrap the tap performs, one for the round creation #203 gates (Word mode's START,
  or the sentence append that creates the record) — where the issue asked for one. Folding
  them into a single request would mean an ordinary authenticated write could mint an
  identity, which is exactly what the next rule forbids; both tokens are invisible and
  prefetched into a two-slot, single-use queue, so the cost is one extra Siteverify call on
  the first PLAY of a new player's life.
- **FIRST BOOTSTRAP IS ONE ORIGIN-WIDE CRITICAL SECTION.** `localStorage` is shared by tabs
  but has no compare-and-swap, so re-reading before minting alone still permits two tabs to
  read empty and create two accounts. A Web Lock covers the entire **re-read → mint/persist
  pending token → bootstrap → commit identity** sequence; the waiter re-reads after entering
  and adopts the winner. A pending token already in storage is retried rather than replaced,
  so a lost answer and an interrupted bootstrap converge through the server's idempotence. A
  browser without Web Locks fails before minting; an unreadable storage is distinct from an
  empty one and keeps the session identity already in memory. Storage events adopt account
  changes, and removal is conditional on the token still being the one this tab is leaving.
  If that conditional removal throws, the departed token remains fenced in memory so its
  stale stored value cannot be re-adopted; a completed identity that cannot be persisted is
  likewise session-only until this tab deliberately leaves it.
- **AN ARBITRARY UNKNOWN TOKEN NEVER CREATES AN IDENTITY.** Only the explicit bootstrap
  request, with a canonical token and Turnstile proof, may do that. A malformed token is an
  input error (**400 `bad_request`**); a well-formed token missing from the base table on an
  ordinary authenticated request is **401 `unknown_device`**. That distinction is what stops a
  revoked device from silently becoming a fresh account on its next write.
- **SIGNED OUT HAS TWO AUTHORITATIVE ANSWERS:** a private call's distinct, unambiguous
  `unknown_device`, and a successful `/devices` self-revocation response whose post-write list
  no longer contains the calling device. The client
  shows a screen with **RECONNECT** (into #204's link flow) and a secondary **SKIP** that
  discards the old token and starts fresh (the next deploy button mints the new one).
  Only on those explicit answers
  — a 5xx or a dropped connection must never sign anyone out, which is why every refusal path
  reads the error CODE rather than the status alone. Every sign-out call carries the epoch of
  the identity that made the request; a late verdict from A must never remove current identity
  B. The copy says what is being left behind, or a
  vanished streak and an empty friends list read as a bug rather than as the sign-out that
  caused them. **RECONNECT is NOT WIRED in #216**: the email link flow is #204's, so the
  screen takes the handler as a prop and offers SKIP alone until then — a button that does
  nothing is worse than a screen that only offers what it can do.
  **THE VERDICT IS DURABLE AND BROADCAST — a persisted TOMBSTONE (user-decided 2026-08-24,
  on the PR-219 follow-up review).** A sign-out REPLACES the stored identity with a
  non-authenticating `{signedOut, accountId, deviceId}` value — the two PUBLIC ids, never a
  token — instead of merely removing it: bare removal read as ordinary identity loss, so a
  reload lost the explanation and treated the player as brand new, and a sibling tab's next
  act could silently mint a replacement account. The tombstone survives reloads (the
  startup read raises the screen), reaches sibling tabs through the same storage channel
  (a tab holding the NAMED identity drops to the screen and fences its token; one holding a
  DIFFERENT identity ignores it), and **fails the bootstrap CLOSED while it stands**: no
  ordinary act may mint through it — leaving the account behind is the player's explicit
  choice. START FRESH removes it, origin-wide (#204's reconnect will too); a tombstone that
  cannot be removed (unwritable storage) is dismissed in memory for the session, so SKIP
  can never loop. A tombstone naming an identity this tab does not hold changes nothing.
- **LOCAL STATE FOLLOWS THE IDENTITY THAT OWNS IT** (`web/state/identityScope.ts`, installed
  once from `main.tsx`): acquiring the **first** identity clears nothing, because the state
  on screen — the guesses waiting behind the PLAY gate's deploy, the run whose PLAY is
  awaiting its answer — is the very thing the deploy button was tapped for. When a non-null identity is
  left and `accountId` changes or becomes unknown, clear the sentence
  outbox, the transient round loads, the private history/streak summaries and every other
  account-scoped cache; when only `deviceId` changes, clear device-owned state such as the
  Word round; merely binding an email to the same account changes neither identity and clears
  nothing. App also remounts its routed surface on each scope transition except the first-ever
  acquisition, so component-local profile, board, invite and device-list state cannot survive
  A → null/B and B's private reads restart when it arrives. Persist v16 drops every
  pre-#216 outbox and Word round. **Persist v17 then tags both maps with their
  `{accountId, deviceId}` owner**: startup keeps a matching owner's state, keeps account-only
  state across a same-account device replacement, and otherwise drops what cannot be proved.
  Ownerless state survives only behind the persisted pending token minted by the deliberate
  first act that created it; a missing/corrupt device record never pumps that state into a
  newly bootstrapped account. **Persist v18 moves the blob behind the transactional
  IndexedDB record** (`web/state/gamePersistence.ts` — the storage boundary, not the
  content shape); the retired localStorage value is NOT read (the standing no-back-compat
  rule), so an existing device starts from the initial state once. **Every in-flight private request captures the
  `(accountId, deviceId)` epoch before resolving its identity and before sending; if resolution
  adopts B for a closure that captured A, the POST is aborted. Its answer is ignored after
  that tuple changes too** — clearing storage without fencing either side would let the
  identity just left write into or repopulate the new one's state.
- **ONE route, POST-only like /friends** (the token is the auth and travels in the BODY, so
  its CloudFront behavior's query allow-list is EMPTY — the standing three-package contract):
  `POST /devices`. `{token, turnstileToken}` bootstraps, `{token}` lists the account's
  devices, `{token, revoke: "<deviceId>", revokeKey: "<opaque>"}` deletes that one base item;
  every answer carries
  `{accountId, deviceId, devices}` so a client never has to guess what a write did, and **no
  answer ever carries the token back**. Revoking the CALLING device is allowed — signing this
  one out is a thing a person may want, and refusing it would be a rule the screen then has to
  explain. The bootstrap is the third behavior wearing the CDN's viewer-request function,
  since a gated write needs a trusted address.
- **The list and the revocation have a REACHABLE surface** (`web/components/DeviceList.tsx`),
  on the PROFILE editor — the screen that already IS the identity screen, reached from the
  leaderboard's EDIT chip. Without it #216's central act would have no way in at all. One row
  per device (its parsed label, when it was last used, and whether it is the one asking), each
  with SIGN OUT; every call answers the list as it now stands, so the screen never guesses
  what a write did. Signing out the current row raises the signed-out screen immediately from
  that answer; it does not wait for a later private call to discover the deletion.

### Word mode: the round belongs to a device (#217, decided 2026-08-23)

- **The start stamp NAMES the device that made it, and two server conditions carry the whole
  model.** Start/restart is accepted only while `submittedAt` is absent; submission only
  while `submittedAt` is absent AND the stamp's device id equals the caller's. Everything
  else follows from those two. It SUPERSEDES #202's start rules and depends on #216: before
  device identities there was nothing device-specific to name, so the stamp could say only
  THAT a clock was running.
- **What it DELETES is inference.** `startedHere`, `mayWrite`, `resumed` as a source of
  authority, and the joiner-clock reasoning in `web/state/wordRoundSync.ts` and the root
  `AGENTS.md`. A device could tell "I am running this" from "I merely joined a clock
  somebody else is playing" only by remembering that its own start had stamped it — a
  session-scoped memory a reload lost, which is why a real 0-claim run whose tab died went
  unrecorded. Only the device holding the run can play it or submit it, and the server says
  which device that is.
- **THE SCREEN PICKS ITS PHASE FROM TWO FACTS: the server's answer, and whether THIS device
  holds the round's deadline** (`web/screens/WordGame.tsx`):
  - server holds a **submitted** run → the **final screen**;
  - **no run started** → **PLAY**;
  - started by **this device** and this device holds the deadline → **resume** before the
    deadline, **submit it** past the deadline;
  - **anything else** — started by another device, or no local deadline — → **PLAY**, whose
    tap atomically mints a new `startedAt` + device stamp and wipes the previous unsubmitted
    start and log.
  That last case covers "started here but my storage is gone", "started elsewhere and I have
  nothing" and "started elsewhere and I somehow still hold a deadline", with no special
  inference for any of them. If a submission won the race, the restart condition fails and
  the client ADOPTS the final run instead of wiping it (the START answers 200 with the
  recorded run, not an error — the daily is one-shot once its log is stored).
  **The MOUNT READ therefore anchors NOTHING** (it did under #202): a clock this device does
  not hold is a run whose claims live in the playing device's storage until it submits, so a
  countdown opened for it would time a log that can never be reported.
- **RESTART IS CONFIRMED, NOT SILENT.** The gate on a day started elsewhere shows what the
  tap will destroy, NAMING the device — *Started on iPhone / Chrome. Starting here ends that
  run.* — and its button says START OVER rather than PLAY, so the tap is a deliberate act on
  a differently-labelled control. Two open tabs is enough to lose a live run by accident, and
  this is exactly what the device label is for. The stamp carries the starting device's
  parsed user-agent FIELDS beside its id — a SNAPSHOT taken at the start, so the warning
  needs no second lookup and still names a device that has since been signed out; the label
  is `deviceLabel`, the one the sign-out screen already prints.
- **What it TRADES, all deliberate:**
  - **Cross-device RESUME becomes cross-device RESTART.** #202 listed resuming the same clock
    on a second device as a benefit; it will now offer a fresh run instead. Resuming a run
    whose claims live in another device's local storage was never really resuming it.
  - **The daily stops being one-shot until a run is SUBMITTED.** Any device on the account
    may restart as often as it likes before submission, so in effect the player can retry the
    day until they get a run they want to keep. Accepted: the day's `word.json` is public and
    cheating is not defended against here (#199). Once a run is submitted the final screen is
    the only outcome and there is nothing to restart. Each restart does spend a Turnstile
    challenge, since a start creates state (#203's rule, unchanged).
  - **Concurrent devices are LAST-COMMIT-WINS inside those two conditions.** If device 3
    restarts before device 2 submits, the stamp moves and device 2's submission is refused
    (`started_elsewhere`, a 409 carrying the stamp that stands — the client adopts it, which
    is what sends that screen back to PLAY, and closes the conversation). If device 2 submits
    first, device 3's restart is refused and device 3 adopts the final run. No run generation,
    observed-start compare-and-swap token or other machinery is added for people deliberately
    playing one account simultaneously: the device ownership and the final-submission
    condition are the whole contract.
  - **Known same-device edge, accepted:** the same device restarting itself while another of
    its own tabs still holds a live in-memory run can submit that old run into the new stamp,
    because the device still matches. Self-inflicted, and it costs only that player's own run.
- **Store shape:** the round item's stamp gains `startedBy` — ONE Map attribute holding the
  device id plus its `device`/`os`/`browser` fields, written by the same mutation as
  `startedAt` so nothing can observe a clock without its owner. The START's condition becomes
  `attribute_not_exists(#sub) OR #p <> :puzzle` (it was `attribute_not_exists(#started) OR …`)
  and its SET writes the runner; the SUBMIT's becomes
  `#p = :puzzle AND #by.#dev = :device AND attribute_not_exists(#sub)`. No persist bump and
  no migration: the local shape is unchanged, and a local clock whose server stamp names
  another device simply reads as "not mine" — the gate, with the warning.
- **It also makes #214's "a settled round's local clock is still running" state
  UNREACHABLE**: a submitted day always lands on the final screen. #214's interim fix for
  that (a settled run ends immediately) stays — it is what settles the clock — but nothing
  now depends on it to avoid an interactive prompt over a recorded run.

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

- **Player identity is a DEVICE TOKEN and a server-assigned ACCOUNT (#216, decided
  2026-08-23; it REPLACED #187's shared secret — see the devices section below for the
  whole model).** Until then the identity WAS a random 128-bit secret in localStorage that
  every device on an account held, and `publicId` was `SHA-256(secret)` derived on the
  client — so nothing was device-specific and nothing could be revoked. What survives from
  #187 is the SHAPE of the public id (`[a-z2-7]{16}`, what `assigned.ts` derives a
  pseudonym and a mark from) and the STANCE: no unique usernames, no registration, and
  **assume heavy cheating and design so it doesn't matter** — global rankings are untrusted
  by design, trust comes from the friends graph (#189), and the percentile is the one
  public stat that survives faking.
- The ONE backend handler also owns the daily score population:
  `GET /scores?lang=<lang>&date=<YYYY-MM-DD>&mode=<sentence|word>`; unlike the
  puzzle route, **`mode` is required**. **It is READ-ONLY since #203** — a POST is a named
  405. The row is written by the ROUND route, from a log the server already holds: the
  round that finishes writes **ONE row per `(date, lang, mode, publicId)`**, including the
  published `revision` it was earned on — **and ONLY when it was PLAYED ON THE DAY**
  (user-decided 2026-08-23, the same `onTime` predicate the streak credit uses; a WORD
  run's on-time instant is its server-stamped START, since its submission is deferred by
  design — see the #211 section). A
  leaderboard is a DAY's competition, so a round not played on that day is not
  competing in it, by a millisecond or by ten years: an archive replay records no row, draws
  no standing (`/scores` answers `bucket: null` for a caller the population does not hold)
  and spends no address allowance. It still stores its LOG and still shows its own result —
  what it does not join is the day's population. **This narrowed an earlier behaviour**: any
  solve used to record a row whenever it landed, so archive plays joined populations of days
  they had not played. First write wins WITHIN one revision; solving a
  corrected revision replaces the retired version's row, so the population still contains
  exactly one row for that player. The request's DynamoDB idempotency token includes the
  revision too, or the replacement is discarded as a replay before its condition is read.
  The puzzle route's malformed-param and future +1-day guards apply; a population is never
  created for an unpublished puzzle.
  *(What #203 retired here: the POST itself, its pre-#216 player credential + score +
  Turnstile body,
  the server-side Turnstile verification, the range validation against the daily, and the
  client-side ask-until-recorded rule of 2026-08-20 that leaned on the write's idempotence.
  The `x-amz-content-sha256` OAC contract still governs every OTHER live POST — /profile,
  /friends, /board and /round — unchanged: hash the exact UTF-8 body bytes you send, and
  never reserialize after hashing; local `backend:dev` has no OAC and cannot surface a
  missing hash.)*
- **The histogram is DERIVED from the day's rows at read time (#187), subsuming the #169
  bucket counters** — per-player rows are a strict superset, and two stores answering
  the same question would drift, so the counter items and the fixed bucket edges are
  gone (no-back-compat rule). The response keeps the shape the solved screen consumes
  (`{ buckets, total, bucket }`, inclusive ranges) with the bands now **one exact band
  per distinct recorded score, ascending** — a day partition is small, one Query +
  compute in the handler. An empty population is honestly `buckets: []`.
- **A score's LIMITS were gameplay limits, and #203 retired the sentence one outright.**
  Sentence mode counts unique vocabulary-valid tries, and the server now COUNTS them off
  the log it stored — there is no claimed number left to bound, so the existence-set
  ceiling is gone (`VOCAB_BUILDS` still says which languages are supported and how long a
  stored guess may be, #200/#201). Word mode's remains, as a FIELD check rather than a
  score check: an end-of-run log may claim at most the distinct claimable ranks in that
  artifact, bounded by the ONE shared `WORD_CLAIM_ZONE` constant (`shared/src/scores.ts`,
  consumed by web + backend). The bands the API returns are derived from the recorded rows
  (#187); consumers render the ranges returned by the API rather than restating them.
- The hashed-IP dedup stays as a **volume sanity floor** under the per-player rows: the
  write dedups by `HMAC-SHA256(client IP, server secret)` and **never stores a raw IP**.
  Up to **5** recorded rows are allowed per `(date, lang, mode, ipHash)`; the dedup item
  expires after 48 hours. Creating a player's row performs its conditional count update
  and create-only put in one DynamoDB transaction, so a capped/failing/duplicate request
  cannot change just one half. Replacing that SAME row for a new published revision does
  not spend another allowance: it adds no player to the population, and uses a separate
  one-item conditional transaction. What is retained is the score row — `(date, lang,
  mode)` partition, `publicId` sort key, `score` + `submittedAt` + `revision` — keyed by the
  server-assigned account id, no personal data. **Since #203 it is the ROUND route that spends the
  allowance**, on the write that first records a finished round.
- **Population reads intentionally do not filter rows by the current revision**
  (user-accepted 2026-08-22). A player who solved the retired version and never returns may
  remain in that day's population; a player who solves the correction replaces their one
  row. Scoping `/board` would make that live read depend on the puzzle store, which it
  deliberately does not, and a republish is exceptional recovery from a broken puzzle.
- **The client IP the dedup hashes arrives in `VIEWER_IP_HEADER` (`shared/src/scores.ts`),
  stamped by a CloudFront viewer-request FUNCTION — corrected 2026-08-16, superseding
  "the origin-request policy forwards CloudFront's trusted viewer address".** That older
  rule cannot be implemented: a live POST needs two things at the origin and NO single
  header mode carries both. *(It was written for the /scores POST; since #203 the routes
  that need a trusted address are `/scores`'s successor writes on `/round` — the
  Turnstile-gated round start and the score row — and the function is associated with BOTH
  behaviors.)*
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
  `shared`: infra writes it, the backend reads it, and a drift is a 500 on every gated
  write that no local run and no synthesized template can reproduce.
- `/scores` has its OWN zero-TTL CloudFront behavior because the histogram is live; it must
  never inherit the puzzle's year-long `s-maxage`. Its query allowList is exactly the
  parameters the handler reads (`lang`, `date`, `mode`, and since #203 `id` — the caller's
  PUBLIC id, which is what makes the answer's band theirs), and its origin-request policy
  carries the viewer-supplied `x-amz-content-sha256` outside the cache key. Local
  `backend:dev` uses the same handler with an in-memory row store and an explicitly
  local accept-all Turnstile verifier.

### Player profile (#188, decided 2026-08-18)

- **Non-unique display name + a 10×10 palette pixel avatar, hung off #187's identity.**
  The ONE handler serves `GET /profile?id=<publicId>` (the public row: name + avatar —
  what a board renders, and what a freshly linked device loads; 404 = never customized)
  and `POST /profile` with `{ token, name, avatar }` (the pre-#216 body carried the shared
  player credential instead) — an
  authenticated upsert keyed by the ACCOUNT the caller's device token resolves to, a
  separate write path from scores. The `/scores` behavior rules
  re-apply: zero-TTL CloudFront behavior, query allowList = exactly the ONE parameter the
  handler reads (`id`), `x-amz-content-sha256` over the exact body bytes on a production
  POST. No Turnstile and no IP dedup here — the device token is the auth, and an overwritten
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
- **The link is `<site>/i/<publicId>`**, and since 2026-08-20 it is TWO paths doing one job
  (`shared/src/invite.ts`; `web/src/screens/FriendInvite.tsx` is the landing). The landing
  shows WHO invited over ONE primary ADD FRIEND button, and the TAP records the edge and
  continues into the game (user-decided 2026-08-24, superseding the auto-add on open: a
  page load must not create server state), so ONE link is still both "add me" and "come
  play". A brand-new visitor's device identity is deployed by that same tap (#216's
  trigger rework), so the edge lands before their first game — this is also the invite
  funnel. The id is
  validated wherever it is READ, so a broken link is an unknown path rather than a request.
  **The RESULT share link
  (`/s/<token>`) is deliberately NOT the carrier:** it is CDN-cached for a year on a cache key
  of `lang`/`date`/`mode`, so an inviter parameter would either fragment that cache per player
  or — unlisted, with no origin request policy on that behavior — never reach the origin at all.
- **The invite link PREVIEWS AS THE PLAYER (user-decided 2026-08-20), which is why the link
  itself is now SERVER-rendered.** A pasted `/i/<publicId>` used to be a plain SPA route, so
  every chat unfurled it with the app's stock card — the same picture for every player. The
  backend serves that path instead: `GET /i/<publicId>` reads the player's profile row and
  answers a preview page whose card (`GET /og/i/<publicId>.png`) draws THREE things — their
  MARK, their NAME, the APP NAME — and whose title says the same two in text. **Nothing more,
  and nothing reading "friend invite":** a person sent this link to a person, so the message
  around it already says what it is; the card only has to say WHO. It draws the ASSIGNED
  identity (`anonName` / `defaultAvatar`) for a player who never customized one, so the face
  in the chat is the face their friends' boards show.
  - **The SPA landing moved to `/join/<publicId>`, and it still does the whole job.** The
    preview page renders the OG tags and `location.replace`s onto it — the `/s/<token>`
    page's own shape, for its reason: a crawler stops at the tags, a human lands where the
    link goes. The paths had to SPLIT because CloudFront routes on PATH ALONE, so one path
    cannot be both the origin-rendered preview and the SPA route under it. The SHARED
    spelling is the one that stayed put, so every link already in the wild simply gained a
    preview.
  - **Three packages agree on those paths, which is why they live in `shared/src/invite.ts`**
    (`VIEWER_IP_HEADER`'s rule): INFRA hands `/i/*` to the API origin, the BACKEND answers it
    and writes the landing into its redirect, and the WEB builds the link and parses the
    landing. A drift is an invite that silently lands nobody on a board — and it is invisible
    in local development, where there is no CDN in front of the SPA and `/i/*` never reaches
    the backend at all.
  - **The preview is cached SHORT (300s), where a share card is cached for a year:** a share
    token is content-addressed, and the player behind an id is not — they can rename
    themselves or redraw their mark. A profile read that FAILS still draws a face (the
    assigned one, the board's own fallback) but answers `no-store`: holding that at the edge
    would put a stranger's face on a player who drew their own.
  - **Reading it needs no authentication and grants nothing**, exactly like `/board`'s `id`:
    a publicId is broadcast by design (an invite link IS one), the route only READS a public
    profile, and the edge is still written by the landing with the clicker's own key.
- **The graph is SERVER-side** precisely because the sender's device is not present at click
  time: only a stored edge lets one click benefit both sides. It follows the DERIVED publicId,
  so restoring a key restores the friends with it — nothing to migrate. (Its side benefit is
  the pre-launch analytics: edges plus score rows answer how many players arrive by invite,
  whether friended players retain better, and how big groups get.)
- **ONE route, POST-only: `POST /friends`** — `{token}` reads your list, `{token, add}` links,
  `{token, remove}` unlinks, and EVERY call answers `{ friends: [publicId] }`, so a client is
  never left guessing what a write did. Every call is a POST because the auth travels in the
  BODY, never a query string (#187's secret; the DEVICE TOKEN since #216) — which is also why
  the READ is a POST:
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
    caller's PUBLIC id — never the token, so it may travel in the query — and widens
    the answer with a below-the-cut window. **Nothing BINDS `id` to the caller, and
    that is deliberate:** anyone holding a publicId can read that player's window
    (score, rank, profile) for any served day. publicIds are broadcast by design —
    an invite link IS one (#189) — and a stranger holding one can already reach the
    same scores by accepting that link, so the read adds no capability the graph did
    not. The TRUSTED surface is the POST.
  - `POST /board { token }` (+ the same query) — the **FRIENDS board, the trusted
    surface**: the server resolves YOUR edges (#189) plus yourself, so the read proves
    who is asking — the device token in the BODY, the /friends rule. Production POST needs
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

*(Resolved 2026-08-22: nothing identified a rank-map revision, so a same-sentence
correction was invisible to every check — and since rank 0 is a GROUP, that is exactly what
moves. The user decided that a republish means the puzzle contained an error, so the round it
retires may simply START OVER. `puzzle:publish` now stamps a `revision` on the puzzle and its
slice by hashing the full puzzle content (rank maps included), the client sends it, and a
changed one resets the local round — see the #203 section above.)*

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
