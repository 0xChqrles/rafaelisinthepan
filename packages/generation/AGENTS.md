# AGENTS.md — @whippin/generation (Python puzzle generation)

> Package-scoped guidance. The root `AGENTS.md` applies here too and holds the
> engineering principles, the CROSS-PACKAGE contracts this package produces for — the
> slug()⇔fold() identity and the per-puzzle JSON schema (rank semantics, groups,
> dq/road) — plus the testing policy and the issue/PR workflow. Read it first.

Python scripts run via `uv`, wired through root `pnpm` scripts. Paths below are
relative to `packages/generation/` unless prefixed.

## File map

```
  generation/                Python generation (run via uv); puzzles -> output/, vocab -> web/public
    scripts/
      reduce_embedding.py     raw .vec/.txt -> *_reduced file (the ONLY filter+cap stage) + vocab
      build_wordlist.py       offline builder: sources -> wordlist/<lang>.txt.gz (hors-dico ref, #38)
      build_lemmas.py         offline builder: AGID -> wordlist/en.lemmas.tsv.gz (en form→lemma, #104;
                              en ONLY since #132 — the fr grouping ships in the word-group inventory)
      build_forms.py          offline builder: Morphalou 3.1 -> wordlist/fr.forms.tsv.gz (the fr
                              WORD-GROUP INVENTORY, #132/#146: duplicate-entry merge + all-POS
                              grouping, homography and display morphology)
      build_vocab.py          reduced vectors -> web/public/vocab/<lang>.json (escape hatch; no re-reduce)
      slug.py                 stdlib-only: slug() contract + path_slug() dir names + write_vocab
      embedding_neighbors.py  shared load/vocab/matrix/cosine-rank logic
      glove_neighbors.py      en paths + derived .kv cache (thin wrapper over the above)
      french_neighbors.py     fr paths + derived .kv cache (thin wrapper)
      start_word.py           start/hint-word selection (rank band 50-150)
      distances.py            stdlib-only: dq quantization + road clustering (#115)
      gen_phrase.py           one sentence -> one self-contained puzzle JSON; also owns the
                              per-secret pipeline (walk_secret) both entry points share
      gen_word.py             one word -> one single-word artifact JSON (#154); imports the
                              per-secret machinery from gen_phrase, never re-implements it
    embedding/<lang>/...      raw + *_reduced vectors + derived .kv caches
    wordlist/<lang>.txt.gz    versioned hors-dico reference wordlist (#38); .cache/ gitignored
    wordlist/en.lemmas.tsv.gz versioned en form→lemma table (lemma grouping, #104)
    wordlist/fr.forms.tsv.gz  versioned fr word-group inventory (#132/#146): source entries +
                              playable grouping + homography + display agreement; fr only
    wordlist/fr.forms.LICENSE the LGPL-LR text governing the Morphalou data it derives from
    output/word/<lang>/<kind>/<author>/<work>/<s1>_<s2>_<s3>.json   generated puzzles
                              filed under their source (#137); gitignored; publish to store/S3
    output/single-word/<lang>/<slug>.json   generated single-word artifacts (#154);
                              gitignored; one flat directory per language
    pyproject.toml, uv.lock   Python project (uv)
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

### The fr word-group inventory: one dictionary, one source per responsibility (#132/#146; decided 2026-07-29 and refined 2026-08-03)

`wordlist/fr.forms.tsv.gz` is the ONE fr word-group inventory:
`group lemma pos feature form dom` rows over EVERY part of speech. A Morphalou source
entry remains **(lemma, pos)**, while the leading `group` is the opaque playable
identity consumers use. It usually equals `lemma:pos`, but after #146 its suffix
must never be read as the group's only POS. The source lemma/POS columns retain every
merged member, making the group's paradigms and remaining homography derivable from
the rows. The same artifact feeds BOTH `gen_phrase`'s merge walk (grouping, #104) and
the display-agreement pass (#119): one dictionary defines grouping, ranking and
display alike, so aliases can never point at one group while display forms come from
another. The data has **three sources and one responsibility each** — this split is
decided, not provisional:

- **Morphalou 3.1 is THE authority for the fr lexeme** — chosen over Lefff by the
  #131 A/B (more realizable cells for every POS against the reduced vocab, the 1990
  rectified spellings, and per-ENTRY rather than per-CLASS failure). `build_forms.py`
  (`pnpm forms:fr`) reads the **pinned** CSV release (exact URL + sha256, verified
  before the archive is opened). Its agreement columns are **expanded** into the
  internal feature vocabulary — verbs keep #119's cells, nouns carry number (gender
  is lexical), adjectives gender×number, every other POS the citation cell `cit` —
  and an unnamed dimension expands across all its values, never into an opaque
  feature. **fr only** (en keeps AGID grouping and has no forms table — a decided
  non-goal).
- **Lexique383 is POS-frequency evidence ONLY** (its exactly one remaining job for
  this artifact): it decides which reading of a homographic surface is dominant (the
  `dom` column) and which of two spellings a cell prefers. It contributes no
  morphology and no grouping. It stays the source of the #38 wordlist, a different
  question.
- **The reduced vocabulary is the sole typability authority** — a rewritten display
  form is usable only when its slug is in the existence set.

Consequences that are load-bearing:

- **Duplicate dictionary filings are normalized before the artifact is written
  (#146, decided 2026-08-03):** entries with the same complete **surface-form set**
  merge across POS; then a same-POS entry B disappears when every `(cell, spelling)`
  row it contributes already exists in a strictly larger entry A. If B is contained
  in two incomparable supersets, only B disappears — it never fuses A and C. This
  merges `rouge` noun/adjective, `ex-épouse`/`ex-époux`, and the plural-only
  `tropiques`/`ciseaux` filings into their larger families; `hebdo` is contained by
  `hebdomadaire`. It deliberately does **not** merge real distinctions (`fil`/`fils`,
  `moi`/`mois`) or masculine/feminine noun derivations (`cafetier`/`cafetière`). On
  the pinned Morphalou 3.1 source the guarded measurements are 5,712 identical-form
  sets / 11,472 entries, 1,496 contained entries, 147,868 resulting groups and
  994,497 artifact rows; `build_rows` hard-fails when any of the five moves.

- **The POS gate has two cases**, unchanged in meaning from #119: with Lexique
  frequency for the surface, the row's class (VER **and** AUX merge — an auxiliary is
  a verb) must strictly beat every rival, so `évident` is dominantly the adjective.
  Without frequency, admit only a surface analysable as that class and **nothing
  else**, so `accoutumes` is admitted and a cross-POS homograph is declined rather
  than guessed. A gated form stays a legal **target**: `pensée` still realizes
  `penser/par:pas:f:s`. Since #134 the `dom` column is **build-time data the display
  pass no longer consults** (realization is keyed by the opaque group); the column
  still ships unchanged in the artifact.
- **The secret's form is NEVER inferred (#133, decided 2026-07-31); #146 asks only
  information the sentence author actually supplies.** EVERY fr secret settles its
  morphology explicitly. On a TTY the first question is usage-level
  gender/number/conjugation (a noun's gender comes from this human answer); a single
  option is shown and confirmed, several require a number. Only a remaining group
  distinction with different typable solve keys opens the complete-form identity
  question. Off a TTY `--form MOT=TRAIT` remains required per secret, with
  `MOT=LEXÈME/TRAIT` only for a real shared-cell ambiguity; a batch run without it
  is a hard error (`--no-inflect` is the explicit opt-out). The CLI/artifact cell
  vocabulary is unchanged, so a batch noun trait such as `n:p` states number but no
  gender. The resulting morphology transfers over the **WHOLE rank map** (all TOP_K
  groups): nominal answers give gender+number to adjectives and number to nouns,
  but prescribe nothing to verbs; verb answers keep the exact conjugation for verbs
  and, by #146's implementation decision, lend their stated number to nouns (a past
  participle also lends stated gender+number to adjectives). `cit` prescribes
  nothing. If one merged group carries both a matching adjective and noun cell, the
  adjective spelling is tried first because it consumes the full gender+number
  answer; the noun's number-only spelling is the fallback. Realization is keyed by
  the opaque group plus explicit group-POS metadata,
  never by parsing the key suffix. The requested form is displayed whenever it
  exists and is typable — no drift guard; a missing/untypable cell keeps the clean
  representative, marked `*` in generation output, and post-agreement slug
  collisions are counted and reported (closest-wins unchanged).
- **Mixed-entry cleanup (the #131 hazard), measured before written:** the Morphalou
  fusion glued a few wrong paradigms INSIDE otherwise-correct entries (sortir's
  `-issant` conjugation, where `ind:pre:1s` would REALIZE «je sortis»). The build
  drops **uncorroborated** rows (origins without `morphalou2`/`lefff`/`lglexlefff`)
  from entries that HAVE corroborated ones, rescuing slug-folding spelling variants
  (`plait`/`plaît`); a wholly single-source entry keeps its coherent paradigm.
  Measured on #131's enumerated cases: all pollution dropped, no legitimate row lost,
  −0.13% realizable verb cells.
- **The Morphalou CSV parser fails closed at entry boundaries.** It skips the
  distribution's prose preamble, then requires exactly 18 CSV fields on every data
  row (quoted semicolons included); a malformed short header is a hard error, never a
  continuation silently glued into the preceding lexeme. A small inline contract
  fixture exercises block flushes, continuations, pronominal normalization,
  uncategorised entries and malformed rows in CI — independent of the gitignored
  source archive.
- **Morphalou's enumerated holes are GUARDED, never patched** — #131 rules out any
  union of sources. `EXPECTED_CELLS` pins them (`sortir/ind:pre:1s` empty,
  `pouvoir/sub:pre:2s` lost, `conquérir + asseoir par:pas:m:p` missing, `pouvoir
  ind:pre:1s` = `puis` alone, …): the build **fails loudly** when the data under a
  pin moves, so a source bump or rule edit forces a re-audit; the committed artifact
  is contract-tested against the same expectations. #132 adds separate all-POS cell
  and homography sentinels for nouns, adjectives and closed classes; the #131 list
  remains the complete basic-verb audit rather than pretending those are the same
  scope. A missing agreement degrades to the dictionary form downstream; a wrong one
  would ship a wrong word — holes beat wrong forms.
- **Licensing travels with the artifact.** Morphalou is **LGPL-LR**; the licence text
  ships inside the distribution's own LISEZ-MOI (`#lgpllr` section), so the build
  extracts it from the exact archive into `wordlist/fr.forms.LICENSE`, and the table
  carries a `#` provenance header (release, URL, digest, licence). Don't distribute
  the table without them.

### Generation outputs

- **Two outputs, two homes (by purpose):**
  - **Puzzles** — one self-contained file per puzzle at
    `packages/generation/output/word/<lang>/<kind>/<author>/<work>/<s1>_<s2>_<s3>.json`,
    slugs in **sentence order** (by `pos`), *not* `--words` order. **Same words AND
    same source overwrite** — the path now carries the metadata, so re-running to fix a
    forgotten `--work` writes a SECOND file and leaves the first where it was, looking
    exactly like a normal source-less puzzle. That is the accepted cost of filing by
    source (`publish` takes whichever path you hand it, so the duplicate is inert until
    you publish it), not a bug to fix by flattening. A puzzle is a
    generation **artifact** (gitignored), not a web asset: it is **published** to the
    daily store (local FS or S3) via `pnpm puzzle:publish`; the front gets the day's
    puzzle from the **backend** (#6), never from web `public/`. Override the ROOT with
    `--out-dir` (the source levels are always appended under it).
    **A puzzle is FILED UNDER ITS SOURCE (#137, decided 2026-07-28):** the `source`
    metadata (#5) already rides inside the JSON, so the corpus organizes itself by it
    on disk — which works have been mined, which are over-represented, whether a
    sentence's source was used before. Two rules make the levels well-defined:
    - **They are `path_slug()`s, NOT slugs.** A directory name is browsed by a human,
      so it answers a different question from the comparison key: a run of anything
      non-alphanumeric becomes ONE dash (`Victor Hugo` → `victor-hugo`, where `slug()`
      gives `victorhugo`; apostrophes separate in both their ASCII and typographic
      forms), and **digits are KEPT** — a work is named `1, 2, 3` or `Joueur 1`, and
      dropping digits the way `slug()` does would leave the first with no name at all.
      It shares `slug()`'s accent/ligature folding and nothing else; it is **never** a
      lookup key, and `slug()`/`fold()` stay byte-identical and untouched.
    - **A missing level is OMITTED with everything under it**, never filled with a
      placeholder — a path cannot skip a component, so an author with no kind would
      read as a kind. So a puzzle with NO `source` still lands at `<lang>/`: the old
      flat layout is this one's degenerate case. A level that WAS given but names
      nothing ASCII (pure punctuation, or a non-Latin script — `книга`, `村上春樹`)
      collapses the same way, but **says so on stderr**: the file then sits high in the
      tree carrying full metadata, indistinguishable from a source-less one.
      `kind` stays an **open** union — the
      first level validates nothing against `KNOWN_KINDS`.
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
- **The playability report is observation only (#135, decided 2026-08-01):** after
  each selected secret's rank map is built, `gen_phrase` prints curator-facing
  evidence for its near field (top ~150): form coverage (clean agreement vs `*`
  fallback vs cross-POS citation), reduced-vocabulary frequency profile, lexemes
  with no clean embedded form, and intra-lexeme vector divergence. It is a REPORT,
  never a filter or a publication gate: no metric/threshold changes the puzzle and
  the report itself does not turn generation into a failure. The curator decides.

---

## Do NOT

- **Don't re-filter in `build_vocab`** (or anywhere after `reduce_embedding.py`).
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

(Cross-package Do-NOTs — slug/fold divergence, fold/display separation, lemma-merge
containment — live in the root `AGENTS.md`.)

---

## Commands

Run from the repo root — each `pnpm <script>` delegates via `pnpm --filter
@whippin/generation` — or from inside the package. Unlike `npm`, **pnpm forwards args
straight to the script — do NOT add a `--` separator** (a literal `--` is passed
through and breaks `gen_phrase.py`'s arg parsing).

```bash
# 0. (Re)build the hors-dico reference wordlist ONCE per language (offline, #38). The
#    committed wordlist/<lang>.txt.gz is already versioned — only rerun to refresh sources.
#    Needs `unmunch` (hunspell-tools; `brew install hunspell`) for the Hunspell union, or
#    pass --skip-hunspell for the Lexique/SCOWL-only union.
pnpm wordlist:fr      # Lexique ∪ Hunspell fr  -> wordlist/fr.txt.gz
pnpm wordlist:en      # SCOWL   ∪ Hunspell en  -> wordlist/en.txt.gz

# 0bis. (Re)build the en form→lemma table ONCE (offline, #104; en ONLY since #132 —
#    the fr grouping ships in the word-group inventory below). The committed
#    wordlist/en.lemmas.tsv.gz is already versioned — only rerun to refresh sources.
pnpm lemmas:en        # AGID infl.txt (inverted) -> wordlist/en.lemmas.tsv.gz

# 0ter. (Re)build the fr WORD-GROUP INVENTORY, fr ONLY (offline, #132/#146): duplicate-
#    entry normalization + all-POS grouping, homography and display morphology in one
#    artifact. The committed wordlist/fr.forms.tsv.gz is already versioned — only rerun
#    to refresh sources. Source entries come from the PINNED
#    Morphalou 3.1 CSV release (digest-verified); Lexique is consulted for surface
#    frequency only (the `dom` gate). Uncorroborated mixed-entry rows are dropped;
#    #146's identical/contained-entry measurements and #131's enumerated cells are
#    validated loudly. Also writes wordlist/fr.forms.LICENSE from the archive's LISEZ-MOI.
pnpm forms:fr         # Morphalou 3.1 -> wordlist/fr.forms.tsv.gz (+ .LICENSE)

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
#    Puzzle -> packages/generation/output/word/<lang>/<kind>/<author>/<work>/ (#137;
#    levels not provided are omitted, so a source-less puzzle stays at <lang>/), then
#    `pnpm puzzle:publish` it.
#    NOTE: gen:phrase ALSO rewrites web/public/vocab/<lang>.json as a side effect.
#    Reads the grouping table for lemma grouping (#104) — fr: the word-group inventory
#    wordlist/fr.forms.tsv.gz (#132), en: wordlist/en.lemmas.tsv.gz (missing table =
#    hard error, --no-lemmas to skip). The secret's form is never inferred (#133): a
#    TTY run asks morphology (gender/number/conjugation), then a complete-form identity
#    only for a real remaining ambiguity; off a TTY --form MOT=TRAIT is required per fr
#    secret (hard error otherwise; --no-inflect opts out). A shared cell with different
#    typable families needs qualified --form MOT=LEXÈME/TRAIT, ex. fils=fils:nc/n:p.
#    The confirmed answer names group 0, so the question fires before the walk and an
#    inflection of a confirmed secret solves its hole (#134/#146); groups are playable
#    word identities ranked by their homograph-free representative, and no-clean
#    groups are surfaced in the playability report (#135, printed per secret on
#    stdout, observation only). Every ranked group is annotated with its dq distance
#    and, for the groups from the hole's start word in to the secret, its road cluster
#    (#115); --no-roads drops the road fields, dq has no opt-out.
pnpm gen:phrase "<sentence>" --lang fr --words a b c   # exactly 3 distinct words; all occurrences hole (no `--`)

# 4. Generate a SINGLE-WORD artifact (#154): one word + its ranked neighborhood, no
#    sentence. -> packages/generation/output/single-word/<lang>/<slug>.json (--out-dir
#    overrides the root). Every per-secret rule is gen_phrase's, imported not copied
#    (walk_secret): merge walk, #133 form confirmation, #119 donors, TOP_K, dq,
#    slug collisions. Two differences, both because there is no sentence — the road
#    zone is the FLAT top-150 (no departure to cut it at) and the output has one flat
#    `ranks` map with no words/holes/start/source. Unlike gen:phrase it does NOT
#    rewrite web/public/vocab/<lang>.json (that is reduce's output).
pnpm gen:word phare --lang fr --form phare=n:s   # --form required per fr word off a TTY
```

`gen_phrase.py` requires **exactly 3 distinct** `--words` selectors after slug
normalization; each must appear in the sentence (matched by slug) and must have
survived reduction. Every matching sentence occurrence becomes a hole, while the
output filename contains the three distinct secret slugs in sentence order.

---

## Current state / mutable

*(Safe to update without touching the invariants above.)*

- All paths below are under `packages/`. **Tunables:** `TOP_N = 400000` (reduce),
  `TOP_K = 10000` / curator report window `PLAYABILITY_TOP = 150` (gen),
  start-rank band `50–150` (`start_word.py`),
  `ROAD_TOP = 150` (now the road zone's CEILING, not its size) / `ROAD_KS = (2,3,4)` /
  `ROAD_MIN_SILHOUETTE = 0.05` (`distances.py`).
- **Playability report (#135):** `build_playability_report` reads (never mutates)
  the final groups at ranks 1..`PLAYABILITY_TOP`; both `--words` and the raw-mode
  selector feed the same `PlayabilityReporter`, whose output is deferred until the
  selector has restored the terminal. Form fractions are exhaustive: a realizable
  rewrite declined by closest-wins is stated separately as a slug collision rather
  than mislabeled as #134's missing/untypable `*` fallback. Frequency uses the final
  display's exact reduced-vocab rank, or its most-frequent slug sibling when that is
  the form's only typability witness; it prints p50/p90/max and the five lowest-
  frequency examples. The report retains every homograph-only flag and every
  comparable divergence internally, rendering the count + five closest flags and
  the five largest representative-to-clean-form cosine distances — measured values,
  no quality verdict or cutoff.
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
  for the words actually committed. Measured
  on a real fr puzzle (`amer` / `plissés` / `grincement`, ~39k keys per secret):
  **802 KB → 828 KB gzipped (+3.2%)**, raw 5.9 MB → 7.1 MB, and the map is otherwise
  byte-identical. On that puzzle two secrets split into genuinely meaningful facets
  (`amer` → figurative vs taste; `plissés` → participles vs garment nouns) while
  `grincement` scored its BEST silhouette (0.19) on a degenerate 149/1 split — the
  metric rewards isolating an outlier, so a minimum road size is worth considering when
  Part 3 (#115's route modal) puts roads on screen.
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
- **en lemma table (#104):** `generation/wordlist/en.lemmas.tsv.gz` is committed —
  AGID `infl.txt` inverted (~260k pairs), filtered by the language token rule, every
  lemma registered as a form of itself. Built by `build_lemmas.py` (downloads cache
  in `wordlist/.cache/`); `gen_phrase` reads it at startup for en (hard error when
  missing; `--no-lemmas` opts out and reproduces the ungrouped walk). The old
  `fr.lemmas.tsv.gz` was REMOVED by #132 — the fr grouping now comes from the word-group
  inventory below, and `pnpm lemmas:fr` no longer exists.
- **fr word-group inventory (#132/#146, Morphalou-sourced, superseding the Lefff
  verb table):** `generation/wordlist/fr.forms.tsv.gz` is committed — 994,497 rows
  over every POS and 147,868 playable groups (13,716 verb / 98,917 noun / 36,341
  adjective source lexemes + the closed classes), 51 verb cells, ~5.7 MB gzipped —
  beside `fr.forms.LICENSE`
  (LGPL-LR, extracted from the archive's LISEZ-MOI). Built by `build_forms.py`
  (`pnpm forms:fr`; downloads cache in `wordlist/.cache/`, sha256-pinned).
  The build merges 5,712 identical-form sets (11,472 source entries) and removes
  1,496 contained same-POS entries. `gen_phrase` loads it ONCE at startup for fr and
  derives both grouping and morphology views from it (missing/corrupt = hard error;
  `--no-inflect` disables the
  agreement pass, and `--no-lemmas` disables grouping but then REQUIRES
  `--no-inflect` on fr — since #134 agreement is keyed by the groups the inventory
  provides, so the pair is rejected rather than silently rewriting nothing). What the source swap bought, intersected with
  the reduced vocabulary (#131's realizable-cell measure): verb 92,030 → **102,911**
  cells, noun **68,077**, adj **53,454** — and `ind:pre:2s` now exists for ~13,000
  lemmas (Lefff had 7,777, Lexique 1,901). The mixed-entry cleanup dropped 5,346
  uncorroborated rows across 1,314 entries; the #131-enumerated cells are pinned in
  `EXPECTED_CELLS`, with 6 all-POS cell + 3 homography sentinels for #132, and all are
  re-validated on every build and by independent contract tests. No `en` inventory —
  a decided non-goal, not a missing file.
- **Hors-dico wordlists (#38):** `generation/wordlist/{fr,en}.txt.gz` are committed —
  `fr` = Lexique ∪ Hunspell fr (~169k forms), `en` = SCOWL(≤60,US) ∪ Hunspell en_US
  (~91k). Built by `build_wordlist.py`; source downloads cache in `wordlist/.cache/`
  (gitignored). Tests use the small fixture `tests/fixtures/dico.fr.txt`.
- **Single-word artifacts (#154):** `gen_word.py` is a thin entry point over
  `gen_phrase`'s machinery — it imports `walk_secret` (claim → walk → keyed, dq-stamped
  map), `annotate_roads`, and the shared command scaffolding `prepare_run` (flag
  parsing → tables → the #134 gate → vectors → the three resolvers, one fail-fast
  order) and `report_run_adjustments` (donor/agreement/`*`-fallback/collision/--form
  reporting, parameterized on the command's wording), so neither the rules nor the
  setup/reporting around them can drift; its own code is the flat road zone, the
  artifact dict, the output path, a reject-early guard on multi-word/clitic input
  (whitespace or apostrophes die with a clear "one word" error before the loads;
  dashes stay legal) and the CLI. Measured on `phare` (fr): 10 000
  ranked groups, 25 497 keys, ~1.5 MB raw — the same order as one sentence hole's map,
  which is what it is. `--no-lemmas`/`--no-inflect`/`--no-roads`/`--donor`/`--form`
  behave exactly as on `gen:phrase`, including the off-TTY hard errors.
- **Puzzles:** generated into `generation/output/word/<lang>/<kind>/<author>/<work>/`
  (#137; gitignored), then published to the store (`pnpm puzzle:publish`). They are no
  longer kept under `web/public/word` — the front serves the day's puzzle from the
  backend (#6). The ~50 puzzles that predate the layout were moved into it by hand
  (local output is gitignored and the store is keyed by `<date>.<lang>.json`, so there
  is no migration path to maintain).
