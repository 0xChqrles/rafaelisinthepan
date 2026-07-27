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
`packages/generation` (the Python generation scripts + `embedding/` data),
`packages/benchmark` (the offline LLM benchmark harness), and
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
      build_lemmas.py         offline builder: Lexique/AGID -> wordlist/<lang>.lemmas.tsv.gz (form→lemma, #104)
      build_forms.py          offline builder: Lefff 3.4 -> wordlist/fr.forms.tsv.gz (verb morphology, #119)
      build_vocab.py          reduced vectors -> web/public/vocab/<lang>.json (escape hatch; no re-reduce)
      slug.py                 stdlib-only: slug() contract + write_vocab (shared by reduce + gen_phrase)
      embedding_neighbors.py  shared load/vocab/matrix/cosine-rank logic
      glove_neighbors.py      en paths + derived .kv cache (thin wrapper over the above)
      french_neighbors.py     fr paths + derived .kv cache (thin wrapper)
      start_word.py           start/hint-word selection (rank band 50-150)
      distances.py            stdlib-only: dq quantization + road clustering (#115)
      gen_phrase.py           one sentence -> one self-contained puzzle JSON
    embedding/<lang>/...      raw + *_reduced vectors + derived .kv caches
    wordlist/<lang>.txt.gz    versioned hors-dico reference wordlist (#38); .cache/ gitignored
    wordlist/<lang>.lemmas.tsv.gz  versioned form→lemma table (lemma grouping, #104)
    wordlist/fr.forms.tsv.gz  versioned lemma+trait→forme table (display agreement, #119); fr only
    wordlist/fr.forms.LICENSE the LGPL-LR text governing the Lefff data it derives from
    output/word/<lang>/<s1>_<s2>_<s3>.json   generated puzzles (gitignored; publish to store/S3)
    pyproject.toml, uv.lock   Python project (uv)
  benchmark/                  offline LLM puzzle benchmark (pkg @whippin/benchmark, #68)
    scripts/llm_play.py       LLM player/referee; reads generation output + web vocab
    scripts/playbook_distill.py  92-puzzle ultra analyst -> critic playbook distiller (#88)
    datasets/strategy-fr-92/  frozen static distillation corpus (92 gzipped puzzles)
    playbooks/                versioned final critic-only model playbook profiles
    tests/test_llm_play.py    provider-adapter + game-rules parity tests
    output/                   full local benchmark/distillation records (gitignored)
    pyproject.toml, uv.lock   isolated Anthropic/OpenAI + Kimi transport dependencies (uv)
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
    src/heat.ts               heatColor() — heat ramp (rank exponents + floating hits ONLY)
    src/progressColor.ts      progressColor() + progressEmoji() — progress ramp (progress bar, selector badge, run rulers incl. the card, share-text emoji row); shares ramp.ts
    src/index.ts              re-exports
  web/                        React + Vite + TS front (pkg @whippin/web)
    src/
      hooks/useVocab.ts       fetch+cache the per-language existence Set (once per session)
      hooks/usePuzzle.ts      fetch the client-computed day's puzzle from the backend
      api.ts                  backend client: puzzleUrl/todayUrl, 404->NO PUZZLE
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
- **`benchmark` is fully OPTIONAL (#68, decided 2026-07-07; schema v2 decided
  2026-07-12 on #68; VARIABLE-LENGTH recorded-set + client-side display filter decided
  2026-07-20 on #81):** absent stays byte-compatible with every existing puzzle. When
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
- **Inflected forms of one word are ONE ranked group (#104, decided 2026-07-20):** on
  the closest-first walk, a word sharing a lemma with a closer word consumes NO rank;
  the closest form is the group's canonical entry, and every other reduced-vocab form
  of the group's lemma(s) is an extra **alias key** pointing at the same
  `{word, rank}` (typing `privées` finds — and displays — `privé`). The secret is
  group 0, so **an inflection of the secret solves the hole** (`vermines` solves
  `vermine`). Grouping is **strict** (the committed Lexique/AGID form→lemma tables;
  no transitive merge across groups that share a form); an ambiguous form (`portes` →
  porte/porter) aliases to whichever of its groups ranked **closest**. Merging is
  filter-then-cap: `TOP_K` counts **distinct groups**, so ranks stay compacted. Two
  selected secrets in one lemma group are rejected at generation.
- **Rank semantics:** secret = `rank 0` (perfect); nearest lemma group = `1`; larger =
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
    `ROAD_TOP = 150` survives only as the **ceiling** on that zone — the start band tops
    out at 150, so it bites only on a start hand-picked outside the band, where it keeps
    the clustering (and the shipped fields) bounded. Deterministic average-linkage
    agglomerative clustering over cosine distance, best `k ∈ {2,3,4}` by mean silhouette,
    **falling back to ONE road (all `road: 0`) below `ROAD_MIN_SILHOUETTE`** — mandatory,
    because some neighborhoods genuinely have a single facet. Roads are numbered by their
    **closest member's rank**, so the road holding rank 1 is `road: 0`. `--no-roads`
    skips them; **`dq` has no opt-out** — it is part of the schema.
  - Both are **GROUP properties**, like `word`/`rank`: every alias key of a lemma group
    carries its group's values, and slug-collision resolution keeps the winning (closest)
    group's. Both are **OPTIONAL to every consumer** — no puzzle published before #115
    carries them, and they must keep working untouched.
- **Slug collisions** (`côté`/`coté` → `cote`): keep the **smallest-rank** entry
  (built closest-first) and display its `word`. Resolved **silently** — generation
  prints no collision output.

### Display agreement: one source per responsibility (#119 addendum 3, decided 2026-07-26)

The words a hole can display are re-inflected to agree with the sentence. The data
behind that has **three sources and one responsibility each** — this split is decided,
not provisional:

- **Lefff 3.4 is THE authority for verb morphology** — surface form, verb lemma, mode,
  tense, person, number, participle gender. `build_forms.py` (`pnpm forms:fr`) reads
  the **pinned** morphology-only `.mlex` release (exact URL + sha256, verified before
  the archive is opened) into `wordlist/fr.forms.tsv.gz`. Its composite tags are
  **expanded** into the internal feature vocabulary — `PS13s` is four cells, `Km` is a
  masculine participle in both numbers — and never become opaque features. Lefff
  compiles paradigms through inflection classes, so a cell exists because the paradigm
  has it. **fr only.**
- **Lexique383 is POS-frequency evidence ONLY** for this table. It decides whether a
  homographic surface may be *read* as a verb, and which of two spellings is preferred;
  it no longer describes a single conjugation. It stays the source of the #38 wordlist
  and the #104 lemma table, which is a different question.
- **The reduced vocabulary is the sole typability authority** — a rewritten display
  form is usable only when its slug is in the existence set.

Consequences that are load-bearing:

- **The POS gate has two cases.** With Lexique frequency for the surface, the verbal
  category (VER **and** AUX — an auxiliary is a verb) must beat every rival, so
  `évident` is never read as a verb. Without frequency, admit only when Lefff gives
  verb analyses and **no** competing non-verbal one, so `accoutumes` is admitted and a
  cross-POS homograph is declined rather than guessed. A gated form stays a legal
  **target**: `pensée` still realizes `penser/par:pas:f:s`.
- **Ambiguity is described, never arbitrated.** Lefff states the cells a spelling
  genuinely shares, so more secrets are ambiguous than under a corpus tagger (`épuises`
  is `ind:pre:2s` *and* `sub:pre:2s`). Those ask on a TTY or need `--form`; nothing is
  guessed. **This has a real cost, and it lands on batch runs:** of the reduced-vocab
  surfaces the gate admits, auto-resolution fell 84.8% → **72.3%** (7,077 → 12,974
  ambiguous of ~46.9k), and present-tense secrets are hit systematically (`PS2s`,
  `PS13s`). A piped `--words` run with a `tu …` verb hole therefore reproduces the #119
  artifact (`t'distraire`) unless `--form` is passed, where the corpus tagger's
  arbitrary pick used to agree it silently — sometimes wrongly. That trade is deliberate.
- **#104's lemma grouping is NOT affected.** `wordlist/fr.lemmas.tsv.gz` keeps its own
  source and content: feeding Lefff's inventory into `merge_ranking` would regroup
  neighbours and change puzzle geometry even under `--no-inflect`. Replacing the
  general lemma-grouping dataset is a separate decision.
- **Licensing travels with the artifact.** The Inria page labels Lefff CeCILL-L while
  the downloaded 3.4 `.mlex` archive ships its own **LGPL-LR** `LICENSE`; the notice
  accompanying the exact distribution governs it, so the derived table carries a `#`
  provenance header (release, URL, digest, licence) and the verbatim text is committed
  as `wordlist/fr.forms.LICENSE`. Don't distribute the table without them.

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
  rank 0 plus its `K` nearest **distinct lemma groups** (#104), each with its alias
  forms. The front is **K-agnostic** — it tests membership in the map, never
  hardcodes 2000.

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

For each unique secret slug, with `N = number of ranked GROUPS in ranks[secret]` —
the count of **distinct rank values** (alias keys share their group's rank, #104;
on an alias-free puzzle this equals the key count):

```
s(rank)   = 1 - ln(rank + 1) / ln(N + 1)              // s(0) = 1 (solved)
p_hole    = (s(rank) - s(start_rank)) / (1 - s(start_rank))   // 0 at start, 1 solved
progress% = 100 * average(p_hole over unique secret slugs)
```

Rendered occurrences of the same secret slug share one logical progress target. They
remain separate runtime holes for positions, feedback, animation, and solved rendering,
but duplicate occurrences do not receive extra weight in the frontend percentage.

### Score

The score is simply the **number of unique tries**. A try is a submitted word that
exists in the per-language vocabulary set, including cold misses and non-improving
warm hits. Repeated guesses are deduped by **canonical identity** (`guessKey`,
#104): a guess found in some rank map is identified by its resolved entry — the
first secret (JSON key order) whose map knows it, plus that entry's rank — so accent
variants AND inflections of an already-tried word count once; a guess in no map (a
cold miss everywhere) falls back to its folded slug (`fold(raw)`). The uncounted
variant plays its feedback but never enters the persisted `tried` history. Invalid
non-words are rejected before counting. The score is displayed as the large background number during the round and
as `<tries> TRIES` at game end (the unit is NAMED — on the solved screen, the share
card, and the share text — because "SCORE" alone reads as points to maximize when
lower is better; singular `TRY` at 1). Like the rest of the UI chrome the label is
localized (fr: `ESSAIS`/`ESSAI`, decided 2026-07-06); the unit stays named in every
language. The solved tray shows the named `<tries> TRIES` headline on EVERY surface
(decided 2026-07-25, superseding #110's headline-omitted-next-to-the-table exception:
the leaderboard moved behind SEE MORE into its own full-screen dialog, whose player row
also carries the count). The share card/text always name the unit.

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
  `packages/shared`, `packages/web`) and pytest (`packages/generation`,
  `packages/benchmark`). The slug/fold
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
- **Don't lemma-merge anywhere except `gen_phrase`'s merge walk (#104)** — the front
  and the benchmark harness only LOOK UP alias keys, never re-group; and **don't
  silently skip a missing lemma table** — error out (`--no-lemmas` to opt out
  explicitly).
- **Don't skip the cache mtime check** in `load_vectors`.
- **Don't inject a missing target word** into the vocab in `gen_phrase` — error out.

---

## Commands

Uses **pnpm** (workspaces in `pnpm-workspace.yaml`, version pinned via the root
`packageManager` field). Each root script runs from the repo **root** (it delegates
to the right workspace via `pnpm --filter`) or from inside the package directly. The
generation scripts are scoped to `@whippin/generation`, while the LLM harness is scoped
to `@whippin/benchmark`; reduce/gen paths below are relative to `packages/generation/`.
Unlike `npm`, **pnpm forwards args straight to
the script — do NOT add a `--` separator** (a literal `--` is passed through and
breaks `gen_phrase.py`'s arg parsing).

```bash
pnpm install                    # installs all workspaces

# 0. (Re)build the hors-dico reference wordlist ONCE per language (offline, #38). The
#    committed wordlist/<lang>.txt.gz is already versioned — only rerun to refresh sources.
#    Needs `unmunch` (hunspell-tools; `brew install hunspell`) for the Hunspell union, or
#    pass --skip-hunspell for the Lexique/SCOWL-only union.
pnpm wordlist:fr      # Lexique ∪ Hunspell fr  -> wordlist/fr.txt.gz
pnpm wordlist:en      # SCOWL   ∪ Hunspell en  -> wordlist/en.txt.gz

# 0bis. (Re)build the form→lemma table ONCE per language (offline, #104). The committed
#    wordlist/<lang>.lemmas.tsv.gz is already versioned — only rerun to refresh sources.
pnpm lemmas:fr        # Lexique ortho→lemme -> wordlist/fr.lemmas.tsv.gz
pnpm lemmas:en        # AGID infl.txt (inverted) -> wordlist/en.lemmas.tsv.gz

# 0ter. (Re)build the verb lemma+trait→forme table, fr ONLY (offline, #119 addendum 3).
#    The committed wordlist/fr.forms.tsv.gz is already versioned — only rerun to refresh
#    sources. Morphology comes from the PINNED Lefff 3.4 .mlex release (digest-verified);
#    Lexique is consulted for surface frequency only. Also writes wordlist/fr.forms.LICENSE.
pnpm forms:fr         # Lefff 3.4 -> wordlist/fr.forms.tsv.gz (+ .LICENSE)

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
#    Reads wordlist/<lang>.lemmas.tsv.gz for lemma grouping (#104; missing table = hard
#    error, --no-lemmas to skip). Every ranked group is annotated with its dq distance
#    and, for the groups from the hole's start word in to the secret, its road cluster
#    (#115); --no-roads drops the road fields, dq has no opt-out.
pnpm gen:phrase "<sentence>" --lang fr --words a b c   # exactly 3 distinct words; all occurrences hole (no `--`)

# 4. Optionally benchmark the generated puzzle offline before publish. --model is required
#    and runs exactly one model. Missing API-provider keys skip with a warning; --effort applies
#    one reasoning level (none|low|medium|high|xhigh|max; default none). --auth api
#    (default) uses the selected provider's API key; --auth subscription uses authenticated
#    Claude.ai / saved ChatGPT Codex-plan access, or Kimi Code with KIMI_CODE_API_KEY.
#    GPT API runs allow the documented
#    none|low|medium|high|xhigh|max; ordinary Codex-plan play supports
#    low|medium|high|xhigh|max. Kimi K3 is a display model, requires subscription auth,
#    rejects none, and maps medium/high -> high plus xhigh/max -> max. --session
#    persistent|stateless defaults to persistent: one native provider conversation per
#    run is the primary product benchmark; stateless reconstructs the complete public
#    record in fresh turns for diagnostics. The historical frozen shared gameplay baseline
#    is prompt v21 at medium effort with NO --playbook. The current harness is prompt v23;
#    do not mix its results into v21 comparisons. --playbook remains an experimental loader only;
#    the static-corpus playbooks are paused and must not be used for benchmark scores.
#    --selection median|best chooses the saved representative (default median). Median
#    requires odd sequential --runs and cost-prunes only provable upper-half tails or after
#    a cap-DNF majority (one run never prunes); best accepts any positive count and stops an
#    unsolved later run once its tries equal the incumbent best score. Puzzle paths may be
#    repo-root-relative (packages/generation/output/...) or generation-package-relative
#    (output/...).
#    --in-place appends the full local lab artifact AND upserts the tested model's lean
#    entry into the puzzle's variable-length benchmark array (any model — the front end
#    filters the FABLE/KIMI/GPT-SOL display trio; a re-run replaces that model, a now-stale
#    entry is pruned). It accepts only the canonical config: median + persistent + current
#    prompt + at least 3 odd runs — and --runs already defaults to 3 for EVERY model, so no
#    selector (Kimi included) needs an explicit --runs 3. Both writes are file-locked, so
#    overlapping runs for different models accumulate instead of clobbering each other.
pnpm bench:puzzle <puzzle.json> --model MODEL [--playbook <model>.playbook.json] [--effort LEVEL] [--auth api|subscription] [--session persistent|stateless] [--cap N] [--runs N] [--selection median|best] [--in-place]
KIMI_CODE_API_KEY=... pnpm bench:puzzle <puzzle.json> --model KIMI --auth subscription --effort medium --in-place

# 5. PAUSED EXPERIMENT: bootstrap one model's playbook from all 92 static French puzzles
#    (#88). Do not run this for normal benchmark production. Each real
#    run makes exactly two resumable paid calls: unrestricted analyst, then independent
#    critic/rewrite. Workflow-level ultra maps to Sonnet adaptive+max, Codex-plan GPT
#    literal ultra, or GPT API max+Pro. --dry-run validates all inputs and reports exact
#    identities/call count without auth checks, writes, or provider calls. Raw outputs
#    are gitignored; selected final-only profiles are versioned under benchmark/playbooks/.
pnpm bench:playbook:distill --model SONNET --auth subscription [--dry-run]
pnpm bench:playbook:distill --model GPT-SOL --auth subscription [--dry-run]

# Local backend harness (@whippin/backend, #17) — no AWS creds needed.
pnpm puzzle:publish <puzzle.json> [--day YYYY-MM-DD] [--s3]  # default: local + active day; --s3 -> the deployed bucket (stack output)
pnpm puzzle:inventory [--s3] [--days N] [--langs en,fr] [--ci]  # publish-buffer coverage (#61); reports + exits 0 by default, --ci exits 1 on any (day,lang) gap for cron/CI
pnpm backend:dev                # local server (GET /?lang=, /today) on :8787 over the local store

# Front end (@whippin/web)
pnpm dev                        # dev server (set VITE_API_BASE_URL=http://localhost:8787 for the local backend)
pnpm build                      # production build -> packages/web/dist
pnpm typecheck                  # tsc --noEmit
pnpm test                       # invariant tests: Vitest (web + shared + backend) + pytest (generation + benchmark)
```

`gen_phrase.py` requires **exactly 3 distinct** `--words` selectors after slug
normalization; each must appear in the sentence (matched by slug) and must have survived
reduction. Every matching sentence occurrence becomes a hole, while the output filename
contains the three distinct secret slugs in sentence order. Front-end dev harnesses:
`?tutorial=1` forces the tutorial, `?streak=N` previews the streak celebration
(dev only). There is **no `?puzzle=` file override** — the front always loads the day's
puzzle from the backend (test a specific puzzle by publishing it to the local store, see
`pnpm puzzle:publish`).

---

## Current state / mutable

*(Safe to update without touching the invariants above.)*

- All paths below are under `packages/`. **Tunables:** `TOP_N = 400000` (reduce),
  `TOP_K = 10000` (gen), start-rank band `50–150` (`start_word.py`),
  `ROAD_TOP = 150` (now the road zone's CEILING, not its size) / `ROAD_KS = (2,3,4)` /
  `ROAD_MIN_SILHOUETTE = 0.05` (`distances.py`).
- **Distance annotations (#115):** `distances.py` is stdlib-only (pure arithmetic over
  float sequences), so the contract tests keep running without numpy/gensim and the
  ≤150-point clustering costs a fraction of a second per secret. They are stamped in
  **two passes, because they know different things**: `dq` is a property of the walk
  alone, so `gen_phrase`'s `build_puzzle_rank_map` — the ONE entry point both authoring
  paths use — wraps the structural `build_merged_rank_map` (#104) and stamps it onto
  every entry by its rank; `road` describes the stretch the player travels, which does
  not exist until the start word is picked, so each path calls `annotate_roads` right
  after `choose_start` (and before the agreement pass, so a rewritten form inherits its
  group's road like any other key). Both key off the entry's `rank` alone, which is what
  makes "aliases share their group's values" true by construction. Deferring the roads
  also takes the clustering off the interactive selector's hover path — it now runs only
  for the words actually committed. **Previously published days keep legacy (annotation-free) behavior until
  they are regenerated and republished** — a curator's call, not part of #115. Measured
  on a real fr puzzle (`amer` / `plissés` / `grincement`, ~39k keys per secret):
  **802 KB → 828 KB gzipped (+3.2%)**, raw 5.9 MB → 7.1 MB, and the map is otherwise
  byte-identical. On that puzzle two secrets split into genuinely meaningful facets
  (`amer` → figurative vs taste; `plissés` → participles vs garment nouns) while
  `grincement` scored its BEST silhouette (0.19) on a degenerate 149/1 split — the
  metric rewards isolating an outlier, so a minimum road size is worth considering when
  Part 3 (#115's route modal) puts roads on screen.
- **Route modal (#117, Part 3 of #115):** tapping a HOLE opens its neighborhood drawn as a
  journey. `game/route.ts` is the pure model (`buildRoute`, contract-tested) and
  `components/RouteModal.tsx` renders it; `Game` owns the open state so the guess prompt can
  go inert behind it. **Entry point only where the geometry exists:** `hasRoute` gates on the
  secret's rank-1 entry carrying `dq`, so every day published before #115 (and the tutorial's
  synthetic boards) renders exactly as before — no button, no degraded list view. The hole
  becomes a `<button>` wrapping its existing spans; it is present for the WHOLE round or not
  at all and the solved choreography only `disabled`s it, because unwrapping mid-round would
  remount the word while its scramble is running. **That disabling covers the solving BEATS
  only — a settled solved screen keeps every hole tappable** (fixed 2026-07-27), which is what
  makes the reveal below reachable at all. `exploreDisabled` is therefore
  `!solvedSettled && (promptExiting || solved)`: `promptExiting` catches the start of the beats
  (the prompt leaves on the solving submit, while `solved` still trails the last word's settle)
  but is NEVER reset on a fresh solve — it doubles as "the input is retired" — so reading it as
  a plain veto left every hole dead for the rest of the screen, and the post-mortem was
  reachable only by RELOADING (the rehydrated branch does reset it).
  **Geometry — a LINE, not a to-scale map (redesigned 2026-07-26 on the user's call: the first
  version was "impossible to understand"; the reference is an SNCF trip).** That version put
  `dq` straight onto absolute positions over a 340svh band, which is faithful and unreadable:
  dq's real shape is a steep near field and a very long cold tail (rank 1 = 255, the start word
  ≈ 120, rank 10 000 = 0), so a linear map spends most of its height on emptiness — the
  departure landed two screens below the destination with nothing between them, and you had to
  scroll to find out where you were. The distance now lives in the **LENGTH OF THE CONNECTOR
  between two stations** — but only where the line SKIPS ranks. **Consecutive ranks are one row
  apart whatever their dq** (decided 2026-07-26): with every near-field group drawn, the rank
  ladder already says they are adjacent, so a proportional connector there buys nothing and costs
  one glaring outlier — dq pins rank 1 at the top of its scale, so 1 and 2 are always further apart
  than any other pair of neighbours. Out on the trunk, where the player's guesses are sparse, the
  length is the only thing carrying the distance and stays proportional
  (`linkHeight`: `LINK_SPAN` px per full dq scale, floored at `LINK_MIN`
  so neighbours never collide, capped at `LINK_MAX` so the cold tail cannot push the
  destination off screen). That is the SAME information — dq differences are all dq means — and
  on a real fr puzzle it took the map from **3.9 screens of mostly emptiness to ~1.0**. (It runs
  ~5 screens again now that the full roads are drawn — see the near field below — but every row is
  content: what was wrong with the first version was the empty space, not the length.) The
  identity leap and the cold end above the first station stay broken traces: neither is a
  distance. **Both are cut to a WHOLE number of the dash unit** (`dashedRun`, fixed 2026-07-27):
  the unit is 5px of line + 8px of nothing, declared once in `RouteModal` and handed to the
  gradient as `--dash` / `--dash-period`, and a run is `n` units PLUS its closing dash. Any other
  height cuts the last unit wherever it falls and the stub lands exactly where the trace meets the
  solid rail — `TAIL_H` 34 ended on 3px of gap against the first station, which reads as a
  rendering slip rather than a broken line. So the heights are DERIVED (34 → 31, 56 → 57), never
  typed. `--route-band-h`,
  the old lane geometry (`stopX`/`labelSide`/`laneNameFont`) and the axis contours are all gone
  with it.
  **The line is TRAVELLED, so it runs departure → arrival DOWN the page** (decided 2026-07-26):
  the off-map words at the top past the torn break, every station reached farthest first, and
  the word itself at the bottom. It **opens with the CLOSEST word you have reached sitting at the
  bottom edge**, a few pixels short of it (decided 2026-07-26): the ground you have covered fills the screen above it, and
  what is still ahead — the words closer than yours, and the destination — waits just below the
  fold. A solved hole has no "here", so it opens on the terminus instead. Measuring that row is
  the subtle part and the reason it is done with an inline `position: static`: it is the STICKY
  one, and a sticky box reports its PARKED position (offsetTop and its rect alike), so at
  scrollTop 0 it has already pinned itself to the bottom and measuring it there just hands back
  the viewport height. Suspending the stickiness for the read is safe because this is a layout
  effect — a synchronous write-read-write before paint, none of which reaches the screen.
  **`showModal()` is its OWN layout effect, and the FIRST one** (fixed 2026-07-27): a closed
  `<dialog>` is `display: none`, so until it opens there are no boxes to measure and the row's
  offsetTop/offsetHeight and the scrollport's clientHeight all read **0** — not a small error but
  a total one. A natural position of 0 makes EVERY scroll offset test as "parked at the top", so
  the torn separator sat under the row for the modal's whole life, and the opening scroll clamped
  to the top of the line. **Dev could not show it:** StrictMode re-runs layout effects after
  mount, by which point the dialog is open, so it only ever appeared in a build — check this one
  with `pnpm build` + `vite preview`, not `pnpm dev`. The parked test also carries a
  **1px `STICK_SLACK`**, because the opening view lands the row EXACTLY on the bottom threshold by
  design and sub-pixel scrollTop would otherwise decide the separator by coin toss.
  Every row lays out on the same three
  columns — the rank in a right-aligned gutter (the "time"), the rail, then the word — which is
  what makes the rail read as one unbroken line; each cell **names its grid column**, because an
  item with a definite ROW span is auto-placed BEFORE the fully-auto ones and leaving them
  implicit silently reorders the columns.
  **The map carries NO labels** (decided 2026-07-26, superseding the `ARRIVÉE` / `VOUS ÊTES ICI` /
  `DÉPART` / `ROUTES` tags tried the same day): every one of those is said by a node's size,
  fill and lane instead, and the only string left on it is `routeOffMap` — the words above the
  torn break have no node, no lane and no distance, so nothing about them can be read off the
  drawing. The screen-reader mirror still names all four in prose (`srRouteStop`), which is why
  dropping them costs no information. Fixed-width `???` is the ONE token for "you have not found
  this word": the destination and every censored station wear it.
  **The censored near field is the WHOLE of it** (decided 2026-07-26, superseding the top-5 band):
  every group of it renders as a station with its word withheld, so each road shows its real
  **length and population** — the one thing a list of your own guesses can never say. Its extent
  is **entirely the DATA's**: the near field IS the road zone, and generation ends that at the
  **DEPARTURE** — the line is a journey and it begins where the puzzle put you down, so anything
  farther than the start word is behind you rather than ahead. That alone took a real fr map from
  ~8 screens to ~5. The bound has **ONE owner** (decided 2026-07-26, superseding the same day's
  first cut, where generation shipped a flat top-150 and `buildRoute` clipped it back here): the
  side that stops SHIPPING the roads is the side that decides where they end, so this module just
  reads `geometry.nearTop` and the clip is gone. The departure is **inside** the zone — you are
  put down on a road, so the fork is drawn just before it and its station sits on a lane (muted
  node, word dimmed to 62% in that lane's colour). The player's own guesses past it are still
  stops — they simply ride the trunk. The censored list ends one rank inside the departure for
  free, because the departure is itself a STOP and a stop is never listed twice. `APPROACH_TOP = 5` survives only as the FLOOR, for a
  `--no-roads` map that has no near field to bound and would otherwise draw none at all.
  **Solving REVEALS the whole neighborhood** (decided 2026-07-26): while the round is live a
  censored station is a position and a lane and nothing else (`RouteHidden.word` is `null`); once
  the hole is solved every one of them gives up its canonical form and the map becomes the
  post-mortem — each word in its ROAD's colour, so a secret's distinct senses finally read off the
  page, dimmed and on the small node so what you FOUND still stands apart from what was merely
  there. **The sr mirror enumerates what has a WORD and counts what does not**: the player's stops
  always, the revealed neighborhood once solved, and `srRouteRoads` ("100 stops across 3 roads
  (56 / 25 / 19), 4 found") standing in for the censored ones — ~100 items of "rank 87, hidden"
  would bury the words the player actually knows, and the count is what they say collectively.
  **Every node is a FILLED square** — outline-only stops were removed the same day. What a stop
  IS comes from size + fill: found `--fg` 15px, the handed-out departure `--muted` 15px with its
  word at 62% opacity (the map's quietest station — you were GIVEN it), "you are here" `--hole`
  gold 21px, an unfound approach station its own lane's colour at 11px, the terminus 23px
  (`--accent` once solved).
  **Roads are LANES of the rail, not a badge** (decided 2026-07-26, superseding the RER letters
  tried the same day — a small letter beside the word was too weak to read): the rail is as wide
  as the neighborhood has roads, a station sits on ITS road's lane, and the trunk forks into them
  (`Junction`) coming in from the far field and merges back out of them into the word. That is
  structural — you read a road off the shape of the line — and it makes the one fact a list
  cannot state visible for free: **a road nobody has reached is a lane with NO stations on it.**
  Both junctions keep the SAME fixed height, and the distance preceding the fork rides in front of
  it as an ordinary trunk link rather than being folded into it: absorbed, it made the junction as
  tall as whatever gap came before, leaving the first lane station far below the bus while the
  merge at the other end hugged its last one. The two ends of the fork have to mirror each other —
  15px from bus to station at both.
  Lane centres live in `RouteModal` (`LANE_X0`/`LANE_GAP`) because the node positions and the
  `--lane-lines` gradient that paints them must agree exactly. Each lane is **as vivid as the
  rest of the app** (decided 2026-07-26, superseding a first muted set — a metro line's whole
  point is telling it from the next one at a glance): `LANE_COLORS` (≤ 4 — `ROAD_KS` caps roads
  there) takes four far-apart hues from the **progress ramp's own stops**
  (`shared/progressColor.ts`) rather than inventing a palette, COPIED not imported, because that
  ramp means "progress" and these mean "identity". Pink leads, never cyan: lane A always holds
  rank 1 and cyan is what the heat ramp paints a rank-1 number, so leading with it would imply a
  rule that isn't one. Gold is "you" and blue is solved, so no lane may borrow either — and
  `--rail` stays the ONE unsaturated line on the map, because the trunk is exactly the stretch
  where no road has been identified. **A lane station's WORD is painted in its lane's colour too**
  (`--lane-c`, set per station; `.on-lane`) — the road then reads off the type as well as off the
  line, with nothing added — while a trunk word stays `--fg`, because above the fork there is no
  road to name. An UNFOUND station's node takes the same colour: a dark node on a vivid lane reads
  as the line being BROKEN, where the lane's own colour reads as a stop with no name on it yet.
  The junction **bus is painted in the lanes' colours, split at the trunk** (`busGradient`), not
  in one neutral bar: a single grey bar at each end of a set of parallel lines reads as a frame
  drawn AROUND them.
  Caveat worth keeping in view: on a real fr puzzle 2 of 3 secrets fork into one big road
  plus a 1–2-group outlier, and an empty lane advertises that outlier as a whole road — honest to
  the data, but see #115's own note above, a minimum road size is still an open question.
  **Word sizes are computed, not measured:** Press Start 2P advances exactly **1em** per glyph
  (measured — the retired `GLYPH_EM = 1.37` was wrong), so `fitWord` shrinks a long word to
  `--wordw / length` rather than letting it break mid-word (`incontestableme/nt` reads as a
  different word). `--wordw` is the one number the CSS has to guess at: it subtracts an **18px
  allowance for a classic scrollbar**, which `100vw` cannot see and which would otherwise make the
  real column narrower than the size fitWord picked. **The rank gutter, by contrast, is MEASURED,
  not computed** (decided 2026-07-26): `.route` is ONE grid and every row a `subgrid` of it, so the
  gutter track is a true `max-content` sized by the widest exponent actually rendered, across all
  rows at once. Per-row grids cannot do that — each would fit its own rank and the rail would
  zigzag — which is why the rows must be subgrid rather than repeat the template. `--gutter`
  (`--rank-size × <widest exponent> + 10px`, set per-modal by RouteModal) survives for the two jobs
  a measured track cannot do: it is the **fallback template** declared before `subgrid`, so a
  browser without it degrades to a computed width instead of collapsing to one column, and it is
  the NUMBER `--wordw` and the parked row's backgrounds need. It also keeps the responsive trick —
  the char count is baked in as a literal while the cell size stays `--rank-size`, so the media
  query shrinks both together (10px → 9px below 360px) without the component knowing: a 17-letter
  word plus four wide roads genuinely does not fit a 320px screen otherwise. Verified no mid-word
  break at 320/360/390/430/900.
  **"You are here" is STICKY on both edges** (decided 2026-07-26): the line can run several
  screens, and the one thing you always need while reading any part of it is where you stand, so
  the `best` row carries `position: sticky` on BOTH offsets — scroll below it and it parks at the
  top, scroll above it and it parks at the bottom, always at the edge it left by. It parks
  `STICK_INSET` px SHORT of that edge rather than flush against it (flush reads as clipped), which
  is one number in three places — the CSS offsets, the opening scroll and the parked test — so it
  lives in `RouteModal` and reaches CSS as `--stick-inset`. A strip fills that margin on the edge
  side: background, so no sliver of the rows sliding past shows through, carrying the lanes SOLID
  so the line still runs all the way out to the edge instead of stopping short of it.
  Its containing block is `.route`, i.e. the whole line, so it travels the entire map. Two things
  follow: it needs an opaque `--bg` to stay legible over the rows it floats above (free
  visually — the station draws its own cross-section of the rail, so the line still runs unbroken
  through it), and **`.route-scroll` may carry no VERTICAL padding**, because a sticky offset
  resolves against the scrollport's padding box and would park the row that far inside the real
  edge; the line's breathing room lives on `.route` as content instead. A solved hole has no
  `best`, so nothing sticks.
  **A parked row shows the GAP it is hiding** (decided 2026-07-26): pinned, the row is drawn hard
  against one it is nowhere near, with an unseen stretch of the line squeezed out between them, so
  the side facing that skipped ground gets **a torn separator — the same dashes the off-map break
  wears**, since both mean the map does not continue straight through there. Below when parked at
  the top, above when parked at the bottom, nothing when the row is simply where it lives (which
  includes the opening view). **`--stick-inset` is the row's ONE margin, used on both of its
  sides**: the same distance holds it off the screen edge and off the separator, so a parked row
  sits centred in its own clearance instead of leaning toward one side; beyond the separator that
  same margin again is what masks the rows really passing behind. The margin on the ROW's side
  still carries the lanes, so the roads run out of the station and INTO the separator: cut short
  they read as a second `--bg` margin, and the separator looks framed on both sides rather than
  ending the line. Two more details that are not decoration — the dashes' gaps are `--bg` rather
  than transparent (over scrolling content, transparent gaps show 3px slivers of what is
  underneath), and the pseudo-element states
  `box-sizing: content-box`, because the global `* { box-sizing: border-box }` does NOT match
  pseudo-elements: `height` there is the SEPARATOR and the borders are the margins, and assuming
  otherwise renders the whole band as one solid block.
  Knowing it is parked needs a scroll listener — the map's ONE piece of scroll JS, and still not
  motion: `readStuck` is arithmetic against `scrollTop` (asking the DOM would be circular, since a
  sticky box reports the parked position either way), and `setStuck` bails out on an unchanged
  value so the ~100-row list re-renders only on a transition. Its natural offset is re-measured
  whenever the model changes, because a guess landing while the map is open can add rows above it
  or make a different station the closest one.
  **The header is the APP's, not a modal's** (decided 2026-07-26): it reuses
  `.topbar-inner` / `.topbar-left` / `.topbar-title` / `.topbar-right` / `.home-btn` wholesale,
  so it cannot drift from the corner-chip policy above — no band, no border, no background, the
  hole's name top-left and one close control top-right. It sits **in flow** above an inner
  `.route-scroll`, which is precisely what lets it paint nothing: with the scroller (not the
  dialog) owning the overflow, no content can ever pass beneath the header, so none has to be
  hidden behind a band. The dismiss-on-backdrop click therefore tests the scroller as well as
  the dialog — the space around the line lives inside it.
  **The LINE has no motion; the OPENING does** (decided 2026-07-27, superseding "no motion at
  all"): the map **zooms out of the word you tapped**, the way a desktop window opens out of its
  icon — the whole dialog, opaque background included, scales from ~0 with its
  `transform-origin` on that word's centre (`route-zoom`, 200ms). It is the transition INTO the
  map, not part of the drawing: the screen that lands reads as that word opened rather than as a
  new screen that replaced it, which is also part of what makes the entry point legible (#129).
  `Game.openRoute` measures `.hole-word-wrap` inside the hole button at open time — the word,
  exponent excluded — and passes the viewport point, which is the fixed full-screen dialog's own
  coordinate space, so the CSS needs no arithmetic; a missing button falls back to dead centre.
  **A transform cannot disturb what this modal measures on open** — the sticky row's natural
  place and the opening scroll are read from `offsetTop`/`offsetHeight`/`clientHeight` in layout
  effects before it ever paints — and that was verified rather than assumed: on a 4.2-screen map
  the opening view is identical with the animation on and forced off. Closing is NOT animated
  (the dialog unmounts). Reduced motion collapses the duration and, with no fill mode, lands on
  the natural scale. Still **no new analytics event** — the three-event invariant stands.
  **"You are here" is read off the HOLE, never off the guess log** (fixed 2026-07-27): a guess
  deduped as a canonical duplicate never enters `tried` (`gameStore.recordGuess`) and can still
  IMPROVE another hole, so the current group can be one the history does not mention. `buildRoute`
  therefore looks the hole's own rank up and visits it as a stop; inferring it from the log and
  falling back to the closest logged one put the marker on a word the player had moved past — a
  rank-5 hole reading as its rank-104 departure, its current word censored `???` on the map while
  the sentence showed it.
  **The hole button is DESCRIBED, not LABELLED** (fixed 2026-07-27): an `aria-label` REPLACES the
  content it wraps, and that content — the word and its exponent — IS the clue, so labelling the
  button deleted it from the button and from the sentence a screen reader reads. The hint moved to
  `aria-describedby`, pointing at an sr-only note `Phrase` renders OUTSIDE the `<p>` (inside it,
  "Explore word 2" would interleave into the prose).
  **A road id may never BE an array length** (fixed 2026-07-27): ids come off the network, so
  `routeGeometry` allocates one lane per DISTINCT road present (`lanes`, ascending → generation's
  contiguous ids are unchanged) instead of sizing by `max id + 1`, where a well-formed
  `road: 4294967295` threw `RangeError`. `api.ts` caps the value too (`MAX_ROAD` 63) — generous on
  purpose, since a rejected puzzle costs the whole day.
  Side effect on the shared input: `WordInput`'s window listener lets a focused BUTTON keep only
  `Enter`, and EVERY editing path in `Game` (`appendChar`, `deleteChar`, `replaceInput`) blurs a
  focused hole button through `releaseHoleFocus`. All three, not just typing: with Backspace and
  history recall leaving it focused, "close the map, fix a typo, press Enter" reopened the map
  instead of submitting (fixed 2026-07-27).
- **Route discoverability (#129, decided 2026-07-27):** #117 made every hole a button and
  nothing said so. Two fixes, both in the show-don't-tell grammar — no permanent chrome, no
  tooltip, no message band (all three considered and rejected the same day).
  **The ambient affordance is the letter WAVE and nothing else** (decided 2026-07-27): every
  few seconds ONE hole ripples its letters (`hole-wave`), quick and transform-only. The
  issue's second motion — a continuous idle brightness/color pulse on every unsolved hole —
  was built, seen, and **dropped on the user's call**; don't reintroduce it. What it cost is
  worth recording, because it is why the surrounding code looks the way it does: to pulse the
  word WITHOUT pulsing the heat-ramp exponent the animation had to ride on
  `.hole-word-wrap` and animate COLOR, which meant `.hole-word` giving up its own `color` for
  `inherit` and a `.hole.tappable` class existing purely as that rule's hook. Both are gone
  with it; `.hole-word` keeps `color: var(--hole)` as before.
  The wave needs per-letter boxes, which did NOT exist — the scramble renders a plain
  string — so `Hole` now splits the word ONCE (`.hole-letter`, used by the resting word and
  the scramble's frames alike; measured against plain text: same height, +0.06px over 5
  letters, and `.hole`'s `nowrap` means the boxes add no wrap opportunity). **The scheduler is
  the round's** (only it knows which holes are unsolved and when the sentence is busy: it
  ripples only a hole whose map can actually be opened, and stands down while a hit is in
  flight, while the map is open, on `promptExiting`, once solved, and entirely under reduced
  motion) but **the hole has the last word** — it alone knows its own scramble is still
  running, and a declined turn costs only a turn. The signal is a tick **PER HOLE**
  (`waveTicks`), never "who is waving": a hole plays on ITS number changing, so a shared
  signal also fired the hole picked previously, whose value fell back — two holes rippling
  from one pick, seen in the browser before it was fixed.
  **The one-time auto-open** is the guaranteed half: the first hole a player EVER solves
  opens its own finished journey — departure, every station visited, arrival — with their own
  data, explaining the feature by being it. `routeSeen` (persist **v4**, defaulted false for
  every older blob — nothing to grandfather, the map shipped with #117) is set by `openRoute`,
  the ONE place a map opens, so a player who found it by tapping is never interrupted.
  `shouldAutoOpenRoute` (pure, in `game/route.ts`) fires only on a mid-round solve — never the
  FINAL one, which belongs to the solved sequence (streak → exits → leaderboard → source) and
  must not gain a competing modal — and names the first newly solved hole in sentence order;
  `Game` filters to holes that HAVE a map before asking. It arms at submit time and waits for
  that hole's own settle report (`resolvedHoleIndices`, the signal the solved gating uses) plus
  350ms, never a guessed timeout. Archive replays included; the tutorial is untouched (it does
  not render `Round`). No new analytics event — the three-event invariant stands.
- **Offline LLM benchmark harness (#68, Kimi provider #91, native sessions #93,
  decided 2026-07-19).** The
  dedicated `benchmark` workspace owns `benchmark/scripts/llm_play.py`, its tests, and
  its provider dependencies.
  It imports generation's canonical `scripts/slug.py`, reads the same web vocab as the SPA,
  and replays folded-vocab existence, unique-try scoring, broadcast rank/MISS feedback,
  strict improvement, solved locks, and the counted-try cap. The singular `--model`
  accepts the seven-model roster's friendly selector (`OPUS`, `SONNET`, `FABLE`, `GPT-SOL`,
  `GPT-TERRA`, `GPT-LUNA`, `KIMI`) or exact id; each invocation runs exactly one model. The
  **display trio** (`display: true`) is **FABLE (`claude-fable-5`), KIMI K3 (`k3`), and
  GPT-5.6 Sol (`gpt-5.6-sol`)** (decided 2026-07-20 on #81, confirmed 2026-07-22); Opus,
  Sonnet, Terra, and Luna are lab-only.
  The `display` flag is now documentation + a roster invariant only — `--in-place` records
  EVERY tested model and the **front end** owns the display filter, so a lab-only model still
  gets embedded (just not rendered). Ordinary play exposes `none|low|medium|high|xhigh|max`: GPT-5.6 API supports the full scale;
  Codex-plan GPT supports `low` through `max`; Anthropic supports `none` through `max`.
  Kimi requires `--auth subscription` with the dedicated `KIMI_CODE_API_KEY`, rejects
  `none` (which would route away from K3), and maps `low→low`, `medium|high→high`, and
  `xhigh|max|ultra→max` (`ultra` is internal, not an ordinary CLI choice). Its distinct
  `kimi_code_agent_sdk` transport pins
  `https://api.kimi.com/coding/`, uses a fresh temp workspace/config, and an Agent SDK
  invocation with no system prompt, tools, MCP,
  settings, skills, agents, plugins, or slash commands; inherited Claude credentials,
  config, and endpoint/model overrides are removed for the subprocess and restored on
  success or failure. Console output and raw lab sessions record requested + effective
  effort, provider/model/transport/auth/session, prompt/cap/selection, duration, and
  **canonical token-usage schema v1** (decided 2026-07-19); token-aware transports also
  print each counted turn's canonical usage immediately. Its fixed fields are inclusive
  `input_tokens`, the `cached_input_tokens` and `cache_write_input_tokens` subsets,
  inclusive `output_tokens`,
  nullable `reasoning_output_tokens` (null when the provider has no breakdown), and
  `total_tokens = input_tokens + output_tokens`. Provider-native payloads remain alongside
  the canonical values as local raw audit data. Persistent Codex CLI's cumulative thread
  snapshots are differenced within each run before per-turn display or aggregation, and
  the baseline resets for every run. Prompt
  v23 defaults `--session persistent`: each run opens one fresh native provider conversation,
  then sends only the newest referee message. Agent SDK transports resume their session id;
  Codex CLI resumes its saved thread; Anthropic API retains the complete assistant content,
  including signed thinking blocks; OpenAI Responses chains `previous_response_id`.
  `--session stateless` is the controlled diagnostic: every turn is fresh and reconstructs
  the fixed rules, initial clues, every prior player reply and exact ordered outcome, plus the
  latest authoritative snapshot. Both modes expose the same public puzzle evidence; neither
  adds hidden puzzle data. The rules explicitly say a displayed ranked clue's
  distance is already known and cannot improve its own word at an equal rank. In stateless
  mode, Anthropic receives the byte-identical prompt as a cacheable fixed-rules block plus the
  growing record.
  The visible reply must be one word, while the prompt affirmatively requires private
  multi-step deduction; malformed prose is rejected, never truncated into a guess.
  `--playbook` accepts only a model/provider/prompt-matched,
  hash-verified `whippin_model_playbook` profile and injects its `final_playbook` under the
  fixed rules as advice. `--selection median|best` defaults to median: median requires odd
  sequential `--runs` (default 3 for EVERY model, Kimi included — decided 2026-07-22; no
  per-provider run-count divergence), cost-prunes a later provable
  upper-half run at the running median bound, and skips remaining calls after a cap-DNF
  majority; best selects the lowest successful score and cost-prunes a later unsolved run
  when it reaches that incumbent score. Kimi prints its counted-guess exposure and warns that
  non-counting turns add paid requests; `low` still uses adaptive thinking. Lab sessions
  record the session mode, selected run, and each run's termination. `--in-place` records the
  full local transcript/token usage AND upserts the tested model's replay-valid lean entry
  into the puzzle's variable-length benchmark array (any model; a re-run replaces that model,
  a now-stale sibling entry is pruned). It accepts only the canonical config — **median +
  persistent + current prompt + at least `MIN_IN_PLACE_RUNS` (3) odd runs** — so results stay
  comparable; the uniform `--runs` default already satisfies that gate for every model.
  **Both `--in-place` writes are guarded by `_exclusive_file_lock`** (an advisory `flock`
  on a sidecar `.<name>.lock`) spanning the read AND the write: the atomic replace alone
  only makes the final swap indivisible, so without the lock two overlapping runs both
  edit the same snapshot and the second drops the first's record. The front end, not the
  harness, filters the display trio. Local benchmark
  output is gitignored and paid provider calls never run in tests/CI.
- **Frozen neutral gameplay baseline (decided 2026-07-17).** Use prompt v21 at `medium`
  effort, without `--playbook`, for both Sonnet and GPT. Two direct same-puzzle stateless
  v21 smokes produced 11 then 6 tries for Sonnet, and 13 then DNF-at-30 for GPT, exposing
  substantial GPT reliability variance. The static-corpus Sonnet/GPT playbooks regressed
  play and are paused; keep them as audit artifacts, not production guidance.
- **Paused bootstrap playbook distillation (#88, decided 2026-07-16; paused
  2026-07-17).** The rigorous calibrated
  neutral-play curriculum from #84/#86 is postponed, not discarded: its exact combined tip
  is preserved remotely at `archive/rigorous-calibration-curriculum-2026-07-16` (`5d727aa`).
  The active branch instead commits `benchmark/datasets/strategy-fr-92`: exactly 92 French
  static puzzles / 276 targets with manifest-bound sentences, secrets, starts, ranks, and
  hashes. `playbook_distill.py` validates the whole graph before auth or writes, then builds
  one deterministic context packet containing every puzzle/target, all neighbors through
  rank 50, and deterministic landmarks through rank 10,000. Each model makes exactly TWO
  resumable long-form calls: an unrestricted analyst pass, then a second critic/rewrite pass
  over the same evidence plus the draft. Workflow `ultra` maps to Anthropic adaptive thinking
  + `max`, Codex-plan GPT literal `ultra`, or GPT API `max` + Pro reasoning. There is no old
  eight-item/2,000-character playbook cap. Both raw stages remain only in the gitignored audit
  artifact; the separate hash-pinned profile contains the critic's final playbook, and ONLY
  that final text can enter `llm_play`. The accepted Sonnet/GPT critic profiles are versioned
  in `benchmark/playbooks/`; raw analyst and continuation transcripts remain local. Claude
  Code max-output recovery can emit one logical answer across several assistant messages, so
  the adapter assembles every ordered text block and removes an exact repeated seam before
  hashing the stage. `--dry-run` performs zero auth checks, writes, or calls.
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
- **Interactive hole selector (decided 2026-07-05, expanded by #100).** WITHOUT
  `--words` on a TTY, three distinct secret groups are chosen with a small raw-mode
  (`termios`/`tty` cbreak) full-screen selector instead of typing words. `extract_candidates`
  lists the selectable occurrences — each token's first word-core whose **display form is
  in `Vset`**;
  because reduction already strips stopwords / single letters / non-dictionary tokens,
  "in `V`" **is** the content-word filter (no separate stopword list), so `l'animal` offers
  only `animal` and punctuation/stopwords are non-selectable. ←/→ navigate the content
  words; the hovered word's **full start-word band** (`start_band`, ranks 50–150) is
  previewed live (its neighbor ranking computed once per secret slug and **cached**).
  **Enter** commits the hovered occurrence's whole repeated-word group, then a **number +
  Enter** picks its shared start word (**Esc** cancels back to navigation, **Ctrl-C**
  aborts). Three distinct commits end it. The produced `holes`/`ranks` are **identical in
  shape** to the `--words` path (`build_rank_map` + `_make_hole` are shared), with one hole
  per group occurrence. `--words` (or off-TTY) **skips** the selector entirely
  (`holes_from_words`), so batch/CI is unaffected. Fewer than 3 distinct selectable words
  → clear error.
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
- **Lemma tables (#104):** `generation/wordlist/{fr,en}.lemmas.tsv.gz` are committed —
  fr = Lexique `ortho`→`lemme` (~138k pairs), en = AGID `infl.txt` inverted (~260k
  pairs), both filtered by the language token rule, every lemma registered as a form of
  itself. Built by `build_lemmas.py` (downloads cache in `wordlist/.cache/`);
  `gen_phrase` reads them at startup (hard error when missing; `--no-lemmas` opts out
  and reproduces pre-#104 output). Alias expansion roughly triples a fr puzzle's rank
  keys (~332 KB → ~762 KB gzipped for a real puzzle).
- **Verb forms table (#119, Lefff-sourced since addendum 3):**
  `generation/wordlist/fr.forms.tsv.gz` is committed — 397k rows / 301k surfaces /
  7,819 verb lemmas / 51 cells (~1.9 MB gzipped, ~0.5 s to load), beside
  `fr.forms.LICENSE`. Built by `build_forms.py` (`pnpm forms:fr`; downloads cache in
  `wordlist/.cache/`, sha256-pinned). `gen_phrase` reads it at startup for fr (hard
  error when missing or malformed; `--no-inflect` opts out and reproduces
  pre-addendum output). What the source swap bought, in two different units — keep them
  apart: **in the table**, 1,901 → **7,777** lemmas carry an `ind:pre:2s` cell and
  76,337 → **396,653** `(lemma, feature)` cells are realizable; **intersected with the
  reduced vocabulary** — the only cells a hole can ever display, since `apply` requires
  `donors.typable` — 62,557 → **92,030** cells over 5,608 → **6,006** lemmas, i.e.
  **+47%**, about a third of the whole-table magnitude. No `en` table — a decided
  non-goal, not a missing file.
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
  `noPuzzle`** (NO PUZZLE TODAY), any other failure → `error`. **The `?puzzle=` file
  override was REMOVED (decided 2026-07-19):** the front ALWAYS loads the day's puzzle
  from the backend — there is no client-side file/URL override. To test a specific puzzle
  locally, publish it into the local store (`pnpm puzzle:publish`) and point the front at
  the local backend. Consequently `usePuzzle`'s `dayNumber` is **always a real number**
  (never `null`), which is why `Game`/`App` no longer carry override/null-day branches
  (`SolvedScreen` still accepts a null `dayNumber` — that null is the TUTORIAL's, which
  reuses it with the PLAY action instead of SHARE). `VITE_API_BASE_URL` (see
  `web/.env.example`) configures the backend base and is required for `pnpm dev` /
  `pnpm build`; the frontend must not silently use its own origin as the backend.
  `usePuzzle` exposes `dayNumber` for persist (#7) / already-solved (#9).
- **Archive routing (#55, decided 2026-07-07):** the client now also fetches **explicit
  past dates** — pairing with #53's server-side "serve any past day". `parseRoute`
  (`web/src/langs.ts`) grew two language-scoped routes beyond `/<lang>`:
  `/<lang>/archive` → the calendar screen (`screens/Archive.tsx`), and
  `/<lang>/<YYYY-MM-DD>` → that past day's game (deep-linkable/shareable). A date is
  honored only when it is a **real calendar date within `[FIRST_PUZZLE_DATE, activeDate]`**
  (`web/src/config.ts`, a launch placeholder the user pins); a malformed or out-of-range
  date-shaped segment → `home` redirect, while a **non-date** second segment keeps the old
  tolerance (`/<lang>/xyz` → today's game). `parseRoute` takes the range bounds as an
  injected arg (App passes the client `activeDate`) so parsing stays pure/testable.
  `usePuzzle(lang, date?)` fetches the given date, else the active day (unchanged); the
  404→`noPuzzle` path is reused as-is. The calendar reads each day's status from the
  **persisted rounds** (device-local) via the extracted `state/status.ts` `statusOf`
  (shared with the language selector). **Cell coloring (decided 2026-07-08):** a day with
  any reconstruction (>0%) is FILLED with its `progressColor(pct)` (solved counts as
  **100%** — the ramp top, NOT the language-card gold), and its number is drawn in `--bg`
  so it reads on the fill; disabled and not-started/0% days keep the neutral surface +
  number color. **A SOLVED day also RIPPLES (decided 2026-07-08):** a shading wave, so a
  validated day is distinguishable from an in-progress one by MOTION, not only color. It
  plays `web/src/assets/ultracode.png` — a **12-frame horizontal sprite sheet** (144×12,
  12 square 12×12 frames) — as a CSS background on `.cal-ripple`: `background-size:
  1200% 100%` fits one frame to the square cell and `steps(12)` walks `background-position-x`
  (end value `100%×12/11` so frame 11 lands on 100% and loops cleanly), `image-rendering:
  pixelated` keeps it crisp. (Superseded the earlier hand-computed SVG-path ripple.)
  Reduced-motion hides it → the static fill + aria-label carry the status.
  The calendar itself is **vertically centered** (`.archive` flex column, top padding
  clears the fixed header). **The live streak stat moved out of the archive body and into
  the shared `TopBar` (decided 2026-07-11):** immediately right of the language flag it is
  only `assets/streak-small.png` (the 8×10 pixel-art source displayed at an exact 3× =
  24×30) plus a larger bare streak amount; a zero/broken streak remains hidden. Entry: a
  calendar icon in the
  game TopBar's right group; `dateForDayNumber` (`shared/day.ts`) is the `dayNumber`
  inverse. The **OG share page** (`backend/ogCard.ts` `renderShareHtml`) now click-throughs
  to the **shared day's** date-addressed URL (`/<lang>/<dateForDayNumber(dayNumber)>`),
  not bare `/<lang>` — so a shared archive result opens that archived date, not today (the
  card/title were already `#dayNumber`-correct). The archive **must not touch streaks**
  (separate issue).
- **Solved-result hierarchy (decided 2026-07-10; leaderboard variant 2026-07-24, #110;
  SEE-MORE dialog 2026-07-25):** the solved tray is sentence-specific and the SAME
  compact stack at every breakpoint and on every surface: the named `<tries> TRIES`
  headline, the PLAYER's full-width **run ruler**, then the actions — SHARE plus, when
  displayed opponents exist, **SEE MORE** (i18n `seeMore`, fr `VOIR PLUS`). **The
  leaderboard no longer renders inline in the tray (decided 2026-07-25, superseding
  #110's inline table — too much information in the tray on mobile):** SEE MORE opens
  `LeaderboardDialog`, a borderless full-screen native dialog on the SOLID app
  background (the animated noise never plays under it) with generous row rhythm,
  closed via its X (`ariaClose`), Escape, or a backdrop click; focus returns to SEE
  MORE. This dialog is the planned home of the deeper result views (#82): per-row
  runs, tested words, per-hole word lists. **The run RULER replaced the bucketed
  trajectory squares (decided 2026-07-25):** one continuous bar per run on the
  PROGRESS ramp (`components/RunRuler.tsx`), one cell per counted try colored
  `progressColor` at that try's reconstruction % — the RAW `progressTrajectory`, no
  on-screen bucketing — with a white tick at each try that solved a secret and the
  hole's sentence index (1..3) under it; one guess dropping several secrets stacks its
  indices under ONE shared tick (`solveTicks` in `web/src/game/share.ts` replays the
  moments with the same rules as the trajectory). **The SHARE CARD draws the SAME
  ruler (decided 2026-07-25, superseding the bucketed-squares card):** the share token
  was bumped to **v2**, carrying the RAW per-try trajectory plus the solve moments
  instead of the `bucketMeans` squares, so `renderCardSvg` renders the on-screen ruler
  scaled to the OG image — same `progressColor` cells, same ticks, same sentence
  indices. v1 tokens (bucketed squares) no longer decode: `decodeResult` rejects them
  on the version check, so a pre-bump link can never mis-draw. It is not a dead end
  though — **every version shares the opening header** (`version | lang | day | scoreLen
  | score`), so `decodeLegacyShareTarget` recovers a SUPERSEDED token's lang + day and
  `/s/<v1token>` **301s to `/<lang>/<date>`**, the archived day it named. That fallback is
  deliberately restricted to versions **strictly older** than the current one: a
  corrupted or hand-crafted CURRENT-version token still gets the flat 404, so a forgery
  can never earn a redirect. `/og/<v1token>.png` stays a 404 (there is no ruler to
  draw). Cell count is
  still DERIVED from the score (one cell per counted try, never stored), and a try that
  did not improve costs ONE bit, which is what keeps a long game's link short. The card
  itself draws at most ONE rect per pixel column: the score field is 15 bits, so a
  hand-built token can declare ~32k tries, and below a pixel per cell the extras only
  stack — collapsing them bounds the rasterizer's work by the CARD instead of by the token.
  **The plain-text EMOJI row moved onto the PROGRESS ramp too (decided 2026-07-25):**
  `progressEmoji` lives with the ramp stops in `shared/src/progressColor.ts` so the row
  and the ruler can't drift — `<35 🟦` (blue→cyan), `<45 🟩`, `<55 🟨`, `<65 🟧`,
  `<75 🟥`, `>=75 🟪` (magenta→violet→indigo), each band the emoji nearest the stop(s)
  it covers, cut at their midpoints. The indigo tail deliberately stays 🟪 rather than
  the nearer-in-RGB 🟦: the ramp closes near its own start, and a row that returns to
  its opening color would read backwards. **The row is BOUNDED to 3–18 cells (decided
  2026-07-25, superseding the cell-for-cell row taken earlier the same day):** pasting 62
  emoji into a message is a wall, not a result, so the row is a SUMMARY of the bar where
  the ruler and the card draw every try. It restores the pre-#113 curve — `ROW_BREAKPOINTS`
  / `MIN_ROW_CELLS` 3 / `MAX_ROW_CELLS` 18 / `rowCellCount` / `rowMeans`, now in
  `web/src/game/share.ts` and NOT in the codec (the v2 token carries the raw run, so the
  decoder no longer derives a count) — with each cell the MEAN progress of its contiguous
  bucket; progress is monotonic and the buckets are contiguous, so the row still reads
  cold→hot. **The LAST cell is PINNED to the solving try**, never its bucket's mean: that
  tail average is what made a 61-try grind plateauing at 70 and solving on its last guess
  close on 🟥 — a finished game reading as unfinished — and it is the one cell that means
  something exact ("this is where you ended") — though on a SOLVED run the last cell is a
  keycap, so the pin is what a row WITHOUT solve moments ends on. **The row carries the
  ruler's TICKS as KEYCAPS (decided 2026-07-25, superseding "the ticks are the one thing the
  row drops"):** a cell holding a try that dropped a secret renders as that hole's
  sentence-position keycap (`1️⃣`/`2️⃣`/`3️⃣`) INSTEAD of its ramp color, so the row shows the
  ORDER the sentence was cracked — `🟦🟩1️⃣🟧🟧🟧🟧🟧🟧2️⃣3️⃣`. The bar puts a mark between two
  cells and numbers it underneath; a single line has neither, so the number takes the cell.
  Three consequences, all accepted: the solve cells lose their color; several secrets falling
  inside ONE cell show every keycap (in sentence order — the same order the ruler stacks them
  under a shared tick), so the row can reach `MAX_ROW_CELLS + 2`; and since the final try
  always solves, a finished run ALWAYS ends on a keycap (a 3-try perfect game is exactly
  `1️⃣2️⃣3️⃣`, no color at all). `solvedAt` is optional — without it the row is the plain ramp.
  In the DIALOG's table:
  one row per entrant sorted by score (player ahead on a tie, DNF last, `lineupModel`
  order) — medal, tag, the entrant's run replayed into its ruler, count (DNF muted).
  **Leaderboard rulers share ONE scale (decided 2026-07-25):** each bar's width is
  proportional to its tries over the longest **SOLVED** run on the table, so lengths and
  solve moments compare straight down the column. Solved, not longest: a DNF's run is not
  a score — it ends at the harness's counted-try cap (`DEFAULT_CAP` 300) — so scaling to it
  would squeeze every real bar, the player's included, into a few pixels. A DNF simply
  overflows the scale and the ruler's own `min(…, 1)` fills its row, which reads right: it
  ran the longest and still didn't finish. The colorize wave is paced separately, by the
  longest run of ALL, since it has to sweep every cell ON SCREEN within its span: its
  per-cell delay comes from
  `rulerStagger(maxN, reduceMotion)`, which returns **0 under reduced motion** — the
  global CSS rule collapses animation/transition DURATIONS but not DELAYS, so the ramp
  would otherwise still crawl across the bar for over a second for someone who asked for
  no motion. **On mobile the tag stacks ABOVE its bar's
  left edge (decided 2026-07-25)** — `.lb-main`, `display: contents` on desktop — so
  the table tightens to medal | tag-over-ruler | count and the bars get the width.
  **The table is MONOCHROME except the run rulers** (decided 2026-07-24): tags are
  muted (the player's alone in fg), counts neutral — identity colors belong to the
  characters, and the rulers are the single color voice — **plus the placement-medal
  column (decided 2026-07-25):** each row leads with its 15×15 pixel-art medal sprite
  (`assets/medals/1-4.png`, rendered at an exact 2×), drawn on the HEAT ramp's four
  anchor stops — 1 hot cyan → 4 cold crimson — not classic podium metals. **The
  PLAYER's tag alone is the solved-word gold** (decided 2026-07-24, replacing a
  tried-and-dropped accent row border), and it reads **"YOU" in EVERY language** — the
  `you` i18n key is deliberately untranslated (fr included; decided 2026-07-24), one
  universal tag across lineup + leaderboard. Rows are **NOT interactive** — an inline
  tap-to-unfold run viewer was tried and removed (too noisy); the run viewer arrives
  with #82, on this dialog. The table is decorative (aria-hidden) with an sr-only
  ranking line carrying the accessible result (also present in the tray, so the
  ranking needs no modal). The lineup does NOT persist past the
  solve: after the keyboard drops, its characters teleport OUT one tick apart (their
  dissolve + shared-flash strips), and only once the last is gone do the results rise
  into the tray (reduced motion or missing strips skip straight there). Both exit beats
  hand the tray back through a signal the DOM has to produce (the keyboard's own
  `animationend`, the lineup's tick clock), and the tray renders NOTHING until they
  arrive — so each carries a **deadline** (`KB_EXIT_FALLBACK_MS` / `LINEUP_EXIT_FALLBACK_MS`
  in `Game.tsx`), a generous multiple of the real duration, cancelled by the genuine
  signal. A lost signal must never be able to strand the player on an empty tray. On a
  streak solve these exit beats do NOT play hidden behind the celebration — keyboard and lineup
  hold still under the modal and the drop + teleport-out start at its dismissal; the
  source types only after the leaderboard has risen (decided 2026-07-24). **The sentence
  must NOT move between the solved beats (decided 2026-07-24):** the lineup renders
  inside a `.lineup-zone` band that keeps its height for the whole round — through the
  exit and on rehydrated solves — and the tray's height is FIXED to the keyboard's
  (taller solved content overflows into the empty band, never grows the tray), so
  .play's centering never shifts the phrase. **Fresh-solve sequence (decided 2026-07-10):** the
  solving submit immediately sends the prompt left while fading it out, in the same render
  that launches the final hole-hit feedback. The next stage waits until EVERY `Hole` reports
  its final secret rendered after its final settle animation completes — never a
  guessed timeout — so multi-word or throttled animation cannot be covered mid-resolution.
  A fresh active-day solve then holds the fully resolved sentence for 300ms before mounting
  the streak modal. **The solved beats run STREAK → keyboard-drop + teleport-out →
  results rise → SOURCE (decided 2026-07-24, #110 — reversing the 2026-07-10
  source-before-results order):** once the modal has completely dismissed (including its
  exit fade) — or immediately after the final holes settle on archive / no-streak play —
  the exit beats play, the results rise into the tray, and only once the risen stack
  reports itself in place does the optional sentence source type quickly, letter by
  letter, with a trailing `_` (tally/colorize choreography continues beneath it; no
  metadata skips the typewriter). **The citation is MOUNTED for the whole round but
  MASKED until that beat:** the prompt and the caption overlay in one `.prompt-zone` grid
  cell and the zone sizes to the taller of the two, so the caption has to lay its full
  citation out from frame one — but the sentence's author/work is a HINT, and rendering it
  for real would leave it readable in an unsolved round's DOM. `SolvedCaption`'s `masked`
  replaces every non-space glyph (the pixel font is monospace and the spaces — its only
  wrap opportunities — are kept, so the mask occupies exactly the real box) and empties the
  sr-only mirror. Rehydrated solves render the full source/results immediately without
  replaying the sequence. Player progression is separate:
  `StreakDialog` is a
  **borderless full-screen** native modal, opened only by a FRESH active-day
  unsolved→solved transition. Its staged animation uses `@react-spring/web` (v9 for React
  18): 200ms empty-screen fade → previous streak (derived without the solved day; 0 when
  broken) 200ms fade → 500ms hold → changed digits wheel down/in from above, staggered
  90ms right-to-left with a slower, subtly bouncing incoming spring → whole new number
  foreground → flame → week with the solved day still empty → that tile lifts toward the
  player, flips onto its completed face, and falls back to the screen plane → its impact
  sends the prior completed-day scale pulse nearest-first across the week at 65ms intervals
  → the ending hint. Unchanged streak digits never move, and the previous value stays
  horizontally centered when the new streak adds a digit. It
  never opens for archive solves, the tutorial, a reload, or an
  already-solved revisit. **Dismissal (decided 2026-07-10, replacing the CONTINUE button):**
  the ending beat is a pulsing arcade-style hint — pure "what to do", never a why (the
  game is done; CONTINUE/CLOSE would beg "continue to what?") — reading TAP ANYWHERE on
  coarse pointers / CLICK ANYWHERE otherwise (localized). **The celebration has NOTHING
  focusable (decided 2026-07-10):** the hint is a plain non-interactive element, not a
  button, and nothing is auto-focused — so no focus ring ever appears and a stray Tab has
  nowhere to land (the modal traps focus; Tab is also swallowed). Once the hint appears the
  WHOLE modal dismisses — click/tap anywhere, ANY key (the "press any key" twin of
  tap-anywhere), or Escape — but dismissal is completely disabled until the hint's entrance
  finishes and it is fully visible. Every dismissal then fades the whole modal opacity over
  200ms before unmounting; after source typing and the result rise, focus moves to the result
  action. While any streak screen is open, the source and solved-result timers stay at their
  initial frame. **Dev-only preview:**
  `?streak=N` (integer `0..99999`)
  opens the sequence immediately with `N` as the PREVIOUS value (`?streak=9` → `9→10`),
  suppresses the first-visit invitation, and synthesizes its visual week without mutating
  persisted rounds/solved days; production builds ignore the parameter.
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
  uninvited. Replay via the header `?`; `?tutorial=1` forces it; the dev-only `?streak=`
  preview suppresses the first-visit invitation.
- **App header (decided 2026-07-06; redesigned 2026-07-21 — this bullet was STALE and is
  corrected 2026-07-26 from the code, which is ground truth):** a fixed **topbar**
  (`components/TopBar.tsx`) of **two corner chips and NOTHING else — no band, no border, no
  background, no blur.** Boxes read as floating rectangles over the animated waves, so the
  groups sit DIRECTLY on the backdrop and the glyphs' own `text-shadow` carries legibility.
  Layout is one optical row: `.topbar-inner` = `min(900px, 100vw - 48px)`, 56px, centred.
  **LEFT is the status spot** — a screen's title in `.topbar-title` (ARCHIVE / TUTORIAL, plus
  any inline stat like the tutorial's counter); the game passes nothing there and floats its
  own progress **counter** (`.hud`, the arcade SCORE spot, painted in `progressColor(pct)`)
  instead — the full-width progress BAR is gone, the number and its colour say what the bar
  said. **RIGHT is the one action group** (`.topbar-right`): the language flag, then the
  screen's contextual controls — every one a `.home-btn` (a transparent `--hud-height` square)
  wrapping a `.pixel-icon` SVG, muted → `--fg` on hover/focus. The **streak stat is NOT in the
  header** (moved back to the archive page 2026-07-21). **Any full-screen surface follows this
  same row** rather than inventing chrome — the route modal (#117) reuses these exact classes,
  minus the flag (switching language out from under a hole's map would navigate the game away).
  The game's right group holds the **archive calendar icon** and help `?` (#55); the tutorial
  puts "TUTORIAL" in the left chip and the skip fast-forward in the right group. The flag
  ALWAYS opens the language screen. The
  game header is rendered by **`GameRoute` (App), NOT inside `Game`** (decided
  2026-07-08): it wraps EVERY state of the route — loading / error / missing-puzzle /
  the loaded game — so navigating into a game (e.g. from the archive) never blinks the
  header away; only the body under the fixed header refreshes. `usePuzzle`'s **stable
  `dayNumber`** is still captured ONCE per request (`useMemo` on the requested date) and
  shared by the fetch, round key, and share, but is no longer rendered in the header. An
  undated tab held open across the 22:00 flip therefore still keeps its fetched puzzle/day;
  the puzzle itself does not silently swap. The topbar is the extension point for future
  chrome (streaks, stats, …).
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
  and every control has a visible `:focus-visible` outline. **The missing-puzzle screen
  has TWO wordings, told apart by the ROUTE (#77, decided 2026-07-27)** — the backend's
  404 is undifferentiated, and which route asked is the only signal needed: on the
  **undated** route (today) it owns that the state is **abnormal** (a publish that did not
  happen), unchanged; on a **dated** archive route (#55) it is usually NORMAL — a
  pre-launch date, or a language backfilled later, simply was never published — so it says
  that plainly (no "not supposed to happen", no "check back"), names the day, and offers
  BACK TO ARCHIVE above the existing CHANGE LANGUAGE, both the same `secondary` weight.
  The pixel font is **self-hosted** (`web/src/assets/fonts/PressStart2P.woff2`, `@font-face` in
  `index.css` — no Google Fonts request).
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
  - **Strip the editor cruft.** Keep only `xmlns`, `viewBox`, the `width`/`height` size (see
    below), `fill="currentColor"`, and the shape elements. **Remove** the `<?xml …?>` prolog
    and `id`/`data-name` (Illustrator layer junk). This is what "remove the useless
    attributes" means for any new icon.
  - **Every icon is orthogonal PIXEL ART** (decided 2026-07-08) — shapes on an integer grid
    with only horizontal/vertical edges (rects, or a path of `v`/`h` moves), NO diagonals —
    so it renders crisp at integer scale. Rendered with `shape-rendering: crispEdges`
    (shared in the `.pixel-icon` CSS class, not per icon).
  - **Size lives in the SVG, at EXACTLY 3× the viewBox** (decided 2026-07-08, revised from
    "size in CSS"). The `.svg` sets its own `width`/`height` = `3N × 3M` **px** for a
    `viewBox="0 0 N M"`, **right next to the viewBox** — so an icon's size is a single source
    of truth in one file, not split into a CSS rule in another folder. CSS (`.pixel-icon`)
    only sets shared rendering (`display: block; shape-rendering: crispEdges`), never a size,
    so a new icon needs **no** CSS: author the `.svg` with its px `width`/`height` and give
    the element `className="pixel-icon"`. Every icon's "pixel" is then 3 screen px — crisp,
    uniform in weight, integer-scaled (×3 vs ×2 is purely a size choice; both are crisp — ×3
    suits the small header viewBoxes, giving ~18–27px). **The ONE exception is the on-screen
    keyboard's control glyphs** (`.kb-icon`, enter/back): their `.svg`s carry NO `width`/
    `height` and `.kb-icon` sizes them in CSS (`height: 30%; width: auto`), because the keys
    shrink on narrow phones and a fixed 3× would overflow.
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
  word/guess): `solve {lang, tries, day, archive}` — the play-solve transition in
  `Game.tsx` (NOT rehydration; `archive` is `'yes'`
  when replaying a past archive day (#55), `'no'` for the live daily puzzle);
  `share {method:'native'|'clipboard'}` — `SolvedScreen`
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
