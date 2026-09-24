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
      rules.py               the FACTS about a candidate secret, as PURE functions (+ the tunables)
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
      llm.py                 the questions asked of Claude + JSON parsing; TASTE is read whole from
                             the `taste` skill, the practical laws from `find-sentences`, at run time
      shelf.py               the shelf, its index, and what the archive already holds (read off
                             the PUBLISH LEDGER, packages/generation/published.jsonl)
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
pnpm curate [--lang fr] [--work <file on the shelf>] [--retry <shelf file | puzzle.json>] [--blind]
#   Needs JEV_API_KEY in the environment (#308): the judge's sentence filter and giveaway
#   notes, and gen_phrase — contextual by default — need it.
#   Picks a work BY RULE (2026-09-20; the model no longer picks: `curate.pick_work` —
#   off the shelf minus the archive minus index.json minus the artist cooldown, a song
#   when no music day is within MUSIC_EVERY_DAYS = 4, else a book, the author never
#   used or proposed first, then the one left longest ago, then the file name; --work
#   forces one; --retry <shelf file> erases a previous attempt on a work — its index
#   entry and the candidate puzzle(s) it wrote under the generation output, their judge
#   scores included — then runs on it), mines it, and — taste choosing, code stating
#   facts — writes ONE candidate day under packages/generation/output/word/fr/... via
#   gen_phrase, headless, the #133 form question answered by the model. Exit 0 = a
#   candidate was written (publish it yourself), 2 = no line of the work made a day
#   (rerun: another work). The log is runs/<stamp>.md. --blind withholds the chosen day
#   from the log and stdout (a run with no day is logged in full; the puzzle file is named
#   after its START words, so its path spoils nothing): the main log gets the player's
#   view, the start words, the source and the path, and everything else goes to
#   runs/<stamp>.spoilers.md — so the run can be read and the puzzle played before being
#   spoiled (user rule 2026-09-07).
#   --retry <candidate puzzle.json> retries ONE SENTENCE instead (user-decided
#   2026-09-10: one command, a work or a puzzle): the work is read off the puzzle's
#   `source`, the file is erased (its judge scores kept and replayed for the same trio),
#   the sentence is found again among the work's mined units for its casing; the mining,
#   judge and shortlist are skipped, the day is chosen on that one line. A sentence the
#   ledger holds is refused.
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

- **TASTE CHOOSES, CODE STATES FACTS (user-decided 2026-09-24).** Which line, which three
  words and which start words make a day is the MODEL's call, read off the `taste` skill
  (the one home of taste: the voice, the line, what is built for the game, the hidden
  words, the start words, difficulty). Code keeps only FACTS — which words can be hidden,
  the cooldowns, the famous line, valid French, the puzzle format — and turns everything
  it MEASURES into notes the model reads; nothing measured refuses a word. Why: replayed
  on the 16 days the user loved, the code rules it replaces would have rejected three of
  the lines before any model saw them (`MIN_CANDIDATES`: JeanJass, NeS, Rounhaa) and five
  of the trios (the pair rules: « éleveur de [pigeons] », « le cafard de l'[homme] »),
  and the stacked vetoes left the synonym next door — the generic, easy words of slop.
  **Measured and removed**: the pair rules (one verb, `MIN_GAP`, head/dependent,
  `COSINE_MAX`), the obviousness and expected-word strikes, the giveaway strike, the
  reach strike, the menu of valid trios, the one-easy-entry rule, `MIN_CANDIDATES`, the
  image ordering and the 600-sentence cap.
- **The judge removes what the model should not have to read (#308, 2026-09-20); the
  model reads the rest, in reading order (2026-09-24).** `curate.judge_sentences` scores
  every mined line with Jev (`contextual_rank.score_sentences`: stands alone / carries an
  image or a turn / not a famous line) and drops what fails the loose `sentence_passes`
  (thresholds in `generation/scripts/contextual_rank.py`, chosen so every published day
  passes; about half a novel goes — lines hanging on a name or a pronoun, the flat ones).
  No ordering, no cap: sorting by the image score favoured description, and on a big
  book the 600-line cap left hundreds of lines unread. A run without the key dies before
  any model call. **A rerun never pays the ranking judge twice**: `generate` replays the
  previous run's sidecar (`--contextual-replay`) when it regenerates with the model's
  start words, and `--retry <puzzle.json>` keeps the erased draft's scores for the same
  trio.
- **The model shortlists with taste, then CHOOSES THE DAY BY COMPARISON.** It reads every
  kept line, `CHUNK` (150) at a time, picks at most `PICKS_PER_CHUNK` (6) by the taste
  skill and ranks a `SHORTLIST` (20), even when fewer than 20 lines were picked (one line
  needs no ordering). `curate.day` then shows it `COMPARE` (5) lines at a
  time, each with the words code allows (`rules.initial_candidates`), and
  `llm.choose_day` names the best line and its three words in the order players will
  find them, playing each out — or declines. Code checks the facts: three distinct words
  of the line that can be hidden, and the line STANDS ALONE (below); a refusal is told
  back and it chooses again, `DAY_ROUNDS` (3) times, then the next lines. Every line
  compared goes to the index as tried.
- **Code MEASURES each chosen word and hands the notes to the start-word step**
  (`curate.build_day`): the READER — the user's own method, one call per word
  (`llm.context_guesses`: the line with that word blanked, the rest intact, no start
  word; the words that could stand there and the one most readers would write) — becomes
  a plain note (`rules.reading`: whether most readers would write the secret itself,
  twins folded — `is_twin`, `TWIN_RANK` 3 — a rare word past `PLAIN_WORD_RANK` never
  said to be expected); the judge's giveaway score (`curate.giveaway_scores`, with its
  real-play meaning: at `GIVEAWAY_MAX` 0.45 and above, a third of the players typed the
  hole within three guesses); and, once the map is built, where the reader's nearest word
  lands in the hole's own map (`rules.map_nearest_filler`). With those notes and each
  hole's band, `llm.pick_starts` plays the day out and chooses the three starts — or
  names ONE hidden word no start can save and another word of the line to hide instead
  (`Replace`: the draft is erased, the day rebuilt, `REPLACE_ROUNDS` 2).
- **Which words can be hidden (facts, `rules.initial_candidates`):** NOUN/VERB/ADJ/ADV and
  PROPN (the parser tags a lowercase brand or rare noun as a proper noun — « rolex »,
  « zigzag », secrets of a favourite day; a name nobody can reason toward is taste's
  call), not stopwords, not among the commonest words (`MAX_COMMON_RANK` 20 /
  `MAX_COMMON_RANK_ADV` 500, read off the reduced vectors' order), not a `WEAK_VERBS` verb
  (saying, thinking, modality — user-decided 2026-09-08), slug in the vocab — a
  hyphenated compound included (user-decided 2026-09-24, lifting the 2026-09-10
  exclusion: « post-it » was a secret of a favourite day), not a secret still in its `SECRET_COOLDOWN_DAYS` (90, `shelf.py`, judged on the
  ledger's game day), no same-lemma twin under another slug in the line (a same-slug
  repeat is one hole per occurrence). A line with fewer than `TRIO` such words is skipped.
- **The sentence must STAND ALONE, solved (user-decided 2026-09-18, on the Svevo day:
  « c'étaient donc des nerfs parfaits » meant nothing even solved — the page is shown
  after the solve, never during play).** One call per CHOSEN line (`llm.stands_alone`, the
  rule read from the find-sentences skill's `## Stands alone` section, the REPLY
  included): the model says in one line what the sentence is about from the sentence
  alone and whether it stands; code refuses on a refusal and the choice is told back.
- **The FAMOUS LINE is a QUOTATION test, never a memory test (user-decided 2026-09-08,
  replacing the two-probe MEMORIZATION test — author + completion from the first half).**
  The model has memorised every line of a canonical book, so what it remembers says
  nothing about what a reader has met: measured on 17 runs, the memory test's two
  rejections were both Machado de Assis lines nobody quotes (one named the niece
  Vénancia). What a reader has met is on record: `pnpm shelf:quotes` fetches, per book,
  the author's fr.wikiquote page, the work's wikiquote page and the work's fr.wikipedia
  article, and `quotes.extract_quotes` writes their quoted lines (`{{citation}}` bodies
  and « … » spans of at least `MIN_QUOTE_WORDS` = 5) to `shelf/quotes/<file>.txt`. The
  curator, OFFLINE, removes every mined unit that shares `QUOTE_MATCH` (0.6) of the
  shorter side's words, in order, with a quoted line — at least `QUOTE_MIN_WORDS` (4) of
  them (`quotes.quoted`) — before the judge or the model reads it, and the log names the
  quote. A book with no file skips the test with a warning; a book whose fetch found no
  page (`quotes.quote_sources` empty) rejects nothing and says so. The model's own
  opinion — would a reader who has not read the book know this line — is logged as an
  ANNOTATION (`llm.widely_known`), never a strike.
- **Taste has ONE home, the `taste` skill, read WHOLE by every prompt that chooses** (the
  shortlist, the day, the starts); the `find-sentences` skill keeps the practical laws
  the prompts quote (`## The quotation rule`, `## Stands alone`, `## The start word`,
  `## The page`). Edit the skills, never a prompt copy.
- **The transport is the benchmark's** (`llm_play._agent_sdk_turn`, the paid-Claude.ai
  guard, the conflict-env scrub): one fresh conversation per question, model
  `claude-opus-5-5`, adaptive thinking, effort `high` (set explicitly: Opus 5.5 defaults to
  `medium`). Opus 5.5 needs the Agent SDK >= 0.2.159 (its bundled CLI >= 2.1.280; an older
  one refuses the model). No second spelling of it here.
- **`gen_phrase` is the only writer of a puzzle**, run headless from this package with
  `--words` and, when it demands one, `--form` answered by the model from the sentence
  (`curate.generate` parses the #133 error's analysis list). Nothing here publishes.
- **The START WORDS are CHOSEN by the model, the three together, never at random**, by
  playing the day out with code's notes (above), from the ONE band 100–200 of every map
  (`starts.start_candidates`: rank `START_RANK_MIN..MAX`, no variant, elision-clean, not
  past `MAX_START_FREQ_RANK` = 40000 in the corpus order — « hétéroptère » is out). The
  first successful gen_phrase run only supplies the rank maps; gen_phrase then reruns
  with `--start MOT=DEPART` per hole (#260). An incomplete model choice refuses and erases
  the draft, never keeping a random generator pick. **A secret/start PAIR is blacklisted for
  good** (user-decided 2026-09-08): `shelf.archive()['pairs']` holds every start each
  secret was ever played with, `choose_starts` and `check_starts` exclude them from the
  band, and a generated start that repeats a pair is refused and re-picked.
- **The displayed sentence must be VALID FRENCH** (user rule 2026-09-06: « l'effet »,
  never « le effet »). After every generation `curate.check_starts` applies the one rule
  code can apply with certainty (`starts.elision_problem`: an eliding word before a
  vowel, an elided one before a consonant; `h` and `y` are left to the model), then asks the model
  whether the displayed sentence is grammatical (`llm.grammar_check`, one reason per
  faulty inserted word) — agreement, elision AND each start's CONSTRUCTION with what
  follows it (« affublé d'un prénom » for « hérité d'un prénom » passed the check on
  2026-09-10). A refused start is re-picked (`llm.pick_start`, taste included) and
  gen_phrase reruns; at most `START_ROUNDS` (3) rounds; what is still doubtful is logged
  for the reviewer.
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
  paragraph (at most `MAX_SENTENCES_PER_UNIT` = 3) that reaches `MIN_WORDS` (14) — the
  micro-story the archive already holds (the Hagakure day is two sentences) — and, since
  2026-09-24, the sentence ALONE when it has at least `MIN_LINE_WORDS` (10): a short
  punchline is often the best line of all (JeanJass, 16 words), and the model judges it.
- **A song is mined the same way, over lines** (`lyrics.candidate_units`): per starting
  line, the runs of consecutive lines within a stanza (never across a blank line, at most
  `MAX_LINES_PER_UNIT` = 4) from the first reaching `MIN_LINE_WORDS` to the first reaching
  `MIN_WORDS`; lines after the first
  lose their capital and a comma bridges a line with no punctuation. The capital and
  terminal-punctuation rules of the sentence filter do not apply to verse.
- **Artist cooldown, not "never twice"**: the same artist at most once every
  `ARTIST_COOLDOWN_DAYS` (30) on the calendar, never the same song. Judged on the
  ledger's game day (`shelf.archive()['last_used']`) and on the run index
  (`shelf.last_proposed`). Books keep "never the same book twice".
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
- **The archive the curator reads is the PUBLISH LEDGER** (`packages/generation/
  published.jsonl`, gitignored, appended by `pnpm puzzle:publish --s3` and by nothing
  else, rebuilt from the bucket by `pnpm puzzle:ledger --s3` — the curator DIES without
  it; root `AGENTS.md`; user-decided 2026-09-08, superseding the generation output of
  2026-09-07):
  works, secrets in their cooldown (judged on the game DAY the line names), the permanent
  secret/start pairs, sentences, the artist cooldown's dates. A day published twice keeps
  its last line for secrets, sentence and work — but its PAIRS come off every line, the
  corrected day's earlier start included (it was played until the correction). Neither the generation output (what `forget` erases: attempts) nor the
  backend's local store (a test bed) is ever read for the archive.

## Do NOT

- Don't publish, and don't write a puzzle by any path but `gen_phrase`.
- Don't turn a measurement into a veto: code states facts, taste chooses. A new signal
  goes to the model as a note, with its real-play meaning.
- Don't write taste into code or a prompt copy; it lives in the `taste` skill.
- Don't commit the shelf (copyrighted files, the artist list) or the runs.
- Don't put a Genius token anywhere but the environment.

## Not in V1 (deliberately)

Publishing; the benchmark as a difficulty gate; difficulty prediction from player logs;
English (`LANGS` is `fr`);
movies/subtitles (explicitly out, #262); per-token guess counting.
