# AGENTS.md — Word Hunt (daily sentence-reconstruction game)

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
Generation writes its JSON output into `packages/web/public/` (the dir web serves).

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
  generation/                Python generation (run via uv); writes JSON into web/public
    scripts/
      reduce_embedding.py     raw .vec/.txt -> *_reduced file (the ONLY filter+cap stage)
      embedding_neighbors.py  shared load/vocab/matrix/cosine-rank logic
      glove_neighbors.py      en paths + derived .kv cache (thin wrapper over the above)
      french_neighbors.py     fr paths + derived .kv cache (thin wrapper)
      start_word.py           start/hint-word selection (rank band 50-150)
      gen_phrase.py           one sentence -> one self-contained puzzle JSON
    embedding/<lang>/...      raw + *_reduced vectors + derived .kv caches
    pyproject.toml, uv.lock   Python project (uv)
  shared/                     cross-cutting TS consumed by web (pkg @word-hunt/shared)
    src/slug.ts               fold() — the slug/fold contract (byte-identical to slug())
    src/types.ts              per-puzzle schema types (Puzzle, Hole, RankMap, …)
    src/index.ts              re-exports
  web/                        React + Vite + TS front (pkg @word-hunt/web)
    src/
      hooks/useVocab.ts       fetch+cache the per-language existence Set (once per session)
      hooks/usePuzzle.ts      resolve+fetch the day's puzzle file
      puzzleSchedule.ts       { "YYYY-MM-DD": { fr, en } } -> puzzle path
      screens/Game.tsx        the guess loop, hole state (imports fold from @word-hunt/shared)
      game/scoring.ts         s(rank), holeProgress, computeProgress
      game/heat.ts            rank/progress -> heatmap color
      components/Phrase.tsx,Hole.tsx,WordInput.tsx,FloatingHit.tsx  rendering
    public/                   served at site root (web assets + generated data)
      vocab/<lang>.json       full slugged reduced vocab (existence set)
      word/<lang>/<s1>_<s2>_<s3>.json   one puzzle each
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
  it keeps passing words until `TOP_N = 200000` have PASSED, then stops reading.
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

- One self-contained file per puzzle: `packages/web/public/word/<lang>/<s1>_<s2>_<s3>.json`,
  slugs in **sentence order** (by `pos`), *not* `--words` order. Same words overwrite.
- `packages/web/public/vocab/<lang>.json` = the **full** slugged reduced vocab
  (existence set), deduped + sorted, deterministic, **NOT** capped to `TOP_K`.
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
     FAR** otherwise. Each impacted hole gets **exactly one** effect:
     - **Warm + improves** → the hole updates to the entry's **accented `word`** and
       lower `rank` (the exponent-drop animation is the feedback, **no** floating
       number).
     - **Warm, no improvement** → a transient rank **number** floats on the hole.
     - **Too far** → the **same** floating + word-shake animation as a hit, but it
       reads **"MISS"** instead of a distance (no rank exists beyond top-K), in the
       coldest heat color.
  3. A single guess can advance/solve **several** holes and can mix the three effects
     across holes. If `typed` is too far for **every** unsolved hole, **"MISS" plays
     on every hole**. The per-hole effects resolve **consecutively in sentence order,
     `STAGGER_MS = 200ms` apart** — not all at once.
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
generation scripts are scoped to `@word-hunt/generation`; reduce/gen paths below are
relative to `packages/generation/`. Unlike `npm`, **pnpm forwards args straight to
the script — do NOT add a `--` separator** (a literal `--` is passed through and
breaks `gen_phrase.py`'s arg parsing).

```bash
pnpm install                    # installs all workspaces (web + shared)

# 1. Reduce ONCE per language (slow, offline). Build the *_reduced source of truth.
pnpm reduce:fr        # embedding/fr/cc.fr.300.vec      -> cc.fr.300_reduced.vec
pnpm reduce:en        # embedding/en/glove.6B.300d.txt  -> glove.6B.300d_reduced.txt

# 2. Generate a puzzle per game (fast; first run for a language builds the .kv cache).
#    Output is written into packages/web/public/{word,vocab}.
pnpm gen:phrase "<sentence>" --lang fr --words a b c   # exactly 3 words (no `--`)

# Front end (@word-hunt/web)
pnpm dev                        # dev server
pnpm build                      # production build -> packages/web/dist
pnpm typecheck                  # tsc --noEmit
```

`gen_phrase.py` requires **exactly 3** `--words`; they must appear in the sentence
(matched by slug) and must have survived reduction. Test overrides:
`?puzzle=<path>` forces a file, `?date=YYYY-MM-DD` overrides "today".

---

## Current state / mutable

*(Safe to update without touching the invariants above.)*

- All paths below are under `packages/`. **Tunables:** `TOP_N = 200000` (reduce),
  `TOP_K = 2000` (gen), start-rank band `50–150` (`start_word.py`).
- **Data present:** `generation/embedding/fr/cc.fr.300_reduced.vec` (+ `.kv` cache
  built), `generation/embedding/en/glove.6B.300d_reduced.txt` (+ `.kv` cache built).
  `web/public/vocab/{en,fr}.json` exist.
- **Puzzles:** `web/public/word/fr/vaincre_triomphe_gloire.json`,
  `web/public/word/en/slutty_dancing_kitchen.json`.
- **Schedule:** `web/src/puzzleSchedule.ts` has 2026-06-25/26/27, all reusing those
  two files as placeholders. Add a dated `{ fr, en }` entry to publish a day.
- **Package manager:** pnpm, pinned via the root `packageManager` field
  (`pnpm@11.9.0`). `pnpm-workspace.yaml` lists the workspaces and uses `allowBuilds`
  to approve `esbuild`'s postinstall (its native binary), which pnpm blocks by default.
- The `.codex/skills/word-hunt-game/` skill + `validate_game_data.mjs` describe a
  **superseded** schema (see Discrepancies).

---

## ⚠ Discrepancies to confirm

These need a human decision; I did **not** change code or blindly record the
intended invariant.

*(Resolved 2026-06-22: a guess fills **all** improving holes — the old "at most one
hole" intent was superseded by an explicit decision to treat each impacted secret
consecutively. Effects now stagger by `STAGGER_MS`.)*

1. **Timer.** `README.md` and the `.codex` docs describe a 2:00 countdown that
   freezes the score. The current code has **no timer** — a round ends only when all
   holes are solved (shows "SOLVED!"). The recorded invariants don't mention a timer.
   Decide: remove the stale timer references, or reintroduce a timer.

2. **`README.md` `gen:phrase` example passes 2 words, not 3.** The example
   `--words forêt ancienne` would fail: `gen_phrase.py` requires exactly 3
   (`nargs=3`), and filenames are `<s1>_<s2>_<s3>.json`. Fix the README example.

3. **`.codex/skills/word-hunt-game/` is entirely stale.** Its `SKILL.md`,
   `references/game-contract.md`, and `scripts/validate_game_data.mjs` target a
   superseded design: a single `public/game_data.json` with per-language
   multi-phrase arrays, a non-existent `scripts/build_game_data.py`, plain integer
   ranks (`ranks[secret][word] = int`, not `{word, rank}`), ASCII-only normalization
   that **drops dashes** (`replace(/[^a-z]/g,'')`, contradicting the dash-keeping
   `fold()`), no slug/accents split, and a 2:00 timer. The validator validates the
   old shape. Decide: update them to the current schema or remove them.
