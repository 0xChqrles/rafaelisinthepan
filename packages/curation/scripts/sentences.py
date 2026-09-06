"""Puzzle candidates out of a book's plain text. Stdlib only.

A candidate is a UNIT: one sentence, or a run of consecutive short sentences of one
paragraph read as one puzzle (a micro-story: the Hagakure day is two sentences, user
rule 2026-09-06 — "a puzzle can be more than one sentence, as long as it is a short
list of words with a meaning"). The filters here are the cheap, mechanical half of the
skill's step 3: the right length, self-contained, not a line of dialogue, not a roll
call of proper nouns. Taste is the LLM's job afterwards.
"""

import re

MIN_WORDS = 14
MAX_WORDS = 33
# A sentence with this many capitalised words after its first is a roll call of names,
# not a line a player can reconstruct.
MAX_INNER_CAPITALS = 2
# Consecutive sentences of one paragraph joined into one unit, at most.
MAX_SENTENCES_PER_UNIT = 3

_TERMINAL = ".!?…"
# A boundary is terminal punctuation (with optional closing quotes) followed by
# whitespace and an opening capital, quote or dash.
# A single capital letter before the period is an initial or a title (M. Dupont), not an end.
_BOUNDARY = re.compile(r"(?<=[.!?…])(?<!\b[A-Z]\.)[»”\"']?\s+(?=[«“\"'\-–—]?\s*[A-ZÀ-ÝŒÆ])")
_WS = re.compile(r"\s+")
_DIALOGUE = re.compile(r"^[«\"“]?\s*[-–—]")


def paragraph_sentences(text: str) -> list[list[str]]:
    """The text as paragraphs of sentences; a paragraph break is always a boundary."""
    out: list[list[str]] = []
    for paragraph in re.split(r"\n\s*\n|\n", text):
        paragraph = _WS.sub(" ", paragraph).strip()
        if not paragraph:
            continue
        sentences = [part.strip() for part in _BOUNDARY.split(paragraph) if part.strip()]
        if sentences:
            out.append(sentences)
    return out


def split_sentences(text: str) -> list[str]:
    return [s for paragraph in paragraph_sentences(text) for s in paragraph]


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
    # A capital that opens a sentence inside the unit is not a proper noun.
    inner_capitals = sum(1 for prev, w in zip(words, words[1:])
                         if w[:1].isupper() and prev.rstrip("»”\"'")[-1:] not in _TERMINAL)
    if inner_capitals > MAX_INNER_CAPITALS:
        return False
    return True


def candidate_sentences(text: str, **kwargs) -> list[str]:
    """Distinct candidate UNITS of a text, in reading order: per starting sentence, the
    shortest run of consecutive sentences of its paragraph (at most
    MAX_SENTENCES_PER_UNIT) that reaches the length band and passes the filter."""
    seen: set[str] = set()
    out: list[str] = []
    for paragraph in paragraph_sentences(text):
        for start in range(len(paragraph)):
            for n in range(1, MAX_SENTENCES_PER_UNIT + 1):
                if start + n > len(paragraph):
                    break
                unit = " ".join(paragraph[start:start + n])
                if word_count(unit) > kwargs.get("max_words", MAX_WORDS):
                    break
                if is_candidate(unit, **kwargs):
                    if unit not in seen:
                        seen.add(unit)
                        out.append(unit)
                    break
    return out
