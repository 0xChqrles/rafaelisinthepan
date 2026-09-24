"""One book in, one candidate puzzle out (issue #260). Never publishes.

    pnpm curate [--lang fr] [--work <file on the shelf>]
    pnpm curate --retry <file on the shelf | candidate puzzle.json>

Linear: a work is picked off the shelf by rule (an epub, or a song file put there by
`shelf:lyrics`), the model shortlists sentences, code strikes the words the context
hands over and lists every valid trio of what is left (`rules.py`), and the model
DESIGNS the day by choosing one as a chain; `gen_phrase` builds its maps headless, a
hole the readers' guesses cannot reach sends the design back without that word, and
a sentence with no trio left is abandoned for the next. The run's log —
every rejection and its rule — is written to `runs/<stamp>.md`, the puzzle to
generation's output directory.
"""

import argparse
from datetime import date, datetime, timezone
from functools import lru_cache
import json
import os
from pathlib import Path
import re
import subprocess
import sys

import _paths
import contextual_rank  # the #308 judge: sentence pre-filter + shortlist order + giveaways (generation/scripts)
from slug import slug

import llm
import quotes as qt
import lyrics as lyr
import rules
import shelf as shelf_mod
import starts as st
from epub import epub_text
from parse import parse, parse_many
from sentences import EXCERPT_SENTENCES, EXCERPT_WINDOW, candidate_sentences, cut_excerpt, excerpt_around

LANGS = ("fr",)
# Candidate sentences shown to the model per book: the BEST by the judge's image score
# (#308, 2026-09-20; was a random sample) after its loose sentence filter.
MAX_SENTENCES = 600
CHUNK = 150
PICKS_PER_CHUNK = 6
SHORTLIST = 20
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

    def begin_attempt(self, n: int) -> None:
        if self.blind:
            self._held = []
            self._emit(f"\n## Attempt {n} (details withheld)")

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
    if lang == "fr":
        import french_neighbors as module
    else:  # pragma: no cover - LANGS guards this
        raise ValueError(lang)
    kv = module.load_vectors()
    V = module.build_vocab(kv)
    M = module.build_matrix(kv, V)

    def key(t: rules.Token):
        for form in (t.text.lower(), t.lemma):
            if form in kv:
                return form
        return None

    def similarity(a: rules.Token, b: rules.Token):
        ka, kb = key(a), key(b)
        if ka is None or kb is None:
            return None
        return float(kv.similarity(ka, kb))

    def frequency_rank(t: rules.Token):
        k = key(t)
        return None if k is None else int(kv.key_to_index[k])

    @lru_cache(maxsize=64)
    def ranking(k: str) -> dict[str, int]:
        return {cand: r for cand, r, _ in module.closest(k, kv, V, M, n=None)}

    def neighbour_rank(t: rules.Token, word: str):
        """Where `word` stands in the STATIC ranking around the token's vector (0 = the
        nearest other word); None when either is unknown. The twin test of the
        obviousness filter (`rules.is_twin`), and the static distance the design
        prompt is shown."""
        k = key(t)
        w = word.lower()
        if k is None or w not in kv or w == k:
            return None
        return ranking(k).get(w)

    return similarity, frequency_rank, neighbour_rank


# ---------------------------------------------------------------------------
# gen_phrase, headless, with the #133 form question answered by the model.

_FORM_NEEDED = re.compile(r"la forme de « (.+?) » doit être explicite")
_ANALYSIS = re.compile(r"^\s*(\d+)\)\s+(\S+)\s+—\s+(.*)$", re.M)
_EXAMPLE = re.compile(r"ex\. --form \S+=(\S+)")
_SHARED = re.compile(r"Précise : (.+?)\.\s*$", re.S)
_WRITTEN = re.compile(r"écrite dans (\S+) :")


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


class OutOfReach(Exception):
    """The day's maps are built and some hole's readers cannot reach it: {secret slug:
    (nearest filler, its rank or None past the map)}. The design goes back without
    those words."""

    def __init__(self, holes: dict[str, tuple[str, int | None]]):
        super().__init__(", ".join(holes))
        self.holes = holes


def _sidecar(puzzle_path: str) -> str:
    """The judge's scores gen_phrase writes beside a puzzle (#308)."""
    return puzzle_path[:-len(".json")] + ".contextual.json"


def generate(claude: llm.Claude, log: Log, sentence: str, words: list[str], source: dict, lang: str,
             context: dict[str, str] | None = None, frequency_rank=lambda t: None,
             pairs: dict[str, set[str]] | None = None, replay: str | None = None,
             chain: list[str] | None = None, reach=None):
    """Returns the written puzzle path, or None with the reason logged. The forms are
    answered by the model as gen_phrase asks. The first successful run only supplies the
    rank maps: `reach(puzzle)` names the holes the readers cannot reach in them (the
    draft is then erased and OutOfReach raised), else the START WORDS are chosen by the
    model, the three together, from each hole's band and along the day's `chain`
    (`choose_starts`), and the puzzle is regenerated with them; every result is checked
    (the displayed sentence must be valid French) and a refused start re-picked, at most
    START_ROUNDS times."""
    forms: dict[str, str] = {}
    starts: dict[str, str] = {}
    tried: dict[str, set[str]] = {}  # every start a hole has shown, secret slug -> words
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
            path = m.group(1) if m else None
            if path and prev and path != prev:  # the file is named after its starts: a rerun leaves no orphan
                Path(prev).unlink(missing_ok=True)
                Path(_sidecar(prev)).unlink(missing_ok=True)
            if path and replay and _sidecar(path) != replay:  # the erased draft's scores, now copied
                Path(replay).unlink(missing_ok=True)
                replay = None
            prev = path or prev
            if path and not chosen:
                chosen = True
                far = reach(json.loads(Path(path).read_text(encoding="utf-8"))) if reach else {}
                if far:
                    Path(path).unlink(missing_ok=True)
                    Path(_sidecar(path)).unlink(missing_ok=True)
                    raise OutOfReach(far)
                picked = choose_starts(claude, log, path, context or {}, forms, frequency_rank, pairs or {}, chain)
                if picked:
                    _adopt(starts, tried, picked)
                    continue
            if path and rounds < st.START_ROUNDS:
                repick = check_starts(claude, log, path, tried, context or {}, frequency_rank, pairs or {}, chain)
                if repick:
                    _adopt(starts, tried, repick)
                    rounds += 1
                    continue
            log(f"- gen:phrase command: `{' '.join(_quote(c) for c in cmd[2:])}`")
            return path or "(path not found in output)"
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
            choice = llm.pick_form(claude, sentence, word, choices)
            forms[word] = choices[choice - 1]
            log(f"- form of « {word} » (shared trait): {forms[word]}")
            continue
        if needed:
            word = needed.group(1)
            analyses = _ANALYSIS.findall(err)
            if not analyses:
                log(f"- gen:phrase needs a form for « {word} » but lists no analysis")
                return None
            choices = [f"{feature} — {desc}" for _, feature, desc in analyses]
            choice = llm.pick_form(claude, sentence, word, choices)
            feature = analyses[choice - 1][1]
            example = _EXAMPLE.search(err)
            if choice == 1 and example:
                feature = example.group(1)
            forms[word] = feature
            log(f"- form of « {word} »: {feature}")
            continue
        log(f"- gen:phrase refused: {err.splitlines()[0] if err else completed.stdout[-300:]}")
        return None
    log("- gen:phrase: too many form rounds")
    return None


def _adopt(starts: dict[str, str], tried: dict[str, set[str]], picked: dict[str, str]) -> None:
    for key, word in picked.items():
        starts[key] = word
        tried.setdefault(key, set()).add(word)


def _word_rank(frequency_rank):
    """A frequency reader over display words for the start candidates (the curator's
    reader takes tokens)."""
    def read(word: str):
        return frequency_rank(rules.Token(-1, word, word.lower(), "", "", -1, slug(word)))
    return read


def choose_starts(claude: llm.Claude, log: Log, path: str, context: dict[str, str],
                  forms: dict[str, str], frequency_rank, pairs: dict[str, set[str]] | None = None,
                  chain: list[str] | None = None) -> dict[str, str]:
    """The model picks the three start words together, from each hole's band (elision-
    clean, not too rare, never a start this secret was played with before — `pairs`,
    the archive's permanent blacklist — nearest first), reading the sentence, each
    slot's form, the context annotations and the chain the day was designed on."""
    pairs = pairs or {}
    puzzle = json.loads(open(path, encoding="utf-8").read())
    words, holes = puzzle["words"], puzzle["holes"]
    by_secret: dict[str, dict] = {}
    for h in holes:
        by_secret.setdefault(h["secret"]["slug"], h)
    marked = st.displayed(words, holes, {k: f"[{h['secret']['word']}]" for k, h in by_secret.items()})
    info = []
    for key, h in by_secret.items():
        options = st.start_candidates(puzzle["ranks"][key], key, st.previous_token(words, h),
                                      exclude=pairs.get(key, ()),
                                      frequency_rank=_word_rank(frequency_rank))[:st.START_OPTIONS]
        if not options:
            log(f"- no elision-clean start in the band for « {h['secret']['word']} »; the band pick stays")
            continue
        info.append({"secret": h["secret"]["word"], "slug": key, "options": options,
                     "context": context.get(key, "unknown"),
                     "slot": f"form {forms.get(h['secret']['word'], '?')}, after « {st.previous_token(words, h) or '—'} »"})
    if not info:
        return {}
    picked = llm.pick_starts(claude, marked, info, chain)
    for h in info:
        word = picked.get(h["slug"])
        rank = next((o["rank"] for o in h["options"] if o["word"] == word), None)
        if word:
            log(f"- start for « {h['secret']} »: « {word} » (rank {rank})")
        else:
            log(f"- the model named no valid start for « {h['secret']} »; the band pick stays")
    return picked


def check_starts(claude: llm.Claude, log: Log, path: str, tried: dict[str, set[str]],
                 context: dict[str, str], frequency_rank, pairs: dict[str, set[str]] | None = None,
                 chain: list[str] | None = None) -> dict[str, str]:
    """The displayed sentence with its start words: a start this secret was already
    played with (`pairs`), the elision rule, then the model's grammar check. Returns
    {secret slug: new start} for every faulty hole (empty = all good, or nothing better
    to offer). `tried` holds every start a hole has shown so far; none is offered again."""
    pairs = pairs or {}
    puzzle = json.loads(open(path, encoding="utf-8").read())
    words, holes = puzzle["words"], puzzle["holes"]
    shown = st.displayed(words, holes)
    by_secret: dict[str, dict] = {}
    for h in holes:
        by_secret.setdefault(h["secret"]["slug"], h)
    faulty: dict[str, str] = {}
    for key, h in by_secret.items():
        if h["start"]["word"] in pairs.get(key, ()):
            faulty[key] = "this secret was already played from this start word"
            continue
        problem = st.elision_problem(st.previous_token(words, h), h["start"]["word"])
        if problem:
            faulty[key] = problem
    if not faulty:
        verdict = llm.grammar_check(claude, shown, [h["start"]["word"] for h in by_secret.values()])
        if verdict["valid"]:
            log(f"- start words check: « {shown} » → valid")
            return {}
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
                                      frequency_rank=_word_rank(frequency_rank))[:st.START_OPTIONS]
        if not options:
            log(f"- no other start in the band for « {h['secret']['word']} » — left to the reviewer")
            continue
        marked = st.displayed(words, holes, {key: "[____]"})
        choice = llm.pick_start(claude, marked, h["secret"]["word"], options,
                                refused=problem, context=context.get(key, "unknown"), chain=chain)
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
        puzzle = json.loads(open(path, encoding="utf-8").read())
    except (OSError, ValueError):
        return [f"- written: `{path}`"]
    seen, starts = set(), []
    for h in puzzle["holes"]:
        if h["secret"]["slug"] not in seen:
            seen.add(h["secret"]["slug"])
            starts.append(f"{h['start']['word']} ({h['start_rank']})")
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


def choose_work(claude: llm.Claude, log: Log, args, archive: dict, index: dict, today: date) -> dict:
    works = shelf_mod.list_works()
    if not works:
        die(f"nothing on the shelf ({_paths.SHELF_DIR})")
    # A file the shelf could not open (`list_works` puts the reason on its entry) is
    # never offered to the model: the pick would spend a call and the run would die on
    # the read. Named in the log so the file gets replaced.
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
    # Eligible: readable, not in the archive and not mined by an earlier run (never the
    # same work twice — `--retry` erases an attempt), not inside the artist cooldown.
    fresh = []
    cooled = set()
    for w in works:
        if w.get("error"):
            continue
        if shelf_mod.in_archive(w, archive["works"]) or w["file"] in index["books"]:
            continue
        if in_cooldown(w, archive, index, today):
            cooled.add(w.get("author", ""))
            continue
        fresh.append(w)
    if cooled:
        log(f"- artist cooldown ({lyr.ARTIST_COOLDOWN_DAYS} days) skips: {', '.join(sorted(cooled))}")
    if not fresh:
        die("every work on the shelf was mined, is in the archive, or is inside the artist cooldown "
            "(--retry <file> erases an attempt)")
    work, why = pick_work(fresh, archive, index, today)
    log(f"- work: {work.get('author')} — {work.get('title')} ({work['kind']}, {work['file']}): {why}")
    return work


def pick_work(fresh: list[dict], archive: dict, index: dict, today: date) -> tuple[dict, str]:
    """The next work, by rule (user-decided 2026-09-20; the model no longer picks):
    a song when no music day is within MUSIC_EVERY_DAYS, else a book; within the
    kind, the author never used or proposed first, then the one left longest ago, then
    the file name — deterministic, so two runs on one shelf pick the same work."""
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


def mine(work: dict, text: str, log: Log) -> list[str]:
    """The mechanical half of the selection: sentences for a book, joined lines for a song."""
    if work["kind"] == "music":
        _, body = lyr.parse_song(text)
        units = [u for u in lyr.candidate_units(lyr.clean_lines(body)) if lyr.is_unit_candidate(u)]
        log(f"- lyric units (joined lines) after the mechanical filter: {len(units)}")
        return units
    log(f"- text: {len(text.split())} words")
    sentences = candidate_sentences(text)
    log(f"- candidate sentences after the mechanical filter: {len(sentences)}")
    return sentences


def rich_enough(log: Log, sentences: list[str], lang: str, in_vocab, past_secrets, frequency_rank) -> list[str]:
    """The sentences with at least MIN_CANDIDATES distinct candidate words — the only
    ones the model is ever shown, so a thin sentence cannot be shortlisted, ranked first
    and forced into a dull trio (the 2026-09-08 « faim · crois · pensée » day)."""
    kept = []
    for s, tokens in zip(sentences, parse_many(sentences, lang)):
        candidates = rules.initial_candidates(tokens, in_vocab=in_vocab, past_secrets=past_secrets,
                                              frequency_rank=frequency_rank)
        if len({t.slug for t in candidates}) >= rules.MIN_CANDIDATES:
            kept.append(s)
    log(f"- rich enough ({rules.MIN_CANDIDATES}+ distinct candidate words): {len(kept)} of {len(sentences)}")
    return kept


def judge_sentences(log: Log, sentences: list[str], judge=None) -> list[str]:
    """The judge's sentence pre-filter and order (#308, 2026-09-20): every candidate is
    scored — stands alone, carries an image, not a famous line — the loose filter
    removes what the model should not have to read (about half a novel: lines hanging
    on a name or a pronoun, the flat ones), and the rest is ordered by image score so
    the MAX_SENTENCES the model reads are the best of the whole work, not a random
    sample. A filter only removes; the model still shortlists and the curator still
    decides. The key is the one gen_phrase needs anyway; without it this dies here,
    before any model call."""
    if not sentences:
        return []
    if judge is None:
        try:
            judge = contextual_rank.JevJudge(contextual_rank.read_api_key(os.environ))
        except contextual_rank.ContextualError as exc:
            die(f"sentence judge: {exc}")
    try:
        scores = contextual_rank.score_sentences(judge, sentences)
    except contextual_rank.ContextualError as exc:
        die(f"sentence judge: {exc}")
    kept = [(s, sc) for s, sc in zip(sentences, scores) if contextual_rank.sentence_passes(sc)]
    kept.sort(key=lambda item: (-item[1]["image"], -item[1]["autonome"]))
    log(f"- judged by Jev: {len(kept)} of {len(sentences)} pass the sentence filter "
        f"(stand alone ≥ {contextual_rank.SENTENCE_ALONE_MIN}, image ≥ "
        f"{contextual_rank.SENTENCE_IMAGE_MIN}, famous ≤ {contextual_rank.SENTENCE_FAMOUS_MAX}); "
        f"ordered by image ({judge.usage['input_tokens']} input tokens)")
    return [s for s, _sc in kept]


def strike_giveaways(log: Log, tokens, candidates, occurrences, judge=None):
    """The candidates the sentence does not hand over, by the judge's measure
    (`contextual_rank.giveaway`, threshold `GIVEAWAY_MAX`, calibrated on how fast real
    players found every published hole). Each distinct word is judged once, every
    occurrence blanked, the rest of the sentence intact and no start word — the reader's
    own view. A filter only removes; the order is kept."""
    if not candidates:
        return candidates
    if judge is None:
        try:
            judge = contextual_rank.JevJudge(contextual_rank.read_api_key(os.environ))
        except contextual_rank.ContextualError as exc:
            die(f"giveaway judge: {exc}")
    verdict: dict[str, float] = {}
    kept = []
    for t in candidates:
        if t.slug not in verdict:
            try:
                # rendered EXACTLY as the threshold was calibrated: lowercase, one blank glyph
                shown = llm.holed(tokens, occurrences[t.slug] - {t.i}, t.i)
                shown = shown.replace("[____]", "\0").replace("____", "_____").replace("\0", "_____").lower()
                verdict[t.slug] = contextual_rank.giveaway(judge, shown, t.text.lower())
            except contextual_rank.ContextualError as exc:
                die(f"giveaway judge: {exc}")
            if verdict[t.slug] >= contextual_rank.GIVEAWAY_MAX:
                log(f"- '{t.text}' is GIVEN AWAY by the sentence (judge {verdict[t.slug]:.2f} ≥ "
                    f"{contextual_rank.GIVEAWAY_MAX}) — struck")
        if verdict[t.slug] < contextual_rank.GIVEAWAY_MAX:
            kept.append(t)
    log("- judge, given away: " + ", ".join(f"{s} {v:.2f}" for s, v in verdict.items()))
    return kept


def shortlist(claude: llm.Claude, log: Log, mined: list[str], exclude: set[str]) -> list[dict]:
    sentences = [s for s in mined if shelf_mod.sentence_key(s) not in exclude]
    if not sentences:
        die("no candidate sentence in this work")
    if len(sentences) > MAX_SENTENCES:
        sentences = sentences[:MAX_SENTENCES]
        log(f"- kept the {MAX_SENTENCES} best by image")
    picks: list[dict] = []
    for start in range(0, len(sentences), CHUNK):
        picks.extend(llm.pick_from_chunk(claude, sentences[start:start + CHUNK], PICKS_PER_CHUNK))
    log(f"- shortlisted by the model: {len(picks)}")
    ranked = llm.rank_sentences(claude, picks, SHORTLIST)
    log(f"- ranked shortlist: {len(ranked)}")
    return ranked


def attempt(claude: llm.Claude, log: Log, sentence: str, book: dict, archive: dict,
            in_vocab, similarity, frequency_rank, lang: str, window: dict | None = None,
            quotes: list[str] = (), neighbour_rank=lambda t, w: None, replay: str | None = None):
    """One sentence through the quotation test, the trio design and generation. `window` is
    the raw text around it (#270), which the model CUTS into the page once the trio is
    found — so a rejected sentence never spends the call. `quotes` are the work's quoted
    lines on file (`shelf_quotes`); the strike is theirs, and the model only annotates."""
    log(f"\n## « {sentence} »")
    hit = qt.quoted(sentence, list(quotes))
    if hit:
        log(f"- rejected: a quoted line — « {hit} »")
        return None
    alone = llm.stands_alone(claude, sentence)
    if not alone["ok"]:
        log(f"- rejected: does not stand alone — {alone['why'] or 'the model names no reason'}")
        return None
    log(f"- stands alone: {alone['about']}" if alone["about"] else "- stands alone")
    known = llm.widely_known(claude, sentence, book.get("author", ""), book.get("title", ""))
    log("- known-line check (annotation): "
        + ("the model thinks a reader would know it" if known["known"] else "not known off the page")
        + (f" — {known['why']}" if known["why"] else ""))
    tokens = parse(sentence, lang)
    candidates = rules.initial_candidates(tokens, in_vocab=in_vocab, past_secrets=archive["secrets"],
                                          frequency_rank=frequency_rank)
    log(f"- candidate words: {', '.join(t.text for t in candidates) or '(none)'}")
    if len({t.slug for t in candidates}) < rules.MIN_CANDIDATES:
        log(f"- rejected: fewer than {rules.MIN_CANDIDATES} distinct candidate words")
        return None
    # TASTE FIRST, CHECKS AFTER (2026-09-24): the model proposes the trio with its own
    # taste from the words code allows; code then checks it — the pair rules, the reader's
    # fillers (the obviousness filter, user-decided 2026-09-10: the user's own method), the
    # giveaway judge, the one easy entry — and, once the maps are built, each hole's reach
    # on its own map. A refusal is told back to the model, which proposes again.
    occurrences: dict[str, set[int]] = {}
    for t in candidates:
        occurrences.setdefault(t.slug, set()).add(t.i)
    readings: dict[str, tuple[list[str], str | None]] = {}
    handed: dict[str, bool] = {}

    def fillers(t: rules.Token) -> tuple[list[str], str | None]:
        if t.slug not in readings:
            readings[t.slug] = llm.context_guesses(claude, tokens, occurrences[t.slug] - {t.i}, t.i,
                                                   rules.CONTEXT_GUESSES)
        return readings[t.slug]

    def handed_over(words: list[rules.Token]) -> set[str]:
        # The judge's second opinion (#308, 2026-09-22): the reader misjudged the
        # 2026-09-21 day (« silence », « enseignant » typed by 13 players of 31 within
        # three guesses). A word the sentence hands over is EASY, on a threshold set
        # from real play. Each word judged once.
        fresh = [t for t in words if t.slug not in handed]
        if fresh:
            kept = {t.slug for t in strike_giveaways(log, tokens, fresh, occurrences)}
            handed.update({t.slug: t.slug not in kept for t in fresh})
        return {t.slug for t in words if handed[t.slug]}

    def reach(puzzle: dict) -> dict[str, tuple[str, int | None]]:
        far = {}
        for key in {h["secret"]["slug"] for h in puzzle["holes"]}:
            nearest = rules.map_nearest_filler(puzzle["ranks"][key], key, list(readings.get(key, ([], None))[0]))
            if rules.out_of_reach(nearest):
                far[key] = nearest
        return far

    first_of = {}
    for t in candidates:
        first_of.setdefault(t.slug, t)
    source = {"kind": book["kind"], "author": book.get("author", ""), "work": book.get("title", "")}
    refused: list[str] = []
    apart = rules.conflicts(candidates, tokens, similarity=similarity)
    paged = False
    for n in range(1, rules.TRIO_ROUNDS + 1):
        proposal = llm.choose_trio(claude, tokens, candidates, refused, apart)
        if proposal is None:
            log("- rejected: the model finds no three words worth finding")
            return None
        trio = [first_of.get(slug(w)) for w in proposal["words"]]
        log(f"- proposal {n}: {' · '.join(proposal['words'])}")
        for step in proposal["path"]:
            log(f"  - chain: {step}")
        if proposal["why"]:
            log(f"  - why: {proposal['why']}")
        off = [w for w, t in zip(proposal["words"], trio) if t is None]
        if off or len({t.slug for t in trio}) < rules.TRIO:
            why = f"not among the allowed words: {', '.join(off)}" if off else "the same word twice"
            log(f"- refused: {why}")
            refused.append(f"« {' · '.join(proposal['words'])} » — {why}")
            continue
        check_log = rules.SearchLog()
        problems, easy = rules.refusals(trio, tokens, similarity=similarity, fillers=fillers,
                                        handed_over=handed_over, neighbour_rank=neighbour_rank,
                                        frequency_rank=frequency_rank, log=check_log)
        for event in check_log.events:
            log(f"- {event}")
        if problems:
            for words, why in problems:
                log(f"- refused: « {words} » — {why}")
                refused.append(f"« {words} » — {why}")
            continue
        words = [t.text for t in trio]
        if easy:
            log(f"- easy entry: {trio[0].text}")
        # What a reader puts in each hole from the context alone: shown to the start-word
        # prompt, which must not hand one over.
        context = {t.slug: ("EASY ENTRY — a reader's first fillers: " if t.slug in easy
                            else "open — a reader's first fillers: ") + (', '.join(fillers(t)[0]) or 'none')
                   for t in trio}
        if window and not paged:
            paged = True
            excerpt = choose_page(claude, log, sentence, window)
            if excerpt:
                source["excerpt"] = excerpt
        try:
            return generate(claude, log, sentence, words, source, lang, context, frequency_rank, archive["pairs"],
                            replay=replay, chain=proposal["path"], reach=reach)
        except OutOfReach as exc:
            for key, (word, rank) in exc.holes.items():
                where = f"rank {rank}" if rank is not None else "past the map"
                why = (f"out of reach: the readers' nearest filler « {word} » sits at {where} in its map "
                       f"(> {rules.FILLER_NEAR_MAX})")
                log(f"- refused: « {key} » — {why}")
                refused.append(f"« {first_of[key].text} » — {why}")
            replay = None  # another trio: the erased draft's scores no longer apply
    log(f"- rejected: no trio stands after {rules.TRIO_ROUNDS} proposals")
    return None


def choose_page(claude: llm.Claude, log: Log, sentence: str, window: dict) -> dict | None:
    """The page around the line (#270): the model says where it starts and ends, code
    clamps it into the window; an unusable answer falls back to EXCERPT_SENTENCES a side.
    None when nothing is left (a line with no page)."""
    answer = llm.choose_excerpt(claude, sentence, window)
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
        work = shelf_mod.work_of(puzzle.get("source") or {}, shelf_mod.list_works())
        if work is None:
            die(f"{given.name} names no work on the shelf (source: {puzzle.get('source')})")
        args.work = work["file"]
        sidecar = Path(_sidecar(str(given.resolve())))
        args.replay = str(sidecar) if sidecar.is_file() else None  # its scores are reused (#308)
        shelf_mod.erase_puzzle(given.resolve())
        log(f"- erased: {given}" + (" (its contextual scores kept for the rerun)" if args.replay else ""))
        return " ".join(words)
    work = next((w for w in shelf_mod.list_works() if w["file"] == args.retry), None)
    if work is None:
        die(f"{args.retry} is neither on the shelf nor a candidate puzzle file")
    for path in shelf_mod.forget(index, work, args.lang):
        log(f"- erased: {path}")
    shelf_mod.save_index(index)
    args.work = args.retry
    return None


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--lang", choices=LANGS, default="fr")
    p.add_argument("--work", help="a file name on the shelf, epub or song (skips the model's pick)")
    p.add_argument("--blind", action="store_true",
                   help="withhold the winning sentence, its secrets and their handling from the "
                        "log and stdout (they go to runs/<stamp>.spoilers.md), so the run can be "
                        "read and the puzzle played before being spoiled")
    p.add_argument("--retry", metavar="FILE",
                   help="retry a WORK — a file on the shelf, epub or song: erase its attempt (index "
                        "entry and candidate puzzles) and run on it again — or ONE SENTENCE — a "
                        "candidate puzzle file: erase it and rerun its sentence (the work read off "
                        "the puzzle's source), skipping the mining, shortlist and ranking")
    args = p.parse_args()

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M")
    log = Log(stamp, blind=args.blind)
    try:
        plan = llm.validate()
    except RuntimeError as exc:
        die(str(exc))
    log(f"- model: {llm.MODEL} (effort {llm.EFFORT}) on the {plan} subscription")

    vocab = set(json.loads((_paths.VOCAB_DIR / f"{args.lang}.json").read_text(encoding="utf-8")))
    index = shelf_mod.load_index()
    sentence = None
    if args.retry:
        sentence = retry_target(args, log, index)
    if not _paths.PUBLISHED_LEDGER.exists():
        die(f"no publish ledger at {_paths.PUBLISHED_LEDGER} — run `pnpm puzzle:ledger --s3` first "
            "(the archive is read off it, and an empty archive would re-propose every published day)")
    archive = shelf_mod.archive(args.lang, datetime.now(timezone.utc).date())
    log(f"- archive: {len(archive['secrets'])} secret(s) still in their {shelf_mod.SECRET_COOLDOWN_DAYS}-day "
        f"cooldown, {sum(len(v) for v in archive['pairs'].values())} secret/start pair(s) blacklisted")
    claude = llm.Claude()

    today = datetime.now(timezone.utc).date()
    book = choose_work(claude, log, args, archive, index, today)
    path = _paths.SHELF_DIR / book["file"]
    text = epub_text(path) if book["kind"] == "book" else path.read_text(encoding="utf-8")
    similarity, frequency_rank, neighbour_rank = load_similarity(args.lang)
    if sentence is not None:
        # One sentence, by hand: found again among the work's mined units so it keeps the
        # source's casing; never a published one (the archive is the one record).
        unit = shelf_mod.find_unit(mine(book, text, log), sentence)
        if unit is None:
            log("- the sentence is not one of the work's mined units — taken as typed")
            unit = sentence
        if shelf_mod.sentence_key(unit) in archive["sentences"]:
            die("that sentence is already published (it is in the ledger)")
        ranked = [{"sentence": unit, "why": "retried by hand"}]
    else:
        proposed = {shelf_mod.sentence_key(s) for s in index["books"].get(book["file"], {}).get("sentences", ())}
        proposed |= archive["sentences"]
        # The judge first (cents, a minute), the parser only on what it keeps.
        mined = judge_sentences(log, [s for s in mine(book, text, log)
                                      if shelf_mod.sentence_key(s) not in proposed])
        mined = rich_enough(log, mined, args.lang, vocab.__contains__, archive["secrets"], frequency_rank)
        ranked = shortlist(claude, log, mined, proposed)

    # The work's quoted lines (the quotation test): fetched onto the shelf by
    # `pnpm shelf:quotes`, read here offline. A missing file skips the test, loudly.
    quotes: list[str] = []
    if book["kind"] == "book":
        on_file = qt.load_quotes(book["file"])
        if on_file is None:
            log("- quotes: NO FILE for this work — run `pnpm shelf:quotes`; the quotation test is skipped")
        elif not qt.quote_sources(book["file"]):
            log("- quotes: the fetch found NO WIKIQUOTE OR WIKIPEDIA PAGE for this work — the quotation "
                "test has nothing to check")
        else:
            quotes = on_file
            log(f"- quotes: {len(quotes)} quoted line(s) on file")
    tried: list[str] = []
    result = None
    for n, pick in enumerate(ranked, 1):
        tried.append(pick["sentence"])
        log.begin_attempt(n)
        # The page around the line (#270): a book's raw neighbouring sentences, the
        # model cutting the window once a trio is found; a song gets none (lyrics are a
        # licensed product — the line is the whole quotation).
        window = excerpt_around(text, pick["sentence"], EXCERPT_WINDOW) if book["kind"] == "book" else None
        result = attempt(claude, log, pick["sentence"], book, archive, vocab.__contains__,
                         similarity, frequency_rank, args.lang, window, quotes, neighbour_rank,
                         replay=getattr(args, "replay", None) if n == 1 else None)
        log.end_attempt(bool(result), player_view(result, book) if result else ())
        if result:
            break
    shelf_mod.record(index, book["file"], tried, author=book.get("author", ""))
    shelf_mod.save_index(index)
    log("")
    if result:
        log(f"## Candidate puzzle\n\n- written: `{result}`\n- publish when approved: `pnpm puzzle:publish {result}`")
    else:
        log("## No puzzle\n\nEvery shortlisted sentence was rejected; run again for another sample or book.")
    log(f"- model calls: {claude.calls}\n- log: `{log.path}`")
    sys.exit(0 if result else 2)


if __name__ == "__main__":
    main()
