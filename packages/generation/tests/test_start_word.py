"""CONTRACT: the start (hint) word of a hole — `start_word.py`, the ONE band rule.

Asserted against AGENTS.md ("ONE start band on every map, START_BAND = 100–200"), not
the implementation:

  - the band is read on the rank the puzzle SHIPS: 100 and 200 are offered, 99 and
    201 are not, and each candidate carries its shipped rank;
  - a morphological variant of the secret is never offered as its start;
  - a map too small to reach the band falls back to every non-variant word;
  - off a TTY the default start is drawn from the band — from what a filter left of
    it when there is one (#308) — and is the secret itself when nothing qualifies.
"""

import random

import gen_phrase
import start_word
from slug import slug

LO, HI = start_word.START_BAND
INSIDE = (LO + HI) // 2


def _ranking(words, first):
    """(word, 0-based position, similarity) nearest-first, as the merge walk's
    `merged` carries it: the map ships each position one rank higher."""
    return [(w, first + i, 1.0 - (first + i) / 1000) for i, w in enumerate(words)]


NEAR = _ranking(["minou", "matou"], 0)                     # far under the band
BAND = _ranking(["chats", "chien", "chat", "tigre"], INSIDE)  # two variants of «chat» among them
FAR = _ranking(["loup", "renard"], HI + 100)               # far over it
RANKING = NEAR + BAND + FAR


def test_the_band_is_read_on_the_ranks_the_puzzle_ships():
    # 300 unrelated words, each its own group: the shipped map ranks them 1..300.
    words = [f"mot{chr(97 + i // 26)}{chr(97 + i % 26)}" for i in range(300)]
    walk = [(w, i, 1.0 - i / 1000) for i, w in enumerate(words)]
    merged, rank_map, _groups = gen_phrase.build_puzzle_rank_map(
        "chat", walk, {}, {}, set())
    shipped = {w: rank_map[slug(w)]["rank"] for w in words}
    by_rank = {r: w for w, r in shipped.items()}

    band = start_word.start_band("chat", merged)
    offered = {w for w, _r in band}
    assert by_rank[LO] in offered and by_rank[HI] in offered
    assert by_rank[LO - 1] not in offered and by_rank[HI + 1] not in offered
    assert sorted(r for _w, r in band) == list(range(LO, HI + 1))
    # each candidate carries the rank its word ships at
    assert all(r == shipped[w] for w, r in band)


def test_a_variant_of_the_secret_is_never_offered():
    assert start_word.is_variant("chat", "chats") and start_word.is_variant("chats", "chat")
    assert start_word.is_variant("chat", "chat")
    assert not start_word.is_variant("chat", "chien")
    band = start_word.start_band("chat", RANKING)
    assert band == [("chien", INSIDE + 2), ("tigre", INSIDE + 4)]


def test_a_map_too_small_for_the_band_falls_back_to_every_non_variant_word(monkeypatch):
    small = _ranking(["chats", "chien", "tigre"], 0)
    assert start_word.start_band("chat", small) == [("chien", 2), ("tigre", 3)]
    # nothing at all qualifies: the secret itself stands in
    assert start_word.start_band("chat", small[:1]) == []
    monkeypatch.setattr(gen_phrase.sys.stdin, "isatty", lambda: False, raising=False)
    assert gen_phrase.choose_start("chat", small[:1], {}, {}) == "chat"


def test_the_off_tty_default_is_drawn_from_the_band_and_from_what_a_filter_left(monkeypatch):
    monkeypatch.setattr(gen_phrase.sys.stdin, "isatty", lambda: False, raising=False)
    pools = []

    def choice(pool):
        pools.append(list(pool))
        return pool[-1]
    monkeypatch.setattr(random, "choice", choice)

    assert gen_phrase.choose_start("chat", RANKING, {}, {}) == "tigre"
    assert pools == [[("chien", INSIDE + 2), ("tigre", INSIDE + 4)]]
    # a filter (#308's judge) only removes: the draw is over what remains
    picked = gen_phrase.choose_start(
        "chat", RANKING, {}, {},
        band_filter=lambda band: [b for b in band if b[0] != "tigre"])
    assert picked == "chien" and pools[1] == [("chien", INSIDE + 2)]
