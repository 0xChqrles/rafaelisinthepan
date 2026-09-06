# AGENTS.md — @whippin/curation (headless sentence curation, #260)

> Package-scoped guidance. The root `AGENTS.md` applies here too (engineering
> principles, the per-puzzle schema, testing policy, the issue/PR workflow). This
> package is a CONSUMER: of `generation` (the slug contract, the start-word band, the
> vectors, `gen_phrase` as the one writer of puzzles) and of `benchmark`'s Claude
> subscription transport. Nothing imports it. It never publishes.

## File map

```
  curation/                  one book in, one CANDIDATE puzzle out (uv); never publishes
    scripts/
      curate.py              the CLI + the linear pipeline (book -> sentences -> trio -> gen_phrase)
      rules.py               the trio rules as PURE functions over parsed tokens (+ the tunables)
      sentences.py           text -> candidate sentences (length band, self-contained; stdlib)
      epub.py                epub -> text + metadata (stdlib)
      parse.py               spaCy adapter (fr_core_news_md) -> rules.Token
      llm.py                 the questions asked of Claude + JSON parsing; the taste profile and
                             the secret rules are READ FROM THE SKILL FILE at run time
      shelf.py               the shelf, its index, and what the archive already holds
      _paths.py              path wiring (generation + benchmark scripts on sys.path)
    shelf/                   GITIGNORED: the epubs to mine (copyrighted) + index.json (state)
    runs/                    GITIGNORED: one markdown log per run (every rejection names its rule)
    tests/                   pytest, dependency-free (rules, sentences, epub); the LLM never runs
    pyproject.toml, uv.lock  claude-agent-sdk, spacy + fr_core_news_md (URL wheel), gensim/numpy
```

## Commands

```bash
pnpm curate [--lang fr] [--book <file on the shelf>] [--seed N]
#   Picks a book (the model, off the shelf minus the archive minus index.json; --book forces
#   one), mines it, and writes the first sentence that survives every rule as a puzzle under
#   packages/generation/output/word/fr/... via gen_phrase — headless, the start word is the
#   band's random pick, the #133 form question is answered by the model from the sentence.
#   Exit 0 = a candidate was written (publish it yourself), 2 = every shortlisted sentence
#   was rejected (rerun: another sample, or another book). The log is runs/<stamp>.md.
pnpm --filter @whippin/curation test
```

Needs: a paid Claude.ai login in Claude Code (`claude auth status`), the French reduced
vectors (`pnpm reduce:fr` done once), and epubs on the shelf.

## Stable invariants

- **The LLM never sees an invalid option.** `rules.initial_candidates` builds the list it
  picks from; `rules.prune` shrinks it after every pick; a pick off the list is ignored.
  The model chooses, code enforces. Tunables live at the top of `rules.py`:
  `ALLOWED_POS`, `MAX_COMMON_RANK` (20) / `MAX_COMMON_RANK_ADV` (500, the frequency
  floors read off the reduced vectors' order), `MIN_GAP` (3 tokens), `COSINE_MAX` (0.40), `MODIFIER_DEPS`,
  `MAX_RESTARTS` (2), `MAX_OFF_LIST` (2), `CONTEXT_GUESSES` (3); and at the top of `curate.py`:
  `MAX_SENTENCES` (600), `CHUNK` (150), `PICKS_PER_CHUNK` (6), `SHORTLIST` (20).
- **The rules, as code applies them** (from the user's curation feedback, #260):
  candidates are NOUN/VERB/ADJ/ADV, not stopwords, not among the commonest words (an
  adverb has the higher floor), slug in the vocab, not a past secret,
  no same-lemma twin under another slug in the sentence (a same-slug repeat is allowed:
  one hole per occurrence). After a pick, gone are: every verb if the pick is a verb
  (at most one verb); the pick's head and dependents and its modifier siblings (a verb
  and its subject, an adjective and its noun — "describing the same thing"); anything
  within `MIN_GAP` tokens ("the same part of the sentence"); lemma/morphological
  variants; anything above `COSINE_MAX` to a pick ("too similar"). `conj` siblings stay
  (a list of nouns is a good spread).
- **One model judgement is TESTED, not trusted**: the MEMORIZATION TEST, two stateless
  probes — name the author (compared by name parts), and complete the line from its
  first half (`COMPLETION_MATCH` = 60% of the true words, in order). Either = the very
  famous line, next sentence; a model under-claims authorship but cannot help finishing
  what it memorized (Camus's opening completes verbatim; Pessoa's "J'ai demandé si peu à
  la vie" does not). Everything else the model is asked is a choice from a list.
- **The CONTEXT CHECK is an ANNOTATION, never a strike** (decided on data 2026-09-06):
  after a trio is found, one stateless call per secret guesses the blank as the player
  sees the sentence (all three blanks); the log records where the true word landed among
  `CONTEXT_GUESSES`. Calibrated on the 12 real-player days (medians 7–23): the model's
  three guesses held the true secret 18 times out of 34, its first guess 13 times — an
  LLM guessing the blank does not predict what the context gives a human, and a strike on
  it would reject most trios that play well. "The context helps too much" stays a rule in
  the model's PICK prompt (the trio rules in the skill) and a line for the reviewer.
- **A dead end restarts the sentence with its first pick struck**, `MAX_RESTARTS` times,
  then the next sentence. No smarter backtracking.
- **The taste profile and the secret rules have ONE home, the `find-sentences` skill
  file**; `llm.py` slices its `## Taste profile`, `## The two laws` and `## The trio
  rules` sections into the prompts at run time. Edit the skill, never a prompt copy.
- **The transport is the benchmark's** (`llm_play._agent_sdk_turn`, the paid-Claude.ai
  guard, the conflict-env scrub): one fresh conversation per question, model
  `claude-opus-5`, adaptive thinking, effort `high`. No second spelling of it here.
- **`gen_phrase` is the only writer of a puzzle**, run headless from this package with
  `--words` and, when it demands one, `--form` answered by the model from the sentence
  (`curate.generate` parses the #133 error's analysis list). The start word is the band's
  random pick. Nothing here publishes.
- **Tests are dependency-free** (`uv run --no-project --with pytest`, like generation and
  benchmark): the rules take plain `Token`s and injected callables, so they run without
  spaCy, vectors or a model.

## Do NOT

- Don't publish, and don't write a puzzle by any path but `gen_phrase`.
- Don't put a rule in a prompt that code can enforce; don't ask the model "is this
  valid?" — give it a valid list.
- Don't copy the taste profile into this package; read the skill.
- Don't commit the shelf (copyrighted files) or the runs.

## Not in V1 (deliberately)

Publishing; the benchmark as a difficulty gate; difficulty prediction from player logs;
a harder start word when the context helps a little; English (`LANGS` is `fr`);
multi-sentence micro-stories; per-token guess counting.
