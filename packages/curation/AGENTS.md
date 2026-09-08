# AGENTS.md — @whippin/curation (headless sentence curation, #260 / music #262)

> Package-scoped guidance. The root `AGENTS.md` applies here too (engineering
> principles, the per-puzzle schema, testing policy, the issue/PR workflow). This
> package is a CONSUMER: of `generation` (the slug contract, the start-word band, the
> vectors, `gen_phrase` as the one writer of puzzles) and of `benchmark`'s Claude
> subscription transport. Nothing imports it. It never publishes.

## File map

```
  curation/                  one work in, one CANDIDATE puzzle out (uv); never publishes
    scripts/
      curate.py              the CLI + the linear pipeline (work -> sentences -> trio -> gen_phrase)
      rules.py               the trio rules as PURE functions over parsed tokens (+ the tunables)
      sentences.py           text -> candidate UNITS: a sentence, or up to 3 consecutive short
                             sentences of one paragraph (length band, self-contained; stdlib)
      epub.py                epub -> text + metadata (stdlib)
      lyrics.py              song files (#262): header format, Genius cleanup, couplet UNITS,
                             the famous-single cut, the artist cooldown (stdlib, tested)
      shelf_lyrics.py        the Genius fetch (lyricsgenius): artist list -> song files on the shelf
      quotes.py              the QUOTATION test: wikitext -> quoted lines, the in-order match, the
                             shelf/quotes/ file (stdlib, tested)
      shelf_quotes.py        the Wikiquote + Wikipedia fetch (MediaWiki API, stdlib): per book on
                             the shelf -> shelf/quotes/<file>.txt
      starts.py              the start-word rule (valid French): displayed sentence, elision,
                             band candidates (stdlib, tested)
      parse.py               spaCy adapter (fr_core_news_md) -> rules.Token
      llm.py                 the questions asked of Claude + JSON parsing; the taste profile and
                             the secret rules are READ FROM THE SKILL FILE at run time
      shelf.py               the shelf, its index, and what the archive already holds (read off
                             the generation output; the backend's local store is a test bed)
      _paths.py              path wiring (generation + benchmark scripts on sys.path)
    shelf/                   GITIGNORED: the epubs and song files to mine (copyrighted),
                             artists.txt (the user's hand-written whitelist), index.json (state),
                             quotes/<file>.txt (each book's quoted lines, per shelf_quotes)
    runs/                    GITIGNORED: one markdown log per run (every rejection names its rule)
    tests/                   pytest, dependency-free (rules, sentences, epub, lyrics); the LLM never runs
    pyproject.toml, uv.lock  claude-agent-sdk, spacy + fr_core_news_md (URL wheel), gensim/numpy,
                             lyricsgenius
```

## Commands

```bash
pnpm curate [--lang fr] [--work <file on the shelf>] [--retry <file>] [--blind] [--seed N]
#   Picks a work (the model, off the shelf minus the archive minus index.json minus the
#   artist cooldown; --work forces one; --retry erases a previous attempt on a file — its
#   index entry and the candidate puzzle(s) it wrote under the generation output — then
#   runs on it), mines it, and writes the first sentence that
#   survives every rule as a puzzle under packages/generation/output/word/fr/... via
#   gen_phrase — headless, the start word is the band's random pick, the #133 form question
#   is answered by the model from the sentence. Exit 0 = a candidate was written (publish it
#   yourself), 2 = every shortlisted sentence was rejected (rerun: another sample, or
#   another work). The log is runs/<stamp>.md. --blind withholds the winning sentence,
#   its secrets and their handling from the log and stdout (a failed attempt is still
#   logged in full; the puzzle file is named after its START words, so its path spoils
#   nothing): the main log gets the player's view, the start words, the source and the
#   path, and everything else goes to runs/<stamp>.spoilers.md — so the run can be read
#   and the puzzle played before being spoiled (user rule 2026-09-07).
pnpm shelf:lyrics [--artists shelf/artists.txt] [--max-songs N]
#   The music source (#262): for each artist of the user's hand-written list, the songs
#   from Genius most viewed first, minus the top FAMOUS_SHARE (the singles), minus what
#   is on the shelf; one .txt per song with a header. Needs GENIUS_ACCESS_TOKEN (a free
#   client token, genius.com/api-clients; never a file in the repo). The only step that
#   touches the network; the curator never does.
pnpm shelf:quotes [--work <file>] [--force]
#   The quotation test's data: per book on the shelf, the author's fr.wikiquote page, the
#   work's wikiquote page when it has one and the work's fr.wikipedia article, their
#   quoted lines written to shelf/quotes/<file>.txt (skipped when the file exists). One
#   request at a time with a named User-Agent; a shelf step, never the curator.
pnpm --filter @whippin/curation test
```

Needs: a paid Claude.ai login in Claude Code (`claude auth status`), the French reduced
vectors (`pnpm reduce:fr` done once), and works on the shelf.

## Stable invariants

- **The LLM never sees an invalid option.** `rules.initial_candidates` builds the list it
  picks from; `rules.prune` shrinks it after every pick; a pick off the list is ignored.
  The model chooses, code enforces. Tunables live at the top of `rules.py`:
  `ALLOWED_POS`, `MAX_COMMON_RANK` (20) / `MAX_COMMON_RANK_ADV` (500, the frequency
  floors read off the reduced vectors' order), `WEAK_VERBS` (verbs of saying, thinking
  and modality, by lemma — never a secret; user-decided 2026-09-08 on a trio led by
  « je crois »), `MIN_CANDIDATES` (8 distinct candidate words, or the sentence never
  reaches the model — `curate.rich_enough` parses the mined sentences before the
  shortlist; measured 2026-09-08 on 27 attempts: 4–7 candidates gave no trio or a dull
  forced one, every trio worth keeping came from 8+), `MIN_GAP` (3 tokens), `COSINE_MAX`
  (0.40), `MODIFIER_DEPS`, `MAX_RESTARTS` (2), `MAX_OFF_LIST` (2), `CONTEXT_GUESSES` (3);
  and at the top of `curate.py`: `MAX_SENTENCES` (600), `CHUNK` (150), `PICKS_PER_CHUNK`
  (6), `SHORTLIST` (20). The mechanical filter (`sentences.is_candidate`) also refuses a
  unit that OPENS on a quotation mark (reported speech, or an argument with a line the
  player cannot see — the same day's « “Il sait qu’il meurt” est une pensée profonde »),
  and the skill's taste rules refuse the REPLY (a line that quotes, answers or corrects
  what the player cannot see) at the shortlist.
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
- **The FAMOUS LINE is a QUOTATION test, never a memory test (user-decided 2026-09-08,
  replacing the two-probe MEMORIZATION test — author + completion from the first half).**
  The model has memorised every line of a canonical book, so what it remembers says
  nothing about what a reader has met: measured on 17 runs, the memory test's two
  rejections were both Machado de Assis lines nobody quotes (one named the niece
  Vénancia). What a reader has met is on record: `pnpm shelf:quotes` fetches, per book,
  the author's fr.wikiquote page, the work's wikiquote page and the work's fr.wikipedia
  article, and `quotes.extract_quotes` writes their quoted lines (`{{citation}}` bodies
  and « … » spans of at least `MIN_QUOTE_WORDS` = 5) to `shelf/quotes/<file>.txt`. The
  curator, OFFLINE, rejects a unit that shares `QUOTE_MATCH` (0.6) of the shorter side's
  words, in order, with a quoted line — at least `QUOTE_MIN_WORDS` (5) of them
  (`quotes.quoted`; a quote can be the first sentence of a two-sentence unit) — and the
  log names the quote. A book with no file skips the test with a warning; a book with no
  page rejects nothing, which is the point (no French reader quotes it). The model's own
  opinion — would a reader who has not read the book know this line — is logged as an
  ANNOTATION (`llm.widely_known`), never a strike. Everything else the model is asked is
  a choice from a list.
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
  (`curate.generate` parses the #133 error's analysis list). Nothing here publishes.
- **The START WORDS are CHOSEN by the model, the three together, never at random**
  (user rule 2026-09-07: the start is the user's daily craft — read the context, avoid a
  synonym when the context helps, go easier when a hole or the context is hard, think of
  the chain of guesses, balance the three; the rules live in the skill's `## The start
  word` section, read by `llm.start_rules`). The first successful gen_phrase run only
  supplies the rank maps; `curate.choose_starts` then shows the model, per hole, the
  slot (form + preceding word), the context-check annotation, and the band candidates
  with ranks (`starts.start_candidates`: rank `START_RANK_MIN..MAX`, no variant,
  elision-clean, not past `MAX_START_FREQ_RANK` = 40000 in the corpus order — « hétéroptère »
  is out), and gen_phrase reruns with `--start MOT=DEPART` per hole — a flag added for
  this (#260), the headless twin of typing a word at the start prompt.
- **The displayed sentence must be VALID FRENCH** (user rule 2026-09-06: « l'effet »,
  never « le effet »). After every generation `curate.check_starts` applies the one rule
  code can apply with certainty (`starts.elision_problem`: an eliding word before a
  vowel, an elided one before a consonant; `h` and `y` are left to the model), then asks the model
  whether the displayed sentence is grammatical (`llm.grammar_check`, one reason per
  faulty inserted word). A refused start is re-picked under the same start rules
  (`llm.pick_start`) and gen_phrase reruns; at most `START_ROUNDS` (3) rounds; what is
  still doubtful is logged for the reviewer.
- **Tests are dependency-free** (`uv run --no-project --with pytest`, like generation and
  benchmark): the rules take plain `Token`s and injected callables, so they run without
  spaCy, vectors or a model.

### Music (#262, user-decided 2026-09-06)

- **The artist list is the whole gate**: `shelf/artists.txt`, the user's, by hand, one
  name per line, gitignored. The fetch reads it and nothing else; the model proposes no
  artist for the fetch. There is NO exclusion list: dropping a name and deleting the
  artist's files is the whole removal.
- **The famous single is cut by pageviews**: `FAMOUS_SHARE` (0.25) of each artist's songs,
  most viewed first, is dropped before any lyric is read (`lyrics.famous_cut`). Features
  are skipped (the line belongs to someone else's song).
- **A puzzle is a UNIT, not necessarily one sentence** (user rule 2026-09-06): a book is
  mined per starting sentence as the shortest run of consecutive sentences of one
  paragraph (at most `MAX_SENTENCES_PER_UNIT` = 3) that reaches the length band — the
  micro-story the archive already holds (the Hagakure day is two sentences).
- **A song is mined the same way, over lines** (`lyrics.candidate_units`): per starting
  line, the shortest run of consecutive lines within a stanza (never across a blank line,
  at most `MAX_LINES_PER_UNIT` = 4) that reaches the sentence band; lines after the first
  lose their capital and a comma bridges a line with no punctuation. The capital and
  terminal-punctuation rules of the sentence filter do not apply to verse.
- **Artist cooldown, not "never twice"**: the same artist at most once every
  `ARTIST_COOLDOWN_DAYS` (30) on the calendar, never the same song. Judged on the
  generation output's file dates (`shelf.archive().last_used`; a puzzle is generated the
  day it is curated) and on the run index (`shelf.last_proposed`). Books keep "never the
  same book twice".
- Music is a minority stream (one or two days a week); the pick prompt says so.
- `source` is `{kind: music, author: <artist>, work: <song title>}`, like the archive.

- **A book day carries its PAGE, and the MODEL CUTS IT (#270, user-decided 2026-09-07;
  the cut 2026-09-08: "sometimes the context should start/end sooner or later")**:
  `sentences.excerpt_around` offers a WINDOW of `EXCERPT_WINDOW` (8) raw sentences each
  side of the chosen unit, in reading order, crossing paragraph breaks (a unit opens its
  paragraph as often as not), never the unit itself; once a trio is found — never before,
  so a rejected sentence spends no call — `llm.choose_excerpt` shows it numbered (B1 right
  before the line, A1 right after) under the skill's `## The page` rules and answers TWO
  COUNTS; `sentences.cut_excerpt` clamps them into the window (code enforces), an answer
  that is not two integers falls back to `EXCERPT_SENTENCES` (3) a side, and a page with
  nothing on either side is no page. The counts are logged (`page:`). The curator hands
  the cut to gen_phrase as `--before`/`--after` — the source's own text, never a summary
  (a curator-written line that gets a fact wrong on a literary screen is worse than
  nothing). **A song gets NO excerpt** (reaffirmed 2026-09-08: a verse or chorus is still
  reproduced lyrics); its track page is gen_phrase's `--url`, by hand.
- **The archive the curator reads is the GENERATION OUTPUT** (`packages/generation/output/
  word/<lang>/…`, every puzzle generated for publishing, works + secrets + sentences),
  never the backend's local store — that one is a test bed (user-decided 2026-09-07).

## Do NOT

- Don't publish, and don't write a puzzle by any path but `gen_phrase`.
- Don't put a rule in a prompt that code can enforce; don't ask the model "is this
  valid?" — give it a valid list.
- Don't copy the taste profile into this package; read the skill.
- Don't commit the shelf (copyrighted files, the artist list) or the runs.
- Don't put a Genius token anywhere but the environment.

## Not in V1 (deliberately)

Publishing; the benchmark as a difficulty gate; difficulty prediction from player logs;
English (`LANGS` is `fr`);
movies/subtitles (explicitly out, #262); per-token guess counting.
