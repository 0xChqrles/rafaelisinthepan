"""The FACTS code keeps about a candidate secret, as pure functions over a parsed sentence.

TASTE CHOOSES, CODE STATES FACTS (2026-09-24): which line, which three words and which
start words make a day is the model's call, read off the `taste` skill. Code only says
which words CAN be a secret (`initial_candidates`: a content word the game admits, not
in its cooldown), turns what it measures into plain notes the model reads — what a
reader would put in a blank (`reading`), whether a player who has the meaning would say
the word (`said`), where the reader's words land in the hole's own map
(`map_nearest_filler`) — and names the facts that hold against a trio, its main word
first (`trio_faults`). How hard a day plays is the difficulty forecast's (`difficulty.py`). The judgements are injected as callables, so everything is
testable without a parser, a model or a vector file.
"""

from dataclasses import dataclass
from decimal import ROUND_DOWN, Decimal
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
# of the players against 76 % above. A NOTE for the model (`said`): how many such words a
# day may hold is the taste's (« moucheron », « mammifères », « stagnation », « cafard » sit
# under it), and how hard the day plays is the difficulty forecast's (`difficulty.py`).
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


def reader_writes(
    candidate: Token,
    expected: str | None,
    *,
    neighbour_rank: Callable[[Token, str], int | None] = lambda t, w: None,
    frequency_rank: Callable[[Token], int | None] = lambda t: None,
) -> bool:
    """Whether most readers would write the secret itself in its blank (`expected`, twins
    folded): the line hands the word over. Only for a word players know (`frequency_rank`
    at or under PLAIN_WORD_RANK): an idiom the model completes with a rare word is not one
    every player knows."""
    rank = frequency_rank(candidate)
    known = rank is None or rank <= PLAIN_WORD_RANK
    return bool(expected) and known and is_twin(candidate, expected, neighbour_rank)


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
    most readers would write the secret itself (`reader_writes`)."""
    others = list(dict.fromkeys(g for g in [*guesses, *([expected] if expected else [])]
                                if slug(g) and not is_twin(candidate, g, neighbour_rank)))
    if reader_writes(candidate, expected, neighbour_rank=neighbour_rank, frequency_rank=frequency_rank):
        lead = "most readers would write the secret itself"
    elif expected:
        lead = f"most readers would write « {expected} »"
    else:
        lead = "readers would split"
    alternatives = ", ".join(others) if others else "nothing else"
    return f"{lead}; other words a reader puts there: {alternatives}"


def same_word(candidate: Token, other: str | None, own: frozenset[str] | None = None) -> bool:
    """Whether a word players would write IS this word in another form (« sauver » for
    « sauva »): its spelling, its lemma, or — what typing it finds — a key of the word's
    own group on its plain map (`own`, the rank-0 keys; « table » is not « tablée »). Only
    without a map, a variant by spelling (`is_variant`, coarse: it takes « table » for
    « tablée »). Never a near neighbour (« faussaire » for « faux-monnayeur »): that is
    another word, in its own group."""
    if not other or " " in other.strip():
        return False
    s = slug(other)
    if s in (candidate.slug, slug(candidate.lemma or "")):
        return True
    return s in own if own is not None else is_variant(s, candidate.slug)


def two_places(x: float) -> str:
    """A score to two places, cut: one under a two-place bar never prints at it."""
    return str(Decimal(str(x)).quantize(Decimal("0.01"), rounding=ROUND_DOWN))


def said(chance: float | None, instead: str | None, same: bool = False) -> str:
    """What the would-say test means for this hole, in one plain line for the model: the
    chance a player who has the meaning says this exact word, and the commoner word they
    would keep saying — unless that word is this one in another form (`same_word`)."""
    if same:
        return (f"players would say « {instead} », this same word in another form: typing it "
                f"finds the hole, so it is a word players say")
    if chance is None:
        return "whether players would say this word: not measured"
    note = f"a player who has the meaning says this exact word at {two_places(chance)}"
    if instead:
        note += f" (they would keep saying « {instead} »)"
    if chance < WOULD_SAY_HARD:
        note += f", under {WOULD_SAY_HARD}: a word players don't say"
    return note


def group_commonness(rank_map: dict, index_of: Callable[[str], int | None]) -> dict[int, int | None]:
    """Each group of `rank_map` (a map's shape: key -> {rank, ...}; a group is its rank,
    every key one of its forms) by its commonness: the corpus position of its commonest
    key (`index_of(slug)` on the key's slug before any `:pos`, lower = commoner). A verb
    shown as « observaient » is as common as « observer ». None when no key is known."""
    out: dict[int, int | None] = {}
    for key, entry in rank_map.items():
        i = index_of(key.split(":", 1)[0])
        known = [x for x in (out.get(entry["rank"]), i) if x is not None]
        out[entry["rank"]] = min(known) if known else None
    return out


# The words a player reads at a glance around a hole: up to NEIGHBOURS each side, never
# across punctuation nor another hidden word (« le droit de ___ », « cinq semaines de ___
# payés »). A hole these alone hand over is no search (user-decided 2026-10-13).
NEIGHBOURS = 3


def neighbourhood(tokens: list[Token], mark: int, hidden: set[int], n: int = NEIGHBOURS) -> list[Token]:
    """The hole's token (`mark`, a token index) and the words right around it, in order."""
    order = list(tokens)
    k = next(j for j, t in enumerate(order) if t.i == mark)

    def walk(step: int) -> list[Token]:
        out, j = [], k + step
        while 0 <= j < len(order) and len(out) < n:
            t = order[j]
            if t.pos == "PUNCT" or t.i in hidden:
                break
            out.append(t)
            j += step
        return out

    return [*reversed(walk(-1)), order[k], *walk(1)]


# The reader's most-likely word at or under this rank in the hole's own map hands the hole
# over as surely as the secret itself (2026-10-12: « pou » and « mourir » sat at 1, both
# holes found in one or two guesses). On the 49 played French days with a reader on file,
# no reader word sat there.
HANDED_RANK = 3


def map_handed(rank_map: dict, secret_slug: str, expected: str | None) -> int | None:
    """The rank of the reader's most-likely word (`expected`) in the hole's own map when it
    is at or under HANDED_RANK — the player types it first and the hole is found — else
    None. The secret itself or a variant of it is the reader note's case, not this one."""
    s = slug(expected or "")
    if not s or " " in (expected or "").strip() or s == secret_slug or is_variant(s, secret_slug):
        return None
    entry = rank_map.get(s)
    return entry["rank"] if entry and 1 <= entry["rank"] <= HANDED_RANK else None


def unmapped(rank_map: dict, secret_slug: str, fillers: list[str], known: Callable[[str], bool]) -> list[str] | None:
    """The reader's words (single words the vectors know, not the secret or a variant)
    when NONE is on the hole's map: whatever the player types first lands past the map,
    which holds another sense of the word (« laisse »: the verb's neighbours, no
    « chaîne », 2026-10-12). Read on the map at hand: every group the walk keeps (`TOP_K`),
    the groups of another sense taken off.
    On the 49 played French days with a reader on file: « facho » (2026-09-16, 4% of the
    players within 30 tries), « insecte », « réverbères »; no loved day. None when one is on
    the map or the reader named no such word."""
    words = []
    for w in fillers:
        s = slug(w)
        if not s or " " in w.strip() or s == secret_slug or is_variant(s, secret_slug) or not known(s):
            continue
        if s in rank_map:
            return None
        words.append(w)
    return list(dict.fromkeys(words)) or None


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


def adjacent(tokens: list[Token], hidden: set[int]) -> set[frozenset[str]]:
    """The pairs of hidden words side by side, nothing between them (« [folk] [dancing] »:
    one idea split over two holes), by slug. A word, a sign or a stop word between two holes
    parts them (« [éleveur] de [pigeons] », a trade and its object), and a word repeated is
    no pair."""
    order = list(tokens)
    return {frozenset({a.slug, b.slug}) for a, b in zip(order, order[1:])
            if a.i in hidden and b.i in hidden and a.slug != b.slug}


@dataclass(frozen=True)
class HoleFacts:
    """What code knows of one hidden word, measured with the trio hidden around it, on the
    map at hand: whether most readers write it in (`reader_writes`); the fragment around one
    of its holes whose words write it in, when one does (`neighbours`); the rank of the
    reader's word on its map when at or under HANDED_RANK (`map_handed`); whether players
    don't say it (`unsaid`); the reader's words when none is on its map
    (`unmapped`); whether its band holds no start (`band_empty`); the slugs of the words its
    path runs through (`path_words`); and the model's verdicts on a word chosen against the
    main word — the partner of a visible word (`mirror`), the step its ladder misses
    (`lottery`)."""
    word: str
    slug: str
    path_words: frozenset[str] = frozenset()
    reader_writes: bool = False
    neighbours: str | None = None
    map_handed: int | None = None
    unsaid: bool = False
    unmapped: tuple[str, ...] | None = None
    band_empty: bool = False
    mirror: bool = False
    lottery: str | None = None


def _refused(h: HoleFacts) -> str | None:
    """What refuses a hidden word wherever it stands, in the player's terms; None when nothing does."""
    if h.unmapped:
        return (f"none of the words readers put in its blank ({', '.join(f'« {w} »' for w in h.unmapped)}) is "
                "on its map: every first guess lands past it")
    if h.neighbours:
        return f"the words right around it write it in (« {h.neighbours} »): no search"
    if h.mirror:
        return "a mirror: the partner of a visible word, the first word players would type"
    if h.lottery:
        return f"a lottery: one of a wide kind, and {h.lottery}"
    if h.band_empty:
        return "no start word in its band"
    return None


def trio_faults(holes: list[HoleFacts], adjacent: set[frozenset[str]] = frozenset()) -> dict:
    """The facts against a trio, its MAIN word first (`holes[0]`; alone, for the gate). The
    main word is refused by any fact that refuses a word, and by being handed — most readers
    write it in, or the reader's word sits at or under HANDED_RANK on its map — never by
    being one players don't say. Each of the two others is refused by any fact that refuses
    a word, or by sitting right beside the main word (`adjacent`, pairs of slugs side by
    side). What holds against the three together refuses none of them: two or more the line
    hands over (readers, or the map), a word every word of whose path is hidden (a locked
    pair, or a hidden path), two others side by side. How many words players don't say a day
    may hold is the taste's: each such word is a note (`said`), never a fact against the trio.
    Returns {"main": why | None, "others": {slug: why}, "trio": [why, ...]}."""
    main, others = holes[0], holes[1:]
    why = _refused(main)
    if why is None and main.reader_writes:
        why = "most readers write it straight in: the main word is never handed"
    if why is None and main.map_handed is not None:
        why = f"the word most readers write sits at rank {main.map_handed} on its map: found in a guess or two"
    faults: dict = {"main": why, "others": {}, "trio": []}
    for h in others:
        why = _refused(h)
        if why is None and frozenset({h.slug, main.slug}) in adjacent:
            why = f"it sits right beside the main word « {main.word} »: one idea per hole"
        if why:
            faults["others"][h.slug] = why
    handed = [h.word for h in holes if h.reader_writes or h.map_handed is not None]
    if len(handed) >= 2:
        faults["trio"].append(f"the line hands over {len(handed)} of its words ({', '.join(handed)}): at most one")
    hidden = {h.slug for h in holes}
    for h in holes:
        if h.path_words and h.path_words <= hidden:
            faults["trio"].append(f"every word the path to « {h.word} » runs through is hidden: a locked pair, "
                                  "or a path hidden")
    for a, b in ((a, b) for n, a in enumerate(others) for b in others[n + 1:]):
        if frozenset({a.slug, b.slug}) in adjacent:
            faults["trio"].append(f"« {a.word} » and « {b.word} » sit side by side: one idea per hole")
    return faults
