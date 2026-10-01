"""Pure helpers for the start words: the displayed sentence, and the band candidates
the model chooses from — only words that can stand after the token before the hole,
by the one rule the letters decide in each language (French elision: « le effet » is
never French; the English article: never « a effect », #317). Whether the displayed
sentence reads right — correct, and still meaning something — is the model's
(`llm.sentence_check`).
"""

import _paths  # noqa: F401
from slug import slug
from start_word import START_BAND, is_variant
from rules import PLAIN_WORD_RANK

# Words that elide before a vowel: « le effet » is never French.
ELIDING = frozenset({"le", "la", "de", "ne", "que", "se", "ce", "je", "me", "te",
                     "jusque", "lorsque", "puisque", "quoique"})
_VOWELS = "aeiouàâäéèêëíìîïóòôöúùûüœæ"
# Initials whose elision the letter does not decide (« l'homme », « le hasard »; « le yaourt »,
# « l'yeuse »): left to the model.
_MODEL_JUDGED = "hy"
_PUNCT = "«»\"'‘’“”(),.;:!?…"
# Re-pick rounds before the run gives the start up to the reviewer.
START_ROUNDS = 3
# Candidates shown to the model for one re-pick.
START_OPTIONS = 40
# A start word past this place in the corpus frequency order is too rare to be a plain
# word a player knows (« hétéroptère » is out, « bestiole » is in) — ONE boundary with the
# obviousness filter's plain-word test (`rules.PLAIN_WORD_RANK`).
MAX_START_FREQ_RANK = PLAIN_WORD_RANK


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


# English's twin of elision (#317): « a » before a consonant SOUND, « an » before a vowel
# sound — sounds, not letters, decide (an hour, a university, a one-off, a euro, an x-ray,
# an FBI agent). The letters make it certain only here: after « a », an initial a or i,
# an e not led into a « you » sound (eu, ew), an o not led into a « w » sound (one, once,
# oui); after « an », an initial whose own name starts with a consonant sound too (b, c,
# d…: read as a word or spelled as letters, it takes « a »). The rest — h, u, y, the
# letters an acronym spells — is the model's.
_A_BEFORE = "aeio"
_A_UNSURE = ("eu", "ew", "one", "once", "oui")
_AN_BEFORE = "bcdgjkpqtvwz"


def article_problem(prev: str, word: str) -> str | None:
    """The one article rule code can apply with certainty, off the letters."""
    if not word:
        return None
    p = prev.lower().strip(_PUNCT)
    w = word.lower()
    if p == "a" and w[0] in _A_BEFORE and not w.startswith(_A_UNSURE):
        return f"« {prev} {word} »: « {word} » opens on a vowel sound, it takes « an »"
    if p == "an" and w[0] in _AN_BEFORE:
        return f"« {prev} {word} »: « {word} » opens on a consonant sound, it takes « a »"
    return None


# The rule the letters decide, per language.
_LETTER_RULES = {"fr": elision_problem, "en": article_problem}


def letter_problem(prev: str, word: str, lang: str) -> str | None:
    """What the language's mechanical rule refuses in « prev word »: French elision, the
    English article. None when the letters leave nothing certain."""
    return _LETTER_RULES[lang](prev, word)


def start_candidates(rank_map: dict, secret_slug: str, prev: str, exclude=(),
                     frequency_rank=lambda word: None, *, lang: str) -> list[dict]:
    """The band's words for one hole (rank START_BAND, 100-200 on every map since
    2026-09-24 — one per display word, no variant of the secret, not too rare) that
    pass the language's letter rule (`letter_problem`), nearest first: [{word, rank}].
    `frequency_rank(word)` reads the corpus order (None = unknown, kept)."""
    seen: set[str] = set()
    out = []
    lo, hi = START_BAND
    for key, entry in rank_map.items():
        rank = entry.get("rank", 0)
        word = entry.get("word", key)
        if not lo <= rank <= hi or word in seen:
            continue
        if is_variant(slug(word), secret_slug) or word in exclude:
            continue
        if letter_problem(prev, word, lang) is not None:
            continue
        freq = frequency_rank(word)
        if freq is not None and freq > MAX_START_FREQ_RANK:
            continue
        seen.add(word)
        out.append({"word": word, "rank": rank})
    out.sort(key=lambda e: e["rank"])
    return out
