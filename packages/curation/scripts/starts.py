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
_VOWELS = "aeiouàâäéèêëíìîïóòôöúùûüœæ"
# Initials whose elision the letter does not decide (« l'homme », « le hasard »; « le yaourt »,
# « l'yeuse »): left to the model's grammar check.
_MODEL_JUDGED = "hy"
_PUNCT = "«»\"'’“”(),.;:!?…"
# Re-pick rounds before the run gives the start up to the reviewer.
START_ROUNDS = 3
# Candidates shown to the model for one re-pick.
START_OPTIONS = 40
# A start word past this place in the corpus frequency order is too rare to be a plain
# word a player knows (« hétéroptère » is out, « bestiole » is in).
MAX_START_FREQ_RANK = 40000
# A HARD hole — one the context check could not guess at all — opens its band down to
# this rank (user-decided 2026-09-08, on a « vertus » started at 105 that read as
# unguessable): the player gets a quite similar word to start from. The ordinary band
# stays generation's START_RANK_MIN..MAX.
NEAR_START_RANK_MIN = 20


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
    """The one grammar rule code can apply with certainty. An `h` or a `y` is left to
    the model (h muet elides, h aspiré does not; « le yaourt » but « l'yeuse »)."""
    if not word:
        return None
    p = prev.lower().strip(_PUNCT)
    first = word[0].lower()
    if p in ELIDING and first in _VOWELS:
        return f"« {prev} {word} » : « {prev} » s'élide devant une voyelle"
    if prev.rstrip().endswith(("'", "’")) and first not in _VOWELS and first not in _MODEL_JUDGED:
        return f"« {prev}{word} » : l'élision demande une voyelle"
    return None


def start_candidates(rank_map: dict, secret_slug: str, prev: str, exclude=(),
                     frequency_rank=lambda word: None, rank_min: int = START_RANK_MIN) -> list[dict]:
    """The band's words for one hole (rank `rank_min`..START_RANK_MAX, one per display
    word, no variant of the secret, not too rare) that pass the elision rule, nearest
    first: [{word, rank}]. `frequency_rank(word)` reads the corpus order (None = unknown,
    kept). `rank_min` is START_RANK_MIN, or NEAR_START_RANK_MIN for a hard hole."""
    seen: set[str] = set()
    out = []
    for key, entry in rank_map.items():
        rank = entry.get("rank", 0)
        word = entry.get("word", key)
        if not rank_min <= rank <= START_RANK_MAX or word in seen:
            continue
        if is_variant(slug(word), secret_slug) or word in exclude:
            continue
        if elision_problem(prev, word) is not None:
            continue
        freq = frequency_rank(word)
        if freq is not None and freq > MAX_START_FREQ_RANK:
            continue
        seen.add(word)
        out.append({"word": word, "rank": rank})
    out.sort(key=lambda e: e["rank"])
    return out
