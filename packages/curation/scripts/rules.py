"""The trio rules as pure functions over a parsed sentence.

TASTE FIRST, CHECKS AFTER (2026-09-24): `initial_candidates` builds the list of words
code allows as secrets; the model proposes a trio from it, with its own taste; `refusals`
checks that trio — the pair rules (`pair_conflict`), the reader's fillers
(`open_candidates`), the one easy entry — and says why a word is refused, so the model
can propose again; `out_of_reach` then judges each hole on its built map. The LLM judgements are injected as callables,
so the rules are testable without a parser, a model or a vector file.

Tunables live here, in one place (issue #260).
"""

from dataclasses import dataclass, field
from typing import Callable

import _paths  # noqa: F401  (generation's scripts on sys.path)
from slug import slug
from start_word import is_variant

# Parts of speech a secret may carry (spaCy Universal POS tags).
ALLOWED_POS = frozenset({"NOUN", "VERB", "ADJ", "ADV"})
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
# A sentence with fewer DISTINCT candidate words than this never reaches the model: the
# trio search needs a choice, and a thin sentence forces a dull trio. Measured on 27
# attempts (2026-09-08): 4–7 candidates gave no trio or « faim · crois · pensée »;
# every trio worth keeping came from 8 or more.
MIN_CANDIDATES = 8
# Two secrets closer than this many tokens are "the same part of the sentence".
MIN_GAP = 3
# Two secrets above this cosine similarity are "too similar".
COSINE_MAX = 0.40
# Sibling dependents of one head that describe the same thing (ADJ + ADJ on one noun,
# a noun and its complement); coordinated siblings (`conj`) are deliberately NOT here —
# a list of nouns is a good spread (Perec's rideaux · palissades · fantômes).
MODIFIER_DEPS = frozenset({"amod", "nmod", "appos", "acl", "advmod"})
# The OBVIOUSNESS FILTER (user-decided 2026-09-10, the user's own method: read the
# context, think of the fillers WITHOUT a start word, and ask "what else can it be?" —
# only a word with real alternatives can be a hole). Judged BEFORE the pick, one
# candidate at a time with the rest of the sentence intact and no start word: the model
# answers as a reader with the words that could really stand there (at most
# CONTEXT_GUESSES, only what would not surprise a reader), and code strikes the word
# when the reader can name at most OBVIOUS_MAX words for it, the secret included
# (« arrêt cardiaque »: arrêt or crise — two, out; « les clefs du magasin »: magasin,
# camion, bureau — three, a hole). A filler that is a TWIN of the secret — a variant,
# or a word within TWIN_RANK of it in the game's own ranking (« clés »/« clefs » 0,
# « certainement »/« sûrement » 0, « premier »/« dernier » 0, measured 2026-09-10) — is
# the secret again, not an alternative. Only the reader's count can see a fixed pair:
# « crise » sits at rank 12668 from « arrêt ». A word a reader GUESSES, with
# alternatives, stays a hole: that is the game. Supersedes the 2026-09-06 annotation
# (three blanks, after the trio, never a strike), which could refuse nothing.
#
# THE EXPECTED WORD IS NEVER A HOLE (user-decided 2026-09-13, "aim harder"): the
# reader's FIRST filler — the word most readers put there, twins folded — is struck
# even with alternatives behind it. Measured on the days' own logs and real medians:
# the curated days of 09-10/11/12 hid one to three expected words (« hérité »,
# « chauffage », « peau » / « montrer ») and played at 6 / 8 / 8; the 09-13 day hid
# none (« lâcher » where a reader puts « dire », « gosses » for « enfants ») and played
# at 44; both Kundera attempts (« quinze [jours] », « au [crayon] », « la [poste] ») hid
# three and were "guessable in 3 tries". The expected word is what the reader NAMES as
# the one most readers would write (None when readers split), never the first of the
# list: the model has memorised a canonical text and lists the true word first — the
# list-position reading struck 32 of 38 words of an Orwell and flipped the same
# Houellebecq words between runs (2026-09-15). The strike applies to a PLAIN word only — one
# at or under PLAIN_WORD_RANK in the corpus order, the boundary the start band uses for
# "a word a player knows" (« hétéroptère » out, « bestiole » in): past it the reader's
# first filler is the model's knowledge, not every player's — « je lance à la
# [cantonade] » (rank 68858) is an idiom the model completes and a player may not (the
# user's call 2026-09-14); every word the rule struck on the easy days sits under 28000.
# The count rule still judges a rare word.
CONTEXT_GUESSES = 6
OBVIOUS_MAX = 2
TWIN_RANK = 3
PLAIN_WORD_RANK = 40000
# NO HOLE OUT OF REACH (2026-09-23, the user's goal "about 80% of players within 30
# tries", reached through curation alone): the same reader's fillers, read the other way,
# on the hole's OWN built map (contextual or not — the static vector would strike a word
# whose sense it misses). A hole none of whose single-word fillers sits within
# FILLER_NEAR_MAX of it is one players cannot approach — their natural first guesses land
# cold and stay cold. Calibrated on REAL play: the 26 published holes with logged fillers
# (2026-09-11..23), "hard" = found within 30 tries by under 60% of the players who
# engaged; at 100 the rule refuses the 4 worst of the 9 hard holes (« lâcher » 661,
# « héros » 404, « humble » 216, « saluer » 141) for 3 of 17 good ones. Raised from 30
# (2026-09-24): at 30 it took two more hard holes but, once the model chose with taste,
# it struck most vivid words (« stupeur » 341… « malade » 107, « miroir » 57: ten on one
# Buzzati run), each strike a new contextual map.
FILLER_NEAR_MAX = 100
# Secrets per puzzle (the sentence schema: exactly three distinct slugs).
TRIO = 3
# How many trios the model may propose for one sentence before it is abandoned: each
# refusal is told back to it (`refusals`, `out_of_reach`) and it proposes again.
TRIO_ROUNDS = 3


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
    """Tokens the LLM may pick first: an allowed POS, not a stopword, a weak verb or one
    of the commonest words, a slug the game admits and has not used, and no same-lemma twin
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
        if t.pos == "VERB" and t.lemma in WEAK_VERBS:
            continue
        if len(t.slug) < 2 or not in_vocab(t.slug):
            continue
        if "-" in t.slug:  # a compound (« sud-américain »): players type it as two words
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


def open_candidates(
    candidates: list[Token],
    *,
    fillers: Callable[[Token], tuple[list[str], str | None]],
    neighbour_rank: Callable[[Token, str], int | None] = lambda t, w: None,
    frequency_rank: Callable[[Token], int | None] = lambda t: None,
    log: "SearchLog | None" = None,
    entries: list[Token] | None = None,
) -> list[Token]:
    """The candidates the context does not hand over. `fillers(token)` answers as a
    reader with the sentence blanked on that one word (every occurrence of it, the rest
    intact, no start word): the words that could really stand there, and the ONE word
    most readers would write when they agree (None when they split). A word is struck
    when it is the EXPECTED word — the reader's named word is the secret or a twin of it
    (`is_twin`) and the word is a plain one (`frequency_rank` at or under
    PLAIN_WORD_RANK; None = unknown, taken as plain) — or when the reader can name at
    most OBVIOUS_MAX words for it, the secret included (a twin is the secret again; a
    named word that is not the secret is one of the alternatives). One judgement per
    distinct slug; the order of the list is kept. Whether the fillers can REACH the word
    is judged later, on its built map (`out_of_reach`).

    `entries`, when given, collects the EXPECTED words that still have alternatives (more
    than OBVIOUS_MAX possible words): never a hole of their own, but ONE may be the day's
    easy ENTRY (`refusals`). An obvious word is never one."""
    log = log or SearchLog()
    verdict: dict[str, bool] = {}
    out = []
    for c in candidates:
        if c.slug not in verdict:
            guesses, named = fillers(c)
            rank = frequency_rank(c)
            rare = rank is not None and rank > PLAIN_WORD_RANK
            expected = named is not None and is_twin(c, named, neighbour_rank) and not rare
            others = {slug(g) for g in [*guesses, *([named] if named else [])]
                      if slug(g) and not is_twin(c, g, neighbour_rank)}
            possible = len(others) + 1  # the secret itself is always one of them
            verdict[c.slug] = expected or possible <= OBVIOUS_MAX
            shown = ", ".join(guesses) or "none"
            agreed = f"most readers write « {named} »" if named else "readers split"
            if expected and entries is not None and possible > OBVIOUS_MAX:
                entries.append(c)
                log.note(f"'{c.text}' is the EXPECTED word — {agreed} (a reader puts: {shown}) — "
                         "struck as a hole, kept as a possible ENTRY")
            elif expected:
                log.note(f"'{c.text}' is the EXPECTED word — {agreed} (a reader puts: {shown}) — struck")
            elif verdict[c.slug]:
                log.note(f"'{c.text}' is obvious — {possible} possible word(s) (a reader puts: {shown}) — struck")
            elif rare:
                log.note(f"'{c.text}' is open — rare (rank {rank}), the reader's expected word is not every "
                         f"player's — {possible} possible words ({agreed}; a reader puts: {shown})")
            else:
                log.note(f"'{c.text}' is open — {possible} possible words ({agreed}; a reader puts: {shown})")
        if not verdict[c.slug]:
            out.append(c)
    return out


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


def out_of_reach(nearest: tuple[str, int | None] | None) -> bool:
    """A hole players cannot approach: the readers' nearest filler sits past
    FILLER_NEAR_MAX in its map, or past the map. No filler to judge is not a verdict."""
    return nearest is not None and (nearest[1] is None or nearest[1] > FILLER_NEAR_MAX)


def pair_conflict(pick: Token, c: Token, tokens: list[Token], *,
                  similarity: Callable[[Token, Token], float | None]) -> str | None:
    """Why `c` cannot share a trio with `pick` (None = it can): two verbs, a word and its
    head or a dependent, two modifiers of one head, neighbours within MIN_GAP, lemma or
    morphological variants, or a cosine above COSINE_MAX. The same slug is one secret,
    never a conflict."""
    if c.slug == pick.slug:
        return None
    if pick.pos == "VERB" and c.pos == "VERB":
        return "two verbs (at most one verb)"
    if c.i == pick.head or c.head == pick.i:
        return "one describes the other (a word and its head)"
    head = {t.i: t for t in tokens}.get(pick.head)
    if (
        head is not None
        and c.head == pick.head
        and c.i != pick.i
        and _dep_family(c.dep) in MODIFIER_DEPS
        and _dep_family(pick.dep) in MODIFIER_DEPS
    ):
        return "they describe the same thing"
    if abs(c.i - pick.i) < MIN_GAP:
        return "the same part of the sentence (too close)"
    if (c.lemma and c.lemma == pick.lemma) or is_variant(c.slug, pick.slug):
        return "forms of one word"
    sim = similarity(c, pick)
    if sim is not None and sim > COSINE_MAX:
        return "too similar in meaning"
    return None


def prune(
    candidates: list[Token],
    pick: Token,
    tokens: list[Token],
    *,
    similarity: Callable[[Token, Token], float | None],
) -> list[Token]:
    """The list after a pick: drop the pick and its other occurrences and every word in
    `pair_conflict` with it."""
    return [c for c in candidates
            if c.slug != pick.slug and pair_conflict(pick, c, tokens, similarity=similarity) is None]


@dataclass
class SearchLog:
    """What happened, for the run log: every strike names its rule."""
    events: list[str] = field(default_factory=list)

    def note(self, msg: str) -> None:
        self.events.append(msg)


def refusals(
    proposal: list[Token],
    tokens: list[Token],
    *,
    similarity: Callable[[Token, Token], float | None],
    fillers: Callable[[Token], tuple[list[str], str | None]],
    handed_over: Callable[[list[Token]], set[str]],
    neighbour_rank: Callable[[Token, str], int | None] = lambda t, w: None,
    frequency_rank: Callable[[Token], int | None] = lambda t: None,
    log: SearchLog | None = None,
) -> tuple[list[tuple[str, str]], set[str]]:
    """Code's verdict on the model's trio, in the ORDER players will find it: the
    refusals as (words, why) — empty when the trio stands — and the slugs of its EASY
    words. Checked cheapest first: the pair rules (free), then the reader's fillers
    (`open_candidates`: an obvious word is refused; an expected one is EASY), then
    `handed_over` (the giveaway judge: EASY too). ONE easy word may open the day (user-
    decided 2026-09-24): an easy word anywhere but first is refused."""
    log = log or SearchLog()
    out: list[tuple[str, str]] = []
    for i, a in enumerate(proposal):
        for b in proposal[i + 1:]:
            why = (pair_conflict(a, b, tokens, similarity=similarity)
                   or pair_conflict(b, a, tokens, similarity=similarity))
            if why:
                out.append((f"{a.text} + {b.text}", why))
    if out:
        return out, set()
    entries: list[Token] = []
    opened = open_candidates(proposal, fillers=fillers, neighbour_rank=neighbour_rank,
                             frequency_rank=frequency_rank, log=log, entries=entries)
    expected = {t.slug for t in entries}
    shut = [t for t in proposal if t not in opened and t.slug not in expected]
    for t in shut:
        out.append((t.text, "obvious: a reader can put only one or two words there"))
    given = handed_over([t for t in opened]) if not shut else set()
    easy = expected | given
    for t in proposal[1:]:
        if t.slug in easy:
            why = "most readers would write it" if t.slug in expected else "the sentence hands it over"
            out.append((t.text, f"{why} — an easy word may only OPEN the day, as the first word"))
    return out, easy
