"""The start word must leave the displayed sentence valid French (user rule
2026-09-06: « l'effet », never « le effet »). Pure helpers: the displayed sentence, the
mechanical elision rule, the band candidates a re-pick chooses from. The grammar
judgement itself is the model's (`llm.grammar_check`).
"""

import _paths  # noqa: F401
from slug import slug
from start_word import START_RANK_MAX, START_RANK_MIN, is_variant

# Words that elide before a vowel: « le effet » is never French.
ELIDING = frozenset({"le", "la", "de", "ne", "que", "se", "ce", "je", "me", "te",
                     "jusque", "lorsque", "puisque", "quoique"})
_VOWELS = "aeiouyàâäéèêëíìîïóòôöúùûüœæ"
_PUNCT = "«»\"'’“”(),.;:!?…"
# Re-pick rounds before the run gives the start up to the reviewer.
START_ROUNDS = 3
# Candidates shown to the model for one re-pick.
START_OPTIONS = 40


def displayed(words: list[str], holes: list[dict], starts: dict[str, str] | None = None) -> str:
    """The sentence as the player first sees it: each hole shows its start word (or the
    override in `starts`, keyed by secret slug) between its display affixes."""
    starts = starts or {}
    out = list(words)
    for h in holes:
        word = starts.get(h["secret"]["slug"], h["start"]["word"])
        out[h["pos"]] = h.get("prefix", "") + word + h.get("suffix", "")
    return " ".join(out)


def previous_token(words: list[str], hole: dict) -> str:
    """What precedes the start word in display: the hole's own prefix when it has one,
    else the previous word of the sentence."""
    if hole.get("prefix"):
        return hole["prefix"]
    return words[hole["pos"] - 1] if hole["pos"] > 0 else ""


def elision_problem(prev: str, word: str) -> str | None:
    """The one grammar rule code can apply with certainty. An `h` is left to the model
    (h muet elides, h aspiré does not)."""
    if not word:
        return None
    p = prev.lower().strip(_PUNCT)
    first = word[0].lower()
    if p in ELIDING and first in _VOWELS:
        return f"« {prev} {word} » : « {prev} » s'élide devant une voyelle"
    if prev.rstrip().endswith(("'", "’")) and first not in _VOWELS and first != "h":
        return f"« {prev}{word} » : l'élision demande une voyelle"
    return None


def start_candidates(rank_map: dict, secret_slug: str, prev: str, exclude=()) -> list[dict]:
    """The band's words for one hole (rank START_RANK_MIN..MAX, one per display word,
    no variant of the secret) that pass the elision rule, nearest first:
    [{word, rank}]."""
    seen: set[str] = set()
    out = []
    for key, entry in rank_map.items():
        rank = entry.get("rank", 0)
        word = entry.get("word", key)
        if not START_RANK_MIN <= rank <= START_RANK_MAX or word in seen:
            continue
        if is_variant(slug(word), secret_slug) or word in exclude:
            continue
        if elision_problem(prev, word) is not None:
            continue
        seen.add(word)
        out.append({"word": word, "rank": rank})
    out.sort(key=lambda e: e["rank"])
    return out
