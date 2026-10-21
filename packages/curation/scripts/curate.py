"""One book in, one candidate puzzle out (issue #260). Never publishes.

    pnpm curate [--lang fr] [--work <file on the shelf>]
    pnpm curate [--lang fr] --retry <file on the shelf | candidate puzzle.json>
    pnpm curate [--lang fr] --bank N | --finish <id> | --rebank

The language picks the shelf (shelf/<lang>/, a work filed by the language of its
edition), the archive and the vectors; the two languages share nothing (#317).

TASTE CHOOSES, CODE STATES FACTS (2026-09-24). A work is picked off the shelf by rule; its
sentences are mined, the quoted ones and what the judge finds unreadable removed; the
model reads every one that is left with the `taste` skill and shortlists the best; then
each of the best lines is READ — does it stand alone, its kind, its main word and the path
to it, code setting aside what the reading strikes — and FINISHED the way the user chooses
words by hand: its main word measured alone and refused by any fact against it, then two
words the model chooses AGAINST it, code measuring what a reader puts in each blank, how
much the sentence hands a word over, what its neighbours call for, which of its nearest
words belong to another sense than the line's, and telling back what fails — and the model
COMPARES the finished lines and chooses the day. Each hidden word's map is its plain static
map minus the words of that other sense (`sense`, `line_map`): ONE map, from the choice of
the words to the puzzle `gen_phrase` writes headless (a word with two dictionary entries
aside, whose form only gen_phrase confirms). Code hands its notes and where the
reader's words land in each hole's map to the model, which chooses the start words by the
taste, the main word's first. Nothing is ever swapped: a line that cannot be built is not
built. The run's log — every choice and its reason — goes to `runs/<stamp>.md`, the puzzle
to generation's output directory.
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
from typing import Callable

import _paths
from build_forms import CITATION_FEATURE  # the forms table's no-agreement cell (generation/scripts)
from slug import slug

import jev  # the curator's Jev questions: the sentence filter and the giveaways
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
# Lines FINISHED — words chosen and checked — before the day is chosen among them
# (user-decided 2026-10-13), checked WORKERS at a time.
CANDIDATES = 10
WORKERS = 5
# Readings of a line asked when code tells one back (a main word the line cannot hide, a
# path through words not in sight), before the line is set aside.
READ_ROUNDS = 3
# Asks for the two words chosen against the main word, per line, what code told back and
# the bank's start step included, before the line is set aside.
COMPANION_ASKS = 3
# The other-sense question (`sense`): the words of a hidden word's plain map shown per round,
# closest first; a round naming SENSE_DIG of them or more is followed by another, showing the
# first SENSE_TOP words left once every word named is taken off, at most SENSE_ROUNDS rounds.
SENSE_TOP = 300
SENSE_DIG = 30
SENSE_ROUNDS = 4
# What a missing step of the narrowing ladder (`llm.LADDER`) makes of a wide word: a lottery.
LOTTERY = {"slot": "the slot shapes no kind", "family": "no smaller family a start can name",
           "first": "it is neither the first member players name nor one the ranks climb to"}
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
        self.stamp = stamp
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

    def end_attempt(self, success: bool, summary: list[str] = (), hide_failure: bool = False) -> None:
        """`hide_failure`: a failed attempt whose lines may still become a day (a work whose
        banking failed is banked again later) goes to the spoilers file too."""
        held, self._held = self._held, None
        if held is None:
            return
        if not success and not hide_failure:
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
# Vectors: what the language's vectors answer, free, None when a word has no vector.

@dataclass(frozen=True)
class Vectors:
    """What the language's vectors answer about a word, free (`load_similarity`): its place in
    the corpus order, where another word stands in its static ranking, its crowd of commoner
    near-words, whether the vectors know a slug, its own group's keys, a slug's commonness (the
    start band's), and its static map — PLAIN, or with the groups of words of another sense
    taken off (`off`, `sense`). Each is None when the word has no vector or map."""
    frequency_rank: Callable = lambda t: None
    neighbour_rank: Callable = lambda t, w: None
    crowd: Callable = lambda t: None
    known: Callable = lambda s: False
    own: Callable = lambda t: None
    index_of: Callable = lambda s: None
    static_map: Callable = lambda t, off=frozenset(): None


def load_similarity(lang: str) -> Vectors:
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

    import gen_phrase as gp  # the static walk (generation/scripts)

    cfg = gp.CONFIG[lang]
    lemma_table = gp.load_lemma_table(lang)
    forms_by_lemma = gp.invert_lemmas(lemma_table)
    Vset = set(V)
    first_index: dict[str, int] = {}
    for i, w in enumerate(kv.index_to_key):
        first_index.setdefault(slug(w), i)

    @lru_cache(maxsize=256)
    def static_map_of(word: str, off: frozenset):
        try:
            _merged, rank_map, _groups = gp.walk_secret(word, word, cfg, kv, V, M, Vset, lemma_table, forms_by_lemma,
                                                        off=off)
        except Exception:  # a word the walk cannot settle alone (#133) is left unmeasured
            return None
        return rank_map

    def static_map(t: rules.Token, off=frozenset()):
        """The token's static map, as `gen_phrase` builds a puzzle's: PLAIN, or with the
        groups the words `off` reach taken off (words near it only through another sense,
        `sense`: gen_phrase's `--other-sense`). None when its vector or its walk is missing."""
        for form in (t.text.lower(), t.lemma):
            if form and form in Vset:
                return static_map_of(form, frozenset(off))
        return None

    def crowd(t: rules.Token):
        """The token's crowd of commoner near-words on its plain map (`rules.crowd_share`)."""
        rank_map = static_map(t)
        return None if rank_map is None else rules.crowd_share(rank_map, first_index.get)

    def own(t: rules.Token):
        """The keys of the token's own group on its plain map — what typing finds the hole
        with (`rules.same_word`); None without a map."""
        rank_map = static_map(t)
        return None if rank_map is None else frozenset(k for k, v in rank_map.items() if v["rank"] == 0)

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
    return Vectors(frequency_rank=frequency_rank, neighbour_rank=neighbour_rank, crowd=crowd,
                   known=first_index.__contains__, own=own, index_of=common_index.get, static_map=static_map)


# ---------------------------------------------------------------------------
# gen_phrase, headless, with the #133 form question answered by the model.

_FORM_NEEDED = re.compile(r"la forme de « (.+?) » doit être explicite")
_ANALYSIS = re.compile(r"^\s*(\d+)\)\s+(\S+)\s+—\s+(.*)$", re.M)
_EXAMPLE = re.compile(r"ex\. --form \S+=(\S+)")
_SHARED = re.compile(r"Précise : (.+?)\.\s*$", re.S)
_WRITTEN = re.compile(r"écrite dans (.+) :$", re.M)
_START_REFUSED = re.compile(r"--start : « (.+?) »")


def run_gen_phrase(sentence: str, words: list[str], source: dict, forms: dict[str, str], lang: str,
                   starts: dict[str, str] | None = None, other_sense: str | None = None):
    """gen_phrase on the line, headless. `other_sense`: the JSON file of each hidden word's
    words of another sense (`sense`), taken off its map (`--other-sense`)."""
    cmd = ["uv", "run", "scripts/gen_phrase.py", sentence, "--lang", lang, "--words", *words]
    if other_sense:
        cmd += ["--other-sense", other_sense]
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


class Unbuildable(Exception):
    """A line that cannot be built as its words were chosen: a fact against the trio found
    on the map at hand (`rules.trio_faults`), or no start giving one of its words a path
    (`llm.pick_starts`). Nothing is swapped (user-decided 2026-10-20): a line is built with
    the words it was chosen with, or not at all. `word`: the hidden word `why` is about when
    that is one of the two chosen against the main word — the bank's start step chooses again
    in its place; None for the main word or the trio, which no choice can mend."""

    def __init__(self, why: str, word: str | None = None):
        super().__init__(f"« {word} »: {why}" if word else why)
        self.why, self.word = why, word


_sidecar = shelf_mod.sidecar_path


def generate(claude: llm.Claude, log: Log, line: dict, checked: "Checked", source: dict, lang: str, *,
             sims: Vectors, pairs: dict[str, set[str]], prior: dict[str, str] | None = None):
    """The line built with its three words, each hole's map its LINE map (`line_map`: the
    words of another sense its line was found to use handed to gen_phrase as
    `--other-sense`, from `runs/<stamp>.spoilers.other-sense.json`): returns the written puzzle path, or
    None with the reason logged. The forms are answered by the model as gen_phrase asks. With
    no starts yet, the first successful run only supplies the maps: the START WORDS are then
    chosen by the model on them (`choose_starts`, the main word's first) — or the line is
    found UNBUILDABLE there, and the draft is erased, nothing swapped — and the puzzle is
    regenerated with the starts. A banked line's starts (`prior`, secret slug -> word) were
    chosen on the line maps: they go on the FIRST run and are never chosen again; a start
    gen_phrase refuses, or one the written map no longer holds in its band, or a fact
    against the trio there (`banked_fault`, code alone) means it was not the map the line was
    banked on — the line is not built.
    Every result is checked (the displayed sentence must be valid in its language) and a
    refused start re-picked, at most START_ROUNDS times. The command logged names the
    sidecar gen_phrase writes beside the puzzle, so it replays."""
    sentence, words = line["sentence"], [t.text for t in checked.trio]
    # keyed by the hidden words: a spoiler, named as one beside the blind run's readable log
    other = _paths.RUNS_DIR / f"{log.stamp}.spoilers.other-sense.json"
    _paths.RUNS_DIR.mkdir(parents=True, exist_ok=True)
    other.write_text(json.dumps({t.slug: line["senses"][t.slug]["off"] for t in checked.trio},
                                ensure_ascii=False, sort_keys=True), encoding="utf-8")
    forms: dict[str, str] = {}
    starts: dict[str, str] = {}
    tried: dict[str, set[str]] = {}  # every start a hole has shown, secret slug -> words
    cleared: dict[str, set[str]] = {}  # the starts the idea check passed, secret slug -> words
    chosen = bool(prior)
    if prior:
        _adopt(starts, tried, prior)
        log("- start words as banked, on the maps they were chosen on: "
            + ", ".join(f"« {prior[t.slug]} » for « {t.text} »" for t in checked.trio))
    rounds = 0
    prev = None
    for _ in range(MAX_GEN_RUNS + st.START_ROUNDS + 1):
        completed, cmd = run_gen_phrase(sentence, words, source, forms, lang, starts, other_sense=str(other))
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
            prev = path
            if not chosen:
                chosen = True
                try:
                    picked = choose_starts(claude, log, path, line, checked, forms, sims, pairs, lang=lang)
                except Unbuildable as raised:
                    log(f"- on the written map, the line cannot be built: {raised}")
                    picked = None
                if picked is None:
                    # A line found unbuildable, or a partial or unusable answer, cannot leave
                    # gen_phrase's random band pick in a candidate day. The model must choose all three.
                    Path(path).unlink(missing_ok=True)
                    Path(_sidecar(path)).unlink(missing_ok=True)
                    return None
                if picked:
                    _adopt(starts, tried, picked)
                    continue
            elif prior and not rounds:
                fault = banked_fault(path, line, checked, prior, sims, pairs, lang=lang)
                if fault:
                    log(f"- on the written map, {fault}: not the map the line was banked on — rebank it")
                    Path(path).unlink(missing_ok=True)
                    Path(_sidecar(path)).unlink(missing_ok=True)
                    return None
            if rounds < st.START_ROUNDS:
                repick = check_starts(claude, log, path, line, checked, tried, sims, pairs, lang=lang,
                                      cleared=cleared, last=rounds == st.START_ROUNDS - 1)
                if repick:
                    _adopt(starts, tried, repick)
                    rounds += 1
                    continue
            # the sidecar beside the puzzle, not the run's file: the command replays the same maps
            shown = [_sidecar(path) if flag == "--other-sense" else c for flag, c in zip([None, *cmd], cmd)]
            log(f"- gen:phrase command: `{' '.join(_quote(c) for c in shown[2:])}`")
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
        refused = _START_REFUSED.search(err)
        if prior and not rounds and refused:
            # A banked start that is no key of its map: the maps moved since the line was banked.
            log(f"- gen:phrase refused the banked start « {refused.group(1)} »: the maps moved since "
                "the line was banked — rebank it")
            return None
        log(f"- gen:phrase refused: {err.splitlines()[0] if err else completed.stdout[-300:]}")
        return None
    log("- gen:phrase: too many form rounds")
    return None


def _adopt(starts: dict[str, str], tried: dict[str, set[str]], picked: dict[str, str]) -> None:
    for key, word in picked.items():
        starts[key] = word
        tried.setdefault(key, set()).add(word)


def _load(path) -> tuple[dict, dict[str, dict]]:
    """A written puzzle (its path, or an in-memory draft: `static_draft`), and the first
    hole of each secret by its slug (a repeated secret is one hole per occurrence, sharing
    one start)."""
    puzzle = path if isinstance(path, dict) else json.loads(Path(path).read_text(encoding="utf-8"))
    by_secret: dict[str, dict] = {}
    for h in puzzle["holes"]:
        by_secret.setdefault(h["secret"]["slug"], h)
    return puzzle, by_secret


def _hole(t: rules.Token, checked: "Checked") -> dict:
    """One hidden word as the start step reads it: its role, its path, and its ladder when it
    is one of a wide kind."""
    return {"slug": t.slug, "role": "main" if t.slug == checked.trio[0].slug else "other",
            "path": checked.paths[t.slug], "ladder": checked.ladders.get(t.slug)}


def _notes(ranks: dict, t: rules.Token, line: dict, checked: "Checked", sims: Vectors) -> str:
    """Code's notes for one hole as the start step reads them: what was measured, where the
    reader's nearest word lands in the hole's own map, and — when every reader's word lands
    far (`rules.far_note`) and the readers do not write the word itself — that the line
    gives little of it."""
    fillers, expected = line["measures"].readings[t.slug]
    nearest = rules.map_nearest_filler(ranks, t.slug, fillers)
    land = ("" if nearest is None else
            f"; the reader's nearest word « {nearest[0]} » sits at rank "
            f"{nearest[1] if nearest[1] is not None else 'beyond the map (10000+)'} in this hole's map")
    notes = checked.context[t.slug] + land
    far = rules.far_note(nearest)
    if far and not rules.reader_writes(t, expected, neighbour_rank=sims.neighbour_rank,
                                       frequency_rank=sims.frequency_rank):
        notes += "; " + far
    return notes


def _unbuildable(trio: list, faults: dict) -> None:
    """Raises Unbuildable for the first fact against the trio (`rules.trio_faults`): the main
    word's, then each other word's (named, for the bank to choose again), then the three's."""
    if faults["main"]:
        raise Unbuildable(f"the main word « {trio[0].text} »: {faults['main']}")
    for t in trio[1:]:
        if t.slug in faults["others"]:
            raise Unbuildable(faults["others"][t.slug], word=t.text)
    if faults["trio"]:
        raise Unbuildable("; ".join(faults["trio"]))


def banked_fault(path, line: dict, checked: "Checked", prior: dict[str, str], sims: Vectors,
                 pairs: dict[str, set[str]], *, lang: str) -> str | None:
    """Why a banked line's starts (`prior`, secret slug -> word) do not stand on the puzzle
    gen_phrase wrote, read in code alone: a start no longer in its hole's band
    (`starts.start_candidates`; a start played since banking is `check_starts`' to trade),
    or a fact against the trio on the written maps with the bands `choose_starts` would show
    (`facts_of`). The starts were chosen on the curator's walk of each word (`line_map`),
    which confirms no form: for a word with two dictionary entries (« marche », noun or
    verb) gen_phrase claims the confirmed entry's other forms too, and every rank after them
    moves. None when the starts stand."""
    puzzle, by_secret = _load(path)
    bands = {}
    for t in checked.trio:
        band = st.start_candidates(puzzle["ranks"][t.slug], t.slug, st.previous_token(puzzle["words"], by_secret[t.slug]),
                                   index_of=sims.index_of, lang=lang)
        if prior.get(t.slug) not in {o["word"] for o in band}:
            return f"the start « {prior.get(t.slug)} » for « {t.text} » is no longer in its band"
        bands[t.slug] = [o for o in band if o["word"] not in pairs.get(t.slug, ())]
    _facts, faults = facts_of(line, checked.trio, checked.paths, sims, puzzle["ranks"], bands)
    try:
        _unbuildable(checked.trio, faults)
    except Unbuildable as raised:
        return f"the line cannot be built: {raised}"
    return None


def choose_starts(claude: llm.Claude, log: Log, path, line: dict, checked: "Checked", forms: dict[str, str],
                  sims: Vectors, pairs: dict[str, set[str]], *, lang: str) -> dict[str, str] | None:
    """The model picks the three start words by the taste (`llm.pick_starts`): the main word's
    first, by the line's kind, then the two others'. Each hole's band is the map's (clean by
    the language's letter rule, its word not too rare by the corpus order, never a start this
    secret was played with before — `pairs`, the archive's permanent blacklist — nearest
    first), shown with the sentence, each slot's form, each word's role, path and ladder, and
    code's notes with where the reader's words land in the hole's own map. Before any
    question, the trio's facts on this map (`rules.trio_faults`: its main word handed on the
    map, two words handed, a word with no start in its band…): any raises Unbuildable; so does
    a word the model finds no start for. Returns None when the model gives no complete trio
    of valid starts; a random generator pick must not become the day."""
    puzzle, by_secret = _load(path)
    words, holes = puzzle["words"], puzzle["holes"]
    bands = {t.slug: st.start_candidates(puzzle["ranks"][t.slug], t.slug, st.previous_token(words, by_secret[t.slug]),
                                          exclude=pairs.get(t.slug, ()), index_of=sims.index_of, lang=lang)
             for t in checked.trio}
    _facts, faults = facts_of(line, checked.trio, checked.paths, sims, puzzle["ranks"], bands)
    _unbuildable(checked.trio, faults)
    marked = st.displayed(words, holes, {k: f"[{h['secret']['word']}]" for k, h in by_secret.items()})
    info = []
    for t in checked.trio:
        h = by_secret[t.slug]
        notes = _notes(puzzle["ranks"][t.slug], t, line, checked, sims)
        log(f"- notes for « {h['secret']['word']} »: {notes}")
        info.append({**_hole(t, checked), "secret": h["secret"]["word"], "options": bands[t.slug], "notes": notes,
                     "slot": f"form {forms.get(h['secret']['word'], '?')}, after « {st.previous_token(words, h) or '—'} »"})
    kind = line["read"]["kind"]
    answer = llm.pick_starts(claude, marked, info, kind, lang=lang)
    if answer["unsaveable"]:
        named = by_secret[answer["unsaveable"]]["secret"]["word"]
        why = "no start in its band gives it a path" + (f": {answer['why']}" if answer["why"] else "")
        if answer["unsaveable"] == checked.trio[0].slug:
            raise Unbuildable(f"the main word « {named} »: {why}")
        raise Unbuildable(why, word=named)
    picked = dict(answer["starts"])
    # A hole the answer left without a valid start — usually a word not written exactly as
    # listed — is asked again, ALONE, once, with the other starts in place and every other
    # hole's notes: the day and its map are worth one more question. Only a hole still without a model-chosen start
    # refuses the draft; gen_phrase's random band pick never stays.
    for h in info:
        if h["slug"] in picked:
            continue
        log(f"- no valid start named for « {h['secret']} »; asked again")
        marked_one = st.displayed(words, holes, {**picked, h["slug"]: "[____]"})
        choice = llm.pick_start(claude, marked_one, h, h["options"], refused="the answer named no candidate for it",
                                kind=kind, lang=lang,
                                others=[{"secret": o["secret"], "role": o["role"], "start": picked.get(o["slug"]),
                                         "notes": o["notes"]} for o in info if o is not h])
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


def _rank_of(rank_map: dict, word: str) -> int | None:
    """Where a display word stands on a hole's map, None when it is not on it."""
    return next((e["rank"] for e in rank_map.values() if e.get("word") == word), None)


def check_starts(claude: llm.Claude, log: Log, path, line: dict, checked: "Checked", tried: dict[str, set[str]],
                 sims: Vectors, pairs: dict[str, set[str]], *, lang: str,
                 cleared: dict[str, set[str]] | None = None, last: bool = False) -> dict[str, str]:
    """The displayed sentence with its start words: a start this secret was already
    played with (`pairs`), then the model reading the sentence (`llm.sentence_check`:
    correct, and still meaning something), then — once it reads right — the FIRST idea in the
    sentence of the main word's start and of the start of each word of a wide kind
    (`llm.start_ideas`: one its hidden word shares, or a riddle). Returns
    {secret slug: new start} for every faulty hole (empty = all good, or nothing better
    to offer). `tried` holds every start a hole has shown so far; none is offered again.
    `cleared` (secret slug -> starts, kept across rounds) holds the starts the idea check
    passed, never asked again; on the `last` round a riddle is logged for the reviewer
    rather than traded for a start no check would read; a riddle never sets a line aside.
    The re-pick reads the day as `pick_starts` does: the hole's role, path and notes with
    where the reader's nearest word lands, and every other hole's notes and shown start."""
    cleared = cleared if cleared is not None else {}
    puzzle, by_secret = _load(path)
    words, holes = puzzle["words"], puzzle["holes"]
    shown = st.displayed(words, holes)
    of = {t.slug: t for t in checked.trio}
    notes = {k: _notes(puzzle["ranks"][k], of[k], line, checked, sims) for k in by_secret}
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
            # of the main word, whose path the day rests on, and of each word of a wide kind,
            # whose start must name a smaller family (user-decided 2026-10-20) — not of every
            # hole: asked of every hole of the user's loved days, the check called 17 of their
            # 57 starts riddles.
            asked = {key: h for key, h in by_secret.items()
                     if (key == checked.trio[0].slug or key in checked.ladders)
                     and h["start"]["word"] not in cleared.get(key, ())}
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
                                      index_of=sims.index_of, lang=lang)
        if not options:
            log(f"- no other start in the band for « {h['secret']['word']} » — left to the reviewer")
            continue
        # the day as it now stands: a hole re-picked earlier in this round shows its new start
        marked = st.displayed(words, holes, {**repick, key: "[____]"})
        choice = llm.pick_start(claude, marked, {**_hole(of[key], checked), "secret": h["secret"]["word"],
                                                 "notes": notes[key]},
                                options, refused=problem, kind=line["read"]["kind"], lang=lang,
                                others=[{"secret": o["secret"]["word"], "role": _hole(of[k], checked)["role"],
                                         "start": repick.get(k, o["start"]["word"]), "notes": notes[k]}
                                        for k, o in by_secret.items() if k != key])
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
    day comes later, chosen by the user — and returns None once the shelf is spent."""
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
    """Jev's sentence pre-filter: every candidate is scored — stands alone,
    carries an image or a turn, not a famous line — and the loose filter removes what the
    model should not have to read (about half a novel: lines hanging on a name or a
    pronoun, the flat ones). Reading order is kept: the model reads everything left
    (2026-09-24 — ordering by the image score favoured description and cut what the model
    never saw). The judge asks its questions in the line's language."""
    if not sentences:
        return []
    try:
        scores = jev.score_sentences(judge, sentences, lang=lang)
    except jev.JevError as exc:
        die(f"sentence judge: {exc}")
    kept = [s for s, sc in zip(sentences, scores) if jev.sentence_passes(sc)]
    log(f"- judged by Jev: {len(kept)} of {len(sentences)} pass the sentence filter "
        f"(stand alone ≥ {jev.SENTENCE_ALONE_MIN}, image ≥ "
        f"{jev.SENTENCE_IMAGE_MIN}, famous ≤ {jev.SENTENCE_FAMOUS_MAX}) "
        f"({judge.usage['input_tokens']} input tokens)")
    return kept


def giveaway_scores(tokens, words, occurrences, lang: str, judge) -> dict[str, float]:
    """How much the sentence hands each word over, by the judge's measure
    (`jev.giveaway`), read on real play (84 holes): under `GIVEAWAY_MIN` the
    line gives no path to the word and it is never hidden; under `GIVEAWAY_HARD` the hole
    plays hard (a note the start step reads); at or above `GIVEAWAY_MAX` a third of the players
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
            scores[t.slug] = jev.giveaway(judge, shown, t.text.lower(), lang=lang)
        except jev.JevError as exc:
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
    test, the crowd — asked once, whatever trio the line ends with; and, around each of its
    holes (a repeated word is one hole per occurrence), the first word the words right
    around it call for, with the fragment it was asked on: the other hidden words cut a
    fragment, and a fragment that changes is asked again."""
    readings: dict = field(default_factory=dict)  # slug -> (the reader's words, the one most write)
    says: dict = field(default_factory=dict)      # slug -> (would-say chance, the word said instead)
    crowds: dict = field(default_factory=dict)    # slug -> crowd share
    frames: dict = field(default_factory=dict)    # slug -> [(the words around one hole, the first word written)]


@dataclass
class Checked:
    """A line's three words once every check on their maps passed: the MAIN word first,
    then the two chosen against it; each word's path — how the line leads to it, and the
    words of the line it runs through — and its ladder when it is one of a wide kind; code's
    notes for the start step, and each word's facts in a few words (the comparison's and
    the bank's)."""
    trio: list
    paths: dict    # slug -> {"line": str, "words": [the words of the line the path runs through]}
    ladders: dict  # slug -> its ladder, for a word of a wide kind
    context: dict  # slug -> code's notes
    tags: dict     # slug -> [its facts]


def new_line(sentence: str, tokens: list, allowed: list, given: dict | None = None) -> dict:
    """A line as the curator works on it: its tokens, the words it can hide (`allowed`, what
    its words are chosen from), the judge's giveaways, what each word was measured at, each
    chosen word's other-sense check (`senses`, slug -> `sense`'s verdict), and the question
    for the two words against the main word — what was told back, the asks spent."""
    return {"sentence": sentence, "tokens": tokens, "allowed": allowed, "given": given or {}, "pathless": [],
            "measures": Measures(), "senses": {}, "told": [], "asks": 0}


def day(claude: llm.Claude, log: Log, ranked: list[dict], book: dict, archive: dict, text: str, in_vocab,
        lang: str, tried: list[str] | None = None, *, judge, sims: Vectors):
    """The day, chosen among FINISHED candidates (user-decided 2026-10-13): the
    shortlist's lines, CANDIDATES at a time, are each prepared on their own (`prepare`),
    the model compares the lines that survived and the first is built, and when it
    cannot be, the next (`compare_and_build`). Then the next lines. Every line prepared
    goes into `tried`. Returns the written puzzle path, or None."""
    tried = tried if tried is not None else []
    for batch_start in range(0, len(ranked), CANDIDATES):
        days, _aside = prepare(claude, log, ranked[batch_start:batch_start + CANDIDATES], archive, in_vocab, lang,
                               tried, judge=judge, sims=sims)
        if not days:
            continue
        path = compare_and_build(claude, log, days, book, archive, text, lang, sims=sims)
        if path:
            return path
    log("- no day: every line was declined or refused")
    return None


def prepare(claude: llm.Claude, log, picks: list[dict], archive: dict, in_vocab, lang: str, tried: list[str],
            *, judge, sims: Vectors) -> tuple[list[tuple[dict, "Checked"]], list[dict]]:
    """Each line FINISHED on its own, up to its start words (`candidate`): READ first, then the
    judge's giveaway paid for the words it can hide, then its main word measured alone and
    two words chosen against it. Returns the lines that survived, each with its checked trio,
    and the lines SET ASIDE, each with its read, the giveaways paid, what was measured and
    why (`line["dropped"]`); every line prepared goes into `tried`."""
    lines = []
    for pick in picks:
        tokens = parse(pick["sentence"], lang)
        allowed = rules.initial_candidates(tokens, lang=lang, in_vocab=in_vocab,
                                           past_secrets=archive["secrets"], frequency_rank=sims.frequency_rank)
        if len({t.slug for t in allowed}) < rules.TRIO:
            log(f"\n## « {pick['sentence']} »\n- skipped: fewer than {rules.TRIO} words can be hidden")
            continue
        lines.append(new_line(pick["sentence"], tokens, allowed))
    if not lines:
        return [], []
    tried.extend(x["sentence"] for x in lines)
    log(f"\n## Preparing {len(lines)} line(s): each read, then its words chosen, the main word first")

    def one(line):
        buffer = Buffer()
        return buffer, candidate(claude, buffer, line, archive["pairs"], lang, judge=judge, sims=sims)

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
    return days, [line for line in lines if line.get("dropped")]


def compare_and_build(claude: llm.Claude, log: Log, days: list[tuple[dict, "Checked"]], book: dict,
                      archive: dict, text: str, lang: str, *, sims: Vectors) -> str | None:
    """The model compares finished lines, each as the player will get it — its kind, its main
    word and the two chosen against it, what leads to each and its facts — and orders them;
    the first is built (`build_day`: page, puzzle, start words), and when it cannot be, the
    next. Returns the written puzzle path, or None."""
    source_base = {"kind": book["kind"], "author": book.get("author", ""), "work": book.get("title", "")}
    shown = []
    for line, c in days:
        occurrences = _occurrences(line["allowed"])
        shown.append({"marked": llm.marked(line["tokens"], {i for t in c.trio for i in occurrences[t.slug]},
                                           lang=lang),
                      "kind": line["read"]["kind"],
                      "words": [{"word": t.text, "path": c.paths[t.slug]["line"],
                                 "path_words": c.paths[t.slug]["words"], "tags": c.tags[t.slug]} for t in c.trio]})
    log(f"\n## Comparing {len(days)} finished line(s)")
    for n, d in enumerate(shown, 1):
        log(f"{n}. « {d['marked']} » — {llm.kind_text(d['kind'])}; "
            + "; ".join(w["word"] + (f" ({', '.join(w['tags'])})" if w["tags"] else "") for w in d["words"]))
    choice = llm.choose_among(claude, shown, lang=lang)
    if not choice or not choice["order"]:
        log("- the model declines these lines" + (f" — {choice['why']}" if choice and choice["why"] else ""))
        return None
    log(f"- order: {', '.join(str(n + 1) for n in choice['order'])} — {choice['why']}")
    for n in choice["order"]:
        line, checked = days[n]
        log(f"\n## Building « {line['sentence']} »")
        path = build_day(claude, log, line, checked, book, archive, text, source_base, lang, sims=sims)
        if path:
            return path
        log("- it could not be built: the next line in the order")
    return None


def read(claude: llm.Claude, log, line: dict, lang: str) -> tuple[dict | None, str | None]:
    """The line READ before anything is paid for (`llm.read_line`: the taste and the skill's
    `## Stands alone`, read whole), the words it can hide (`line["allowed"]`) shown. The
    verdicts are the model's; code applies them in order (`strike`): a line that does not
    stand alone, names no main word, whose main word needs the work, is one of a wide kind
    whose ladder misses a step (a lottery), is the partner of a visible word (a mirror), or
    leaves the joke readable once it is hidden, is SET ASIDE. A reading code tells back — a
    kind none of `llm.KINDS`, a main word the line cannot hide, a path through words not in
    sight (`told_back`) — is asked again, READ_ROUNDS times in all. A line with no kind is
    kept (the bank lists it under No kind). Returns (the read, None) for a line kept, (the
    read or None, why) for a line set aside."""
    hideable = list(dict.fromkeys(t.text for t in line["allowed"]))
    refused: list[str] = []
    for _ in range(READ_ROUNDS):
        r = llm.read_line(claude, line["sentence"], hideable, refused, lang=lang)
        problem = ("its kind must be a number from 1 to 7, or null" if r is None
                   else None if not r["stands_alone"] or r["anchor"] is None else told_back(r, line))
        if problem is None:
            if r["anchor"] is not None:
                r["path_words"] = content_path(r["path_words"], line)
            _log_read(log, r)
            return r, strike(r)
        log(f"- told back: {problem}")
        refused.append(problem)
    return None, f"no usable reading in {READ_ROUNDS} asks ({refused[-1]})"


def told_back(read: dict, line: dict) -> str | None:
    """What code tells back of a reading that names a main word: one the line cannot hide,
    or a path that does not run through 1 to 3 of the line's own words left in sight
    (`path_off`). None when it holds."""
    anchor = slug(read["anchor"])
    if anchor not in {t.slug for t in line["allowed"]}:
        return f"« {read['anchor']} » is not one of the words that can be hidden"
    return path_off(read["path_words"], line, anchor, "the main word")


def path_off(words: list[str], line: dict, own: str, name: str) -> str | None:
    """What code tells back of a path said to run through `words`: not 1 to 3 of the line's
    own words — never a sign, nor the hidden word itself (`own`, its slug; `name`, how the
    question calls it) — its stop words passed over (`content_path`). None when it holds."""
    sight = {t.slug for t in line["tokens"] if not t.stop and t.pos != "PUNCT" and t.slug != own}
    words = content_path(words, line)
    off = [w for w in words if slug(w) not in sight]
    if not 1 <= len(words) <= 3 or off:
        return (f"its path must run through 1 to 3 words of the line left in sight, never {name}"
                + (f": {', '.join(f'« {w} »' for w in off)} is not one" if off else ""))
    return None


def content_path(words: list[str], line: dict) -> list[str]:
    """A path's words but the line's stop words (« up », « part », « certain »: the parser's
    list, which the model cannot know) — always in sight, a stop word never locks a pair
    (`rules.trio_faults`), so the path is checked and kept without it."""
    stops = {t.slug for t in line["tokens"] if t.stop} - {t.slug for t in line["tokens"] if not t.stop}
    return [w for w in words if slug(w) not in stops]


def strike(read: dict) -> str | None:
    """Why the reading sets the line aside, the model's verdicts taken in order; None when the
    line is kept."""
    if not read["stands_alone"]:
        return f"does not stand alone: {read['why']}"
    anchor = read["anchor"]
    if anchor is None:
        return "no word the line is about has a path"
    if slug(anchor) in {slug(w) for w in read["needs_book"]}:
        return f"its main word « {anchor} » needs the work to mean anything"
    if read["wide"]:
        missing = next((LOTTERY[step] for step in llm.LADDER if not (read["ladder"] or {}).get(step)), None)
        if missing:
            return f"a lottery: « {anchor} » is one of a wide kind, and {missing}"
    if read["mirror"]:
        return f"a mirror: « {anchor} » is the partner of a visible word, the first word players would type"
    if not read["joke_hidden"]:
        return "the joke reads with the main word hidden"
    return None


def _log_read(log, read: dict) -> None:
    if read["about"]:
        log(f"- read: {read['about']}")
    if read["needs_book"]:
        log(f"  - needs the work: {', '.join(f'« {w} »' for w in read['needs_book'])}")
    if not read["stands_alone"] or read["anchor"] is None:
        return
    log(f"  - {llm.kind_text(read['kind'])}; main word « {read['anchor']} » — {read['path']} (through "
        f"{', '.join(f'« {w} »' for w in read['path_words'])})")
    if read["wide"]:
        log(f"  - one of a wide kind: {llm.ladder_text(read['ladder'])}")
    if read["sibling"]:
        log(f"  - sibling: « {read['sibling']} » makes the same joke (a warning)")


def floor(line: dict, read: dict, lang: str, judge) -> str | None:
    """The judge's giveaway, paid once the line is read, for the words it can hide but those
    the read says need the work (they leave the pool): a word under `GIVEAWAY_MIN` is one the
    line gives no path to, never hidden. Sets the line's `given`, `pathless` and `allowed`;
    returns why the line is set aside — no clue to its main word, or fewer than TRIO words left
    — or None."""
    book = {slug(w) for w in read["needs_book"]}
    allowed = [t for t in line["allowed"] if t.slug not in book]
    given = giveaway_scores(line["tokens"], allowed, _occurrences(allowed), lang, judge)
    line["given"] = given
    line["pathless"] = list(dict.fromkeys(f"{t.text} ({rules.two_places(given[t.slug])})" for t in allowed
                                          if given[t.slug] < jev.GIVEAWAY_MIN))
    line["allowed"] = [t for t in allowed if given[t.slug] >= jev.GIVEAWAY_MIN]
    anchor = slug(read["anchor"])
    if given[anchor] < jev.GIVEAWAY_MIN:
        return (f"no clue: the line gives no path to its main word « {read['anchor']} » "
                f"({rules.two_places(given[anchor])}, under {jev.GIVEAWAY_MIN})")
    if len({t.slug for t in line["allowed"]}) < rules.TRIO:
        return f"fewer than {rules.TRIO} words can be hidden (no path to {', '.join(line['pathless'])})"
    return None


def set_aside(log, line: dict, why: str) -> None:
    """The line goes no further: why is logged, and kept with it for the bank (`line["dropped"]`)."""
    log(f"- set aside: {why}")
    line["dropped"] = why


def candidate(claude: llm.Claude, log, line: dict, pairs: dict[str, set[str]], lang: str, *, judge,
              sims: Vectors) -> Checked | None:
    """One line made a candidate day: it is READ first (`read`), then the judge's giveaway is
    paid for the words it can hide (`floor`), then its words are chosen, the main word first
    (`choose_trio`). A line set aside on the way goes no further, its read on `line["read"]`
    and why on `line["dropped"]`. Returns the checked trio, or None."""
    log(f"\n## « {line['sentence']} »")
    line["read"], why = read(claude, log, line, lang)
    if why is None:
        why = floor(line, line["read"], lang, judge)
        if line["pathless"]:
            log(f"- no path to {', '.join(line['pathless'])}")
    if why is not None:
        set_aside(log, line, why)
        return None
    return choose_trio(claude, log, line, sims, pairs, lang)


def choose_trio(claude: llm.Claude, log, line: dict, sims: Vectors, pairs: dict[str, set[str]],
                lang: str) -> Checked | None:
    """A read line's three words, chosen as the user chooses them by hand: its MAIN word —
    the read's — measured alone and refused by any fact against it (`anchor_gate`: the line
    then has no day, the main word is never swapped), then two words chosen against it
    (`choose_others`). A line either sets aside is kept with why (`line["dropped"]`)."""
    anchor, why = anchor_gate(claude, log, line, sims, pairs, lang)
    if why:
        set_aside(log, line, why)
        return None
    return choose_others(claude, log, line, anchor, sims, pairs, lang)


def measure(claude: llm.Claude, line: dict, t, hidden: set[int], sims: Vectors, lang: str) -> None:
    """One hidden word measured, each measure asked once for the line (`line["measures"]`):
    what a reader puts in its blank and whether a player who has the meaning would say it —
    its other occurrences hidden, the rest of the line intact — and its crowd of commoner
    near-words; and, around EACH of its holes, the first word the words right around it call
    for, the other hidden words (`hidden`, token indices) cutting that fragment: asked again
    only when they change it."""
    m, tokens = line["measures"], line["tokens"]
    occurrences = _occurrences(line["allowed"])[t.slug]
    own = occurrences - {t.i}
    if t.slug not in m.readings:
        m.readings[t.slug] = llm.context_guesses(claude, tokens, own, t.i, rules.CONTEXT_GUESSES, lang=lang)
    if t.slug not in m.crowds:
        m.crowds[t.slug] = sims.crowd(t)
    if t.slug not in m.says:
        ask = lambda: llm.would_say(claude, tokens, own, t.i, t.text.lower(), lang=lang)
        chance, instead = ask()
        # In a crowd the verdict turns on would-say near its bar, where one answer
        # wobbles: a second is asked and the two averaged.
        if chance is not None and m.crowds[t.slug] is not None and m.crowds[t.slug] >= rules.BURIED_CROWD:
            again, _ = ask()
            chance = chance if again is None else round((chance + again) / 2, 3)
        m.says[t.slug] = (chance, instead)
    asked, frames = dict(m.frames.get(t.slug, ())), []
    for i in sorted(occurrences):
        around = rules.neighbourhood(tokens, i, occurrences | hidden)
        fragment = llm.holed(around, set(), i, lang=lang).replace("[____]", "___")
        if fragment not in asked:
            asked[fragment] = llm.neighbours_complete(claude, fragment, lang=lang)
        frames.append((fragment, asked[fragment]))
    m.frames[t.slug] = frames


def sense(claude: llm.Claude, log, line: dict, t, sims: Vectors, lang: str) -> dict | None:
    """Which of a hidden word's nearest words are near it only through ANOTHER dictionary
    sense than the one its line uses (user-decided 2026-10-21: "the main goal is actually to
    eliminate irrelevant meanings of a word"), asked once per word per line (`line["senses"]`,
    kept in the bank). The model is shown the first SENSE_TOP words of the word's plain map,
    closest first, each group once (`llm.other_sense`), and names those; while a round names
    SENSE_DIG or more and fewer than SENSE_ROUNDS were asked, the next round shows the first
    SENSE_TOP words of the plain map still there once every word named so far is taken off —
    a round naming n words brings n new words into view, and the near words kept are shown
    again, so the second look catches what the first missed (shown only new words, the
    first round's misses stayed on top: « creator » for God, god 12th → 37th). The first
    round also says which sense the line uses, and EVERY round whether the map CARRIES it: false
    when the line uses a sense its map barely holds (« partir » for dying on a map of leaving),
    so no start leads a player there. The first round that says so ends the asking and the
    word is not carried — the later rounds, shown a list already cleared, grew lenient (on 158
    played holes they passed « partir » for dying "though mourir and décéder are absent"). The
    words named leave the word's map (`line_map`): a word off the map reads as far to a player,
    and the line's own sense keeps the plain order (on 158 played holes, the words named
    touched no one-meaning word). Returns {"used", "carried", "why", "off": [the words named,
    in order]}; None when an answer is still unusable once asked again — no verdict, and the
    word is never hidden unchecked. A word with no plain map is not asked: nothing to take
    off, and its facts refuse it (no start in its band)."""
    senses = line.setdefault("senses", {})
    if t.slug in senses:
        return senses[t.slug]
    rank_map = sims.static_map(t)
    order = [] if rank_map is None else list(dict.fromkeys(
        e["word"] for e in sorted((e for e in rank_map.values() if e["rank"] >= 1), key=lambda e: e["rank"])))
    if not order:
        return {"used": "", "carried": True, "why": "", "off": []}
    off: list[str] = []
    first = verdict = None
    for n in range(SENSE_ROUNDS):
        window = [w for w in order if w not in off][:SENSE_TOP]
        if not window:
            break
        ask = lambda: llm.other_sense(claude, line["sentence"], t.text, window, lang=lang, off=tuple(off))
        answer = ask() or ask()  # an unusable answer is asked once more
        if answer is None:
            log(f"- other sense of « {t.text} »: no usable answer, asked twice")
            return None
        first = first or answer
        verdict = answer
        off += answer["words"]
        if (n == 0 and not answer["other"]) or not answer["carried"] or len(answer["words"]) < SENSE_DIG:
            break
    senses[t.slug] = {"used": first["used"], "carried": verdict["carried"], "why": verdict["why"], "off": off}
    log(f"- other sense of « {t.text} »: the line uses it as {first['used']}; "
        + (f"{len(off)} word(s) of another sense set aside ({', '.join(off[:5])}{', …' if len(off) > 5 else ''})"
           if off else "no word of another sense set aside")
        + ("" if verdict["carried"] else " — its map barely carries that sense"))
    return senses[t.slug]


def _uncarried(claude: llm.Claude, log, line: dict, t, sims: Vectors, lang: str) -> str | None:
    """Why a hidden word cannot be hidden in its line by its other-sense check (`sense`): its
    map barely carries the sense the line uses, or no verdict came; None when it can."""
    verdict = sense(claude, log, line, t, sims, lang)
    if verdict is None:
        return "no verdict on the sense the line uses it in (no usable answer, asked twice)"
    if not verdict["carried"]:
        return (f"the line uses it as {verdict['used']}, a sense its map barely carries"
                + (f" — {verdict['why']}" if verdict["why"] else ""))
    return None


def line_map(line: dict, t, sims: Vectors) -> dict | None:
    """The map a hidden word is checked on, given its starts on and written with: its static
    map with the words of another sense its line was found to use taken off (`sense`), the
    map gen_phrase writes (`--other-sense`) — ONE map from the choice to the shipped puzzle,
    save for a word with two dictionary entries (« marche », noun or verb): this walk confirms
    no form, gen_phrase's claims the confirmed entry's other forms too, and the ranks after
    them move (`banked_fault` reads a banked line's starts again on the written map). The
    plain map for a word not asked yet (a word offered, not chosen). None without a map."""
    sensed = line.get("senses", {}).get(t.slug)
    return sims.static_map(t) if sensed is None else sims.static_map(t, frozenset(sensed["off"]))


def band_of(line: dict, t, sims: Vectors, pairs: dict[str, set[str]], lang: str) -> list[dict]:
    """The start words a word's band offers on its line map (`line_map`), as the start step
    would show them (`starts.start_candidates`: clean by the letter rule after the word
    before it, not too rare, never a start the secret was played with — `pairs`); empty when
    it has none, or no map."""
    draft = static_draft(line, [t], sims, lang)
    if draft is None:
        return []
    _, by_secret = _load(draft)
    return st.start_candidates(draft["ranks"][t.slug], t.slug, st.previous_token(draft["words"], by_secret[t.slug]),
                               exclude=pairs.get(t.slug, ()), index_of=sims.index_of, lang=lang)


def context_note(line: dict, t, sims: Vectors) -> str:
    """Code's notes on one measured word, as the model reads them: what a reader puts in its
    blank (`rules.reading`), how much the sentence hands it over — with its real-play meaning
    — whether a player who has the meaning says it, its crowd, and, under GIVEAWAY_HARD, that
    the line gives little of it."""
    m, given = line["measures"], line["given"][t.slug]
    guesses, expected = m.readings[t.slug]
    chance, instead = m.says[t.slug]
    note = rules.reading(t, guesses, expected, neighbour_rank=sims.neighbour_rank, frequency_rank=sims.frequency_rank)
    note += (f"; the sentence hands it over at {rules.two_places(given)} (on real play, "
             f"{jev.GIVEAWAY_MAX} and above was typed within three guesses by a third of the players)")
    note += "; " + rules.said(chance, instead, same=rules.same_word(t, instead, sims.own(t)))
    note += "; " + rules.crowd_note(m.crowds[t.slug])
    if given < jev.GIVEAWAY_HARD:
        note += (f"; under {rules.two_places(jev.GIVEAWAY_HARD)} {rules.GIVES_LITTLE} "
                 f"(such holes played hard on real play)")
    return note


def hole_facts(line: dict, t, path_words: list[str], sims: Vectors, rank_map: dict | None, band: list[dict],
               verdict: dict | None = None) -> rules.HoleFacts:
    """What code knows of one measured word (`measure`), on the map at hand (`rank_map`, None
    without one) with the starts its band offers (`band`), and — for a word chosen against the
    main word — the model's verdicts on it (`verdict`: {mirror, wide, ladder}; the main word's
    were the read's, and passed)."""
    m = line["measures"]
    guesses, expected = m.readings[t.slug]
    chance, instead = m.says[t.slug]
    own = sims.own(t)
    same = rules.same_word(t, instead, own)
    lottery = None
    if verdict and verdict["wide"]:
        lottery = next((LOTTERY[step] for step in llm.LADDER if not (verdict["ladder"] or {}).get(step)), None)
    return rules.HoleFacts(
        word=t.text, slug=t.slug, path_words=frozenset(slug(w) for w in path_words),
        reader_writes=rules.reader_writes(t, expected, neighbour_rank=sims.neighbour_rank,
                                          frequency_rank=sims.frequency_rank),
        neighbours=next((fragment for fragment, first in m.frames[t.slug] if rules.same_word(t, first, own)), None),
        map_handed=None if rank_map is None else rules.map_handed(rank_map, t.slug, expected),
        unsaid=not same and chance is not None and chance < rules.WOULD_SAY_HARD,
        buried=not same and rules.buried(chance, m.crowds[t.slug]),
        unmapped=None if rank_map is None else tuple(
            rules.unmapped(rank_map, t.slug, [*guesses, *filter(None, [expected])], sims.known) or ()) or None,
        band_empty=not band, mirror=bool(verdict and verdict["mirror"]), lottery=lottery)


def facts_of(line: dict, trio: list, paths: dict, sims: Vectors, ranks: dict, bands: dict,
             verdicts: dict | None = None) -> tuple[list[rules.HoleFacts], dict]:
    """The trio's facts, its main word first, on the maps at hand (`ranks`, slug -> map;
    `bands`, slug -> starts), and the faults they make (`rules.trio_faults`, the holes side by
    side read off the line)."""
    occurrences = _occurrences(line["allowed"])
    hidden = {i for t in trio for i in occurrences[t.slug]}
    holes = [hole_facts(line, t, paths[t.slug]["words"], sims, ranks.get(t.slug), bands[t.slug],
                        (verdicts or {}).get(t.slug)) for t in trio]
    return holes, rules.trio_faults(holes, rules.adjacent(line["tokens"], hidden))


def _tags(h: rules.HoleFacts, given: float, wide: bool) -> list[str]:
    """A word's facts in a few words, for the comparison and the bank."""
    return [tag for tag, on in (("readers write it in", h.reader_writes),
                                ("a word players don't say", h.unsaid),
                                ("the line gives little of it", given < jev.GIVEAWAY_HARD),
                                ("one of a wide kind", wide)) if on]


def anchor_gate(claude: llm.Claude, log, line: dict, sims: Vectors, pairs: dict[str, set[str]],
                lang: str) -> tuple[rules.Token | None, str | None]:
    """The MAIN word, named by the read, measured ALONE — only its own occurrences hidden —
    then its other sense asked (`sense`): a main word whose sense in the line its map barely
    carries, or with no verdict, sets the line aside. Then, on its line map (`line_map`), it
    is refused by any fact against it (`rules.trio_faults`: buried, unmapped, written in by
    the readers or by its neighbours, the reader's word at or under `rules.HANDED_RANK` on its
    map, no start in its band): the line then has no day, since the main word is never
    swapped. A word players don't say passes: the trio's one such word belongs there. Returns
    (the main word, None), or (None, why)."""
    read = line["read"]
    anchor = next(t for t in line["allowed"] if t.slug == slug(read["anchor"]))
    measure(claude, line, anchor, _occurrences(line["allowed"])[anchor.slug], sims, lang)
    log(f"- main word « {anchor.text} »: {context_note(line, anchor, sims)}")
    why = _uncarried(claude, log, line, anchor, sims, lang)
    if why:
        return None, f"the main word « {anchor.text} »: {why}"
    _holes, faults = facts_of(line, [anchor], {anchor.slug: {"line": read["path"], "words": read["path_words"]}}, sims,
                              {anchor.slug: line_map(line, anchor, sims)},
                              {anchor.slug: band_of(line, anchor, sims, pairs, lang)})
    if faults["main"]:
        return None, f"the main word « {anchor.text} »: {faults['main']}"
    return anchor, None


def refuse(log, line: dict, word: str, why: str) -> None:
    """A word chosen against the main word, refused: it leaves the words to choose from, and
    the next ask is told why."""
    line["allowed"] = [t for t in line["allowed"] if t.slug != slug(word)]
    line["told"].append(f"« {word} »: {why}")
    log(f"- « {word} » refused: {why}")


def choose_others(claude: llm.Claude, log, line: dict, anchor, sims: Vectors, pairs: dict[str, set[str]],
                  lang: str) -> Checked | None:
    """The two words chosen AGAINST the main word (`llm.choose_companions`, the user's own
    method): offered the words the line can hide with it, each with the starts its band
    offers on its line map (`band_of`): the PLAIN map for a word not yet asked its other
    sense — a word with none is not offered; asking every word offered would cost a call
    each, and the starts are chosen later, on the line maps — the main word's path, ladder and notes, and what was told back. Code checks the answer —
    two distinct words of those offered, each with a path through 1 to 3 of the line's words,
    else told back — then asks each word its other sense (`sense`): one whose sense in the
    line its map barely carries, or with no verdict, is refused (`refuse`: it leaves the
    words to choose from, the ask spent). Then it measures each word with the three hidden
    and reads their facts on the line maps (`line_map`, `rules.trio_faults`): one against
    another word refuses it; one against the three together is told back, nothing refused.
    The main word passed ALONE
    (`anchor_gate`): all that can now hold against it is its neighbours, cut by a word hidden
    among them, writing it in — that word is refused, never the main word. COMPANION_ASKS
    asks for the line in all (`line["asks"]`, the bank's start step included); a decline, or
    the asks spent, sets it aside. Returns the checked trio, the main word first, or None."""
    read = line["read"]
    occurrences = _occurrences(line["allowed"])
    # The words right around the main word's holes, measured alone: a word hidden among them
    # cuts its fragment.
    near = {u.i for i in occurrences[anchor.slug]
            for u in rules.neighbourhood(line["tokens"], i, occurrences[anchor.slug])}
    while line["asks"] < COMPANION_ASKS:
        firsts: dict = {}
        for t in line["allowed"]:
            firsts.setdefault(t.slug, t)
        bands = {s: band_of(line, t, sims, pairs, lang) for s, t in firsts.items()}
        pool = {s: t for s, t in firsts.items() if s != anchor.slug and bands[s]}
        if len(pool) < 2:
            set_aside(log, line, "fewer than two words with a start in their band can be hidden with the main word")
            return None
        line["asks"] += 1
        answer = llm.choose_companions(claude, llm.marked(line["tokens"], occurrences[anchor.slug], lang=lang), read,
                                       context_note(line, anchor, sims),
                                       [{"word": t.text, "options": bands[s]} for s, t in pool.items()],
                                       line["told"], lang=lang)
        if answer is None:
            problem = "the answer must name two of the words offered, each with its path and verdicts"
        elif answer["words"] is None:
            set_aside(log, line, "no two words go with the main word" + (f": {answer['why']}" if answer["why"] else ""))
            return None
        else:
            log(f"- against « {anchor.text} »: {' · '.join(w['word'] for w in answer['words'])} — {answer['why']}")
            for w in answer["words"]:
                log(f"  - « {w['word']} »: {w['path']} (through {', '.join(f'« {x} »' for x in w['path_words'])})"
                    + (f" — one of a wide kind: {llm.ladder_text(w['ladder'])}" if w["wide"] else "")
                    + (f"; when it lands: {w['lands']}" if w["lands"] else ""))
            named = [slug(w["word"]) for w in answer["words"]]
            if len(set(named)) < 2 or any(s not in pool for s in named):
                problem = ("two distinct words of those offered, never the main word: "
                           + ", ".join(f"« {w['word']} »" for w in answer["words"]))
            else:
                problem = next((f"« {w['word']} »: {off}" for w in answer["words"]
                                for off in [path_off(w["path_words"], line, slug(w["word"]), "the word itself")]
                                if off), None)
        if problem:
            log(f"- told back: {problem}")
            line["told"].append(problem)
            continue
        verdicts = {slug(w["word"]): {**w, "path_words": content_path(w["path_words"], line)} for w in answer["words"]}
        others = [pool[s] for s in verdicts]
        uncarried = {t.slug: why for t in others for why in [_uncarried(claude, log, line, t, sims, lang)] if why}
        for t in others:
            if t.slug in uncarried:
                refuse(log, line, t.text, uncarried[t.slug])
        if uncarried:
            continue
        trio = [anchor, *others]
        hidden = {i for t in trio for i in occurrences[t.slug]}
        for t in trio:
            measure(claude, line, t, hidden, sims, lang)
        paths = {anchor.slug: {"line": read["path"], "words": read["path_words"]},
                 **{s: {"line": w["path"], "words": w["path_words"]} for s, w in verdicts.items()}}
        holes, faults = facts_of(line, trio, paths, sims, {t.slug: line_map(line, t, sims) for t in trio},
                                 {t.slug: band_of(line, t, sims, pairs, lang) for t in trio}, verdicts)
        refused = dict(faults["others"])
        if faults["main"]:
            refused.update({t.slug: f"hidden too, it leaves the words right around the main word « {anchor.text} » "
                                    f"writing it in (« {holes[0].neighbours} »)"
                            for t in others if t.slug not in refused and occurrences[t.slug] & near})
        for t in others:
            if t.slug in refused:
                refuse(log, line, t.text, refused[t.slug])
        if faults["trio"]:
            told = f"« {' · '.join(t.text for t in others)} » against « {anchor.text} »: " + "; ".join(faults["trio"])
            log(f"- told back: {told}")
            line["told"].append(told)
        if faults["main"] or refused or faults["trio"]:
            continue
        ladders = {anchor.slug: read["ladder"]} if read["wide"] else {}
        ladders.update({s: w["ladder"] for s, w in verdicts.items() if w["wide"]})
        return Checked(trio, paths, ladders, {t.slug: context_note(line, t, sims) for t in trio},
                       {h.slug: _tags(h, line["given"][h.slug], h.slug in ladders) for h in holes})
    set_aside(log, line, f"no two words against the main word survived {COMPANION_ASKS} asks"
              + (f" ({line['told'][-1]})" if line["told"] else ""))
    return None


def check_words(claude: llm.Claude, log, line: dict, checked: Checked, sims: Vectors, pairs: dict[str, set[str]],
                lang: str) -> None:
    """The trio checked once more before its puzzle is written, as it was chosen: each word
    measured (free when its measures came along: a measure is never asked twice) and its
    facts read on its line map (`line_map`, the map gen_phrase writes; `rules.trio_faults`).
    Raises Unbuildable on any: nothing is swapped."""
    occurrences = _occurrences(line["allowed"])
    hidden = {i for t in checked.trio for i in occurrences[t.slug]}
    for t in checked.trio:
        measure(claude, line, t, hidden, sims, lang)
    _holes, faults = facts_of(line, checked.trio, checked.paths, sims, {t.slug: line_map(line, t, sims) for t in checked.trio},
                              {t.slug: band_of(line, t, sims, pairs, lang) for t in checked.trio})
    _unbuildable(checked.trio, faults)


def build_day(claude: llm.Claude, log: Log, line: dict, checked: Checked, book: dict, archive: dict, text: str,
              source_base: dict, lang: str, *, sims: Vectors, prior: dict[str, str] | None = None):
    """The chosen day, built: its trio checked once more on its line maps (`check_words`),
    the page cut (a book), and `generate` writes the puzzle on those same maps, its start
    words chosen there by the taste — or, for a banked line, the starts it was banked with
    (`prior`), chosen on them already and read again on the written map in code
    (`banked_fault`). A line found unbuildable is not built: nothing is swapped. Returns the
    written puzzle path, or None."""
    try:
        check_words(claude, log, line, checked, sims, archive["pairs"], lang)
    except Unbuildable as raised:
        log(f"- the line cannot be built: {raised}")
        return None
    sentence = line["sentence"]
    known = llm.widely_known(claude, sentence, book.get("author", ""), book.get("title", ""), lang=lang)
    log("- known-line check (annotation): "
        + ("the model thinks a reader would know it" if known["known"] else "not known off the page")
        + (f" — {known['why']}" if known["why"] else ""))
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
    return generate(claude, log, line, checked, source, lang, sims=sims, pairs=archive["pairs"], prior=prior)


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
    erased with its sidecar — the retry replaces it — and its sentence is returned, as the puzzle keeps
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
        shelf_mod.erase_puzzle(given.resolve())
        log(f"- erased: {given}")
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


def bank_works(claude: llm.Claude, log: Log, args, archive: dict, today: date, judge, in_vocab,
               sims: Vectors) -> int:
    """`--bank N`: N works (all of the shelf, as many as asked), each mined and shortlisted
    as a run does; EVERY line of its shortlist finished as a day but for its puzzle — read,
    its words chosen, the main word first, each with its other sense asked (`prepare`), then
    its start words chosen on its line maps with the start step's own checks (`start_lines`)
    — and kept in the bank with what it was read and measured at, a line set aside on the way
    kept with why (`bank.aside`); nothing is compared or written as a puzzle. A work is banked
    once: chosen and claimed under the bank's lock, against the index as it stands then, and
    kept even when no line survived (a marker). A work whose banking fails is released
    (`bank.unclaim`), its detail kept with the spoilers; two failures in a row end the
    process."""
    total, failures = 0, 0
    for _ in range(args.bank):
        with bank.locked(args.lang):
            index = shelf_mod.load_index(args.lang)
            book = choose_work(log, args, archive, index, today,
                               banked=bank.works(args.lang) | bank.claimed(args.lang))
            if book is not None:
                bank.claim(args.lang, book["file"])
        if book is None:
            break
        log.begin_attempt()
        stamp = bank.taste_stamp()  # before the reads: a taste edited meanwhile reads them again
        try:
            text = read_work(book, args.lang)
            judged = judged_lines(log, book, text, archive, index, args.lang, judge)
            # a work with no line left banks nothing and stays banked: there is nothing to retry
            ranked = shortlist(claude, log, judged, args.lang) if judged else []
            days, aside = prepare(claude, log, ranked, archive, in_vocab, args.lang, [], judge=judge, sims=sims)
            started = start_lines(claude, log, days, archive, args.lang, sims)
        except Exception as exc:  # a failed call (a usage limit, the judge): the work is released
            bank.unclaim(args.lang, book["file"])
            log(f"- failed: {type(exc).__name__}: {exc}")  # held with the spoilers in a blind run
            log.end_attempt(False, [f"- banking {book['file']} failed, released ({type(exc).__name__})"],
                            hide_failure=True)
            failures += 1
            if failures >= 2:
                log("- two works failed in a row: stopping")
                break
            continue
        except BaseException:  # the judge refused (die), or the process is stopped
            bank.unclaim(args.lang, book["file"])
            raise
        failures = 0
        entries = [bank.entry(book, line, checked, starts, args.lang, stamp) for line, checked, starts in started]
        dropped = [bank.aside(book, line, args.lang, stamp)
                   for line in [*aside, *(line for line, _ in days if line.get("dropped"))]]
        bank.append(args.lang, entries + dropped or [bank.empty(book)])
        bank.unclaim(args.lang, book["file"])
        bank.render(args.lang)
        total += len(entries)
        log.end_attempt(bool(entries), [f"- banked: {len(entries)} line(s) of {book.get('author', '')} — "
                                        f"{book.get('title', '')}, {len(dropped)} set aside"])
        if args.work:
            break
    held = bank.lines(args.lang)
    log(f"\n## Bank\n\n- banked this run: {total} line(s)\n- the bank holds {len(held)} line(s) of "
        f"{len({e['work'] for e in held})} work(s): `{bank.bank_file(args.lang)}`, to read in "
        f"`{bank.view_file(args.lang)}`")
    return 0 if total else 2


def rebank_works(claude: llm.Claude, log: Log, args, archive: dict, in_vocab, sims: Vectors) -> int:
    """`--rebank`: the bank's lines taken again under today's taste, work by work — READ again
    when never read or read under another taste (`read`), and their words CHOSEN again, the
    main word first, with their start words on their line maps (`rebank_line`) — the shelf
    never read, the judge never asked (each line's giveaways were stored when it was banked,
    its measures and other-sense checks too), nothing written. The lines taken are
    `bank.stale`'s. Works are
    claimed as `--bank` claims them, so processes run side by side, and each work's entries
    are rewritten in place (`bank.replace_work`). A work whose rebanking fails is released;
    two failures in a row end the process. Resumable: a line taken under today's taste is
    never taken again, and one left as it was is taken by the next rebank."""
    total, failures, seen = 0, 0, set()
    while True:
        with bank.locked(args.lang):
            taken = bank.claimed(args.lang) | seen
            work = next((e["work"] for e in bank.stale(args.lang)
                         if e["work"] not in taken and args.work in (None, e["work"])), None)
            if work is not None:
                bank.claim(args.lang, work)
        if work is None:
            break
        seen.add(work)
        log.begin_attempt()
        try:
            entries = [e for e in bank.load(args.lang) if e["work"] == work and not e.get("empty")]
            redone = reread_work(claude, log, entries, archive, args.lang, in_vocab, sims)
        except Exception as exc:  # a failed call (a usage limit): the work is released
            bank.unclaim(args.lang, work)
            log(f"- failed: {type(exc).__name__}: {exc}")  # held with the spoilers in a blind run
            log.end_attempt(False, [f"- rebanking {work} failed, released ({type(exc).__name__})"],
                            hide_failure=True)
            failures += 1
            if failures >= 2:
                log("- two works failed in a row: stopping")
                break
            continue
        except BaseException:  # the process is stopped
            bank.unclaim(args.lang, work)
            raise
        failures = 0
        bank.replace_work(args.lang, work, redone)
        bank.unclaim(args.lang, work)
        bank.render(args.lang)
        again = [e for e, before in zip(redone, entries) if e is not before]
        total += len(again)
        log.end_attempt(True, [f"- taken again: {len(again)} line(s) of {work}, "
                               f"{sum(1 for e in again if e.get('dropped'))} set aside"])
    log(f"\n## Rebank\n\n- taken again this run: {total} line(s)\n- left for a rebank: {len(bank.stale(args.lang))} "
        f"line(s)\n- read in `{bank.view_file(args.lang)}`")
    return 0 if total else 2


def reread_work(claude: llm.Claude, log, entries: list[dict], archive: dict, lang: str, in_vocab,
                sims: Vectors) -> list[dict]:
    """One work's banked entries as the bank now keeps them, in order: each one `--rebank`
    takes (`bank.is_stale`) taken again (`rebank_line`), WORKERS at a time, and the rest as
    they were; an entry taken again keeps when it was banked, and what it was measured at and
    its other-sense checks: never asked twice. Only a lasting fact sets a line aside with no
    call: its sentence or its work published (`--finish` refuses either), or fewer than TRIO
    words to hide among those judged at banking."""
    stamp = bank.taste_stamp()
    out = list(entries)
    todo = []
    for n, e in enumerate(entries):
        if not bank.is_stale(e, stamp):
            continue
        line = {"sentence": e["sentence"], "read": None, "given": e["given"], "measures": bank.measures_of(e, Measures),
                "senses": dict(e.get("senses") or {})}
        if shelf_mod.sentence_key(e["sentence"]) in archive["sentences"]:
            line["dropped"] = "the sentence was published"
        elif shelf_mod.in_archive(bank.book_of(e), archive["works"]):
            line["dropped"] = "the work was published: never the same work twice"
        else:
            tokens = parse(e["sentence"], lang)
            judged = bank.pool(tokens, e["given"], lang, in_vocab)
            if len({t.slug for t in judged}) < rules.TRIO:
                line["dropped"] = f"fewer than {rules.TRIO} words can be hidden"
            else:
                todo.append((n, {**new_line(e["sentence"], tokens, judged, e["given"]), "measures": line["measures"],
                                 "senses": line["senses"]}))
        if line.get("dropped"):
            log(f"\n## « {e['sentence']} »\n- set aside: {line['dropped']}")
            out[n] = {**bank.aside(bank.book_of(e), line, lang, stamp), "bankedAt": e["bankedAt"]}

    def one(item):
        n, line = item
        buffer = Buffer()
        buffer(f"\n## « {line['sentence']} »")
        return buffer, rebank_line(claude, buffer, line, entries[n], archive, lang, sims, stamp)

    with llm.subscription_only(), ThreadPoolExecutor(WORKERS) as pool:
        done = list(pool.map(one, todo))
    for (n, _), (buffer, entry) in zip(todo, done):
        for row in buffer:
            log(row)
        if entry is not None:
            out[n] = {**entry, "bankedAt": entries[n]["bankedAt"]}
    return out


def rebank_line(claude: llm.Claude, log, line: dict, e: dict, archive: dict, lang: str, sims: Vectors,
                stamp: str) -> dict | None:
    """One banked line taken again (`--rebank`). READ under today's taste (`read`), unless its
    read is today's: the read is a lasting verdict on the line, so it is shown every word
    judged at banking, those in their cooldown included. Then its words chosen again, the
    main word first (`anchor_gate`, `choose_others`), from those its read leaves and out of
    their cooldown (`--finish` refuses a word in it), and its start words on its line maps
    (`bank_line`). Returns the entry as the bank now keeps it — kept with its words, or set
    aside with why, its read, giveaways, measures and other-sense checks kept either way — or
    None when it is
    left as it was, for a later rebank: no usable reading; its main word, or words enough to
    leave it short, in their cooldown; or, a word in its cooldown left out, set aside once its
    main word passed — the words against it were chosen without that word, a fact of the
    day, never a lasting verdict."""
    book = bank.book_of(e)
    if e.get("taste") == stamp and e.get("read") and not e.get("dropped"):
        line["read"] = bank.read_of(e["read"])
        _log_read(log, line["read"])
    else:
        line["read"], why = read(claude, log, line, lang)
        if line["read"] is None:
            log(f"- not read: {why}; left for the next rebank")
            return None
        if why:
            set_aside(log, line, why)
            return bank.aside(book, line, lang, stamp)
    needs_book = {slug(w) for w in line["read"]["needs_book"]}
    line["allowed"] = [t for t in line["allowed"] if t.slug not in needs_book]
    if len({t.slug for t in line["allowed"]}) < rules.TRIO:
        set_aside(log, line, f"fewer than {rules.TRIO} words can be hidden once those that need the work leave")
        return bank.aside(book, line, lang, stamp)
    cooling = archive["secrets"]
    cooled = {t.slug: t.text for t in line["allowed"] if t.slug in cooling}
    line["allowed"] = [t for t in line["allowed"] if t.slug not in cooling]
    if slug(line["read"]["anchor"]) in cooling:
        log(f"- its main word « {line['read']['anchor']} » is in its cooldown: left for a later rebank")
        return None
    if len({t.slug for t in line["allowed"]}) < rules.TRIO:
        log("- words in their cooldown leave it short: left for a later rebank")
        return None
    anchor, why = anchor_gate(claude, log, line, sims, archive["pairs"], lang)
    if why:
        set_aside(log, line, why)
        return bank.aside(book, line, lang, stamp)
    checked = choose_others(claude, log, line, anchor, sims, archive["pairs"], lang)
    started = bank_line(claude, log, line, checked, archive, lang, sims) if checked else None
    if started is not None:
        checked, picked, draft = started
        return bank.entry(book, line, checked, {"starts": picked, "draft": draft}, lang, stamp)
    if cooled:
        log(f"- chosen without {', '.join(f'« {w} »' for w in cooled.values())}, in their cooldown: "
            "left for a later rebank")
        return None
    return bank.aside(book, line, lang, stamp)


def static_draft(line: dict, trio: list, sims: Vectors, lang: str) -> dict | None:
    """The day as the start step reads it before its puzzle is written: the line's display
    tokens, one hole per occurrence of each hidden word (located as `gen_phrase` locates
    them), and each word's line map (`line_map`: the map gen_phrase writes). None when a word
    has no map or cannot be located."""
    import gen_phrase as gp  # generation/scripts: the display tokens and the hole shape

    cfg = gp.CONFIG[lang]
    words = gp.display_tokens(line["sentence"])
    holes, ranks = [], {}
    for t in trio:
        rank_map = line_map(line, t, sims)
        if rank_map is None:
            return None
        ranks[t.slug] = rank_map
        found = [(pos, gp.locate_core(token, t.slug, cfg)) for pos, token in enumerate(words)]
        found = [(pos, at) for pos, at in found if at]
        if not found:
            return None
        for pos, (core, prefix, suffix) in found:
            holes.append(gp._make_hole(core, prefix, suffix, pos, core, 0))
    holes.sort(key=lambda h: h["pos"])
    return {"words": words, "holes": holes, "ranks": ranks}


def _set_starts(draft: dict, starts: dict[str, str]) -> None:
    """Each hole shows its secret's start (by slug), with the start's rank on its map."""
    for h in draft["holes"]:
        word = starts.get(h["secret"]["slug"])
        if word:
            h["start"] = {"word": word, "slug": slug(word)}
            h["start_rank"] = _rank_of(draft["ranks"][h["secret"]["slug"]], word)


def bank_line(claude: llm.Claude, log, line: dict, checked: "Checked", archive: dict, lang: str,
              sims: Vectors) -> tuple["Checked", dict, dict] | None:
    """One line's words given their start words before its puzzle is written: the run's start
    step (`choose_starts`, then `check_starts`' rounds: the sentence read with its starts, the
    one-idea check) on the line's maps (`static_draft`) — the maps `--finish` writes, so the
    starts are never chosen again. A word chosen against
    the main word that no start saves is refused, and two words are chosen again
    (`choose_others`) within the line's COMPANION_ASKS; anything else the start step finds
    against the line sets it aside. Returns (the checked trio, its starts {slug: word}, the
    draft as the player first sees it), or None, why kept on `line["dropped"]`."""
    while True:
        draft = static_draft(line, checked.trio, sims, lang)
        if draft is None:
            set_aside(log, line, "a hidden word has no map: no start words")
            return None
        try:
            picked = choose_starts(claude, log, draft, line, checked, {}, sims, archive["pairs"], lang=lang)
        except Unbuildable as raised:
            if raised.word is None:
                set_aside(log, line, raised.why)
                return None
            refuse(log, line, raised.word, raised.why)
            checked = choose_others(claude, log, line, checked.trio[0], sims, archive["pairs"], lang)
            if checked is None:
                return None
            continue
        if picked is None:
            set_aside(log, line, "no complete trio of valid start words")
            return None
        _set_starts(draft, picked)
        tried = {k: {w} for k, w in picked.items()}
        cleared: dict[str, set[str]] = {}
        for rounds in range(st.START_ROUNDS):
            repick = check_starts(claude, log, draft, line, checked, tried, sims, archive["pairs"], lang=lang,
                                  cleared=cleared, last=rounds == st.START_ROUNDS - 1)
            if not repick:
                break
            _adopt(picked, tried, repick)
            _set_starts(draft, picked)
        return checked, picked, draft


def start_lines(claude: llm.Claude, log: Log, days: list[tuple[dict, "Checked"]], archive: dict, lang: str,
                sims: Vectors) -> list[tuple[dict, "Checked", dict]]:
    """`bank_line` on every finished line, WORKERS at a time, each line's log written in
    order once all are done. Returns (line, checked, {"starts", "draft"}) for every line
    that got its starts; the others are set aside, why on `line["dropped"]`."""
    def one(item):
        line, checked = item
        buffer = Buffer()
        buffer(f"\n## Start words: « {line['sentence']} »")
        return buffer, bank_line(claude, buffer, line, checked, archive, lang, sims)

    with llm.subscription_only(), ThreadPoolExecutor(WORKERS) as pool:
        done = list(pool.map(one, days))
    out = []
    for (line, _), (buffer, result) in zip(days, done):
        for entry in buffer:
            log(entry)
        if result is not None:
            checked, picked, draft = result
            out.append((line, checked, {"starts": picked, "draft": draft}))
    return out


def finish_line(claude: llm.Claude, log: Log, args, archive: dict, today: date, index: dict, in_vocab,
                sims: Vectors) -> str | None:
    """`--finish ID`: one banked line, chosen by the user, made a candidate day — read
    against today's archive (`bank.restore`), then built as a run builds its chosen line
    (`build_day`: its words checked once more on its line maps, the page, the puzzle written
    on those maps with the starts it was banked with — chosen on them, never chosen again —
    and their checks). No paid step: Jev is not asked. A line found unbuildable, or whose
    written map is not the one its starts were banked on (`banked_fault`), stops with why:
    nothing is swapped. Writes the candidate puzzle; never publishes."""
    entry = next((e for e in bank.load(args.lang) if e.get("id") == args.finish), None)
    if entry is None:
        die(f"no banked {args.lang} line has the id {args.finish} (see {bank.view_file(args.lang)})")
    book = {w["file"]: w for w in shelf_mod.list_works(_paths.shelf_dir(args.lang))}.get(entry["work"])
    if book is None or book.get("error"):
        die(f"{entry['work']} is no longer readable on the {args.lang} shelf")
    if shelf_mod.in_archive(book, archive["works"]):
        die(f"{book.get('author')} — {book.get('title')} is already published: never the same work twice")
    if in_cooldown(book, archive, index, today):
        log(f"- note: {book.get('author')} is inside the artist cooldown ({lyr.ARTIST_COOLDOWN_DAYS} days)")
    restored, why = bank.restore(entry, archive, args.lang, in_vocab, sims.frequency_rank, Measures, Checked)
    if restored is None:
        die(f"this line can no longer be used: {why}")
    line, checked = restored
    source_base = {"kind": book["kind"], "author": book.get("author", ""), "work": book.get("title", "")}
    log.begin_attempt()
    log(f"\n## Finishing « {line['sentence']} » — {book.get('author')}, {book.get('title')}")
    path = build_day(claude, log, line, checked, book, archive, read_work(book, args.lang), source_base, args.lang,
                     sims=sims, prior=entry["starts"])
    log.end_attempt(bool(path), player_view(path, book) if path else ["- the line could not be built"],
                    hide_failure=True)
    return path


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
                           "the puzzle's source), skipping the mining and the shortlist")
    mode.add_argument("--bank", type=int, metavar="WORKS",
                      help="bank WORKS works off the shelf: every shortlisted line finished as a day but for "
                           "its puzzle (read, its words chosen the main word first, each word's other sense set "
                           "aside, start words on the maps the puzzle will have) and kept in bank/<lang>.jsonl, "
                           "read in bank/<lang>.md; nothing is written as a puzzle")
    mode.add_argument("--finish", metavar="ID",
                      help="make a banked line (its id in bank/<lang>.md) a candidate day: its words checked "
                           "again, the page, the puzzle written on the maps its starts were banked on (each word's "
                           "plain map minus its other sense), the starts checked; nothing paid, nothing swapped; "
                           "never publishes")
    mode.add_argument("--rebank", action="store_true",
                      help="take the bank's lines again under today's taste, work by work, in place: each one "
                           "read again when never read or read under another taste, and its words chosen "
                           "again, the main word first, with start words on their maps; no shelf, no Jev, "
                           "no puzzle")
    args = p.parse_args()
    if args.bank is not None and args.bank < 1:
        p.error("--bank takes a number of works, 1 or more")
    if args.finish and args.work:
        p.error("--finish names its line: the work is the line's")

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M")
    if args.bank:  # banking processes run side by side: one log each
        stamp += f"-bank-{os.getpid()}"
    elif args.finish:  # so may the lines the user finishes
        stamp += f"-finish-{args.finish}"
    elif args.rebank:  # and the processes taking the bank again
        stamp += f"-rebank-{os.getpid()}"
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
    # before any model call: the ledger, and Jev's key where Jev is asked — the sentence
    # filter and the giveaways of `--bank` and a normal run; `--finish` and `--rebank` read
    # the giveaways stored with each line.
    if not _paths.PUBLISHED_LEDGER.exists():
        die(f"no publish ledger at {_paths.PUBLISHED_LEDGER} — run `pnpm puzzle:ledger --s3` first "
            "(the archive is read off it, and an empty archive would re-propose every published day)")
    judge = None
    if not (args.rebank or args.finish):
        try:
            judge = jev.JevJudge(jev.read_api_key(os.environ))
        except jev.JevError as exc:
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
        code = bank_works(claude, log, args, archive, today, judge, vocab.__contains__, load_similarity(args.lang))
        log(f"- model calls: {claude.calls}\n- log: `{log.path}`")
        sys.exit(code)
    if args.rebank:
        code = rebank_works(claude, log, args, archive, vocab.__contains__, load_similarity(args.lang))
        log(f"- model calls: {claude.calls}\n- log: `{log.path}`")
        sys.exit(code)

    if args.finish:
        result = finish_line(claude, log, args, archive, today, index, vocab.__contains__,
                             load_similarity(args.lang))
    else:
        with bank.locked(args.lang):  # a --bank process running beside never takes this work
            book = choose_work(log, args, archive, index, today,
                               banked=bank.works(args.lang) | bank.claimed(args.lang))
            bank.claim(args.lang, book["file"])
        text = read_work(book, args.lang)
        sims = load_similarity(args.lang)
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
        result = day(claude, log, ranked, book, archive, text, vocab.__contains__, args.lang,
                     tried=tried, judge=judge, sims=sims)
        log.end_attempt(bool(result), player_view(result, book) if result else ())
        with bank.locked(args.lang):  # read again: another run may have recorded its work since
            fresh = shelf_mod.load_index(args.lang)
            shelf_mod.record(fresh, book["file"], tried, author=book.get("author", ""))
            shelf_mod.save_index(fresh, args.lang)
            bank.unclaim(args.lang, book["file"])  # recorded: the index keeps it from now on
    log("")
    if result:
        log(f"## Candidate puzzle\n\n- written: `{result}`\n- publish when approved: `pnpm puzzle:publish {result}`")
    else:
        log("## No puzzle\n\n" + ("The banked line could not be built." if args.finish else
                                  "No line of this work made a day worth playing; run again on another work."))
    log(f"- model calls: {claude.calls}\n- log: `{log.path}`")
    sys.exit(0 if result else 2)


if __name__ == "__main__":
    main()
