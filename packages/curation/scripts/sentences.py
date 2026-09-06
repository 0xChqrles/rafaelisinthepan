"""Sentence candidates out of a book's plain text. Stdlib only.

One sentence per candidate (multi-sentence micro-stories are not mined in V1). The
filters here are the cheap, mechanical half of the skill's step 3: the right length,
self-contained, not a line of dialogue, not a roll call of proper nouns. Taste is the
LLM's job afterwards.
"""

import re

MIN_WORDS = 14
MAX_WORDS = 33
# A sentence with this many capitalised words after its first is a roll call of names,
# not a line a player can reconstruct.
MAX_INNER_CAPITALS = 2

_TERMINAL = ".!?…"
# A boundary is terminal punctuation (with optional closing quotes) followed by
# whitespace and an opening capital, quote or dash.
# A single capital letter before the period is an initial or a title (M. Dupont), not an end.
_BOUNDARY = re.compile(r"(?<=[.!?…])(?<!\b[A-Z]\.)[»”\"']?\s+(?=[«“\"'\-–—]?\s*[A-ZÀ-ÝŒÆ])")
_WS = re.compile(r"\s+")
_DIALOGUE = re.compile(r"^[«\"“]?\s*[-–—]")


def split_sentences(text: str) -> list[str]:
    """Split plain text into sentences; a paragraph break is always a boundary."""
    out: list[str] = []
    for paragraph in re.split(r"\n\s*\n|\n", text):
        paragraph = _WS.sub(" ", paragraph).strip()
        if not paragraph:
            continue
        out.extend(part.strip() for part in _BOUNDARY.split(paragraph) if part.strip())
    return out


def word_count(sentence: str) -> int:
    return len(re.findall(r"[^\s]+", sentence))


def is_candidate(sentence: str, *, min_words: int = MIN_WORDS, max_words: int = MAX_WORDS) -> bool:
    """The mechanical filter: length band, opens on a capital or quote, closes on
    terminal punctuation, no dialogue dash, no roll call of names, no digits."""
    n = word_count(sentence)
    if n < min_words or n > max_words:
        return False
    if not sentence[0].isupper() and sentence[0] not in "«\"“":
        return False
    if sentence.rstrip("»”\"'")[-1:] not in _TERMINAL:
        return False
    if _DIALOGUE.match(sentence):
        return False
    if re.search(r"\d", sentence):
        return False
    words = sentence.split()
    inner_capitals = sum(1 for w in words[1:] if w[:1].isupper())
    if inner_capitals > MAX_INNER_CAPITALS:
        return False
    return True


def candidate_sentences(text: str, **kwargs) -> list[str]:
    """Distinct candidate sentences of a text, in reading order."""
    seen: set[str] = set()
    out: list[str] = []
    for sentence in split_sentences(text):
        if sentence in seen or not is_candidate(sentence, **kwargs):
            continue
        seen.add(sentence)
        out.append(sentence)
    return out
