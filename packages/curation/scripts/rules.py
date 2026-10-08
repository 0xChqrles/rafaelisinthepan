"""The FACTS code keeps about a candidate secret, as pure functions over a parsed sentence.

TASTE CHOOSES, CODE STATES FACTS (2026-09-24): which line, which three words and which
start words make a day is the model's call, read off the `taste` skill. Code only says
which words CAN be a secret (`initial_candidates`: a content word the game admits, not
in its cooldown) and turns what it measures into plain notes the model reads — what a
reader would put in a blank (`reading`), whether a player who has the meaning would say
the word (`said`), where the reader's words land in the hole's own map
(`map_nearest_filler`). Nothing here refuses a trio. The judgements are injected as
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
# (user-decided 2026-09-08, on a trio led by « je crois »). By spaCy lemma, per language:
# the English list is the French one translated, word for word (#317).
WEAK_VERBS = {
    "fr": frozenset({
        "dire", "croire", "penser", "savoir", "sembler", "paraître", "vouloir", "pouvoir",
        "devoir", "falloir", "trouver", "avoir", "être", "faire", "aller",
    }),
    "en": frozenset({
        "say", "believe", "think", "know", "seem", "appear", "want", "can",
        "must", "need", "find", "have", "be", "do", "make", "go",
    }),
}
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
# The WORD PLAYERS SAY (the user's test, 2026-10-06): would a player who has roughly the
# meaning ever say this word, or keep to commoner words meaning nearly the same
# (`llm.would_say`, the chance they say it)? Asked blind of 123 French holes played
# 2026-08-26 → 10-05, it told the holes fewer than half the players found within 30 tries
# from the rest at AUC 0.84 (two runs, 0.81 and 0.86, agreeing at 0.93; the giveaway
# score: 0.70). Under WOULD_SAY_HARD sat 25 holes, found within 30 tries by a median 41 %
# of the players against 76 % above. ONE such word is a hard day the user may love
# (« moucheron », « mammifères », « stagnation », « cafard » sit under it); TWO or more
# made the worst days: finished by a median 40 % of the players (6 days, none reaching
# the taste's 70 %), against 57 % with one (12) and 71 % with none (23) —
# « faux-monnayeur » (0.30) shared 2026-10-05 with a second one, and 30 % finished it.
WOULD_SAY_HARD = 0.4
# Secrets per puzzle (the sentence schema: exactly three distinct slugs).
TRIO = 3


@dataclass(frozen=True)
class Token:
    i: int
    text: str
    lemma: str
    pos: str
    slug: str
    stop: bool = False
    # The whitespace after the token in the source (spaCy's `whitespace_`): an English
    # line is rebuilt with it (« don't », « the dog's »), never with a space per token.
    space: str = " "


def initial_candidates(
    tokens: list[Token],
    *,
    lang: str,
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
        if t.pos == "VERB" and t.lemma in WEAK_VERBS[lang]:
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


def same_word(candidate: Token, other: str | None) -> bool:
    """Whether the word players would say instead IS this word in another form (« sauver »
    for « sauva »): its spelling, its lemma or a variant. Typing it finds the hole, since a
    ranked group holds every form of a word — so the hidden word is said. Never a near
    neighbour (« faussaire » for « faux-monnayeur »): that is another word, in its own group."""
    if not other or " " in other.strip():
        return False
    s = slug(other)
    return s in (candidate.slug, slug(candidate.lemma or "")) or is_variant(s, candidate.slug)


def said(chance: float | None, instead: str | None, same: bool = False) -> str:
    """What the would-say test means for this hole, in one plain line for the model: the
    chance a player who has the meaning says this exact word, and the commoner word they
    would keep saying — unless that word is this one in another form (`same_word`)."""
    if same:
        return (f"players would say « {instead} », this same word in another form: typing it "
                f"finds the hole, so it is a word players say")
    if chance is None:
        return "whether players would say this word: not measured"
    note = f"a player who has the meaning says this exact word at {chance:.2f}"
    if instead:
        note += f" (they would keep saying « {instead} »)"
    if chance < WOULD_SAY_HARD:
        note += f", under {WOULD_SAY_HARD}: a word players don't say"
    return note


# A BURIED word (user-decided 2026-10-08, after « charnier »): players only half-say it
# (would-say at most BURIED_WOULD_SAY) and it sits among commoner near-words (at least
# BURIED_CROWD of its CROWD_N nearest groups on the plain, embedding-only map are more
# common in the corpus). Players reach the idea, then circle the commoner neighbours and
# stall: on 126 played French holes, half-said words in such a crowd stalled players about
# twice as often (a run of 10 guesses with no new best: 33% against 18%), rarity aside.
# A rare NAME passes (« saint-bernard », said at 0.58); a rare stand-in does not
# (« faux-monnayeur », « charnier »). Code refuses it — the second veto after the giveaway floor.
BURIED_WOULD_SAY = 0.50
BURIED_CROWD = 0.70
CROWD_N = 30


def crowd_share(rank_map: dict, index_of: Callable[[str], int | None]) -> float | None:
    """The share of the secret's CROWD_N nearest groups in `rank_map` (a map's shape:
    key -> {rank, ...}, rank 0 the secret) that are more common than the secret's own
    group; a group's commonness is the corpus position of its commonest key
    (`index_of(slug)`, lower = commoner). A group with no known key is left out of the
    share. None when the secret's group or every neighbour is unknown."""
    groups: dict[int, list[int]] = {}
    for key, entry in rank_map.items():
        i = index_of(key.split(":", 1)[0])
        groups.setdefault(entry["rank"], []).extend([] if i is None else [i])
    if not groups.get(0):
        return None
    secret = min(groups[0])
    near = [min(groups[r]) for r in sorted(r for r in groups if r >= 1)[:CROWD_N] if groups[r]]
    return round(sum(i < secret for i in near) / len(near), 3) if near else None


def buried(chance: float | None, crowd: float | None) -> bool:
    """Whether a hidden word is BURIED: half-said and among commoner near-words."""
    return chance is not None and crowd is not None and chance <= BURIED_WOULD_SAY and crowd >= BURIED_CROWD


def crowd_note(crowd: float | None) -> str:
    if crowd is None:
        return "its crowd of commoner near-words: not measured"
    n = round(crowd * CROWD_N)
    return f"{n} of its {CROWD_N} nearest words on the plain map are more common than it"


def unsaid(chances: dict[str, float | None]) -> str | None:
    """The trio's fact when it hides two or more words players don't say (under
    WOULD_SAY_HARD), keyed by the hidden word; None when it hides one or none."""
    under = [w for w, c in chances.items() if c is not None and c < WOULD_SAY_HARD]
    if len(under) < 2:
        return None
    return (f"this trio hides {len(under)} words players don't say ({', '.join(under)}): on real play the "
            f"days with two or more were finished by a median 40% of the players (none reached 70%), against "
            f"57% with one and 71% with none")


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
