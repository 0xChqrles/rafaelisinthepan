"""One book in, one candidate puzzle out (issue #260). Never publishes.

    pnpm curate [--lang fr] [--book <file on the shelf>]

Greedy and linear: the LLM picks a book off the shelf, then sentences, then the
secrets one at a time from a list that code keeps valid (`rules.py`); a sentence
with no trio is abandoned for the next; the first sentence that survives is handed
to `gen_phrase` headless. The run's log — every rejection and its rule — is written
to `runs/<stamp>.md`, the puzzle to generation's output directory.
"""

import argparse
from datetime import datetime, timezone
import json
import random
import re
import subprocess
import sys

import _paths
from slug import slug

import llm
import rules
import shelf as shelf_mod
from parse import parse
from sentences import candidate_sentences

LANGS = ("fr",)
# Candidate sentences shown to the model per book (a random sample above this).
MAX_SENTENCES = 600
CHUNK = 150
PICKS_PER_CHUNK = 6
SHORTLIST = 20
# gen_phrase runs per sentence (one per form question the LLM answers).
MAX_GEN_RUNS = 6


class Log:
    def __init__(self, stamp: str):
        _paths.RUNS_DIR.mkdir(parents=True, exist_ok=True)
        self.path = _paths.RUNS_DIR / f"{stamp}.md"
        self.lines: list[str] = [f"# Curation run {stamp}", ""]

    def __call__(self, line: str = "") -> None:
        print(line, flush=True)
        self.lines.append(line)
        self.path.write_text("\n".join(self.lines) + "\n", encoding="utf-8")


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


def run_gen_phrase(sentence: str, words: list[str], source: dict, forms: dict[str, str], lang: str):
    cmd = ["uv", "run", "scripts/gen_phrase.py", sentence, "--lang", lang, "--words", *words]
    for key in ("kind", "author", "work"):
        if source.get(key):
            cmd += [f"--{key}", source[key]]
    for word, form in forms.items():
        cmd += ["--form", f"{word}={form}"]
    completed = subprocess.run(
        cmd, cwd=_paths.GENERATION_DIR, stdin=subprocess.DEVNULL,
        capture_output=True, text=True,
    )
    return completed, cmd


def generate(claude: llm.Claude, log: Log, sentence: str, words: list[str], source: dict, lang: str):
    """Returns the written puzzle path, or None with the reason logged."""
    forms: dict[str, str] = {}
    for _ in range(MAX_GEN_RUNS):
        completed, cmd = run_gen_phrase(sentence, words, source, forms, lang)
        if completed.returncode == 0:
            m = _WRITTEN.search(completed.stdout)
            log(f"- gen:phrase command: `{' '.join(_quote(c) for c in cmd[2:])}`")
            return m.group(1) if m else "(path not found in output)"
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


def _quote(arg: str) -> str:
    return f'"{arg}"' if " " in arg or "'" in arg else arg


# ---------------------------------------------------------------------------

def choose_book(claude: llm.Claude, log: Log, args, archive: dict, index: dict) -> dict:
    books = shelf_mod.list_books()
    if not books:
        die(f"no epub on the shelf ({_paths.SHELF_DIR})")
    if args.book:
        book = next((b for b in books if b["file"] == args.book), None)
        if book is None:
            die(f"{args.book} is not on the shelf")
        return book
    fresh = [b for b in books
             if not shelf_mod.in_archive(b, archive["works"]) and b["file"] not in index["books"]]
    if not fresh:
        die("every book on the shelf was read or is in the archive already")
    book = llm.pick_book(claude, fresh, archive["works"])
    log(f"- book: {book.get('author')} — {book.get('title')} ({book['file']}): {book.get('why', '')}")
    return book


def shortlist(claude: llm.Claude, log: Log, text: str, exclude: set[str], seed: int) -> list[dict]:
    sentences = [s for s in candidate_sentences(text) if s not in exclude]
    log(f"- candidate sentences after the mechanical filter: {len(sentences)}")
    if not sentences:
        die("no candidate sentence in this book")
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
            in_vocab, similarity, frequency_rank, lang: str):
    """One sentence through memorization test, trio search and generation."""
    log(f"\n## « {sentence} »")
    known, answer = llm.recognizes_source(claude, sentence, book.get("author", ""))
    if known:
        log(f"- rejected: the model recognizes the line ({answer.get('author')} — {answer.get('work')})")
        return None
    log(f"- memorization test: not recognized (author guess: {answer.get('author') or 'none'}; "
        f"completion: {answer.get('continuation') or 'none'})")
    tokens = parse(sentence, lang)
    candidates = rules.initial_candidates(tokens, in_vocab=in_vocab, past_secrets=archive["secrets"],
                                          frequency_rank=frequency_rank)
    log(f"- candidate words: {', '.join(t.text for t in candidates) or '(none)'}")
    if len(candidates) < rules.TRIO:
        log("- rejected: fewer than three candidate words")
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
    for t in trio:
        guesses = llm.context_guesses(claude, tokens, blanks - {t.i}, t.i, rules.CONTEXT_GUESSES)
        rank = next((k + 1 for k, g in enumerate(guesses)
                     if slug(g) == t.slug or (slug(g) and rules.is_variant(slug(g), t.slug))), None)
        log(f"- context check '{t.text}': {', '.join(guesses) or '(no guess)'}"
            + (f" → guessed #{rank}" if rank else " → not guessed"))
    source = {"kind": "book", "author": book.get("author", ""), "work": book.get("title", "")}
    return generate(claude, log, sentence, words, source, lang)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--lang", choices=LANGS, default="fr")
    p.add_argument("--book", help="an epub file name on the shelf (skips the model's pick)")
    p.add_argument("--seed", type=int, default=None, help="sample seed (default: today)")
    args = p.parse_args()

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M")
    log = Log(stamp)
    try:
        plan = llm.validate()
    except RuntimeError as exc:
        die(str(exc))
    log(f"- model: {llm.MODEL} (effort {llm.EFFORT}) on the {plan} subscription")

    vocab = set(json.loads((_paths.VOCAB_DIR / f"{args.lang}.json").read_text(encoding="utf-8")))
    archive = shelf_mod.archive(args.lang)
    index = shelf_mod.load_index()
    claude = llm.Claude()

    book = choose_book(claude, log, args, archive, index)
    from epub import epub_text

    text = epub_text(_paths.SHELF_DIR / book["file"])
    log(f"- text: {len(text.split())} words")
    proposed = set(index["books"].get(book["file"], {}).get("sentences", ())) | archive["sentences"]
    seed = args.seed if args.seed is not None else int(stamp[:10].replace("-", ""))
    ranked = shortlist(claude, log, text, proposed, seed)

    similarity, frequency_rank = load_similarity(args.lang)
    tried: list[str] = []
    result = None
    for pick in ranked:
        tried.append(pick["sentence"])
        result = attempt(claude, log, pick["sentence"], book, archive, vocab.__contains__,
                         similarity, frequency_rank, args.lang)
        if result:
            break
    shelf_mod.record(index, book["file"], tried)
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
