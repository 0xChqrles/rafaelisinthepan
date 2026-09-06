"""The trio rules as pure functions over a parsed sentence.

The LLM never sees an invalid option: `initial_candidates` builds the list it picks
from, `prune` shrinks the list after every pick, and `search_trio` drives the pick /
context-test / prune loop with the two LLM judgements injected as callables — so the
whole search is testable without a parser, a model or a vector file.

Tunables live here, in one place (issue #260).
"""

from dataclasses import dataclass, field
from typing import Callable

import _paths  # noqa: F401  (generation's scripts on sys.path)
from start_word import is_variant

# Parts of speech a secret may carry (spaCy Universal POS tags).
ALLOWED_POS = frozenset({"NOUN", "VERB", "ADJ", "ADV"})
# Frequency floors (0-based rank in the reduced vectors' frequency order): a secret is
# never one of the commonest words (`bien` 3, `très` 4, `tout` 1 — `temps` 21 was a
# secret), and an adverb, the function-like class, must be a real word (`encore` 24,
# `toujours` 59, `jamais` 158 are out; `pensivement` was a secret).
MAX_COMMON_RANK = 20
MAX_COMMON_RANK_ADV = 500
# Two secrets closer than this many tokens are "the same part of the sentence".
MIN_GAP = 3
# Two secrets above this cosine similarity are "too similar".
COSINE_MAX = 0.40
# Sibling dependents of one head that describe the same thing (ADJ + ADJ on one noun,
# a noun and its complement); coordinated siblings (`conj`) are deliberately NOT here —
# a list of nouns is a good spread (Perec's rideaux · palissades · fantômes).
MODIFIER_DEPS = frozenset({"amod", "nmod", "appos", "acl", "advmod"})
# How many times a sentence is retried with its exhausted first pick struck.
MAX_RESTARTS = 2
# Consecutive picks off the list before the model is taken to have declined.
MAX_OFF_LIST = 2
# Guesses the context check asks for, per finished secret, for the run log. It is an
# ANNOTATION, never a strike: calibrated 2026-09-06 on the 12 real-player days (medians
# 7–23), the model's three guesses held the true secret 18 times out of 34, its first
# guess 13 times — a strike on either would reject most trios that play well.
CONTEXT_GUESSES = 3
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


def _dep_family(dep: str) -> str:
    return dep.split(":", 1)[0]


def initial_candidates(
    tokens: list[Token],
    *,
    in_vocab: Callable[[str], bool],
    past_secrets: frozenset[str] | set[str] = frozenset(),
    frequency_rank: Callable[[Token], int | None] = lambda t: None,
) -> list[Token]:
    """Tokens the LLM may pick first: an allowed POS, not a stopword or one of the
    commonest words, a slug the game admits and has not used, and no same-lemma twin
    under another slug visible in the sentence (a same-slug repeat is fine: one hole
    per occurrence). `frequency_rank` reads the word's place in the corpus (None =
    unknown, which is not a reason to drop it)."""
    lemma_slugs: dict[str, set[str]] = {}
    for t in tokens:
        if t.lemma:
            lemma_slugs.setdefault(t.lemma, set()).add(t.slug)
    out = []
    for t in tokens:
        if t.pos not in ALLOWED_POS or t.stop:
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


def prune(
    candidates: list[Token],
    pick: Token,
    tokens: list[Token],
    *,
    similarity: Callable[[Token, Token], float | None],
) -> list[Token]:
    """The list after a pick: drop the pick and its other occurrences, every verb when
    the pick is a verb, the pick's head and dependents, its modifier siblings, its
    neighbours within MIN_GAP, its lemma / morphological variants, and anything the
    vectors put above COSINE_MAX to it."""
    by_index = {t.i: t for t in tokens}
    head = by_index.get(pick.head)
    out = []
    for c in candidates:
        if c.slug == pick.slug:
            continue
        if pick.pos == "VERB" and c.pos == "VERB":
            continue
        if c.i == pick.head or c.head == pick.i:
            continue
        if (
            head is not None
            and c.head == pick.head
            and c.i != pick.i
            and _dep_family(c.dep) in MODIFIER_DEPS
            and _dep_family(pick.dep) in MODIFIER_DEPS
        ):
            continue
        if abs(c.i - pick.i) < MIN_GAP:
            continue
        if (c.lemma and c.lemma == pick.lemma) or is_variant(c.slug, pick.slug):
            continue
        sim = similarity(c, pick)
        if sim is not None and sim > COSINE_MAX:
            continue
        out.append(c)
    return out


@dataclass
class SearchLog:
    """What happened, for the run log: every strike names its rule."""
    events: list[str] = field(default_factory=list)

    def note(self, msg: str) -> None:
        self.events.append(msg)


def search_trio(
    tokens: list[Token],
    candidates: list[Token],
    *,
    choose: Callable[[list[Token], list[Token]], Token | None],
    similarity: Callable[[Token, Token], float | None],
    log: SearchLog | None = None,
    max_restarts: int = MAX_RESTARTS,
) -> list[Token] | None:
    """Greedy, constraint-propagated search for TRIO secrets.

    `choose(remaining, picked)` is the LLM's pick (None = it declines the list). An
    empty list before the trio is complete restarts the sentence with the first pick
    struck, at most `max_restarts` times. Returns the trio, or None when the sentence
    has no trio."""
    log = log or SearchLog()
    banned_first: set[str] = set()
    for attempt in range(max_restarts + 1):
        remaining = [c for c in candidates if c.slug not in banned_first]
        picked: list[Token] = []
        off_list = 0
        while len(picked) < TRIO:
            if not remaining:
                break
            pick = choose(remaining, picked)
            if pick is None:
                log.note("the model declined every remaining word")
                break
            if pick.slug not in {c.slug for c in remaining}:
                off_list += 1
                log.note(f"'{pick.text}' is not on the list — ignored")
                if off_list >= MAX_OFF_LIST:
                    log.note("the model keeps answering off the list — taken as a decline")
                    break
                continue
            off_list = 0
            picked.append(pick)
            before = len(remaining)
            remaining = prune(remaining, pick, tokens, similarity=similarity)
            log.note(f"picked '{pick.text}' ({pick.pos.lower()}); {before - 1 - len(remaining)} "
                     f"word(s) pruned, {len(remaining)} left")
        if len(picked) == TRIO:
            return picked
        if not picked:
            log.note("no first pick possible")
            return None
        banned_first.add(picked[0].slug)
        if attempt < max_restarts:
            log.note(f"dead end after {len(picked)} pick(s); restart {attempt + 1}/{max_restarts} "
                     f"with '{picked[0].text}' struck")
        else:
            log.note(f"dead end after {len(picked)} pick(s); no restart left")
    log.note("no trio for this sentence")
    return None
