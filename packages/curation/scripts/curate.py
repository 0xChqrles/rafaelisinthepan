"""One book in, one candidate puzzle out (issue #260). Never publishes.

    pnpm curate [--lang fr] [--work <file on the shelf>]

Greedy and linear: the LLM picks a work off the shelf (an epub, or a song file put
there by `shelf:lyrics`), then sentences, then the secrets one at a time from a list
that code keeps valid (`rules.py`); a sentence with no trio is abandoned for the next;
the first sentence that survives is handed to `gen_phrase` headless. The run's log —
every rejection and its rule — is written to `runs/<stamp>.md`, the puzzle to
generation's output directory.
"""

import argparse
from datetime import date, datetime, timezone
import json
from pathlib import Path
import random
import re
import subprocess
import sys

import _paths
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
# Candidate sentences shown to the model per book (a random sample above this).
MAX_SENTENCES = 600
CHUNK = 150
PICKS_PER_CHUNK = 6
SHORTLIST = 20
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

    return similarity, frequency_rank


# ---------------------------------------------------------------------------
# gen_phrase, headless, with the #133 form question answered by the model.

_FORM_NEEDED = re.compile(r"la forme de « (.+?) » doit être explicite")
_ANALYSIS = re.compile(r"^\s*(\d+)\)\s+(\S+)\s+—\s+(.*)$", re.M)
_EXAMPLE = re.compile(r"ex\. --form \S+=(\S+)")
_SHARED = re.compile(r"Précise : (.+?)\.\s*$", re.S)
_WRITTEN = re.compile(r"écrite dans (\S+) :")


def run_gen_phrase(sentence: str, words: list[str], source: dict, forms: dict[str, str], lang: str,
                   starts: dict[str, str] | None = None):
    cmd = ["uv", "run", "scripts/gen_phrase.py", sentence, "--lang", lang, "--words", *words]
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


def generate(claude: llm.Claude, log: Log, sentence: str, words: list[str], source: dict, lang: str,
             context: dict[str, str] | None = None, frequency_rank=lambda t: None,
             pairs: dict[str, set[str]] | None = None):
    """Returns the written puzzle path, or None with the reason logged. The forms are
    answered by the model as gen_phrase asks. The first successful run only supplies the
    rank maps: the START WORDS are then chosen by the model, the three together, from
    each hole's band (`choose_starts`), and the puzzle is regenerated with them; every
    result is checked (the displayed sentence must be valid French) and a refused start
    re-picked, at most START_ROUNDS times."""
    forms: dict[str, str] = {}
    starts: dict[str, str] = {}
    tried: dict[str, set[str]] = {}  # every start a hole has shown, secret slug -> words
    chosen = False
    rounds = 0
    prev = None
    for _ in range(MAX_GEN_RUNS + st.START_ROUNDS + 1):
        completed, cmd = run_gen_phrase(sentence, words, source, forms, lang, starts)
        if completed.returncode == 0:
            m = _WRITTEN.search(completed.stdout)
            path = m.group(1) if m else None
            if path and prev and path != prev:  # the file is named after its starts: a rerun leaves no orphan
                Path(prev).unlink(missing_ok=True)
            prev = path or prev
            if path and not chosen:
                chosen = True
                picked = choose_starts(claude, log, path, context or {}, forms, frequency_rank, pairs or {})
                if picked:
                    _adopt(starts, tried, picked)
                    continue
            if path and rounds < st.START_ROUNDS:
                repick = check_starts(claude, log, path, tried, context or {}, frequency_rank, pairs or {})
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
                  forms: dict[str, str], frequency_rank, pairs: dict[str, set[str]] | None = None) -> dict[str, str]:
    """The model picks the three start words together, from each hole's band (elision-
    clean, not too rare, never a start this secret was played with before — `pairs`,
    the archive's permanent blacklist — nearest first), reading the sentence, each
    slot's form and the context annotations."""
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
    picked = llm.pick_starts(claude, marked, info)
    for h in info:
        word = picked.get(h["slug"])
        rank = next((o["rank"] for o in h["options"] if o["word"] == word), None)
        if word:
            log(f"- start for « {h['secret']} »: « {word} » (rank {rank})")
        else:
            log(f"- the model named no valid start for « {h['secret']} »; the band pick stays")
    return picked


def check_starts(claude: llm.Claude, log: Log, path: str, tried: dict[str, set[str]],
                 context: dict[str, str], frequency_rank, pairs: dict[str, set[str]] | None = None) -> dict[str, str]:
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
                                refused=problem, context=context.get(key, "unknown"))
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
    if args.work:
        work = next((w for w in works if w["file"] == args.work), None)
        if work is None:
            die(f"{args.work} is not on the shelf")
        return work
    # Eligible: not in the archive and not mined by an earlier run (never the same work
    # twice — `--retry` erases an attempt), not inside the artist cooldown.
    fresh = []
    cooled = set()
    for w in works:
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
    work = llm.pick_book(claude, fresh, archive["works"])
    log(f"- work: {work.get('author')} — {work.get('title')} ({work['kind']}, {work['file']}): {work.get('why', '')}")
    return work


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


def shortlist(claude: llm.Claude, log: Log, mined: list[str], exclude: set[str], seed: int) -> list[dict]:
    sentences = [s for s in mined if shelf_mod.sentence_key(s) not in exclude]
    if not sentences:
        die("no candidate sentence in this work")
    if len(sentences) > MAX_SENTENCES:
        sentences = random.Random(seed).sample(sentences, MAX_SENTENCES)
        log(f"- sampled {MAX_SENTENCES} of them")
    picks: list[dict] = []
    for start in range(0, len(sentences), CHUNK):
        picks.extend(llm.pick_from_chunk(claude, sentences[start:start + CHUNK], PICKS_PER_CHUNK))
    log(f"- shortlisted by the model: {len(picks)}")
    ranked = llm.rank_sentences(claude, picks, SHORTLIST)
    log(f"- ranked shortlist: {len(ranked)}")
    return ranked


def attempt(claude: llm.Claude, log: Log, sentence: str, book: dict, archive: dict,
            in_vocab, similarity, frequency_rank, lang: str, window: dict | None = None,
            quotes: list[str] = ()):
    """One sentence through the quotation test, trio search and generation. `window` is
    the raw text around it (#270), which the model CUTS into the page once the trio is
    found — so a rejected sentence never spends the call. `quotes` are the work's quoted
    lines on file (`shelf_quotes`); the strike is theirs, and the model only annotates."""
    log(f"\n## « {sentence} »")
    hit = qt.quoted(sentence, list(quotes))
    if hit:
        log(f"- rejected: a quoted line — « {hit} »")
        return None
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

    def choose(remaining, picked):
        word = llm.pick_secret(claude, tokens, remaining, picked)
        if word is None:
            return None
        key = slug(word)
        return next((t for t in remaining if t.slug == key), rules.Token(-1, word, "", "", "", -1, key))

    search_log = rules.SearchLog()
    trio = rules.search_trio(tokens, candidates, choose=choose, similarity=similarity, log=search_log)
    for event in search_log.events:
        log(f"- {event}")
    if trio is None:
        return None
    words = [t.text for t in trio]
    log(f"- trio: {' · '.join(words)}")
    # The context check, as the player sees the sentence (all three blanks): an
    # annotation for the reviewer, never a strike (see rules.CONTEXT_GUESSES).
    blanks = {t.i for t in trio}
    context: dict[str, str] = {}
    for t in trio:
        guesses = llm.context_guesses(claude, tokens, blanks - {t.i}, t.i, rules.CONTEXT_GUESSES)
        rank = next((k + 1 for k, g in enumerate(guesses)
                     if slug(g) == t.slug or (slug(g) and rules.is_variant(slug(g), t.slug))), None)
        verdict = f"guessed #{rank} from context (guesses: {', '.join(guesses)})" if rank \
            else f"not guessed from context (guesses: {', '.join(guesses) or 'none'})"
        context[t.slug] = verdict
        log(f"- context check '{t.text}': {verdict}")
    source = {"kind": book["kind"], "author": book.get("author", ""), "work": book.get("title", "")}
    excerpt = choose_page(claude, log, sentence, window) if window else None
    if excerpt:
        source["excerpt"] = excerpt
    return generate(claude, log, sentence, words, source, lang, context, frequency_rank, archive["pairs"])


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


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--lang", choices=LANGS, default="fr")
    p.add_argument("--work", help="a file name on the shelf, epub or song (skips the model's pick)")
    p.add_argument("--blind", action="store_true",
                   help="withhold the winning sentence, its secrets and their handling from the "
                        "log and stdout (they go to runs/<stamp>.spoilers.md), so the run can be "
                        "read and the puzzle played before being spoiled")
    p.add_argument("--retry", metavar="FILE",
                   help="erase a previous attempt on this shelf file — its index entry and the "
                        "candidate puzzle(s) it wrote under the generation output — then run on it")
    p.add_argument("--seed", type=int, default=None, help="sample seed (default: today)")
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
    if args.retry:
        work = next((w for w in shelf_mod.list_works() if w["file"] == args.retry), None)
        if work is None:
            die(f"{args.retry} is not on the shelf")
        for path in shelf_mod.forget(index, work, args.lang):
            log(f"- erased: {path}")
        shelf_mod.save_index(index)
        args.work = args.retry
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
    proposed = {shelf_mod.sentence_key(s) for s in index["books"].get(book["file"], {}).get("sentences", ())}
    proposed |= archive["sentences"]
    seed = args.seed if args.seed is not None else int(stamp[:10].replace("-", ""))
    similarity, frequency_rank = load_similarity(args.lang)
    mined = rich_enough(log, mine(book, text, log), args.lang, vocab.__contains__, archive["secrets"],
                        frequency_rank)
    ranked = shortlist(claude, log, mined, proposed, seed)

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
                         similarity, frequency_rank, args.lang, window, quotes)
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
