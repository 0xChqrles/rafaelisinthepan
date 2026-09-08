"""Which lines of a work are QUOTED — the famous-line test as a QUOTATION test, never a
memory test (user-decided 2026-09-08). The model has memorised every line of a canonical
book, which says nothing about what a reader knows; what a reader knows is on record:
the author's Wikiquote page and the work's Wikipedia article are where a French reader
meets a line without opening the book. `shelf_quotes.py` fetches those onto the shelf;
this module extracts the quoted lines from the raw wikitext and matches a candidate unit
against them. Stdlib only, tested; the curator never touches the network.
"""

from pathlib import Path
import re

import _paths
from slug import slug

QUOTES_DIR = _paths.SHELF_DIR / "quotes"
# A quoted line shorter than this is an aphorism fragment or a title, matched by chance
# too easily; skipped.
MIN_QUOTE_WORDS = 5
# A candidate is OUT when it shares this share of the SHORTER side's CONTENT words, in
# order, with a quoted line — and at least QUOTE_MIN_WORDS of them (a quote can be the
# first sentence of a two-sentence unit, or a unit the first half of a long quote).
# Content words only: French function words fall in the same order in any two sentences
# about anything, and « je ne sais pas si … veut dire … » is not a quotation of Camus.
QUOTE_MATCH = 0.6
QUOTE_MIN_WORDS = 4
_STOPWORDS = frozenset((
    "a au aux avec ce ces cet cette c d dans de des du elle elles en et eux il ils je j l la "
    "le les leur leurs lui ma mais me mes moi mon ne ni nos notre nous on ou où par pas pour "
    "qu que qui sa se ses si son sur ta te tes toi ton tu un une vos votre vous y est etait "
    "ete etre suis es sont sera serait ai as avons avez ont avait avoir fut plus tres tout "
    "toute tous toutes comme bien peu meme aussi donc alors car ici cela ca ceci"
).split())

# Name particles that two different people share.
_NAME_PARTICLES = frozenset({"de", "du", "la", "le", "les", "von", "van", "der", "as", "and", "et"})


def same_person(a: str, b: str) -> bool:
    """Two author strings name the same person when they share a real name part
    (`Camus, Albert` / `Albert Camus`; never on a particle alone)."""

    def parts(text: str) -> set[str]:
        return {slug(w) for w in re.split(r"[\s,()\-]+", text)} - {""} - _NAME_PARTICLES

    return bool({p for p in parts(a) if len(p) >= 3} & parts(b))


# ---------------------------------------------------------------------------
# Wikitext -> quoted lines

def template_params(wikitext: str, start: int) -> tuple[list[str], int]:
    """The top-level `|`-separated parameters of the template whose body starts at
    `start` (just past `{{name|`), and the index past its closing `}}`. Nested templates
    and links keep their own pipes."""
    params: list[str] = []
    depth_t = depth_l = 0
    i = cur = start
    while i < len(wikitext):
        two = wikitext[i:i + 2]
        if two == "{{":
            depth_t += 1
            i += 2
        elif two == "}}":
            if depth_t == 0:
                params.append(wikitext[cur:i])
                return params, i + 2
            depth_t -= 1
            i += 2
        elif two == "[[":
            depth_l += 1
            i += 2
        elif two == "]]":
            depth_l = max(0, depth_l - 1)
            i += 2
        elif wikitext[i] == "|" and depth_t == 0 and depth_l == 0:
            params.append(wikitext[cur:i])
            i += 1
            cur = i
        else:
            i += 1
    params.append(wikitext[cur:])
    return params, len(wikitext)


def template_bodies(wikitext: str, name: str = "citation") -> list[str]:
    """The quote of every `{{citation|...}}` template: its `citation=` parameter, else its
    first positional one. Raw wikitext, in page order."""
    out: list[str] = []
    for m in re.finditer(r"\{\{\s*" + re.escape(name) + r"\s*\|", wikitext, re.I):
        params, _ = template_params(wikitext, m.end())
        named = {}
        positional = []
        for p in params:
            key, eq, value = p.partition("=")
            if eq and re.fullmatch(r"\s*[\w\- ]+\s*", key):
                named[key.strip().lower()] = value
            else:
                positional.append(p)
        body = named.get("citation") if "citation" in named else (positional[0] if positional else "")
        body = (body or "").strip()
        if body:
            out.append(body)
    return out


def clean_markup(text: str) -> str:
    """Wiki markup out: refs, tags, inner templates, links (keeping their label), bold and
    italic quotes, entities; whitespace collapsed."""
    text = re.sub(r"<ref[^>]*>.*?</ref>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<ref[^>]*/>", " ", text, flags=re.I)
    text = re.sub(r"<br\s*/?>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    for _ in range(3):  # inner templates, a few levels deep
        text = re.sub(r"\{\{[^{}]*\}\}", " ", text)
    text = re.sub(r"\[\[[^\]|]*\|([^\]]*)\]\]", r"\1", text)
    text = re.sub(r"\[\[([^\]]*)\]\]", r"\1", text)
    text = re.sub(r"'{2,}", "", text)
    text = text.replace("&nbsp;", " ").replace(" ", " ")
    return " ".join(text.split())


def word_count(text: str) -> int:
    return len([w for w in text.split() if slug(w)])


def extract_quotes(wikitext: str, min_words: int = MIN_QUOTE_WORDS) -> list[str]:
    """Every quoted line of a page, cleaned, deduplicated, in page order: the citation
    templates (Wikiquote's own shape, used on Wikipedia too) and the « … » spans (how an
    encyclopedia article quotes an incipit)."""
    raw = template_bodies(wikitext)
    raw += re.findall(r"«\s*(.+?)\s*»", wikitext, flags=re.S)
    seen: set[str] = set()
    out: list[str] = []
    for r in raw:
        q = clean_markup(r)
        key = " ".join(slug(w) for w in q.split() if slug(w))
        if word_count(q) < min_words or key in seen:
            continue
        seen.add(key)
        out.append(q)
    return out


# ---------------------------------------------------------------------------
# The test

def _words(text: str) -> list[str]:
    """The content words of a line, as slugs — function words out."""
    return [s for s in (slug(w) for w in text.split()) if s and s not in _STOPWORDS]


def in_order_hits(short: list[str], long: list[str]) -> int:
    """How many of `short`'s words appear in `long`, in order."""
    i = hits = 0
    for w in short:
        try:
            j = long.index(w, i)
        except ValueError:
            continue
        hits += 1
        i = j + 1
    return hits


def quoted(unit: str, quotes: list[str]) -> str | None:
    """The quoted line the unit is (or contains, or is contained by), else None."""
    uw = _words(unit)
    if not uw:
        return None
    for q in quotes:
        qw = _words(q)
        if len(qw) < MIN_QUOTE_WORDS:
            continue
        short, long = (qw, uw) if len(qw) <= len(uw) else (uw, qw)
        hits = in_order_hits(short, long)
        if hits >= QUOTE_MIN_WORDS and hits / len(short) >= QUOTE_MATCH:
            return q
    return None


# ---------------------------------------------------------------------------
# The shelf file: shelf/quotes/<work file>.txt — `# source: <page>` lines, then one
# quote per line. Gitignored with the shelf.

def quotes_file(work_file: str, root: Path = QUOTES_DIR) -> Path:
    return root / f"{work_file}.txt"


def save_quotes(work_file: str, quotes: list[str], sources: list[str], root: Path = QUOTES_DIR) -> Path:
    path = quotes_file(work_file, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"# source: {s}" for s in sources] + [" ".join(q.split()) for q in quotes]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def load_quotes(work_file: str, root: Path = QUOTES_DIR) -> list[str] | None:
    """The quoted lines on file for a work; None when the fetch never ran for it."""
    path = quotes_file(work_file, root)
    if not path.exists():
        return None
    return [line.strip() for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.startswith("#")]
