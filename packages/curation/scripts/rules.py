"""The trio rules as pure functions over a parsed sentence.

The LLM never sees an invalid option: `initial_candidates` builds the candidate list,
`open_candidates` keeps the words the context leaves open, and `valid_trios` lists
every trio whose three words `prune` lets stand together — the model designs the day by
choosing one of them; `out_of_reach` then judges each hole on its built map. The LLM judgements are injected as callables,
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
# engaged; at 30 the rule refuses 6 of the 9 hard holes (« lâcher » 661, « héros » 404,
# « humble » 216, « saluer » 141, « alcoolique » 72, « redoutée » 40) for 3 of 17 good
# ones — a lost good hole is cheap, a day nobody finishes is not.
FILLER_NEAR_MAX = 30
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
    is judged later, on its built map (`out_of_reach`)."""
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
            if expected:
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


def nearest_filler(candidate: Token, words: list[str],
                    neighbour_rank: Callable[[Token, str], int | None]) -> tuple[str, int] | None:
    """The reader's filler nearest the candidate in the static ranking, as (word, rank);
    None when no filler's rank is known. The secret itself and its variants are not
    fillers. Information for the design prompt, never a strike."""
    best = None
    for w in words:
        s = slug(w)
        if not s or s == candidate.slug or is_variant(s, candidate.slug):
            continue
        rank = neighbour_rank(candidate, w)
        if rank is not None and (best is None or rank < best[1]):
            best = (w, rank)
    return best


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


def valid_trios(
    tokens: list[Token],
    candidates: list[Token],
    *,
    similarity: Callable[[Token, Token], float | None],
) -> list[tuple[Token, Token, Token]]:
    """Every trio of distinct candidate words that can stand together: each pair passes
    `prune` both ways, whichever of the two were picked first (one token per slug, its
    first occurrence — a repeated slug is one secret with a hole per occurrence). In the
    candidates' order, so the listing is stable."""
    firsts: list[Token] = []
    for c in candidates:
        if c.slug not in {f.slug for f in firsts}:
            firsts.append(c)
    fits = {
        (a.slug, b.slug)
        for a in firsts for b in firsts
        if a.slug != b.slug and prune([b], a, tokens, similarity=similarity)
    }
    together = lambda a, b: (a.slug, b.slug) in fits and (b.slug, a.slug) in fits  # noqa: E731
    n = len(firsts)
    return [
        (firsts[i], firsts[j], firsts[k])
        for i in range(n) for j in range(i + 1, n) for k in range(j + 1, n)
        if together(firsts[i], firsts[j]) and together(firsts[i], firsts[k]) and together(firsts[j], firsts[k])
    ]
