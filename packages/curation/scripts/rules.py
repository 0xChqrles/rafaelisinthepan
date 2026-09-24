"""The FACTS code keeps about a candidate secret, as pure functions over a parsed sentence.

TASTE CHOOSES, CODE STATES FACTS (2026-09-24): which line, which three words and which
start words make a day is the model's call, read off the `taste` skill. Code only says
which words CAN be a secret (`initial_candidates`: a content word the game admits, not
in its cooldown) and turns what it measures into plain notes the model reads — what a
reader would put in a blank (`reading`), where the reader's words land in the hole's own
map (`map_nearest_filler`). Nothing here refuses a trio. The judgements are injected as
callables, so everything is testable without a parser, a model or a vector file.
"""

from dataclasses import dataclass
from typing import Callable

import _paths  # noqa: F401  (generation's scripts on sys.path)
from slug import slug
from start_word import is_variant

# Parts of speech a secret may carry (spaCy Universal POS tags). PROPN too: the parser
# tags a lowercase brand or a rare noun as a proper noun (« les rolex », « en zigzag »,
# both secrets of a favourite day); a character's name nobody can reason toward is
# taste's call, not code's.
ALLOWED_POS = frozenset({"NOUN", "VERB", "ADJ", "ADV", "PROPN"})
# Frequency floors (0-based rank in the reduced vectors' frequency order): a secret is
# never one of the commonest words (`bien` 3, `très` 4, `tout` 1 — `temps` 21 was a
# secret), and an adverb, the function-like class, must be a real word (`encore` 24,
# `toujours` 59, `jamais` 158 are out; `pensivement` was a secret).
MAX_COMMON_RANK = 20
MAX_COMMON_RANK_ADV = 500
# Verbs of saying, thinking and modality — function-like, never a clever secret
# (user-decided 2026-09-08, on a trio led by « je crois »). By spaCy lemma.
WEAK_VERBS = frozenset({
    "dire", "croire", "penser", "savoir", "sembler", "paraître", "vouloir", "pouvoir",
    "devoir", "falloir", "trouver", "avoir", "être", "faire", "aller",
})
# The READER (the user's own method, 2026-09-10): blank one word, the rest of the line
# intact and no start word, and ask what else could stand there — at most
# CONTEXT_GUESSES words — and which ONE word most readers would write. A filler that is
# a TWIN of the secret — a variant, or a word within TWIN_RANK of it in the game's own
# ranking (« clés »/« clefs », « certainement »/« sûrement ») — is the secret again, not
# an alternative. What the reader says is a NOTE for the model (`reading`), not a verdict.
CONTEXT_GUESSES = 6
TWIN_RANK = 3
# A word past this corpus rank is not "a word a player knows" (the start band's boundary,
# `starts.MAX_START_FREQ_RANK`): a reader's expected word there is the model's
# knowledge, not every player's.
PLAIN_WORD_RANK = 40000
# Secrets per puzzle (the sentence schema: exactly three distinct slugs).
TRIO = 3


@dataclass(frozen=True)
class Token:
    i: int
    text: str
    lemma: str
    pos: str
    dep: str
    head: int
    slug: str
    stop: bool = False


def initial_candidates(
    tokens: list[Token],
    *,
    in_vocab: Callable[[str], bool],
    past_secrets: frozenset[str] | set[str] = frozenset(),
    frequency_rank: Callable[[Token], int | None] = lambda t: None,
) -> list[Token]:
    """The words that CAN be a secret: an allowed POS, not a stopword, a weak verb or one
    of the commonest words, a slug the game admits and has not used (a hyphenated
    compound included — « post-it »), and no same-lemma twin under another slug visible
    in the sentence (a same-slug repeat is fine: one hole per occurrence).
    `frequency_rank` reads the word's place in the corpus (None = unknown, which is not a
    reason to drop it)."""
    lemma_slugs: dict[str, set[str]] = {}
    for t in tokens:
        if t.lemma:
            lemma_slugs.setdefault(t.lemma, set()).add(t.slug)
    out = []
    for t in tokens:
        if t.pos not in ALLOWED_POS or t.stop:
            continue
        if t.pos == "VERB" and t.lemma in WEAK_VERBS:
            continue
        if len(t.slug) < 2 or not in_vocab(t.slug):
            continue
        rank = frequency_rank(t)
        if rank is not None and rank < (MAX_COMMON_RANK_ADV if t.pos == "ADV" else MAX_COMMON_RANK):
            continue
        if t.slug in past_secrets:
            continue
        if t.lemma and len(lemma_slugs.get(t.lemma, ())) > 1:
            continue
        out.append(t)
    return out


def is_twin(candidate: Token, word: str, neighbour_rank: Callable[[Token, str], int | None]) -> bool:
    """`word` is the candidate's secret in another form: the same slug, a morphological
    variant, or within TWIN_RANK of it in the game's ranking (`neighbour_rank(token,
    word)`, None = unknown, which is not a twin)."""
    s = slug(word)
    if s and (s == candidate.slug or is_variant(s, candidate.slug)):
        return True
    rank = neighbour_rank(candidate, word)
    return rank is not None and rank <= TWIN_RANK


def reading(
    candidate: Token,
    guesses: list[str],
    expected: str | None,
    *,
    neighbour_rank: Callable[[Token, str], int | None] = lambda t, w: None,
    frequency_rank: Callable[[Token], int | None] = lambda t: None,
) -> str:
    """What the reader's answer means for this hole, in one plain line for the model: the
    other words a reader could put there (twins folded into the secret), and whether
    most readers would write the secret itself — a word the context hands over — which
    only counts for a word players know (`frequency_rank` at or under PLAIN_WORD_RANK)."""
    others = list(dict.fromkeys(g for g in [*guesses, *([expected] if expected else [])]
                                if slug(g) and not is_twin(candidate, g, neighbour_rank)))
    rank = frequency_rank(candidate)
    known = rank is None or rank <= PLAIN_WORD_RANK
    if expected and is_twin(candidate, expected, neighbour_rank) and known:
        lead = "most readers would write the secret itself"
    elif expected:
        lead = f"most readers would write « {expected} »"
    else:
        lead = "readers would split"
    alternatives = ", ".join(others) if others else "nothing else"
    return f"{lead}; other words a reader puts there: {alternatives}"


def map_nearest_filler(rank_map: dict, secret_slug: str, fillers: list[str]) -> tuple[str, int | None] | None:
    """The reader's filler nearest the secret in the hole's OWN map, as (word, rank); the
    rank is None for a word past the map (farther than every ranked group). None when the
    reader named no single-word filler — a multi-word filler cannot be typed, and the
    secret itself and its variants are not fillers."""
    best: tuple[str, int | None] | None = None
    for w in fillers:
        s = slug(w)
        if not s or " " in w.strip() or s == secret_slug or is_variant(s, secret_slug):
            continue
        entry = rank_map.get(s)
        rank = entry["rank"] if entry else None
        if best is None or (rank is not None and (best[1] is None or rank < best[1])):
            best = (w, rank)
    return best
