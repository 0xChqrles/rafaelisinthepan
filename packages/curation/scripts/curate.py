"""One book in, one candidate puzzle out (issue #260). Never publishes.

    pnpm curate [--lang fr] [--work <file on the shelf>]
    pnpm curate [--lang fr] --retry <file on the shelf | candidate puzzle.json>

The language picks the shelf (shelf/<lang>/, a work filed by the language of its
edition), the archive and the vectors; the two languages share nothing (#317).

TASTE CHOOSES, CODE STATES FACTS (2026-09-24). A work is picked off the shelf by rule; its
sentences are mined, the quoted ones and what the judge finds unreadable removed; the
model reads every one that is left with the `taste` skill and shortlists the best; then
each of the best lines is FINISHED — the model picks its three words, in the order
players will find them, and code measures what a reader puts in each blank, how much the
sentence hands a word over, what its neighbours call for, swapping a word that fails —
and the model COMPARES the finished lines and chooses the day. Code hands its notes and
where the reader's words land in each hole's map to the model, which chooses the start
words by the taste (or swaps a word no start can save). `gen_phrase` writes the puzzle headless. The run's log
— every choice and its reason — goes to `runs/<stamp>.md`, the puzzle to generation's
output directory.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from functools import lru_cache
import json
import os
from pathlib import Path
import re
import subprocess
import sys

import _paths
from build_forms import CITATION_FEATURE  # the forms table's no-agreement cell (generation/scripts)
import contextual_rank  # the #308 judge: sentence pre-filter + shortlist order + giveaways (generation/scripts)
from slug import slug

import llm
import quotes as qt
import lyrics as lyr
import rules
import shelf as shelf_mod
import bank
import starts as st
from epub import epub_text
from parse import parse
from sentences import EXCERPT_SENTENCES, EXCERPT_WINDOW, candidate_sentences, cut_excerpt, excerpt_around

# The model reads every sentence the judge keeps, in reading order, CHUNK at a time.
CHUNK = 150
PICKS_PER_CHUNK = 6
SHORTLIST = 20
# Lines FINISHED — words chosen, checked, swapped — before the day is chosen among them
# (user-decided 2026-10-13), checked WORKERS at a time; word choices per line.
CANDIDATES = 10
WORKERS = 5
DAY_ROUNDS = 3
# Hidden words the start-word step may swap before the line is given up.
REPLACE_ROUNDS = 2
# Lines of a work's shortlist banked by `--bank` (a work gives at most one day: its first
# batch is what a run compares).
BANK_LINES = CANDIDATES
# The music stream: a song is picked when the archive shows no music day within this
# many days (one or two a week; user-decided 2026-09-20, a rule in code, no model call).
MUSIC_EVERY_DAYS = 4
# gen_phrase runs per sentence (one per form question the LLM answers).
MAX_GEN_RUNS = 6


class Log:
    """The run log, printed as it goes. In BLIND mode (`--blind`, user rule 2026-09-07:
    the curator must be readable without spoiling the puzzle) an attempt's lines are
    held back: a failed attempt's are then written in full (a rejected sentence is not
    the puzzle), a successful attempt's go to `<stamp>.spoilers.md` and the main log
    gets only what the player sees."""

    def __init__(self, stamp: str, blind: bool = False):
        _paths.RUNS_DIR.mkdir(parents=True, exist_ok=True)
        self.path = _paths.RUNS_DIR / f"{stamp}.md"
        self.spoilers = _paths.RUNS_DIR / f"{stamp}.spoilers.md"
        self.blind = blind
        self.lines: list[str] = [f"# Curation run {stamp}" + (" (blind)" if blind else ""), ""]
        self._held: list[str] | None = None

    def __call__(self, line: str = "") -> None:
        if self._held is not None:
            self._held.append(line)
            return
        self._emit(line)

    def _emit(self, line: str) -> None:
        print(line, flush=True)
        self.lines.append(line)
        self.path.write_text("\n".join(self.lines) + "\n", encoding="utf-8")

    def begin_attempt(self) -> None:
        if self.blind:
            self._held = []
            self._emit("\n## Attempt 1 (details withheld)")

    def end_attempt(self, success: bool, summary: list[str] = ()) -> None:
        held, self._held = self._held, None
        if held is None:
            return
        if not success:
            for line in held:
                self._emit(line)
            return
        with open(self.spoilers, "a", encoding="utf-8") as f:
            f.write("\n".join(held) + "\n")
        for line in summary:
            self._emit(line)
        self._emit(f"- full detail (SPOILERS): `{self.spoilers}`")


def die(msg: str) -> None:
    print(f"[curate] {msg}", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Vectors: cosine between two tokens, None when either has no vector.

def load_similarity(lang: str):
    from embedding_neighbors import for_lang  # gensim + numpy: only a run loads them

    neighbors = for_lang(lang)
    kv = neighbors.load_vectors()
    V = neighbors.build_vocab(kv)
    M = neighbors.build_matrix(kv, V)

    def key(t: rules.Token):
        for form in (t.text.lower(), t.lemma):
            if form in kv:
                return form
        return None

    def frequency_rank(t: rules.Token):
        """The WORD's place in the corpus order: the commoner of its form and its lemma, so
        an inflected form of a common word (« boussoles ») is not read as rare."""
        found = [int(kv.key_to_index[f]) for f in (t.text.lower(), t.lemma) if f and f in kv]
        return min(found) if found else None

    @lru_cache(maxsize=64)
    def ranking(k: str) -> dict[str, int]:
        return {cand: r for cand, r, _ in neighbors.closest(k, kv, V, M)}

    def neighbour_rank(t: rules.Token, word: str):
        """Where `word` stands in the STATIC ranking around the token's vector (0 = the
        nearest other word); None when either is unknown. The reader note's twin test
        (`rules.is_twin`)."""
        k = key(t)
        w = word.lower()
        if k is None or w not in kv or w == k:
            return None
        return ranking(k).get(w)

    import gen_phrase as gp  # the static walk only: no judge is called here (contextual=None)

    cfg = gp.CONFIG[lang]
    lemma_table = gp.load_lemma_table(lang)
    forms_by_lemma = gp.invert_lemmas(lemma_table)
    Vset = set(V)
    first_index: dict[str, int] = {}
    for i, w in enumerate(kv.index_to_key):
        first_index.setdefault(slug(w), i)

    @lru_cache(maxsize=256)
    def static_map_of(word: str):
        try:
            _merged, rank_map, _groups = gp.walk_secret(word, word, cfg, kv, V, M, Vset, lemma_table, forms_by_lemma)
        except Exception:  # a word the walk cannot settle alone (#133) is left unmeasured
            return None
        return rank_map

    def static_map(t: rules.Token):
        """The token's FREE static map (the judge only reorders its groups); None when its
        vector or its walk is missing."""
        for form in (t.text.lower(), t.lemma):
            if form and form in Vset:
                return static_map_of(form)
        return None

    def crowd(t: rules.Token):
        """The token's crowd of commoner near-words on the free static map (`rules.crowd_share`)."""
        rank_map = static_map(t)
        return None if rank_map is None else rules.crowd_share(rank_map, first_index.get)

    def own(t: rules.Token):
        """The keys of the token's own group on its free static map — what typing finds the
        hole with (`rules.same_word`); None without a map."""
        rank_map = static_map(t)
        return None if rank_map is None else frozenset(k for k, v in rank_map.items() if v["rank"] == 0)

    def unmapped(t: rules.Token, fillers: list[str]):
        """The reader's words when none is on the token's free static map (`rules.unmapped`)."""
        rank_map = static_map(t)
        return None if rank_map is None else rules.unmapped(rank_map, t.slug, fillers, first_index.__contains__)

    # The start band's reader of commonness (`starts.start_candidates`) counts a word's
    # CAPITALISED spellings too — reduce's commonness table: a name is written capitalised,
    # so the lowercase-only order above ranks « zeus » or « shiva » as rare. The crowd keeps
    # that order, the one the buried rule was measured on.
    table = os.path.splitext(neighbors.SPEC.vectors_path)[0] + "_commonness.json"
    if not os.path.exists(table):
        raise SystemExit(f"Missing {table}: run `pnpm reduce:{lang}` (it writes the commonness table).")
    with open(table, encoding="utf-8") as f:
        ranks = json.load(f)
    common_index: dict[str, int] = {}
    for w, r in ranks.items():
        s = slug(w)
        common_index[s] = min(r, common_index.get(s, r))
    return frequency_rank, neighbour_rank, crowd, unmapped, own, common_index.get


# ---------------------------------------------------------------------------
# gen_phrase, headless, with the #133 form question answered by the model.

_FORM_NEEDED = re.compile(r"la forme de « (.+?) » doit être explicite")
_ANALYSIS = re.compile(r"^\s*(\d+)\)\s+(\S+)\s+—\s+(.*)$", re.M)
_EXAMPLE = re.compile(r"ex\. --form \S+=(\S+)")
_SHARED = re.compile(r"Précise : (.+?)\.\s*$", re.S)
_WRITTEN = re.compile(r"écrite dans (.+) :$", re.M)


def run_gen_phrase(sentence: str, words: list[str], source: dict, forms: dict[str, str], lang: str,
                   starts: dict[str, str] | None = None, replay: str | None = None):
    cmd = ["uv", "run", "scripts/gen_phrase.py", sentence, "--lang", lang, "--words", *words]
    if replay:  # #308: a rerun rebuilds the same contextual map from the first run's sidecar
        cmd += ["--contextual-replay", replay]
    for key in ("kind", "author", "work"):
        if source.get(key):
            cmd += [f"--{key}", source[key]]
    excerpt = source.get("excerpt") or {}
    for sentence_before in excerpt.get("before", ()):
        cmd += ["--before", sentence_before]
    for sentence_after in excerpt.get("after", ()):
        cmd += ["--after", sentence_after]
    for word, form in forms.items():
        cmd += ["--form", f"{word}={form}"]
    for word, start in (starts or {}).items():
        cmd += ["--start", f"{word}={start}"]
    completed = subprocess.run(
        cmd, cwd=_paths.GENERATION_DIR, stdin=subprocess.DEVNULL,
        capture_output=True, text=True,
    )
    return completed, cmd


class Replace(Exception):
    """The start-word step found a hidden word no start can save and names another word
    of the line (`llm.pick_starts`); the draft is erased and the day rebuilt with it."""

    def __init__(self, secret: str, with_: str, why: str):
        super().__init__(f"{secret} -> {with_}")
        self.secret, self.with_, self.why = secret, with_, why


class Handed(Exception):
    """The start-word step found, on the day's own map, two or more holes handed over —
    the reader writes the secret itself, or a word at or under `rules.HANDED_RANK`
    (`rules.map_handed`); the draft is erased and the model swaps one (`llm.drop_handed`).
    `facts`: secret slug -> what hands it over."""

    def __init__(self, words: list[str], facts: dict[str, str]):
        super().__init__(", ".join(words))
        self.words, self.facts = words, facts


_sidecar = shelf_mod.sidecar_path


def generate(claude: llm.Claude, log: Log, sentence: str, words: list[str], source: dict, lang: str,
             context: dict[str, str] | None = None, index_of=lambda s: None,
             pairs: dict[str, set[str]] | None = None, replay: str | None = None,
             chain: list[str] | None = None, fillers: dict[str, list[str]] | None = None,
             expected: dict[str, str | None] | None = None):
    """Returns the written puzzle path, or None with the reason logged. The forms are
    answered by the model as gen_phrase asks. The first successful run only supplies the
    rank maps: the START WORDS are then chosen by the model, the three together, playing
    the day out from each hole's band with code's notes (`context`, and where the
    reader's `fillers` land in each map) — or it
    names a word to swap, and the draft is erased and Replace raised; the puzzle is
    regenerated with the starts; every result is checked (the displayed sentence must be
    valid in its language) and a refused start re-picked, at most START_ROUNDS times."""
    forms: dict[str, str] = {}
    starts: dict[str, str] = {}
    tried: dict[str, set[str]] = {}  # every start a hole has shown, secret slug -> words
    cleared: dict[str, set[str]] = {}  # the starts the idea check passed, secret slug -> words
    if replay:  # an erased draft's scores require the same trio AND context
        try:
            recorded = json.loads(Path(replay).read_text(encoding="utf-8"))
            scored = {slug(h["secret"]) for h in recorded["holes"]}
            excerpt = source.get("excerpt") or {}
            same_context = (recorded["sentence"] == sentence
                            and recorded["before"] == excerpt.get("before", [])
                            and recorded["after"] == excerpt.get("after", []))
        except (OSError, ValueError, KeyError, TypeError):
            scored = set()
            same_context = False
        if scored != {slug(w) for w in words} or not same_context:
            log("- the erased draft's scores cover another trio or context: the judge runs again")
            Path(replay).unlink(missing_ok=True)
            replay = None
    chosen = False
    rounds = 0
    prev = None
    for _ in range(MAX_GEN_RUNS + st.START_ROUNDS + 1):
        # A rerun (new starts) never pays the judge again: it replays the scores the
        # previous run wrote beside its puzzle (#308).
        completed, cmd = run_gen_phrase(sentence, words, source, forms, lang, starts,
                                        replay=_sidecar(prev) if prev else replay)
        if completed.returncode == 0:
            m = _WRITTEN.search(completed.stdout)
            if m is None:
                # A puzzle whose path cannot be read cannot be given its start words nor
                # checked: what gen_phrase wrote carries its own random band pick, and
                # that is never a candidate day.
                log("- gen:phrase wrote a puzzle but its path could not be read off the output: the draft "
                    "is refused (the file is left under the generation output, with the generator's own "
                    "start words)")
                return None
            path = m.group(1)
            if prev and path != prev:  # the file is named after its starts: a rerun leaves no orphan
                Path(prev).unlink(missing_ok=True)
                Path(_sidecar(prev)).unlink(missing_ok=True)
            if replay and _sidecar(path) != replay:  # the erased draft's scores, now copied
                Path(replay).unlink(missing_ok=True)
                replay = None
            prev = path
            if not chosen:
                chosen = True
                try:
                    picked = choose_starts(claude, log, path, context or {}, forms, index_of, pairs or {},
                                           chain, fillers or {}, lang=lang, expected=expected or {})
                except (Replace, Handed):
                    Path(path).unlink(missing_ok=True)
                    Path(_sidecar(path)).unlink(missing_ok=True)
                    raise
                if picked is None:
                    # A partial or unusable answer cannot leave gen_phrase's random
                    # band pick in a candidate day. The model must choose all three.
                    Path(path).unlink(missing_ok=True)
                    Path(_sidecar(path)).unlink(missing_ok=True)
                    return None
                if picked:
                    _adopt(starts, tried, picked)
                    continue
            if rounds < st.START_ROUNDS:
                repick = check_starts(claude, log, path, tried, context or {}, index_of, pairs or {}, chain,
                                      lang=lang, fillers=fillers or {}, cleared=cleared,
                                      last=rounds == st.START_ROUNDS - 1)
                if repick:
                    _adopt(starts, tried, repick)
                    rounds += 1
                    continue
            log(f"- gen:phrase command: `{' '.join(_quote(c) for c in cmd[2:])}`")
            return path
        err = completed.stderr.strip()
        needed = _FORM_NEEDED.search(err)
        shared = _SHARED.search(err)
        if shared and "porté par plusieurs lexèmes" in err:
            spellings = re.findall(r"--form (\S+?)=(\S+)", shared.group(1))
            if not spellings:
                log(f"- gen:phrase refused: {err.splitlines()[0]}")
                return None
            word = spellings[0][0]
            choices = [s for _, s in spellings]
            choice = llm.pick_form(claude, sentence, word, choices, lang=lang)
            forms[word] = choices[choice - 1]
            log(f"- form of « {word} » (shared trait): {forms[word]}")
            continue
        if needed:
            word = needed.group(1)
            analyses = _ANALYSIS.findall(err)
            if not analyses:
                # A word the forms table has no analysis for does not inflect (an -ly
                # adverb, « famous »): its one form is the citation, no agreement — a
                # fact, not a choice, so the model is not asked.
                if forms.get(word) == CITATION_FEATURE:
                    log(f"- gen:phrase refused « {word} » even as {CITATION_FEATURE}: {err.splitlines()[0]}")
                    return None
                forms[word] = CITATION_FEATURE
                log(f"- form of « {word} »: {CITATION_FEATURE} (no analysis in the forms table: it does not inflect)")
                continue
            choices = [f"{feature} — {desc}" for _, feature, desc in analyses]
            choice = llm.pick_form(claude, sentence, word, choices, lang=lang)
            feature = analyses[choice - 1][1]
            example = _EXAMPLE.search(err)
            if choice == 1 and example:
                feature = example.group(1)
            forms[word] = feature
            log(f"- form of « {word} »: {feature}")
            continue
        if replay and "rejeu :" in err:
            # The erased draft's scores no longer cover the map — the word tables moved
            # since they were paid (a group they never scored): judge it again rather
            # than lose the line; the replay only ever saves money.
            log("- the erased draft's scores no longer cover the map (the word tables "
                "changed): the judge runs again")
            Path(replay).unlink(missing_ok=True)
            replay = None
            continue
        log(f"- gen:phrase refused: {err.splitlines()[0] if err else completed.stdout[-300:]}")
        return None
    log("- gen:phrase: too many form rounds")
    return None


def _adopt(starts: dict[str, str], tried: dict[str, set[str]], picked: dict[str, str]) -> None:
    for key, word in picked.items():
        starts[key] = word
        tried.setdefault(key, set()).add(word)


def _load(path: str) -> tuple[dict, dict[str, dict]]:
    """A written puzzle, and the first hole of each secret by its slug (a repeated secret
    is one hole per occurrence, sharing one start)."""
    puzzle = json.loads(Path(path).read_text(encoding="utf-8"))
    by_secret: dict[str, dict] = {}
    for h in puzzle["holes"]:
        by_secret.setdefault(h["secret"]["slug"], h)
    return puzzle, by_secret


def _notes(ranks: dict, key: str, context: dict[str, str], fillers: dict[str, list[str]]) -> str:
    """Code's notes for one hole as the start step reads them: what was measured, where the
    reader's nearest word lands in the hole's own map, and — when every reader's word lands
    far (`rules.far_note`) and the readers do not write the word itself — that the line
    gives little of it."""
    nearest = rules.map_nearest_filler(ranks, key, fillers.get(key, []))
    land = ("" if nearest is None else
            f"; the reader's nearest word « {nearest[0]} » sits at rank "
            f"{nearest[1] if nearest[1] is not None else 'beyond the map (10000+)'} in this hole's map")
    notes = context.get(key, "nothing measured") + land
    far = rules.far_note(nearest)
    if far and "most readers would write the secret itself" not in notes:
        notes += "; " + far
    return notes


def choose_starts(claude: llm.Claude, log: Log, path: str, context: dict[str, str],
                  forms: dict[str, str], index_of, pairs: dict[str, set[str]] | None = None,
                  chain: list[str] | None = None, fillers: dict[str, list[str]] | None = None,
                  *, lang: str, expected: dict[str, str | None] | None = None) -> dict[str, str] | None:
    """The model picks the three start words together, by the taste, from each
    hole's band (clean by the language's letter rule, its word not too rare by the corpus
    order `index_of`, never a start this secret was played with before — `pairs`, the
    archive's permanent blacklist — nearest first), reading the sentence, each slot's form, code's notes and the chain the day was
    chosen on. The
    notes add where the reader's words land in the hole's own map. Raises Handed, before
    any question, when the map hands two or more holes over (no start makes such a day:
    the reader writes the secret itself, or its most-likely word — `expected` — sits at or
    under `rules.HANDED_RANK`). Raises Replace when the model names a hidden word no start
    can save. Returns None when the model gives no
    complete trio of valid starts; a random generator pick must not become the day."""
    pairs, fillers, expected = pairs or {}, fillers or {}, expected or {}
    puzzle, by_secret = _load(path)
    words, holes = puzzle["words"], puzzle["holes"]
    handed: dict[str, str] = {}
    for key in by_secret:
        if "most readers would write the secret itself" in context.get(key, ""):
            handed[key] = "most readers write it straight in"
        elif (rank := rules.map_handed(puzzle["ranks"][key], key, expected.get(key))) is not None:
            handed[key] = f"most readers write « {expected[key]} », rank {rank} in its map"
    if len(handed) >= 2:
        log("- the map hands over " + "; ".join(f"« {by_secret[k]['secret']['word']} » ({fact})"
                                                for k, fact in handed.items()))
        raise Handed([by_secret[k]["secret"]["word"] for k in handed], handed)
    marked = st.displayed(words, holes, {k: f"[{h['secret']['word']}]" for k, h in by_secret.items()})
    info = []
    for key, h in by_secret.items():
        options = st.start_candidates(puzzle["ranks"][key], key, st.previous_token(words, h),
                                      exclude=pairs.get(key, ()), index_of=index_of,
                                      lang=lang)
        if not options:
            log(f"- no clean start in the band for « {h['secret']['word']} »; the model must replace it")
        notes = _notes(puzzle["ranks"][key], key, context, fillers)
        log(f"- notes for « {h['secret']['word']} »: {notes}")
        info.append({"secret": h["secret"]["word"], "slug": key, "options": options, "notes": notes,
                     "slot": f"form {forms.get(h['secret']['word'], '?')}, after « {st.previous_token(words, h) or '—'} »"})
    answer = llm.pick_starts(claude, marked, info, chain, lang=lang)
    if answer["replace"]:
        swap = answer["replace"]
        log(f"- the start words can't save « {swap['secret']} »: swap for « {swap['with']} » — {swap['why']}")
        raise Replace(swap["secret"], swap["with"], swap["why"])
    picked = dict(answer["starts"])
    # A hole the answer left without a valid start — usually a word not written exactly as
    # listed — is asked again, ALONE, once, with the other starts in place and every other
    # hole's notes: the day and its map are worth one more question. Only a hole still without a model-chosen start
    # refuses the draft; gen_phrase's random band pick never stays.
    for h in info:
        if h["slug"] in picked or not h["options"]:
            continue
        log(f"- no valid start named for « {h['secret']} »; asked again")
        marked_one = st.displayed(words, holes, {**picked, h["slug"]: "[____]"})
        choice = llm.pick_start(claude, marked_one, h["secret"], h["options"],
                                refused="the answer named no candidate for it", context=h["notes"], chain=chain,
                                others=[{"secret": o["secret"], "start": picked.get(o["slug"]), "notes": o["notes"]}
                                        for o in info if o is not h],
                                lang=lang)
        if choice is not None:
            picked[h["slug"]] = choice
    if set(picked) != set(by_secret):
        missing = [h["secret"]["word"] for key, h in by_secret.items() if key not in picked]
        log(f"- no complete trio of valid start words (missing: {', '.join(missing)}); the draft is refused")
        return None
    for h in info:
        word = picked[h["slug"]]
        rank = next((o["rank"] for o in h["options"] if o["word"] == word), None)
        log(f"- start for « {h['secret']} »: « {word} » (rank {rank})")
    if answer.get("why"):
        log(f"  - why: {answer['why']}")
    return picked


def check_starts(claude: llm.Claude, log: Log, path: str, tried: dict[str, set[str]],
                 context: dict[str, str], index_of, pairs: dict[str, set[str]] | None = None,
                 chain: list[str] | None = None, *, lang: str,
                 fillers: dict[str, list[str]] | None = None,
                 cleared: dict[str, set[str]] | None = None, last: bool = False) -> dict[str, str]:
    """The displayed sentence with its start words: a start this secret was already
    played with (`pairs`), then the model reading the sentence (`llm.sentence_check`:
    correct, and still meaning something), then — once it reads right — the FIRST idea in the
    sentence of each start whose line gives little of its word (`rules.GIVES_LITTLE` in its
    notes; `llm.start_ideas`: one its hidden word shares, or a riddle). Returns
    {secret slug: new start} for every faulty hole (empty = all good, or nothing better
    to offer). `tried` holds every start a hole has shown so far; none is offered again.
    `cleared` (secret slug -> starts, kept across rounds) holds the starts the idea check
    passed, never asked again; on the `last` round a riddle is logged for the reviewer
    rather than traded for a start no check would read.
    The re-pick reads the day as `pick_starts` does: the hole's notes with where the
    reader's nearest word (`fillers`) lands, and every other hole's notes and shown start."""
    pairs = pairs or {}
    cleared = cleared if cleared is not None else {}
    puzzle, by_secret = _load(path)
    words, holes = puzzle["words"], puzzle["holes"]
    shown = st.displayed(words, holes)
    notes = {k: _notes(puzzle["ranks"][k], k, context, fillers or {}) for k in by_secret}
    faulty: dict[str, str] = {}
    for key, h in by_secret.items():
        if h["start"]["word"] in pairs.get(key, ()):
            faulty[key] = "this secret was already played from this start word"
    if not faulty:
        verdict = llm.sentence_check(claude, shown, [h["start"]["word"] for h in by_secret.values()], lang=lang)
        if verdict["valid"]:
            log(f"- start words check: « {shown} » → valid")
            # A start shares ONE idea with its hidden word, and it is the first idea the start
            # brings in the sentence (user-decided 2026-10-14): « berceau » for « cercueil »
            # shared only a side meaning, and the user's round made no progress at all. Asked
            # only where the line gives little of the word: there a riddle start leaves the
            # player nothing to go on. Asked of every hole of the user's loved days, the check
            # called 17 of their 57 starts riddles; on the holes the line gives little of, 2.
            asked = {key: h for key, h in by_secret.items()
                     if rules.GIVES_LITTLE in notes[key] and h["start"]["word"] not in cleared.get(key, ())}
            riddles, judged = (llm.start_ideas(claude, shown, [{"start": h["start"]["word"], "secret": h["secret"]["word"]}
                                                               for h in asked.values()], lang=lang)
                               if asked else ({}, set()))
            for key, h in asked.items():
                word = h["start"]["word"]
                if word in riddles:
                    faulty[key] = riddles[word]
                elif word in judged:
                    cleared.setdefault(key, set()).add(word)
            unjudged = [h["start"]["word"] for h in asked.values() if h["start"]["word"] not in judged]
            if unjudged:
                log("- start ideas check: no usable verdict for " + ", ".join(f"« {w} »" for w in unjudged)
                    + " — left to the reviewer")
            if not faulty:
                if asked and not unjudged:
                    log("- start ideas check: each start asked shares its first idea with its hidden word")
                return {}
            if last:
                # A re-pick now would ship unread: the start the sentence check passed stays.
                for key, problem in faulty.items():
                    h = by_secret[key]
                    log(f"- start « {h['start']['word']} » for « {h['secret']['word']} »: {problem} — "
                        "the last round, left to the reviewer")
                return {}
        else:
            for key, h in by_secret.items():
                if h["start"]["word"] in verdict["faulty"]:
                    faulty[key] = verdict["faulty"][h["start"]["word"]]
            if not faulty:
                log(f"- start words check: the model doubts « {shown} » but names no start word — "
                    "left to the reviewer")
                return {}
    repick: dict[str, str] = {}
    for key, problem in faulty.items():
        h = by_secret[key]
        log(f"- start « {h['start']['word']} » for « {h['secret']['word']} » refused: {problem}")
        prev = st.previous_token(words, h)
        options = st.start_candidates(puzzle["ranks"][key], key, prev,
                                      exclude={h["start"]["word"], *tried.get(key, ()), *pairs.get(key, ())},
                                      index_of=index_of, lang=lang)
        if not options:
            log(f"- no other start in the band for « {h['secret']['word']} » — left to the reviewer")
            continue
        # the day as it now stands: a hole re-picked earlier in this round shows its new start
        marked = st.displayed(words, holes, {**repick, key: "[____]"})
        choice = llm.pick_start(claude, marked, h["secret"]["word"], options,
                                refused=problem, context=notes[key], chain=chain,
                                others=[{"secret": o["secret"]["word"], "start": repick.get(k, o["start"]["word"]),
                                         "notes": notes[k]}
                                        for k, o in by_secret.items() if k != key],
                                lang=lang)
        if choice is None:
            log(f"- the model finds no valid start for « {h['secret']['word']} » — left to the reviewer")
            continue
        repick[key] = choice
        log(f"- start for « {h['secret']['word']} » re-picked: « {choice} »")
    return repick


def player_view(path: str, book: dict) -> list[str]:
    """What the blind log may show of a written puzzle: the sentence as the player
    first sees it, the start words with their ranks, the source, the path."""
    try:
        puzzle, by_secret = _load(path)
    except (OSError, ValueError):
        return [f"- written: `{path}`"]
    starts = [f"{h['start']['word']} ({h['start_rank']})" for h in by_secret.values()]
    return [f"- player view: « {st.displayed(puzzle['words'], puzzle['holes'])} »",
            f"- start words: {', '.join(starts)}",
            f"- source: {book.get('author', '')} — {book.get('title', '')}",
            f"- written: `{path}`"]


def _quote(arg: str) -> str:
    return f'"{arg}"' if " " in arg or "'" in arg else arg


# ---------------------------------------------------------------------------

def in_cooldown(work: dict, archive: dict, index: dict, today: date) -> bool:
    """The artist cooldown (music only): used on the calendar, or proposed by a run,
    within ARTIST_COOLDOWN_DAYS."""
    if work["kind"] != "music":
        return False
    key = slug(work.get("author", ""))
    return lyr.within_cooldown(archive["last_used"].get(key), today) or \
        lyr.within_cooldown(shelf_mod.last_proposed(index, work.get("author", "")), today)


def choose_work(log: Log, args, archive: dict, index: dict, today: date,
                banked: set[str] = frozenset()) -> dict | None:
    """The work of a run (by rule, or `--work`). Never one the bank holds lines of
    (`banked`): a work is mined once. Banking (`--bank`) keeps no artist cooldown — the
    day comes later, and `--pull` applies it — and returns None once the shelf is spent."""
    banking = bool(getattr(args, "bank", None))
    works = shelf_mod.list_works(_paths.shelf_dir(args.lang))
    if not works:
        die(f"nothing on the shelf ({_paths.shelf_dir(args.lang)})")
    # A file the shelf could not open (`list_works` puts the reason on its entry) is
    # never picked: the run would die on the read. Named in the log so the file gets
    # replaced.
    broken = [w for w in works if w.get("error")]
    if broken:
        log("- unreadable, skipped: " + ", ".join(f"{w['file']} ({w['error']})" for w in broken))
    if args.work:
        work = next((w for w in works if w["file"] == args.work), None)
        if work is None:
            die(f"{args.work} is not on the shelf")
        if work.get("error"):
            die(f"{args.work} cannot be read: {work['error']}")
        return work
    # Eligible: readable, not in the archive and not mined by an earlier run or banked
    # (never the same work twice — `--retry` erases an attempt), not inside the artist
    # cooldown.
    fresh = []
    cooled = set()
    for w in works:
        if w.get("error"):
            continue
        if shelf_mod.in_archive(w, archive["works"]) or w["file"] in index["books"] or w["file"] in banked:
            continue
        if not banking and in_cooldown(w, archive, index, today):
            cooled.add(w.get("author", ""))
            continue
        fresh.append(w)
    if cooled:
        log(f"- artist cooldown ({lyr.ARTIST_COOLDOWN_DAYS} days) skips: {', '.join(sorted(cooled))}")
    if not fresh:
        if banking:
            log("- the shelf is spent: every work was mined, banked or is in the archive")
            return None
        die("every work on the shelf was mined, is in the archive, or is inside the artist cooldown "
            "(--retry <file> erases an attempt)")
    if banking:
        work, why = bank_pick(fresh, [w for w in works if w["file"] in banked], archive, index, today)
    else:
        work, why = pick_work(fresh, archive, index, today)
    log(f"- work: {work.get('author')} — {work.get('title')} ({work['kind']}, {work['file']}): {why}")
    return work


def bank_pick(fresh: list[dict], banked: list[dict], archive: dict, index: dict,
              today: date) -> tuple[dict, str]:
    """The next work to bank. A work gives at most one day, so the bank keeps the
    calendar's shape: one song for every MUSIC_EVERY_DAYS works, an artist's next song only
    once the bank holds ARTIST_COOLDOWN_DAYS more works (the calendar plays an artist once
    in that many days), and the authors spread (the fewest banked works first); within
    that, `pick_work`'s order."""
    count: dict[str, int] = {}
    for w in banked:
        count[slug(w.get("author", ""))] = count.get(slug(w.get("author", "")), 0) + 1
    of = lambda w: count.get(slug(w.get("author", "")), 0)
    songs_each = len(banked) // lyr.ARTIST_COOLDOWN_DAYS + 1
    music = [w for w in fresh if w["kind"] == "music" and of(w) < songs_each]
    books = [w for w in fresh if w["kind"] != "music"]
    songs = sum(1 for w in banked if w["kind"] == "music")
    want_music = bool(music) and (not books or songs * MUSIC_EVERY_DAYS < len(banked) + 1)
    pool = music if want_music else (books or [w for w in fresh if w["kind"] == "music"])
    least = min(of(w) for w in pool)
    pool = [w for w in pool if of(w) == least]
    work, why = pick_work(pool, {**archive, "last_music": None if want_music else today}, index, today)
    return work, f"banking ({'a song' if want_music else 'a book'}, the bank's mix); {why.split('; ')[-1]}"


def pick_work(fresh: list[dict], archive: dict, index: dict, today: date) -> tuple[dict, str]:
    """The next work, by rule (no model call):
    a song when no music day is within MUSIC_EVERY_DAYS or no book is left, else a
    book; within the kind, the author never used or proposed first, then the one left
    longest ago, then the file name — deterministic, so two runs on one shelf pick the
    same work."""
    music = [w for w in fresh if w["kind"] == "music"]
    last_music = archive.get("last_music")
    want_music = bool(music) and (last_music is None or (today - last_music).days >= MUSIC_EVERY_DAYS)
    pool = music if want_music else ([w for w in fresh if w["kind"] != "music"] or fresh)

    def last_seen(w):
        dates = [d for d in (archive["last_used"].get(slug(w.get("author", ""))),
                             shelf_mod.last_proposed(index, w.get("author", ""))) if d]
        return max(dates) if dates else None

    def order(w):
        last = last_seen(w)
        return (last is not None, last or date.min, w["file"])
    work = min(pool, key=order)
    last = last_seen(work)
    why = ("music day: none within the last "
           f"{MUSIC_EVERY_DAYS} days; " if want_music else "") + \
        ("author never used" if last is None else f"author last seen {last.isoformat()}")
    return work, why


def mine(work: dict, text: str, log: Log, lang: str) -> list[str]:
    """The mechanical half of the selection: sentences for a book, joined lines for a song."""
    if work["kind"] == "music":
        _, body = lyr.parse_song(text)
        units = [u for u in lyr.candidate_units(lyr.clean_lines(body)) if lyr.is_unit_candidate(u)]
        log(f"- lyric units (joined lines) after the mechanical filter: {len(units)}")
        return units
    log(f"- text: {len(text.split())} words")
    sentences = candidate_sentences(text, lang=lang)
    log(f"- candidate sentences after the mechanical filter: {len(sentences)}")
    return sentences


def judge_sentences(log: Log, sentences: list[str], lang: str, judge) -> list[str]:
    """The judge's sentence pre-filter (#308): every candidate is scored — stands alone,
    carries an image or a turn, not a famous line — and the loose filter removes what the
    model should not have to read (about half a novel: lines hanging on a name or a
    pronoun, the flat ones). Reading order is kept: the model reads everything left
    (2026-09-24 — ordering by the image score favoured description and cut what the model
    never saw). The judge asks its questions in the line's language."""
    if not sentences:
        return []
    try:
        scores = contextual_rank.score_sentences(judge, sentences, lang=lang)
    except contextual_rank.ContextualError as exc:
        die(f"sentence judge: {exc}")
    kept = [s for s, sc in zip(sentences, scores) if contextual_rank.sentence_passes(sc)]
    log(f"- judged by Jev: {len(kept)} of {len(sentences)} pass the sentence filter "
        f"(stand alone ≥ {contextual_rank.SENTENCE_ALONE_MIN}, image ≥ "
        f"{contextual_rank.SENTENCE_IMAGE_MIN}, famous ≤ {contextual_rank.SENTENCE_FAMOUS_MAX}) "
        f"({judge.usage['input_tokens']} input tokens)")
    return kept


def giveaway_scores(tokens, words, occurrences, lang: str, judge) -> dict[str, float]:
    """How much the sentence hands each word over, by the judge's measure
    (`contextual_rank.giveaway`), read on real play (84 holes): under `GIVEAWAY_MIN` the
    line gives no path to the word and it is never hidden; under `GIVEAWAY_HARD` the hole
    plays hard (a note the start step reads: its start is tied to the word's direct meaning); at or above `GIVEAWAY_MAX` a third of the players
    typed it within three guesses. Each distinct word judged once, every occurrence
    blanked, the rest of the sentence intact and no start word — the reader's own view."""
    scores: dict[str, float] = {}
    for t in words:
        if t.slug in scores:
            continue
        try:
            # rendered EXACTLY as the threshold was calibrated: lowercase, one blank glyph
            shown = llm.holed(tokens, occurrences[t.slug] - {t.i}, t.i, lang=lang)
            shown = shown.replace("[____]", "\0").replace("____", "_____").replace("\0", "_____").lower()
            scores[t.slug] = contextual_rank.giveaway(judge, shown, t.text.lower(), lang=lang)
        except contextual_rank.ContextualError as exc:
            die(f"giveaway judge: {exc}")
    return scores


def _occurrences(words) -> dict[str, set[int]]:
    """Where each hideable word stands in the line, by slug (a repeat is one hole per
    occurrence)."""
    out: dict[str, set[int]] = {}
    for t in words:
        out.setdefault(t.slug, set()).add(t.i)
    return out


def shortlist(claude: llm.Claude, log: Log, sentences: list[str], lang: str) -> list[dict]:
    if not sentences:
        die("no candidate sentence in this work")
    picks: list[dict] = []
    for start in range(0, len(sentences), CHUNK):
        picks.extend(llm.pick_from_chunk(claude, sentences[start:start + CHUNK], PICKS_PER_CHUNK, lang=lang))
    log(f"- shortlisted by the model: {len(picks)}")
    ranked = llm.rank_sentences(claude, picks, SHORTLIST, lang=lang)
    log(f"- ranked shortlist: {len(ranked)}")
    return ranked


class Buffer(list):
    """A line's log while it is checked on its own thread; written to the run's log, in
    the batch's order, once every line is done."""

    def __call__(self, line: str = "") -> None:
        self.append(line)


@dataclass
class Measures:
    """What each word of one line was measured at, by slug — the reader, the would-say
    test, the crowd, the neighbours — asked once, whatever trio the line ends with; and
    the words swapped OUT of it, never offered again (a swap that brought one back
    undid the one before and spent the line's swaps)."""
    readings: dict = field(default_factory=dict)    # slug -> (the reader's words, the one most write)
    says: dict = field(default_factory=dict)        # slug -> (would-say chance, the word said instead)
    crowds: dict = field(default_factory=dict)      # slug -> crowd share
    neighbours: dict = field(default_factory=dict)  # slug -> (the words around it, the first word written)
    out: set = field(default_factory=set)           # slugs swapped out of the trio


@dataclass
class Checked:
    """A line's trio once every check before the ranking passed: its notes for the start
    step, how each word plays (the comparison's), the swaps it took."""
    trio: list
    chain: list[str]
    swaps: int
    context: dict[str, str]
    levels: dict[str, str]
    measures: Measures


def day(claude: llm.Claude, log: Log, ranked: list[dict], book: dict, archive: dict, text: str,
        in_vocab, frequency_rank, neighbour_rank, lang: str, replay: str | None = None,
        tried: list[str] | None = None, *, judge, crowd=lambda t: None, unmapped=lambda t, fillers: None,
        own=lambda t: None,
        index_of=lambda s: None):
    """The day, chosen among FINISHED candidates (user-decided 2026-10-13): the
    shortlist's lines, CANDIDATES at a time, are each prepared on their own (`prepare`),
    the model compares the lines that survived and the first is built, and when it
    cannot be, the next (`compare_and_build`). Then the next lines. Every line prepared
    goes into `tried`. Returns the written puzzle path, or None."""
    tried = tried if tried is not None else []
    for batch_start in range(0, len(ranked), CANDIDATES):
        days = prepare(claude, log, ranked[batch_start:batch_start + CANDIDATES], archive, in_vocab,
                       frequency_rank, neighbour_rank, lang, tried, judge=judge, crowd=crowd,
                       unmapped=unmapped, own=own)
        if not days:
            continue
        path = compare_and_build(claude, log, days, book, archive, text, frequency_rank, neighbour_rank, lang,
                                 replay if batch_start == 0 else None, crowd=crowd, unmapped=unmapped, own=own,
                                 index_of=index_of)
        if path:
            return path
    log("- no day: every line was declined or refused")
    return None


def prepare(claude: llm.Claude, log, picks: list[dict], archive: dict, in_vocab, frequency_rank,
            neighbour_rank, lang: str, tried: list[str], *, judge, crowd=lambda t: None,
            unmapped=lambda t, fillers: None, own=lambda t: None) -> list[tuple[dict, "Checked"]]:
    """Each line FINISHED on its own, up to the ranking: the line must stand alone, the
    model picks its three words from the words code allows (a word the line gives no path
    to, giveaway under `GIVEAWAY_MIN`, is never offered), and every check before the
    ranking runs with its swaps (`check_trio`). Returns the lines that survived, each
    with its checked trio; every line prepared goes into `tried`."""
    lines = []
    for pick in picks:
        tokens = parse(pick["sentence"], lang)
        allowed = rules.initial_candidates(tokens, lang=lang, in_vocab=in_vocab,
                                           past_secrets=archive["secrets"], frequency_rank=frequency_rank)
        given: dict[str, float] = {}
        pathless: list[str] = []
        if len({t.slug for t in allowed}) >= rules.TRIO:
            # The floor: a word the line gives no path to is never hidden.
            given = giveaway_scores(tokens, allowed, _occurrences(allowed), lang, judge)
            pathless = list(dict.fromkeys(f"{t.text} ({rules.two_places(given[t.slug])})" for t in allowed
                                          if given[t.slug] < contextual_rank.GIVEAWAY_MIN))
            allowed = [t for t in allowed if given[t.slug] >= contextual_rank.GIVEAWAY_MIN]
        if len({t.slug for t in allowed}) < rules.TRIO:
            log(f"\n## « {pick['sentence']} »\n- skipped: fewer than {rules.TRIO} words can be hidden"
                + (f" (no path to {', '.join(pathless)})" if pathless else ""))
            continue
        lines.append({"sentence": pick["sentence"], "tokens": tokens, "allowed": allowed, "given": given,
                      "pathless": pathless})
    if not lines:
        return []
    tried.extend(x["sentence"] for x in lines)
    log(f"\n## Preparing {len(lines)} line(s): words chosen and checked on each")

    def one(line):
        buffer = Buffer()
        return buffer, candidate(claude, buffer, line, frequency_rank, neighbour_rank, lang,
                                 crowd=crowd, unmapped=unmapped, own=own)

    with llm.subscription_only(), ThreadPoolExecutor(WORKERS) as pool:
        prepared = list(pool.map(one, lines))
    days: list[tuple[dict, Checked]] = []
    for line, (buffer, checked) in zip(lines, prepared):
        for entry in buffer:
            log(entry)
        if checked is not None:
            days.append((line, checked))
    if not days:
        log("\n- no line of these survived its checks")
    return days


def compare_and_build(claude: llm.Claude, log: Log, days: list[tuple[dict, "Checked"]], book: dict,
                      archive: dict, text: str, frequency_rank, neighbour_rank, lang: str,
                      replay: str | None = None, *, crowd=lambda t: None, unmapped=lambda t, fillers: None,
                      own=lambda t: None, index_of=lambda s: None) -> str | None:
    """The model compares finished lines, each as the player will get it — its words and
    how each plays — and orders them; the first is built (`build_day`: page, ranking,
    start words), and when it cannot be, the next. Returns the written puzzle path, or
    None."""
    source_base = {"kind": book["kind"], "author": book.get("author", ""), "work": book.get("title", "")}
    shown = []
    for line, c in days:
        occurrences = _occurrences(line["allowed"])
        shown.append({"marked": llm.marked(line["tokens"], {i for t in c.trio for i in occurrences[t.slug]},
                                           lang=lang),
                      "words": [{"word": t.text, "level": c.levels[t.slug]} for t in c.trio],
                      "path": c.chain})
    log(f"\n## Comparing {len(days)} finished line(s)")
    for n, d in enumerate(shown, 1):
        log(f"{n}. « {d['marked']} » — " + "; ".join(f"{w['word']} ({w['level']})" for w in d["words"]))
    choice = llm.choose_among(claude, shown, lang=lang)
    if not choice or not choice["order"]:
        log("- the model declines these lines" + (f" — {choice['why']}" if choice and choice["why"] else ""))
        return None
    log(f"- order: {', '.join(str(n + 1) for n in choice['order'])} — {choice['why']}")
    for n in choice["order"]:
        line, checked = days[n]
        log(f"\n## Building « {line['sentence']} »")
        path = build_day(claude, log, line, checked.trio, checked.chain, book, archive, text, source_base,
                         frequency_rank, neighbour_rank, lang, replay,
                         crowd=crowd, unmapped=unmapped, own=own, index_of=index_of,
                         measures=checked.measures, swaps=checked.swaps)
        if path:
            return path
        log("- it could not be built: the next line in the order")
    return None


def candidate(claude: llm.Claude, log, line: dict, frequency_rank, neighbour_rank, lang: str, *,
              crowd=lambda t: None, unmapped=lambda t, fillers: None, own=lambda t: None) -> Checked | None:
    """One line made a candidate day: it must STAND ALONE (a refusal ends the line), the
    model picks its three words (a pick that is not three distinct words of the line that
    can be hidden is told back, DAY_ROUNDS times), and every check before the ranking
    runs (`check_trio`). Returns the checked trio, or None with the reason logged."""
    log(f"\n## « {line['sentence']} »"
        + (f"\n- no path to {', '.join(line['pathless'])}" if line["pathless"] else ""))
    alone = llm.stands_alone(claude, line["sentence"], lang=lang)
    if not alone["ok"]:
        log(f"- refused: does not stand alone — {alone['why'] or 'it leans on its page'}")
        return None
    first_of: dict[str, rules.Token] = {}
    for t in line["allowed"]:
        first_of.setdefault(t.slug, t)
    refused: list[str] = []
    for _ in range(DAY_ROUNDS):
        choice = llm.choose_words(claude, {"sentence": line["sentence"], "allowed": hideable(line)},
                                  refused, lang=lang)
        if choice is None or choice["words"] is None:
            log("- the model declines this line" + (f" — {choice['why']}" if choice and choice["why"] else ""))
            return None
        log(f"- chosen: {' · '.join(choice['words'])} — {choice['why']}")
        for step in choice["path"]:
            log(f"  - {step}")
        trio = [first_of.get(slug(w)) for w in choice["words"]]
        if any(t is None for t in trio) or len({t.slug for t in trio}) < rules.TRIO:
            why = "the three words must be distinct words of the line that can be hidden"
            log(f"- refused: {why}")
            refused.append(f"« {' · '.join(choice['words'])} » — {why}")
            continue
        return check_trio(claude, log, line, trio, choice["path"], frequency_rank, neighbour_rank, lang,
                          crowd=crowd, unmapped=unmapped, own=own, measures=Measures(), swaps=0)
    log("- no usable choice of words for this line")
    return None


def hideable(line: dict) -> list[str]:
    """The words a line can hide, as the model is shown them: each once, in line order."""
    return list(dict.fromkeys(t.text for t in line["allowed"]))


def check_trio(claude: llm.Claude, log, line: dict, trio: list, chain: list[str], frequency_rank,
               neighbour_rank, lang: str, *, crowd=lambda t: None, unmapped=lambda t, fillers: None,
               own=lambda t: None,
               measures: Measures, swaps: int) -> Checked | None:
    """Every check a trio meets before the ranking is paid for. Code measures each hidden
    word — what a reader puts in its blank, how much the sentence hands it over
    (`line["given"]`, judged for every word that can be hidden), whether a player who has
    the meaning would say it, its crowd, what its neighbours alone call for. A BURIED word
    (`rules.buried`: half-said, among commoner near-words on the free map) is refused by
    code and replaced by the model's choice (`llm.replace_word`); so is a word its
    NEIGHBOURS alone hand over (`rules.neighbourhood`, `llm.neighbours_complete`: « le
    droit de ___ ») and an UNMAPPED word, none of the words readers put in its blank on
    its free map (`rules.unmapped`). A trio hiding two or more words players don't say has
    one swapped by the model (`llm.drop_unsaid`); one whose line hands over two or more,
    one swapped too (`llm.drop_handed`). A swapped word is replaced by another word of the
    line that can be hidden, REPLACE_ROUNDS times in all, the start step's swaps
    (`build_day`) included. A word is measured once (`measures`)."""
    tokens, given = line["tokens"], line["given"]
    occurrences = _occurrences(line["allowed"])
    readings, says, crowds, neighbours = measures.readings, measures.says, measures.crowds, measures.neighbours
    while True:
        for t in trio:
            if t.slug not in readings:
                readings[t.slug] = llm.context_guesses(claude, tokens, occurrences[t.slug] - {t.i}, t.i,
                                                       rules.CONTEXT_GUESSES, lang=lang)
            if t.slug not in crowds:
                crowds[t.slug] = crowd(t)
            if t.slug not in says:
                ask = lambda: llm.would_say(claude, tokens, occurrences[t.slug] - {t.i}, t.i, t.text.lower(), lang=lang)
                chance, instead = ask()
                # In a crowd the verdict turns on would-say near its bar, where one answer
                # wobbles: a second is asked and the two averaged.
                if chance is not None and crowds[t.slug] is not None and crowds[t.slug] >= rules.BURIED_CROWD:
                    again, _ = ask()
                    chance = chance if again is None else round((chance + again) / 2, 3)
                says[t.slug] = (chance, instead)
            if t.slug not in neighbours:
                around = rules.neighbourhood(tokens, t.i, occurrences[t.slug] - {t.i}
                                             | {i for u in trio if u.slug != t.slug for i in occurrences[u.slug]})
                fragment = llm.holed(around, set(), t.i, lang=lang).replace("[____]", "___")
                neighbours[t.slug] = (fragment, llm.neighbours_complete(claude, fragment, lang=lang))
        hard = {t.slug for t in trio if given[t.slug] < contextual_rank.GIVEAWAY_HARD}
        same = {t.slug for t in trio if rules.same_word(t, says[t.slug][1], own(t))}
        unsaid = rules.unsaid({t.text: None if t.slug in same else says[t.slug][0] for t in trio})
        rare = {t.slug for t in trio if t.slug not in same and says[t.slug][0] is not None
                and says[t.slug][0] < rules.WOULD_SAY_HARD}
        context = {}
        for t in trio:
            guesses, expected = readings[t.slug]
            note = rules.reading(t, guesses, expected, neighbour_rank=neighbour_rank, frequency_rank=frequency_rank)
            note += (f"; the sentence hands it over at {rules.two_places(given[t.slug])} (on real play, "
                     f"{contextual_rank.GIVEAWAY_MAX} and above was typed within three guesses by a third of the players)")
            note += "; " + rules.said(*says[t.slug], same=t.slug in same)
            note += "; " + rules.crowd_note(crowds[t.slug])
            if unsaid and t.slug in rare:
                note += "; " + unsaid
            if t.slug in hard:
                note += (f"; under {rules.two_places(contextual_rank.GIVEAWAY_HARD)} {rules.GIVES_LITTLE} "
                         f"(such holes played hard on real play)")
            context[t.slug] = note
        handed = [t for t in trio if "most readers would write the secret itself" in context[t.slug]]
        # Two or more words players don't say, or two or more the line hands over (a day
        # solved in a few guesses, 2026-10-12): the model swaps one BEFORE the ranking is
        # paid for (a swap at the start step pays it twice). Any other trio goes straight
        # on: one easy word is the start step's to tune.
        swap = None
        hidden = {i for t in trio for i in occurrences[t.slug]}
        others = _others(line, trio, measures)
        sunk = next((t for t in trio if t.slug not in same and rules.buried(says[t.slug][0], crowds[t.slug])), None)
        given_away = next((t for t in trio if rules.same_word(t, neighbours[t.slug][1], own(t))), None)
        stranded = next(((t, off) for t in trio
                         for off in [unmapped(t, [*readings[t.slug][0], *filter(None, [readings[t.slug][1]])])]
                         if off), None)
        if sunk is not None:
            log(f"- « {sunk.text} » is buried (would-say {says[sunk.slug][0]}, "
                f"crowd {crowds[sunk.slug]}): refused")
            pick = llm.replace_word(claude, llm.marked(tokens, hidden, lang=lang),
                                    [{"secret": t.text, "notes": context[t.slug]} for t in trio], sunk.text,
                                    others, chain, lang=lang,
                                    refused="players only half-say it and it sits among commoner words meaning "
                                            "nearly the same, so they reach the idea, circle the commoner "
                                            "neighbours and stall.")
            if pick is None:
                log(f"- no replacement named for « {sunk.text} »")
                return None
            swap = {"secret": sunk.text, "with": pick["with"],
                    "why": f"buried among commoner near-words ({pick['why']})"}
        elif given_away is not None:
            fragment, first = neighbours[given_away.slug]
            log(f"- « {given_away.text} »: its neighbours alone hand it over (« {fragment} » → « {first} »): refused")
            pick = llm.replace_word(claude, llm.marked(tokens, hidden, lang=lang),
                                    [{"secret": t.text, "notes": context[t.slug]} for t in trio], given_away.text,
                                    others, chain, lang=lang,
                                    refused=f"the words right around it hand it over — « {fragment} » is "
                                            f"« {first} » for anyone — so it is no search.")
            if pick is None:
                log(f"- no replacement named for « {given_away.text} »")
                return None
            swap = {"secret": given_away.text, "with": pick["with"],
                    "why": f"its neighbours hand it over ({pick['why']})"}
        elif stranded is not None:
            lost, off = stranded
            words = ", ".join(f"« {w} »" for w in off)
            log(f"- « {lost.text} »: none of the words readers put there ({words}) is on its map: refused")
            pick = llm.replace_word(claude, llm.marked(tokens, hidden, lang=lang),
                                    [{"secret": t.text, "notes": context[t.slug]} for t in trio], lost.text,
                                    others, chain, lang=lang,
                                    refused=f"none of the words readers put in its blank ({words}) is on its map: "
                                            "the map holds another sense of it, so every first guess lands past "
                                            "the map and players are stuck.")
            if pick is None:
                log(f"- no replacement named for « {lost.text} »")
                return None
            swap = {"secret": lost.text, "with": pick["with"],
                    "why": f"no word readers put there is on its map ({pick['why']})"}
        elif unsaid:
            swap = llm.drop_unsaid(claude, llm.marked(tokens, hidden, lang=lang),
                                   [{"secret": t.text, "notes": context[t.slug]} for t in trio],
                                   [t.text for t in trio if t.slug in rare], others, chain, lang=lang)
        elif len(handed) >= 2:
            swap = llm.drop_handed(claude, llm.marked(tokens, hidden, lang=lang),
                                   [{"secret": t.text, "notes": context[t.slug]} for t in trio],
                                   [t.text for t in handed], others, chain, lang=lang)
            if swap is None:
                log(f"- the line hands over {len(handed)} words and no swap was named")
                return None
        if not swap:
            levels = {t.slug: ("easy: most readers write it straight in" if t in handed
                               else "hard: the line gives little of it" if t.slug in hard
                               else "hard: a word players don't say" if t.slug in rare
                               else "medium") for t in trio}
            return Checked(trio, chain, swaps, context, levels, measures)
        log(f"- before the ranking, « {swap['secret']} » is swapped for « {swap['with']} » — {swap['why']}")
        swapped = _swap(log, line, trio, chain, Replace(swap["secret"], swap["with"], swap["why"]), swaps, measures.out)
        if swapped is None:
            return None
        trio, chain, swaps = swapped


def _others(line: dict, trio: list, measures: Measures) -> list[str]:
    """The words a swap may bring in: the line's hideable words, neither in the trio nor
    swapped out of it before."""
    taken = {t.slug for t in trio} | measures.out
    return list(dict.fromkeys(t.text for t in line["allowed"] if t.slug not in taken))


def _swap(log, line: dict, trio: list, chain: list[str], swap: "Replace", swaps: int, out: set):
    """The trio with `swap` made: (trio, chain, swaps), the word swapped out added to
    `out`; or None — the swaps are spent (REPLACE_ROUNDS), the word named is not one the
    line can hide, or it was swapped out before."""
    if swaps >= REPLACE_ROUNDS:
        log("- no trio of this line survived its swaps")
        return None
    old = next((t for t in trio if t.slug == slug(swap.secret) or t.text == swap.secret), None)
    new = next((t for t in line["allowed"] if t.slug == slug(swap.with_)), None)
    if old is None or new is None or new.slug in {t.slug for t in trio}:
        log(f"- the swap « {swap.secret} » → « {swap.with_} » is not a word of the line that can be hidden")
        return None
    if new.slug in out:
        log(f"- the swap « {swap.secret} » → « {swap.with_} » brings back a word already swapped out of this line")
        return None
    out.add(old.slug)
    trio = [new if t is old else t for t in trio]
    log(f"- trio now: {' · '.join(t.text for t in trio)}")
    return trio, [f"{new.text} replaces {old.text}: {swap.why}", *chain], swaps + 1


def build_day(claude: llm.Claude, log: Log, line: dict, trio: list, chain: list[str], book: dict, archive: dict,
              text: str, source_base: dict, frequency_rank, neighbour_rank, lang: str, replay: str | None,
              crowd=lambda t: None, unmapped=lambda t, fillers: None, own=lambda t: None, index_of=lambda s: None,
              measures: Measures | None = None, swaps: int = 0):
    """The chosen day, built: the page is cut (a book), the trio passes its checks
    (`check_trio`; free when the comparison's `measures` come along), and `generate`
    writes the puzzle, the start words chosen by the taste. The start step may swap a
    word no start can save (Replace) or find two holes handed over on the map (Handed,
    `llm.drop_handed`); the trio is then checked again and rebuilt, REPLACE_ROUNDS swaps
    in all."""
    sentence, tokens = line["sentence"], line["tokens"]
    known = llm.widely_known(claude, sentence, book.get("author", ""), book.get("title", ""), lang=lang)
    log("- known-line check (annotation): "
        + ("the model thinks a reader would know it" if known["known"] else "not known off the page")
        + (f" — {known['why']}" if known["why"] else ""))
    measures = measures or Measures()
    occurrences = _occurrences(line["allowed"])
    source = dict(source_base)
    if book["kind"] == "book":
        window = excerpt_around(text, sentence, EXCERPT_WINDOW, lang=lang)
        excerpt = choose_page(claude, log, sentence, window, lang) if window else None
        if excerpt:
            source["excerpt"] = excerpt
    elif book["kind"] == "music":
        # A song's page is its whole stanza, verse or chorus: no cut, no model call.
        excerpt = lyr.stanza_excerpt(lyr.clean_lines(lyr.parse_song(text)[1]), sentence)
        if excerpt:
            source["excerpt"] = excerpt
            log(f"- page: the line's stanza, {len(excerpt['before'])} line(s) before, "
                f"{len(excerpt['after'])} after")
    while True:
        checked = check_trio(claude, log, line, trio, chain, frequency_rank, neighbour_rank, lang,
                             crowd=crowd, unmapped=unmapped, own=own, measures=measures, swaps=swaps)
        if checked is None:
            return None
        if checked.swaps != swaps:
            replay = None  # another trio: the scores of the erased draft no longer apply
        trio, chain, swaps, context = checked.trio, checked.chain, checked.swaps, checked.context
        readings = measures.readings
        try:
            return generate(claude, log, sentence, [t.text for t in trio], source, lang, context, index_of,
                            archive["pairs"], replay=replay, chain=chain,
                            fillers={t.slug: readings[t.slug][0] for t in trio},
                            expected={t.slug: readings[t.slug][1] for t in trio})
        except Replace as raised:
            swap = raised
        except Handed as raised:
            hidden = {i for t in trio for i in occurrences[t.slug]}
            others = _others(line, trio, measures)
            pick = llm.drop_handed(claude, llm.marked(tokens, hidden, lang=lang),
                                   [{"secret": t.text, "notes": context[t.slug]
                                     + (f"; on its map: {raised.facts[t.slug]}" if t.slug in raised.facts else "")}
                                    for t in trio], raised.words, others, chain, lang=lang)
            if pick is None:
                log(f"- the map hands over {len(raised.words)} words and no swap was named")
                return None
            log(f"- after the ranking, « {pick['secret']} » is swapped for « {pick['with']} » — {pick['why']}")
            swap = Replace(pick["secret"], pick["with"], f"its map handed it over ({pick['why']})")
        swapped = _swap(log, line, trio, chain, swap, swaps, measures.out)
        if swapped is None:
            return None
        trio, chain, swaps = swapped
        replay = None  # another trio: the scores of the erased draft no longer apply


def choose_page(claude: llm.Claude, log: Log, sentence: str, window: dict, lang: str) -> dict | None:
    """The page around the line (#270): the model says where it starts and ends, code
    clamps it into the window; an unusable answer falls back to EXCERPT_SENTENCES a side.
    None when nothing is left (a line with no page)."""
    answer = llm.choose_excerpt(claude, sentence, window, lang=lang)
    if answer is None:
        answer = {"before": EXCERPT_SENTENCES, "after": EXCERPT_SENTENCES}
        log("- page: no usable cut from the model; the default three-and-three")
    excerpt = cut_excerpt(window, answer["before"], answer["after"])
    log(f"- page: {len(excerpt['before'])} sentence(s) before, {len(excerpt['after'])} after "
        f"(offered {len(window['before'])}/{len(window['after'])})")
    return excerpt if excerpt["before"] or excerpt["after"] else None


def retry_target(args, log: Log, index: dict) -> str | None:
    """`--retry`: a candidate puzzle file names its work (set as `args.work`) and is
    erased — the retry replaces it — and its sentence is returned, as the puzzle keeps
    it (lowercased tokens); a file on the shelf has its whole attempt erased (index
    entry, candidate puzzles) and is set as the work, returning None."""
    given = Path(args.retry)
    if given.suffix == ".json" and given.is_file():
        try:
            puzzle = json.loads(given.read_text(encoding="utf-8"))
            words = puzzle["words"]
        except (OSError, ValueError, KeyError, TypeError):
            die(f"{given} is not a candidate puzzle")
        if puzzle.get("lang") != args.lang:
            die(f"{given.name} is a « {puzzle.get('lang')} » puzzle: retry it with --lang {puzzle.get('lang')}")
        work = shelf_mod.work_of(puzzle.get("source") or {}, shelf_mod.list_works(_paths.shelf_dir(args.lang)))
        if work is None:
            die(f"{given.name} names no work on the {args.lang} shelf (source: {puzzle.get('source')})")
        args.work = work["file"]
        sidecar = Path(_sidecar(str(given.resolve())))
        args.replay = str(sidecar) if sidecar.is_file() else None  # its scores are reused (#308)
        shelf_mod.erase_puzzle(given.resolve())
        log(f"- erased: {given}" + (" (its contextual scores kept for the rerun)" if args.replay else ""))
        return " ".join(words)
    work = next((w for w in shelf_mod.list_works(_paths.shelf_dir(args.lang)) if w["file"] == args.retry), None)
    if work is None:
        die(f"{args.retry} is neither on the {args.lang} shelf nor a candidate puzzle file")
    for path in shelf_mod.forget(index, work, args.lang, shelf_mod.published_drafts(args.lang)):
        log(f"- erased: {path}")
    shelf_mod.save_index(index, args.lang)
    args.work = args.retry
    return None


def read_work(book: dict, lang: str) -> str:
    path = _paths.shelf_dir(lang) / book["file"]
    return epub_text(path) if book["kind"] == "book" else path.read_text(encoding="utf-8")


def quote_filter(log: Log, book: dict, lang: str):
    """The work's quoted lines (the quotation test): fetched onto the shelf by
    `pnpm shelf:quotes`, read here offline, and applied to every mined line before the
    judge or the model reads it. A missing file skips the test, loudly. Returns the filter:
    the lines given, minus the quoted ones."""
    quotes: list[str] = []
    if book["kind"] == "book":
        on_file = qt.load_quotes(book["file"], qt.quotes_dir(lang))
        if on_file is None:
            log(f"- quotes: NO FILE for this work — run `pnpm shelf:quotes --lang {lang}`; "
                "the quotation test is skipped")
        elif not qt.quote_sources(book["file"], qt.quotes_dir(lang)):
            log("- quotes: the fetch found NO WIKIQUOTE OR WIKIPEDIA PAGE for this work — the quotation "
                "test has nothing to check")
        else:
            quotes = on_file
            log(f"- quotes: {len(quotes)} quoted line(s) on file")

    def unquoted(lines: list[str]) -> list[str]:
        kept = []
        for line in lines:
            hit = qt.quoted(line, quotes, lang=lang) if quotes else None
            if hit:
                log(f"- a quoted line, out: « {line} » — « {hit} »")
            else:
                kept.append(line)
        return kept
    return unquoted


def judged_lines(log: Log, book: dict, text: str, archive: dict, index: dict, lang: str, judge) -> list[str]:
    """The work's lines the model reads: mined, minus what a run proposed or the ledger
    holds, minus the quoted ones, through the judge's sentence filter."""
    unquoted = quote_filter(log, book, lang)
    proposed = {shelf_mod.sentence_key(s) for s in index["books"].get(book["file"], {}).get("sentences", ())}
    proposed |= archive["sentences"]
    mined = unquoted([s for s in mine(book, text, log, lang) if shelf_mod.sentence_key(s) not in proposed])
    return judge_sentences(log, mined, lang, judge)


def bank_works(claude: llm.Claude, log: Log, args, archive: dict, index: dict, today: date, judge,
               in_vocab, sims) -> int:
    """`--bank N`: N works, each mined and shortlisted as a run does, the first BANK_LINES
    lines of its shortlist finished up to the ranking (`prepare`) and kept in the bank — no
    line compared, no ranking paid. A work gives at most one day, so a work's first batch
    is what a run would compare. A work is banked once (claimed under the bank's lock, so
    processes running at once never share one); a run never mines it again. A work whose
    banking fails is released (`bank.unclaim`); two failures in a row end the process."""
    frequency_rank, neighbour_rank, crowd, unmapped, own, _ = sims
    total, failures = 0, 0
    for _ in range(args.bank):
        with bank.locked(args.lang):
            book = choose_work(log, args, archive, index, today,
                               banked=bank.works(args.lang) | bank.claimed(args.lang))
            if book is not None:
                bank.claim(args.lang, book["file"])
        if book is None:
            break
        log.begin_attempt()
        try:
            text = read_work(book, args.lang)
            judged = judged_lines(log, book, text, archive, index, args.lang, judge)
            # a work with no line left banks nothing and stays claimed: there is nothing to retry
            ranked = shortlist(claude, log, judged, args.lang) if judged else []
            days = prepare(claude, log, ranked[:BANK_LINES], archive, in_vocab, frequency_rank, neighbour_rank,
                           args.lang, [], judge=judge, crowd=crowd, unmapped=unmapped, own=own)
        except Exception as exc:  # a failed call (a usage limit, the judge): the work is released
            bank.unclaim(args.lang, book["file"])
            log.end_attempt(False)
            log(f"- banking {book['file']} failed, released: {type(exc).__name__}: {exc}")
            failures += 1
            if failures >= 2:
                log("- two works failed in a row: stopping")
                break
            continue
        except BaseException:  # the judge refused (die), or the process is stopped
            bank.unclaim(args.lang, book["file"])
            raise
        failures = 0
        entries = [bank.entry(book, line, checked) for line, checked in days]
        bank.append(args.lang, entries)
        total += len(entries)
        log.end_attempt(bool(entries), [f"- banked: {len(entries)} line(s) of {book.get('author', '')} — "
                                        f"{book.get('title', '')}"])
        if args.work:
            break
    held = bank.load(args.lang)
    log(f"\n## Bank\n\n- banked this run: {total} line(s)\n- the bank holds {len(held)} line(s) of "
        f"{len({e['work'] for e in held})} work(s): `{bank.bank_file(args.lang)}`")
    return 0 if total else 2


def pull_day(claude: llm.Claude, log: Log, args, archive: dict, index: dict, today: date, in_vocab,
             sims) -> str | None:
    """`--pull`: the day made from the bank. The work is picked by the run's own rule
    (`pick_work`: the music cadence, the author left longest) among the banked works the
    archive still allows; its banked lines are read against today's archive
    (`bank.restore`), compared and built as a run's finished lines are
    (`compare_and_build`: page, ranking, start words). Returns the written puzzle path."""
    frequency_rank, neighbour_rank, crowd, unmapped, own, index_of = sims
    entries = bank.load(args.lang)
    by_work: dict[str, list[dict]] = {}
    for e in entries:
        by_work.setdefault(e["work"], []).append(e)
    shelf = {w["file"]: w for w in shelf_mod.list_works(_paths.shelf_dir(args.lang))}
    pool = [shelf[f] for f in by_work
            if f in shelf and not shelf[f].get("error") and (not args.work or f == args.work)
            and not shelf_mod.in_archive(shelf[f], archive["works"])
            and not in_cooldown(shelf[f], archive, index, today)]
    log(f"- bank: {len(entries)} line(s) of {len(by_work)} work(s); {len(pool)} work(s) the archive still allows")
    if not pool:
        die("no banked work is left that the archive allows — bank more (`--bank N`)")
    log.begin_attempt()
    result, book = None, None
    while pool and not result:
        book, why = pick_work(pool, archive, index, today)
        pool.remove(book)
        log(f"\n## Work: {book.get('author')} — {book.get('title')} ({book['kind']}, {book['file']}): {why}")
        days = []
        for e in by_work[book["file"]]:
            restored, out = bank.restore(e, archive, args.lang, in_vocab, frequency_rank, Measures, Checked)
            if restored:
                days.append(restored)
            else:
                log(f"- banked « {e['sentence']} » out: {out}")
        if not days:
            continue
        text = read_work(book, args.lang)
        for batch_start in range(0, len(days), CANDIDATES):
            result = compare_and_build(claude, log, days[batch_start:batch_start + CANDIDATES], book, archive,
                                       text, frequency_rank, neighbour_rank, args.lang, crowd=crowd,
                                       unmapped=unmapped, own=own, index_of=index_of)
            if result:
                break
    log.end_attempt(bool(result), player_view(result, book) if result else ())
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--lang", choices=shelf_mod.LANGS, default="fr",
                   help="the language of the day: its shelf (shelf/<lang>/), archive and vectors")
    p.add_argument("--work", help="a file name on the shelf, epub or song (skips the pick by rule)")
    p.add_argument("--blind", action="store_true",
                   help="withhold the winning sentence, its secrets and their handling from the "
                        "log and stdout (they go to runs/<stamp>.spoilers.md), so the run can be "
                        "read and the puzzle played before being spoiled")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--retry", metavar="FILE",
                      help="retry a WORK — a file on the shelf, epub or song: erase its attempt (index "
                           "entry and candidate puzzles) and run on it again — or ONE SENTENCE — a "
                           "candidate puzzle file: erase it and rerun its sentence (the work read off "
                           "the puzzle's source), skipping the mining, shortlist and ranking")
    mode.add_argument("--bank", type=int, metavar="WORKS",
                      help="bank WORKS works: every shortlisted line finished up to the ranking and kept "
                           "in bank/<lang>.jsonl for a later --pull; no day is written, no ranking paid")
    mode.add_argument("--pull", action="store_true",
                      help="make the day from the bank: compare a banked work's lines, rank and build the best")
    args = p.parse_args()
    if args.bank is not None and args.bank < 1:
        p.error("--bank takes a number of works, 1 or more")

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M")
    if args.bank:  # banking processes run side by side: one log each
        stamp += f"-bank-{os.getpid()}"
    log = Log(stamp, blind=args.blind)
    try:
        plan = llm.validate()
    except RuntimeError as exc:
        die(str(exc))
    log(f"- model: {llm.MODEL} (effort {llm.EFFORT}) on the {plan} subscription")
    log(f"- language: {args.lang} (shelf `{_paths.shelf_dir(args.lang)}`)")

    vocab = set(json.loads((_paths.VOCAB_DIR / f"{args.lang}.json").read_text(encoding="utf-8")))
    index = shelf_mod.load_index(args.lang)
    # What the run cannot do without is checked before `--retry` erases anything and
    # before any model call: the ledger, and the judge's key (the one gen_phrase needs
    # anyway).
    if not _paths.PUBLISHED_LEDGER.exists():
        die(f"no publish ledger at {_paths.PUBLISHED_LEDGER} — run `pnpm puzzle:ledger --s3` first "
            "(the archive is read off it, and an empty archive would re-propose every published day)")
    try:
        judge = contextual_rank.JevJudge(contextual_rank.read_api_key(os.environ))
    except contextual_rank.ContextualError as exc:
        die(f"judge: {exc}")
    sentence = None
    if args.retry:
        sentence = retry_target(args, log, index)
    today = datetime.now(timezone.utc).date()
    archive = shelf_mod.archive(args.lang, today)
    log(f"- archive: {len(archive['secrets'])} secret(s) still in their {shelf_mod.SECRET_COOLDOWN_DAYS}-day "
        f"cooldown, {sum(len(v) for v in archive['pairs'].values())} secret/start pair(s) blacklisted")
    claude = llm.Claude()

    if args.bank:
        sims = load_similarity(args.lang)
        code = bank_works(claude, log, args, archive, index, today, judge, vocab.__contains__, sims)
        log(f"- model calls: {claude.calls}\n- log: `{log.path}`")
        sys.exit(code)

    if args.pull:
        result = pull_day(claude, log, args, archive, index, today, vocab.__contains__,
                          load_similarity(args.lang))
    else:
        book = choose_work(log, args, archive, index, today,
                           banked=bank.works(args.lang) | bank.claimed(args.lang))
        text = read_work(book, args.lang)
        frequency_rank, neighbour_rank, crowd, unmapped, own, index_of = load_similarity(args.lang)
        if sentence is not None:
            # One sentence, by hand: found again among the work's mined units so it keeps the
            # source's casing; never a published one (the archive is the one record).
            unquoted = quote_filter(log, book, args.lang)
            unit = shelf_mod.find_unit(mine(book, text, log, args.lang), sentence)
            if unit is None:
                log("- the sentence is not one of the work's mined units — taken as typed")
                unit = sentence
            if shelf_mod.sentence_key(unit) in archive["sentences"]:
                die("that sentence is already published (it is in the ledger)")
            ranked = [{"sentence": line, "why": "retried by hand"} for line in unquoted([unit])]
        else:
            ranked = shortlist(claude, log, judged_lines(log, book, text, archive, index, args.lang, judge),
                               args.lang)

        tried: list[str] = []
        log.begin_attempt()
        result = day(claude, log, ranked, book, archive, text, vocab.__contains__, frequency_rank,
                     neighbour_rank, args.lang, replay=getattr(args, "replay", None), tried=tried, judge=judge,
                     crowd=crowd, unmapped=unmapped, own=own, index_of=index_of)
        log.end_attempt(bool(result), player_view(result, book) if result else ())
        shelf_mod.record(index, book["file"], tried, author=book.get("author", ""))
        shelf_mod.save_index(index, args.lang)
    log("")
    if result:
        log(f"## Candidate puzzle\n\n- written: `{result}`\n- publish when approved: `pnpm puzzle:publish {result}`")
    else:
        log("## No puzzle\n\n" + ("No banked line made a day; bank more works." if args.pull else
                                  "No line of this work made a day worth playing; run again on another work."))
    log(f"- model calls: {claude.calls}\n- log: `{log.path}`")
    sys.exit(0 if result else 2)


if __name__ == "__main__":
    main()
