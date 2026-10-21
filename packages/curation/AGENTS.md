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
      rules.py               the FACTS about a candidate secret and against a trio, as PURE functions
                             (+ the tunables)
      sentences.py           text -> candidate UNITS: a sentence, or up to 3 consecutive short
                             sentences of one paragraph (length band, self-contained; stdlib)
      epub.py                epub -> text + metadata (stdlib)
      lyrics.py              song files (#262): header format, Genius cleanup, couplet UNITS,
                             the famous-single cut, the artist cooldown (stdlib, tested)
      shelf_lyrics.py        the Genius fetch (lyricsgenius): artist list -> song files on the shelf
      quotes.py              the QUOTATION test: wikitext -> quoted lines, the in-order match, the
                             shelf/<lang>/quotes/ file (stdlib, tested)
      shelf_quotes.py        the Wikiquote + Wikipedia fetch (MediaWiki API, stdlib): per book on
                             a language's shelf, that language's wikis -> shelf/<lang>/quotes/<file>.txt
      starts.py              the start-word rule (valid in the language): displayed sentence, French
                             elision / the English article, band candidates (stdlib, tested)
      parse.py               spaCy adapter (fr_core_news_md, en_core_web_md) -> rules.Token
      llm.py                 the questions asked of Claude + JSON parsing; TASTE is read whole from
                             the `taste` skill, the practical laws from `find-sentences`, at run time;
                             the taste's seven kinds by number (`KINDS`)
      jev.py                 the two questions asked of TypeSafe's Jev: the sentence filter and the
                             giveaway (client, per-language templates, thresholds; stdlib, tested)
      shelf.py               LANGS, the shelves, their index, and what a language's archive already
                             holds (read off the PUBLISH LEDGER, packages/generation/published.jsonl)
      _paths.py              path wiring (generation + benchmark scripts on sys.path), shelf_dir(lang)
    shelf/<lang>/            GITIGNORED, ONE SHELF PER LANGUAGE (fr/, en/): the epubs and song files
                             to mine (copyrighted), artists.txt (the user's hand-written whitelist),
                             index.json (state), quotes/<file>.txt (each book's quoted lines, per
                             shelf_quotes)
    runs/                    GITIGNORED: one markdown log per run (every rejection names its rule)
    bank/<lang>.jsonl        GITIGNORED: banked lines, read and finished but for their puzzle, and the lines
                             set aside with why (`--bank`, `--rebank`; scripts/bank.py),
    bank/<lang>.md           read here by kind (SPOILERS); `--finish <id>` makes one a candidate day
    tests/                   pytest, dependency-free (rules, sentences, epub, lyrics); the LLM never runs
    pyproject.toml, uv.lock  claude-agent-sdk, spacy + fr_core_news_md + en_core_web_md (URL wheels),
                             gensim/numpy, lyricsgenius
```

## Commands

```bash
pnpm curate [--lang fr|en] [--work <file on the shelf>] [--retry <shelf file | puzzle.json>] [--blind]
#   --lang (`shelf.LANGS`: fr, en; default fr) picks the SHELF (shelf/<lang>/, where a work
#   goes by its EDITION's language), the ARCHIVE (the ledger's lines of that language) and
#   the VECTORS (generation's `embedding_neighbors.for_lang`); the two languages share nothing
#   (#317, user-decided 2026-09-25).
#   Needs JEV_API_KEY in the environment: Jev's sentence filter and giveaway scores
#   (`jev.py`) ask it. gen_phrase asks no judge.
#   Picks a work BY RULE (no model call: `curate.pick_work` —
#   off the shelf minus the archive minus index.json minus the artist cooldown, a song
#   when no music day is within MUSIC_EVERY_DAYS = 4 or no book is left, else a book,
#   the author never used or proposed first, then the one left longest ago, then the
#   file name; --work forces one; --retry <shelf file> erases a previous attempt on a
#   work — its index
#   entry and the candidate puzzle(s) it wrote under the generation output, their
#   `.other-sense.json` sidecars included, but never a puzzle that was published
#   (`shelf.published_drafts`, off every ledger line: its sidecar rebuilds its maps) — then
#   runs on it), mines it, and — taste choosing, code stating
#   facts — writes ONE candidate day under packages/generation/output/word/<lang>/... via
#   gen_phrase, headless, the #133 form question answered by the model. Exit 0 = a
#   candidate was written (publish it yourself), 2 = no line of the work made a day
#   (rerun: another work). The log is runs/<stamp>.md. --blind withholds the chosen day
#   from the log and stdout (a run with no day is logged in full; the puzzle file is named
#   after its START words, so its path spoils nothing): the main log gets the player's
#   view, the start words, the source and the path, and everything else goes to
#   runs/<stamp>.spoilers.md — and the trio's words of another sense, handed to gen_phrase,
#   to runs/<stamp>.spoilers.other-sense.json (keyed by the hidden words) — so the run can
#   be read and the puzzle played before being spoiled (user rule 2026-09-07).
#   --retry <candidate puzzle.json> retries ONE SENTENCE instead (user-decided
#   2026-09-10: one command, a work or a puzzle): the work is read off the puzzle's
#   `source`, the file and its sidecar are erased, the sentence is found again among the
#   work's mined units for its casing; the mining, judge and shortlist are skipped, the day
#   is chosen on that one line. A sentence the ledger holds is refused.
pnpm curate [--lang fr|en] --bank N [--work <file>] [--blind]
#   BANKS N works (the whole shelf, as many as asked) instead of making a day (user-decided
#   2026-10-18: lines curated ahead, the user picks the ones to finish). Each work is mined,
#   quote-tested, through the judge's sentence filter and shortlisted as a run does; EVERY
#   line of its shortlist (SHORTLIST, 20) is READ (below) and finished as a day but for its
#   puzzle: its main word measured alone and two words chosen against it, each word's OTHER
#   SENSE set aside (`curate.prepare`, below), then its START WORDS chosen on the words' LINE
#   maps (`curate.line_map`: the maps its puzzle will have) by the run's own start step and
#   checks (`curate.bank_line` on an in-memory draft, `static_draft`; a word chosen against
#   the main word that no start saves is refused and two words chosen again, within the
#   line's COMPANION_ASKS) — and appended to bank/<lang>.jsonl with its read, the taste it was
#   read under (`bank.taste_stamp`: the taste and find-sentences skills, hashed before the
#   work's lines are read), its three words — the main word first, each with its role, its
#   path and the words it runs through, its ladder when it is one of a wide kind, its facts
#   and its start with its rank — each word's other-sense check (`senses`: the sense the line
#   uses, whether its map carries it, why, the words set aside) and what it was measured at.
#   A line SET ASIDE on the way (by its read, its giveaway, its main word, the two words
#   against it, or its start words) is appended too, with why (`dropped`), its read, the
#   giveaways paid, what was measured and the other-sense checks asked (`bank.aside`): it
#   counts as mined and is never finished. Nothing is compared or written as a puzzle.
#   bank/<lang>.md (`bank.render`, SPOILERS) lists the lines kept BY KIND — the taste's seven
#   in order, then No kind — each with its id, its source, its main word and the visible words
#   its path runs through, its ladder, the sibling warning, each of the two words chosen
#   against it with its path, and the line as it opens with each word's start, its rank, its
#   facts and how many words of another sense its map lost (the main word in bold); then the
#   lines set aside, each with why; then the lines waiting for `--rebank` (their words to
#   choose, or their other-sense check). The works keep the calendar's shape
#   (`curate.bank_pick`: one song per MUSIC_EVERY_DAYS works, an artist's next song once
#   ARTIST_COOLDOWN_DAYS more works are banked, authors spread; songs held back only until
#   the books run out), with no artist cooldown; a banked work is never mined again, by a
#   bank or a run (a work that banked no line stays as a marker entry). Processes may run
#   side by side, a normal run included: each CLAIMS its work under the bank's lock
#   (bank/<lang>.claims, `<file>\t<pid>`; a claim whose process is gone no longer counts),
#   re-reading the index before each pick; a banking process logs to its own
#   runs/<stamp>-bank-<pid>.md and releases a work whose banking failed (its detail kept
#   with the spoilers; two failures in a row stop it). Exit 2 when nothing was banked.
pnpm curate [--lang fr|en] --finish <id> [--blind]
#   A banked line the user chose, made ONE candidate day: read against today's archive
#   (`bank.restore`: a line set aside, one whose words were not chosen the main word first or
#   carry no other-sense check — no back-compat, `--rebank` takes them — a published work or
#   sentence, or a word back in its secret cooldown, is refused), then built as a run builds
#   its chosen line (`curate.build_day`: its words checked once more on their line maps from
#   the measures stored, the page, then gen_phrase on those same maps — `--other-sense` —
#   with the starts it was banked with on the FIRST run: chosen on these maps, never chosen
#   again; then `check_starts`' rounds on the written puzzle, since the archive's start
#   blacklist may have moved and the agreed forms are known only now). No paid step: Jev is
#   not asked, no JEV_API_KEY needed. A line found UNBUILDABLE stops with why, nothing swapped; a banked
#   start gen_phrase refuses, or one the written map no longer holds in its band, or a fact
#   against the trio on that map (`curate.banked_fault`, code alone: a word with two
#   dictionary entries is the one case where the written map differs, below) stops it too,
#   logged « rebank it ». Never publishes.
pnpm curate [--lang fr|en] --rebank [--work <file>] [--blind]
#   TAKES the bank's lines again under today's taste, in place (`curate.rebank_works`): every
#   line with its giveaways stored never read, or read under another taste stamp, or read
#   under this one and kept with words not chosen the main word first or without their
#   other-sense check (`bank.stale`). Never reads the shelf, never asks the judge (no
#   JEV_API_KEY needed: the giveaways and the measures are the ones stored at banking), never
#   runs gen_phrase. Each line is
#   parsed again, its sentence or its work published since (`--finish` refuses either), or
#   fewer than TRIO words to hide among those judged at banking, set aside with no call; else
#   READ (`curate.read`, one call) unless its read is today's, shown every word judged at
#   banking at or above the floor (`bank.pool`), those in their cooldown INCLUDED: the read
#   is a lasting verdict on the line, the cooldown a fact of the day. Then its words are
#   CHOSEN again, the main word first, as a run chooses them (`curate.anchor_gate`,
#   `curate.choose_others`), from the words its read leaves and out of their cooldown, and
#   its start words on their line maps (`curate.bank_line`): no measure nor other-sense
#   check stored is asked again, a hole's neighbours answer only when its fragment changed.
#   The line gains its read, the stamp (taken before the reads: a taste edited meanwhile
#   takes them again) and its new words, or is set aside with why — its read, giveaways,
#   measures and other-sense checks kept either way, so a later rebank takes it again with
#   no judge; it keeps when it was banked. A line
#   with no usable reading (`READ_ROUNDS` told back), or whose main word (or enough of its
#   words to leave it short) is in its cooldown, or set aside after its main word passed
#   while a word in its cooldown was left out (the words against it were chosen without
#   it), is left as it was, for a later rebank. A line set aside before its giveaway was paid
#   is never taken again: nothing it could hide was judged. Works are claimed as `--bank`
#   claims them (processes side by side), each work's entries rewritten in place under the
#   lock (`bank.replace_work`: a temporary file renamed
#   over the bank, every other work untouched and in order), the page rendered after each,
#   under the lock. A work whose rebanking fails is released; two failures in a row stop the
#   process. Resumable and idempotent: exit 2 when nothing was left to take. Copy
#   bank/<lang>.jsonl first (gitignored).
pnpm shelf:lyrics [--lang fr] [--artists shelf/<lang>/artists.txt] [--max-songs N]
#   The music source (#262): for each artist of the user's hand-written list, the songs
#   from Genius most viewed first, minus the top FAMOUS_SHARE (the singles), minus what
#   is on the shelf; one .txt per song with a header, `<artist>__<title>__<genius id>.txt`
#   (`lyrics.song_filename`: readable, one file per song). Needs GENIUS_ACCESS_TOKEN (a free
#   client token, genius.com/api-clients; never a file in the repo). The only step that
#   touches the network; the curator never does.
pnpm shelf:quotes [--lang fr] [--work <file>] [--force]
#   The quotation test's data: per book on the language's shelf, the author's page on
#   that language's Wikiquote, the work's page there when it has one and the work's
#   article on that language's Wikipedia (fr.* or en.*), their quoted lines written to
#   shelf/<lang>/quotes/<file>.txt (skipped when the file exists).
#   One request at a time with a named User-Agent; a shelf step, never the curator.
pnpm --filter @whippin/curation test
```

Needs: a paid Claude.ai login in Claude Code (`claude auth status`), the language's reduced
vectors (`pnpm reduce:fr` / `pnpm reduce:en` done once), and works on its shelf.

## Stable invariants

- **TASTE CHOOSES, CODE STATES FACTS (user-decided 2026-09-24).** Which line, which three
  words and which start words make a day is the MODEL's call, read off the `taste` skill
  (the one home of taste: the voice, the line, the seven kinds and the rules for every
  kind, the three words, the start words, difficulty). Code keeps only FACTS — which words
  can be hidden, the cooldowns, the famous line, valid grammar, the puzzle format — and
  turns everything it MEASURES into notes the model reads; nothing measured refuses a word
  but the giveaway FLOOR (`curate.floor`) and the facts `rules.trio_faults` names, by role
  (below): the BURIED, NEIGHBOURS and UNMAPPED rules and an empty start band on every hole,
  the main word handed, a word right beside the main word — and the model's own verdicts on
  a word it chose (a mirror, a lottery) and its other-sense verdict on a hidden word (a map
  that barely carries the line's sense, or no verdict: `curate.sense`, user-decided
  2026-10-21). Why: replayed
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
  every mined line with Jev (`jev.score_sentences`: stands alone / carries an image or a
  turn / not a famous line) and drops what fails the loose `sentence_passes` (thresholds in
  `scripts/jev.py`, chosen so every published day passes; about half a novel goes — lines
  hanging on a name or a pronoun, the flat ones). No ordering, no cap: sorting by the image
  score favoured description, and on a big book the 600-line cap left hundreds of lines
  unread. A run that asks Jev (`--bank`, a normal run) dies without the key before any
  model call. Jev is asked two things and no more (`jev.py`): this sentence filter and the
  giveaway (below), the French requests byte-identical to the calibrated ones. It orders no
  map: a hidden word's map is its plain map minus its other sense (below).
- **The model shortlists with taste, then CHOOSES THE DAY AMONG FINISHED LINES**
  (user-decided 2026-10-13: a line chosen before its checks ran was hollowed out by its
  swaps, and the rest of the shortlist was never looked at). It reads every kept line,
  `CHUNK` (150) at a time, picks at most `PICKS_PER_CHUNK` (6) by the taste skill and
  ranks a `SHORTLIST` (20), even when fewer than 20 lines were picked (one line needs no
  ordering; an empty or unreadable ranking keeps the reading order — the question asks
  for an order, never a refusal). `curate.day` then FINISHES the shortlist `CANDIDATES`
  (10) lines at a time, `WORKERS` (5) in parallel (`curate.candidate`; the subscription's
  conflicting credentials are removed once around the whole block, `llm.subscription_only`,
  since each call's own removal would be restored under the others): the line is READ
  (below; a line the read sets aside goes no further and pays no judge), the judge's
  giveaway is paid for the words it can hide (the floor, below), then its words are chosen
  THE MAIN WORD FIRST (below, `curate.choose_trio`). `llm.choose_among` then COMPARES the
  lines that survived, each as the player will get it — the line with its words in
  brackets, its kind, its main word and the two chosen against it, what leads to each and
  its facts in a few words (`Checked.tags`: readers write it in, a word players don't say,
  the line gives little of it, one of a wide kind) — and orders them, best day first,
  leaving out what would make no day; a line with no kind goes first only when, read aloud,
  it beats the built ones. The first is built (`curate.build_day`: its words checked once
  more on their line maps, page, puzzle, start words); when it cannot be, the next; then the
  next lines. Every line prepared goes to the index as tried.
- **The words are chosen the way the user chooses them by hand (user-decided 2026-10-20:
  "once I find a good line, there's always a word I'm sure I want to pick, then I chose 2
  other words that works well with my first pick"): the MAIN word first, then two AGAINST
  it, and nothing is ever swapped.** The main word is the read's (below), named once. It is
  measured ALONE — only its own occurrences hidden — then its OTHER SENSE is asked (below),
  and it is refused by any fact against it on its line map (`curate.anchor_gate`,
  `rules.trio_faults`: buried, unmapped, its neighbours writing it in, most readers writing
  it in, the reader's word at or under `HANDED_RANK` on its map, no start in its band): the
  line is then set aside, since the main word is never swapped; one players don't say
  passes — the trio's one such word belongs there. Then `llm.choose_companions` chooses TWO
  words against it — the taste, whole, and the laws; the line with the main word in
  brackets, its kind, path, ladder and notes; every word the line can hide with it, each
  with the starts its band offers on its line map (`curate.band_of`): the PLAIN map for a
  word not yet asked its other sense (a word with none is not offered; asking every word
  offered would cost a call each, and the starts are chosen later, on the line maps); what
  was refused so far — each with its path
  through 1 to 3 words of the line, whether it is the partner of a visible word, whether it
  is one of a wide kind and its ladder, what it does when it lands; or it declines (the line
  is set aside). An answer that is not two distinct words offered, each with such a path
  (`curate.path_off`), is told back. Each word then has its other sense asked — one whose
  map barely carries its sense in the line, or with no verdict, is refused, the ask spent —
  and is measured with the three hidden (`curate.measure`) and its facts read on its line map
  (`rules.trio_faults`, by role). The
  main word passed alone: all that can now hold against it is its neighbours, cut by a word
  hidden among them, writing it in — that word is refused, never the main word nor the line.
  A fact against one of the two others — buried, unmapped, its neighbours writing it in (a
  VETO on every hole, never the day's one handed word: user-decided 2026-10-13 and
  2026-10-20), a mirror, a lottery (a wide word whose ladder misses a step, on every hole:
  user-decided 2026-10-20), no start in its band, right beside the main word with nothing
  between (`rules.adjacent`: « [folk] [dancing] »; « [éleveur] de [pigeons] » passes) —
  refuses it: it leaves the words to choose from and the next ask is told why
  (`curate.refuse`); what holds against the three together — two or more words players
  don't say, two or more the line hands over (readers, or the map), a word every word of
  whose path is hidden (a locked pair, or the main word's path hidden by a word chosen
  against it), two others side by side — is told back, refusing none.
  `COMPANION_ASKS` (3) asks per line in all, format answers and the bank's start step
  included; spent, the line is set aside. There is no review of a finished trio: asked of
  every trio, the model swapped on 77% of played days, loved ones included, and picked the
  hard word no better than chance — the trio is built up front, main word first, and code
  tells back what fails. NOTHING IS SWAPPED (user-decided 2026-10-20): a fact found on the
  written map, or a word no start gives a path, makes the line UNBUILDABLE
  (`curate.Unbuildable`) and it is not built; only the bank's start step chooses again in
  place of a word chosen against the main word that no start saves.
- **Each hidden word's map is its PLAIN static map minus the words of ANOTHER SENSE than
  the one its line uses (user-decided 2026-10-21: "the main goal is actually to eliminate
  irrelevant meanings of a word"), ONE map from the choice of the words to the shipped
  puzzle** (`curate.line_map`; how gen_phrase takes the words off: generation `AGENTS.md`).
  The one exception is a word with two dictionary entries (« marche », noun or verb): the
  curator's walk confirms no form, gen_phrase's claims the confirmed entry's other forms
  too, and every rank after them moves by as many — so `--finish` reads the banked starts'
  bands and the trio's facts again on the written map, in code (`curate.banked_fault`).
  `curate.sense` asks it once per word per line, of the main word in `anchor_gate` and of
  each word chosen against it in `choose_others` (`line["senses"]`, kept in the bank): the
  model is shown the first `SENSE_TOP` (300) display words of the word's plain map, closest
  first, each group once, and names those near it ONLY through another dictionary sense — a
  homonym, a clearly different use or construction (`llm.other_sense`); while a round names
  `SENSE_DIG` (30) or more and fewer than `SENSE_ROUNDS` (4) were asked, the next round shows
  the first 300 words of the plain map still there once every word named so far is taken
  off — a round naming n words brings n new words into view, not a whole new window (the
  near words left are shown again); code keeps only words of the list shown. The
  first round also says which sense the line uses, and EVERY round whether the map CARRIES
  it once the words named are gone — for a figurative or euphemistic sense, the words of
  that sense, not of the literal one it comes from. The first round that says no ends the
  asking (the later rounds, shown a list already cleared, grow lenient), and a word whose
  map barely carries its sense (« partir » for dying on a map of leaving: 3 of 158 played
  holes) is refused — the main word sets the line aside, one chosen against it is refused
  (`curate.refuse`) — and so is a word whose answer is still unusable once asked again:
  never hidden unchecked. Every map the curator checks
  or picks starts on is the line map — the facts, the bands, `check_words`, the start
  step's draft (`static_draft`) — and `generate` hands gen_phrase the words
  (`--other-sense`, `runs/<stamp>.spoilers.other-sense.json`: keyed by the trio, a spoiler,
  named as one, in every run); gen_phrase writes them beside the
  puzzle (`<puzzle>.other-sense.json`, `shelf.sidecar_path`), the logged command names that
  sidecar so it replays, and a draft erased takes its sidecar with it. The crowd and a
  word's own keys stay on the plain map. Why: the plain order is right within one meaning
  (« poison »: poisonous 1st, toxic 5th, toxin 6th); on 158 played holes the model named
  other-sense neighbours on 92 and touched no one-meaning word.
- **Code MEASURES each chosen word and hands the facts to the choice and the notes to the
  start-word step** (`curate.measure`, each measure asked once per line, `Measures`; the
  facts `curate.hole_facts`, the notes `curate.context_note`): the READER — the user's own
  method, one call per word (`llm.context_guesses`: the line with that word blanked, the
  rest intact, no start word; the words that could stand there and the one most readers
  would write) — whether most readers would write the secret itself (`rules.reader_writes`,
  twins folded — `is_twin`, `TWIN_RANK` 3 — a rare word past `PLAIN_WORD_RANK` never said to
  be expected), a fact and a plain note (`rules.reading`); the judge's giveaway score
  (`curate.giveaway_scores`, judged once the line is read, BEFORE the choice, for every word
  that can be hidden but those the read says need the work — the floor, below — with its
  real-play meaning: at `GIVEAWAY_MAX` 0.45 and above, a third of the players typed the
  hole within three guesses; under `GIVEAWAY_HARD` 0.20 the hole plays hard, noted as one
  the line gives little of — the start step's note, never a nearer band, below; scores in
  the notes are cut to two places, never rounded (`rules.two_places`): a score under a bar
  never prints at it); the WOULD-SAY test (user-decided 2026-10-06, on « faux-monnayeur »),
  one call per word (`llm.would_say`: the line with that word blanked AND the word named —
  would a player who has roughly the meaning ever say it, or keep to commoner words
  meaning nearly the same?) as a note (`rules.said`) — in English the question adds that
  the players come from every English-speaking country, so a word or a sense only a small
  part of English speakers use counts as unsaid (`llm.AUDIENCE`, user-decided 2026-10-14,
  after « knickers »; the French question stays worded as calibrated): under
  `WOULD_SAY_HARD` 0.4 it is a word players don't say; ONE makes a hard day a loved day may
  hold (« moucheron », « mammifères »), TWO or more made the worst days (finished by a
  median 40 % of the players, against 57 % with one and 71 % with none), so a trio holding
  two is told back (`rules.trio_faults`) and never kept; the CROWD (`rules.crowd_share`,
  free: the word's own PLAIN static map, `gen_phrase.walk_secret`, built in
  `load_similarity`): the share of its `CROWD_N` (30) nearest groups more common in the
  corpus than it, as a note — and the BURIED rule (user-decided 2026-10-08, after
  « charnier »): a word players only half-say (would-say ≤ `BURIED_WOULD_SAY` 0.50, asked
  TWICE and averaged when the crowd is over its bar) among commoner near-words (crowd ≥
  `BURIED_CROWD` 0.70) is refused on every hole. Players
  reach the idea, circle the commoner neighbours and stall: on 126 played French holes such
  words stalled players about twice as often, rarity aside. A rare NAME passes
  (« saint-bernard », said at 0.58), a rare stand-in does not (« faux-monnayeur »,
  « charnier »); English uses the French bars, unchecked on play — the NEIGHBOURS rule
  (user-decided 2026-10-13: "droit de ___ is no fun when it's vote", « cinq semaines de ___
  payés »): the words right around the hole — up to `NEIGHBOURS` (3) each side, never
  across punctuation nor another hole (`rules.neighbourhood`; the other hidden words cut the
  fragment, and a fragment that changes is asked again) — shown alone, the model writes the
  first word they call for (`llm.neighbours_complete`), around EACH hole of a repeated word
  (`Measures.frames`, one frame per occurrence); when that is the hidden word around any of
  them (`rules.same_word`) the neighbours hand it over and it is refused the same way, on every
  hole, never counted as the day's one handed word. Its first word is the measure, never a
  share: told the word or not, the model hedges (« vote » 0.3, « arrêt ___ » → « cardiaque »
  0.3), and Jev's fixed-expression question scored « vote » under « sacrifices », a hole
  players searched. On 174 played French holes it refuses 16, among them « vote »,
  « congés », « partir », « chaussettes », and of the loved days' 48 « poche » (« dans sa ___
  une montre ») and « humain » (« le savoir ___ ») — and the UNMAPPED rule (user-decided
  2026-10-12, after « laisse », whose vector is the verb's: its map held no « chaîne »): a
  word NONE of whose reader words (single words the vectors know) is on its line map
  (`rules.unmapped`, read on the map at hand) is refused the same way — every first guess
  lands past the map. On the
  49 played French days with a reader on file it catches « facho », « insecte »,
  « réverbères », no loved day. A word whose reader's most-likely word sits at or under
  `HANDED_RANK` (3) on its map is handed over too (`rules.map_handed`: « pou » for
  « morpion », « mourir » for « partir », both found in one or two guesses; no played day
  had one) — read on the line map at the choice, on the written map at the start step (the
  same map, its forms agreed; a banked line's at `--finish`): the main word so handed is
  refused, and two words handed
  over (readers, or the map) are
  told back (user-decided 2026-10-12, after a Desproges day solved in ten seconds); ONE easy
  word is the start step's to tune, never a duller word. And, once the map is built, where
  the reader's nearest word lands in the hole's own map (`rules.map_nearest_filler`) — past
  `READER_FAR_RANK` (500), or past the map, the note adds that the line gives little of the
  word (`rules.far_note`, `curate._notes`; user-decided 2026-10-14, after « tutoyer » at 759
  and « cercueil » at 1010: nothing a player types first tells them they are getting
  closer); a fact for the start step, never which start to take (the taste's call), never
  when the readers write the word itself, and never a veto (the user kept « cercueil »). A
  word players would say instead that IS this word in another form (« sauver » for
  « sauva »: its spelling, its lemma, or a key of its own group on its plain map — what
  typing it finds, `rules.same_word`, `curate.load_similarity`'s `own`; « table » is not
  « tablée »; the coarse spelling test `is_variant` only for a word with no map — never a
  near neighbour like « faussaire », which is another word in its own group) finds the
  hole, so that word counts as said; the NEIGHBOURS rule reads the same test.
- **Which words can be hidden (facts, `rules.initial_candidates`):** NOUN/VERB/ADJ/ADV and
  PROPN (the parser tags a lowercase brand or rare noun as a proper noun — « rolex »,
  « zigzag », secrets of a favourite day; a name nobody can reason toward is taste's
  call), not stopwords, not among the commonest words (`MAX_COMMON_RANK` 20 /
  `MAX_COMMON_RANK_ADV` 500, read off the reduced vectors' order), not a `WEAK_VERBS` verb
  (saying, thinking, modality — user-decided 2026-09-08; per language, the English list
  the French one translated word for word, #317), slug in the vocab — a
  hyphenated compound included (user-decided 2026-09-24, lifting the 2026-09-10
  exclusion: « post-it » was a secret of a favourite day) and only WHOLE — `parse` merges
  the pieces spaCy splits (« ice-cold », « répondit-il »), since gen_phrase can hole a
  word-core, never a piece of one — not a secret still in its `SECRET_COOLDOWN_DAYS` (90, `shelf.py`, judged on the
  ledger's game day), no same-lemma twin under another slug in the line (a same-slug
  repeat is one hole per occurrence), and **the line gives a path to it** (user-decided
  2026-10-02): the judge's giveaway score at or above `GIVEAWAY_MIN` (0.10,
  `jev.py`). Why: under it players never reason their way to the word — English
  « bloated » and « rapacity » beat a native speaker — and no loved day's hole sits under
  it. The words under it are logged and never shown to the model. A line with fewer than
  `TRIO` such words is set aside, and so is one whose MAIN word (the read's, below) sits
  under it: no clue (`curate.floor`).
- **Every shortlisted line is READ before anything is paid for (user-decided 2026-10-20:
  the seven kinds of line, the main word first).** One call per line (`llm.read_line`, the
  taste and the find-sentences skill's `## Stands alone` read whole, the words code allows
  shown): whether the line stands alone, SOLVED, without its page (the Svevo day:
  « c'étaient donc des nerfs parfaits » meant nothing even solved), which of its words need
  the work to mean anything (they leave the pool, never judged nor hidden), its KIND
  (`llm.KINDS`, the
  taste's `### <n>. <name>` headings) or none, its MAIN word — the word the line is about —
  with the 1 to 3 visible words its path runs through, the main word's narrowing ladder
  when it is one of a wide kind (the slot's kind, a smaller family a start can name, the
  first member or the ranks climbing to it), whether it is the partner of a visible word,
  whether hiding it hides the joke, one sibling making the same joke. The verdicts are the
  model's; code applies them in order (`curate.strike`) and SETS THE LINE ASIDE: it does not
  stand alone; it names no main word; its main word needs the work; the main word is one of
  a wide kind with a ladder step missing (a lottery); it is a mirror; the joke reads with it
  hidden. Code TELLS BACK (`curate.told_back`) a kind none of the seven, a main word the
  line cannot hide, a path not through 1 to 3 of the line's words left in sight (never the
  main word; its stop words passed over and left out of the path, `curate.content_path`:
  the parser's list, which the model cannot know, and a word always in sight never locks a
  pair), `READ_ROUNDS` (3) asks in all; a malformed answer raises. A
  line with NO KIND is kept. The sibling is a warning only. Only then is the giveaway paid
  (the floor, below); then its words are chosen, its main word first (above).
- **The FAMOUS LINE is a QUOTATION test, never a memory test (user-decided 2026-09-08,
  replacing the two-probe MEMORIZATION test — author + completion from the first half).**
  The model has memorised every line of a canonical book, so what it remembers says
  nothing about what a reader has met: measured on 17 runs, the memory test's two
  rejections were both Machado de Assis lines nobody quotes (one named the niece
  Vénancia). What a reader has met is on record, in the day's language (#317):
  `pnpm shelf:quotes` fetches, per book, the author's Wikiquote page, the work's
  Wikiquote page and the work's Wikipedia article — fr.* for the French shelf, en.* for
  the English one — and `quotes.extract_quotes` writes their quoted lines of at least
  `MIN_QUOTE_WORDS` = 5 to `shelf/<lang>/quotes/<file>.txt`: in French the `{{citation}}`
  bodies and « … » spans; in English en.wikiquote's top-level `* ` bullets (a `** `
  sub-bullet is the source), block-quote templates and “…” / "…" spans. The curator,
  OFFLINE, removes every mined unit that shares `QUOTE_MATCH` (0.6) of the shorter side's
  CONTENT words (the language's function words out), in order, with a quoted line — at
  least `QUOTE_MIN_WORDS` (4) of them (`quotes.quoted`) — before the judge or the model
  reads it, and the log names the
  quote. A book with no file skips the test with a warning; a book whose fetch found no
  page (`quotes.quote_sources` empty) rejects nothing and says so. The model's own
  opinion — would a reader who has not read the book know this line — is logged as an
  ANNOTATION (`llm.widely_known`), never a strike.
- **Taste has ONE home, the `taste` skill, read WHOLE by every prompt that chooses** (the
  shortlist, the read, the words against the main word, the day, the starts); the
  `find-sentences` skill keeps the practical
  laws the prompts quote (`## The quotation rule`, `## Stands alone`, `## The trio rules`,
  `## The start word`, `## The page`); a check that judges ONE rule of the taste quotes that
  section of it (`llm.taste_section`: the start-idea check), so the taste's headings are
  unique. Its seven kinds are named once in code, by number (`llm.KINDS`; a test ties them
  to the headings). Edit the skills, never a prompt copy: an edit changes the taste stamp,
  and `--rebank` takes every banked line again.
- **The transport is the benchmark's** (`llm_play._agent_sdk_turn`, the paid-Claude.ai
  guard, the conflict-env scrub): one fresh conversation per question, model
  `claude-opus-5-5`, adaptive thinking, effort `high` (set explicitly: Opus 5.5 defaults to
  `medium`). Opus 5.5 needs the Agent SDK >= 0.2.159 (its bundled CLI >= 2.1.280; an older
  one refuses the model). No second spelling of it here.
- **`gen_phrase` is the only writer of a puzzle**, run headless from this package with
  `--words`, `--other-sense` (above) and, when it demands one, `--form` answered by the model from the sentence
  (`curate.generate` parses the #133 error's analysis list; a word with NO analysis does
  not inflect and takes `cit`, no agreement — a fact, so no question). Nothing here publishes.
- **The START WORDS are CHOSEN by the model, never at random — the main word's first, by
  its kind, then the two others', so the day is neither handed over nor out of reach**
  (`llm.pick_starts`: each hole with its role, its path, its ladder when it is one of a wide
  kind — a start whose FIRST idea names the ladder's smaller family, never the whole kind —
  user-decided 2026-10-20), by the taste with code's notes (above), from the band 100–200
  of every map, for EVERY hole (user-decided 2026-10-08: a hole under `GIVEAWAY_HARD` 0.20
  is noted as one the line gives little of, a fact, never a nearer band; which start each
  hole takes is the taste's `## The start words`); the WHOLE band is shown, no cap
  (`starts.start_candidates`: shipped rank within the
  band, no variant, letter-rule-clean, its WORD not
  past `MAX_START_FREQ_RANK` = 40000 in the corpus order — « hétéroptère » is out; the word
  is the map group, judged on its commonest key (`rules.group_commonness`), so a common verb
  shown inflected — « observaient » — stays; and each key reads reduce's COMMONNESS table
  (`*_reduced_commonness.json`, missing = the run dies), which counts a word's
  CAPITALISED spellings, so a name — « shiva », « zeus » for « Dieu » — is not ranked
  rare; the table only ever moves a word up. The crowd keeps the lowercase reduced order
  the buried rule was measured on). In a run, the first successful gen_phrase run only
  supplies the maps; gen_phrase then reruns with `--start MOT=DEPART` per hole (#260); a
  banked line's starts, chosen on the line maps, go on the first run and are read again on
  the written map in code (`--finish`, above).
  Before any question, the trio's facts are read on the map at hand (`rules.trio_faults`:
  the line maps in the bank's in-memory draft, the written map in a run — one map — a word
  handed there, a word with NO candidate in its band); any makes the line UNBUILDABLE, and
  so does a hidden word the model finds no start gives a path to (`unsaveable`: none of its
  candidates links to it in its everyday sense, or it is dead or out of reach whatever its
  start, user-decided 2026-10-08) — the bank's start step chooses again in place of one of
  the two others; in a run the line is not built. A hole the answer leaves without a valid start is asked again, alone, once
  (`llm.pick_start`, its role and the line's kind, with every other hole's notes and start);
  still incomplete, the draft is refused and erased — never a random generator pick. **A
  secret/start PAIR is blacklisted for
  good** (user-decided 2026-09-08): `shelf.archive()['pairs']` holds every start each
  secret was ever played with, `choose_starts` and `check_starts` exclude them from the
  band, and a generated start that repeats a pair is refused and re-picked.
- **The displayed sentence must be VALID in its language AND MEAN SOMETHING, and the
  MODEL judges it, never a mechanical check** (user rule 2026-09-06: « l'effet », never
  « le effet »; the sense, and the model as the judge, user-decided 2026-10-01: Opus
  reads a sentence better than any checklist). Code only keeps the BAND clean:
  `starts.start_candidates` offers only words that can stand after the token before the
  hole by the one rule the letters decide (`starts.letter_problem`) — in French, elision
  (`elision_problem`: an eliding word before a vowel, an elided one before a consonant;
  `h` and `y` are left to the model); in English, the article « a » / « an » (#317,
  `article_problem`): sounds decide, not letters (an hour, a university, a one-off, a
  euro, an x-ray), so code drops only what the letters make certain — « a » before an a,
  i, e or o not led into a consonant sound (eu, ew, one, once, oui), « an » before b, c,
  d, g, j, k, p, q, t, v, w, z. After every generation `curate.check_starts` asks the
  model to read the displayed sentence as a native reader (`llm.sentence_check`, one
  reason per faulty inserted word): correct language — agreement, elision or the
  article, each start's construction — AND still meaning something, each start the kind
  of thing its place needs (« le fitness se suicide » is French and means nothing; a
  grammar-only check passed it). A start may be odd or funny; only a wrong or
  meaningless one is refused. Once the sentence reads right, `llm.start_ideas` asks, for
  the main word's start and the start of each word of a wide kind (user-decided
  2026-10-20: the main word's path is the day's, and a wide word's start must name a
  smaller family), the FIRST idea it brings where it stands and whether its hidden word
  shares it — the taste's
  `### One idea, the start's first one`, quoted (user-decided 2026-10-14, the user's own
  reading: « fracas » carries noise like « rugissements »; « berceau » for « cercueil »
  shared only a vague side meaning, its stronger ideas led away, and the user's round
  made no progress at all); a RIDDLE start is re-picked, never sets a line aside. Not of
  every hole: asked of every hole of the user's loved days, the check called 17 of their 57
  starts riddles, and the picks still read the rule in the taste. A start the check passed
  is never asked again (`cleared`, kept across rounds); a
  start the answer gives no verdict for refuses nothing and is logged as left to the
  reviewer, never as a pass; and on the last round (`START_ROUNDS`) a riddle is logged for
  the reviewer instead of traded for a start no check would read. A refused start is
  re-picked (`llm.pick_start`, taste included, reading the day as `pick_starts` does: the
  hole's role, path and notes with where the reader's nearest word lands, and every other
  hole's notes and shown start) and gen_phrase reruns; at most `START_ROUNDS` (3) rounds;
  what is still
  doubtful is logged for the reviewer.
- **Tests are dependency-free** (`uv run --no-project --with pytest`, like generation and
  benchmark): the rules take plain `Token`s and injected callables, so they run without
  spaCy, vectors or a model.

### Music (#262, user-decided 2026-09-06)

- **The artist list is the whole gate**: `shelf/<lang>/artists.txt`, the user's, by hand, one
  name per line, gitignored. The fetch reads it and nothing else; the model proposes no
  artist for the fetch. A line is the artist's Genius name, case and spacing aside
  (« miki (FRA) »: folded to letters, « miki » was the German rapper M.I.K.I.); a line
  naming none is skipped with the search's first names, never replaced by them
  (`shelf_lyrics.find_artist`). A day credits the name without Genius's namesake tag
  (`lyrics.artist_name`: « miki (FRA) » is miki, as the archive and the cooldown know
  it). There is NO exclusion list: dropping a name and deleting the artist's files is
  the whole removal.
- **The famous single is cut by pageviews**: `FAMOUS_SHARE` (0.25) of each artist's songs,
  most viewed first, is dropped before any lyric is read (`lyrics.famous_cut`). Features
  are skipped (the line belongs to someone else's song).
- **A puzzle is a UNIT, not necessarily one sentence** (user rule 2026-09-06): a book is
  mined per starting sentence as the shortest run of consecutive sentences of one
  paragraph (at most `MAX_SENTENCES_PER_UNIT` = 3) that reaches `MIN_WORDS` (14) — the
  micro-story the archive already holds (the Hagakure day is two sentences) — and, since
  2026-09-24, the sentence ALONE when it has at least `MIN_LINE_WORDS` (10): a short
  punchline is often the best line of all (JeanJass, 16 words), and the model judges it.
- **Ad-libs are not the line** (user-decided 2026-10-16, after a day opening on
  « Yeah, »): `lyrics.strip_adlibs` drops a parenthesis whose words are all `FILLERS` or
  all said in the line or the lines next to it (the backing voice's echo; a repeat marker
  « (x2) » too), and a `FILLERS` word set off by a comma at a line's start or end, with
  its comma; a line of ad-libs alone is no line. Any other parenthesis is the song's text
  and stays, unbracketed when it is the whole line: Genius brackets half a hook, a second
  voice, « on attise (le fuego) ». Only set off: « elle m'a dit ouais » keeps its word;
  an answer word (« nan », « oui ») is never a filler. A GAP — Genius's « (?) » for a
  word nobody made out, or its bracketed guess « avec [Lars, Medlar et le A ?] » — stays
  as Genius shows it, and no unit is cut across it (`lyrics.is_unit_candidate`): the
  fetch keeps inline brackets (`remove_section_headers=False`; `clean_lines` drops the
  header lines), since the library's removal deletes every bracket and leaves a hole.
- **A song is mined the same way, over lines** (`lyrics.candidate_units`): per starting
  line, the runs of consecutive lines within a stanza (never across a blank line, at most
  `MAX_LINES_PER_UNIT` = 4) from the first reaching `MIN_LINE_WORDS` to the first reaching
  `MIN_WORDS`; lines after the first
  lose their capital and a comma bridges a line with no punctuation. The capital and
  terminal-punctuation rules of the sentence filter do not apply to verse.
- **Artist cooldown, not "never twice"**: the same artist at most once every
  `ARTIST_COOLDOWN_DAYS` (30) on the calendar, never the same song. Judged on the
  ledger's game day (`shelf.archive()['last_used']`) and on the run index
  (`shelf.last_proposed`). The same song is the same artist AND the same `title_key`
  (`shelf.in_archive`), none of the book's looser matches: every record has an « Intro »,
  and Rounhaa's « H » is inside his « LOVE DEATH ROBOTS ». Books keep "never the same
  book twice".
- Music is a minority stream (one or two days a week): `curate.pick_work` picks a song
  when the archive shows no music day within `MUSIC_EVERY_DAYS` (4), or when no eligible
  book is left on the shelf; otherwise a book.
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
  nothing). **A song day's page is its WHOLE STANZA, verse or chorus** (user-decided
  2026-10-16: "full verse or chorus"; it reverses "a song gets no excerpt"):
  `lyrics.stanza_excerpt`, the stanza's lines before the unit and after it, never cut and
  no model call, each side bridged as the unit is and ended on a full stop (the solved
  page opens the line on a capital). Its track page is gen_phrase's `--url`, by hand.
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
- **Never the same BOOK twice** (`shelf.in_archive`, a shelf work against the archive's
  works): titles compare by `shelf.title_key` (each word folded by `slug` without its
  dashes, its digits kept: « Vernon Subutex 1 » is not « … 2 », « Jean - Christophe » is
  « Jean-Christophe »), and the archive keeps one work per author and key, so every
  published volume counts. The same key is the same work whoever the author is, since
  the ledger and the shelf can spell one author two ways (`Fyodor Dostoevsky` / `Fédor
  Dostoïevski`); the kind is not compared, so a book titled like a published song is
  out unless `--work` forces it. One key inside the other, never splitting a number
  (« … 1 » is not inside « … 12 »), is an edition's padding (« Le postier V2 »,
  « … (French Edition) ») and the same work only by the same author: one spelling, or
  `quotes.same_person` (an author missing on either side does not tell them apart). Kawakami's « Les Années douces » is not Ernaux's « Les années ».
  `shelf.forget` compares titles by the same key, so a `--retry` on one volume keeps the
  other volume's drafts.

## Do NOT

- Don't publish, and don't write a puzzle by any path but `gen_phrase`.
- Don't turn a measurement into a veto: code states facts, taste chooses. A new signal
  goes to the model as a note, with its real-play meaning. The vetoes are the giveaway
  floor (`GIVEAWAY_MIN`, user-decided 2026-10-02) and the facts `rules.trio_faults` names:
  on every hole the BURIED rule (`rules.buried`, user-decided 2026-10-08), the UNMAPPED
  rule (`rules.unmapped`, user-decided 2026-10-12), the NEIGHBOURS rule
  (`rules.neighbourhood` + `llm.neighbours_complete`, user-decided 2026-10-13) and an empty
  start band; the main word handed (readers, or its map); a word right beside the main
  word (`rules.adjacent`); the model's own verdicts on a word it chose (a mirror, a
  lottery: user-decided 2026-10-20); and its other-sense verdict on a hidden word (a map
  that barely carries the line's sense, or no verdict: `curate.sense`, user-decided
  2026-10-21). What holds against the three together is told back,
  never a veto. Don't keep a hand list of refused words: the buried rule measures any word
  (the user: "the curator will be good in 30 years with this solution").
- Don't swap a word (user-decided 2026-10-20): the main word is never swapped (a fact
  against it sets the line aside), one of the two others is chosen again only by the bank's
  start step, and a line found unbuildable on its written map is not built
  (`curate.Unbuildable`).
- Don't write taste into code or a prompt copy; it lives in the `taste` skill.
- Don't ask a model to PLAY the puzzle — to guess its way to a secret, count the tries or
  simulate a player (user-decided 2026-09-25): LLMs don't play like people (on real
  puzzles they beat them most days and miss what people find easily, and the result moves
  with the model, the run and the prompt). Difficulty is read off real play: the taste
  skill's examples and code's calibrated notes. The reader, filling a blank the way the
  user reads, is not play; nor is the would-say test, which is told the word.
- Don't commit the shelf (copyrighted files, the artist list) or the runs.
- Don't put a Genius token anywhere but the environment.

## Not in V1 (deliberately)

Publishing; the benchmark as a difficulty gate; difficulty prediction from player logs;
music in English (out of #317's scope; the code paths are generic);
movies/subtitles (explicitly out, #262); per-token guess counting.
