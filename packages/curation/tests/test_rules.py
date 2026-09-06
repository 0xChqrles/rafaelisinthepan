"""The trio rules, asserted against the spec in the package AGENTS.md / issue #260."""

from rules import (
    COSINE_MAX,
    MAX_COMMON_RANK,
    MAX_COMMON_RANK_ADV,
    MAX_OFF_LIST,
    MIN_GAP,
    SearchLog,
    Token,
    initial_candidates,
    prune,
    search_trio,
)


def tok(i, text, pos, dep, head, lemma=None, stop=False):
    return Token(i=i, text=text, lemma=lemma or text, pos=pos, dep=dep, head=head,
                 slug=text.lower().replace("é", "e"), stop=stop)


# "le vieux chat gris dort sur la pierre froide et la lune blanche brille"
SENT = [
    tok(0, "le", "DET", "det", 2, stop=True),
    tok(1, "vieux", "ADJ", "amod", 2),
    tok(2, "chat", "NOUN", "nsubj", 4),
    tok(3, "gris", "ADJ", "amod", 2),
    tok(4, "dort", "VERB", "ROOT", 4, lemma="dormir"),
    tok(5, "sur", "ADP", "case", 7, stop=True),
    tok(6, "la", "DET", "det", 7, stop=True),
    tok(7, "pierre", "NOUN", "obl", 4),
    tok(8, "froide", "ADJ", "amod", 7, lemma="froid"),
    tok(9, "et", "CCONJ", "cc", 12, stop=True),
    tok(10, "la", "DET", "det", 11, stop=True),
    tok(11, "lune", "NOUN", "nsubj", 13),
    tok(12, "blanche", "ADJ", "amod", 11, lemma="blanc"),
    tok(13, "brille", "VERB", "conj", 4, lemma="briller"),
]
VOCAB = {t.slug for t in SENT}
no_sim = lambda a, b: None  # noqa: E731


def test_initial_candidates_keep_only_content_words_the_game_admits():
    cands = initial_candidates(SENT, in_vocab=VOCAB.__contains__)
    assert [c.text for c in cands] == [
        "vieux", "chat", "gris", "dort", "pierre", "froide", "lune", "blanche", "brille",
    ]


def test_initial_candidates_drop_past_secrets_and_unknown_slugs():
    cands = initial_candidates(SENT, in_vocab=lambda s: s != "lune", past_secrets={"chat"})
    texts = [c.text for c in cands]
    assert "lune" not in texts and "chat" not in texts


def test_initial_candidates_drop_a_same_lemma_twin_under_another_slug():
    sent = SENT + [tok(14, "dormait", "VERB", "conj", 4, lemma="dormir")]
    cands = initial_candidates(sent, in_vocab=lambda s: True)
    assert "dort" not in [c.text for c in cands]
    assert "dormait" not in [c.text for c in cands]


def test_a_same_slug_repeat_stays_a_candidate():
    sent = SENT + [tok(14, "chat", "NOUN", "conj", 11)]
    cands = initial_candidates(sent, in_vocab=lambda s: True)
    assert [c.text for c in cands].count("chat") == 2


def test_prune_after_a_verb_removes_every_verb():
    cands = initial_candidates(SENT, in_vocab=VOCAB.__contains__)
    dort = next(c for c in cands if c.text == "dort")
    left = prune(cands, dort, SENT, similarity=no_sim)
    assert not any(c.pos == "VERB" for c in left)


def test_prune_removes_head_children_and_modifier_siblings():
    cands = initial_candidates(SENT, in_vocab=VOCAB.__contains__)
    gris = next(c for c in cands if c.text == "gris")
    left = {c.text for c in prune(cands, gris, SENT, similarity=no_sim)}
    assert "chat" not in left     # its head (the thing it describes)
    assert "vieux" not in left    # modifier sibling on the same noun
    assert "lune" in left and "blanche" in left


def test_prune_removes_neighbours_within_min_gap():
    cands = initial_candidates(SENT, in_vocab=VOCAB.__contains__)
    pierre = next(c for c in cands if c.text == "pierre")
    left = {c.text for c in prune(cands, pierre, SENT, similarity=no_sim)}
    for c in cands:
        if 0 < abs(c.i - pierre.i) < MIN_GAP:
            assert c.text not in left


def test_prune_removes_too_similar_words_and_variants():
    cands = initial_candidates(SENT, in_vocab=VOCAB.__contains__)
    lune = next(c for c in cands if c.text == "lune")
    sim = lambda a, b: COSINE_MAX + 0.1 if {a.text, b.text} == {"lune", "chat"} else 0.0  # noqa: E731
    left = {c.text for c in prune(cands, lune, SENT, similarity=sim)}
    assert "chat" not in left
    sent = SENT + [tok(14, "lunes", "NOUN", "conj", 11)]
    cands = initial_candidates(sent, in_vocab=lambda s: True)
    left = {c.text for c in prune(cands, lune, sent, similarity=no_sim)}
    assert "lunes" not in left


def test_search_trio_walks_pick_prune_to_three():
    cands = initial_candidates(SENT, in_vocab=VOCAB.__contains__)
    order = ["chat", "lune"]
    choose = lambda rem, picked: next((c for c in rem if c.text in order), rem[0])  # noqa: E731
    log = SearchLog()
    trio = search_trio(SENT, cands, choose=choose, similarity=no_sim, log=log)
    # chat prunes dort (head), vieux/gris (children, neighbours); lune prunes brille
    # (head) and blanche (child); pierre is the first word left, four tokens away.
    assert [t.text for t in trio] == ["chat", "lune", "pierre"]
    assert sum("picked" in e for e in log.events) == 3


def test_search_trio_restarts_with_the_first_pick_struck_then_gives_up():
    cands = initial_candidates(SENT, in_vocab=VOCAB.__contains__)
    firsts = []

    def choose(rem, picked):
        if not picked:
            firsts.append(rem[0].text)
        return rem[0]

    # Everything is too similar to everything: no second pick ever survives.
    trio = search_trio(SENT, cands, choose=choose, similarity=lambda a, b: 1.0, max_restarts=2)
    assert trio is None
    assert firsts == ["vieux", "chat", "gris"]  # three attempts, a new first each time


def test_search_trio_ignores_a_pick_off_the_list():
    cands = initial_candidates(SENT, in_vocab=VOCAB.__contains__)
    stray = tok(99, "soleil", "NOUN", "obj", 4)
    calls = []

    def choose(rem, picked):
        calls.append(len(rem))
        return stray if len(calls) == 1 else rem[-1]

    trio = search_trio(SENT, cands, choose=choose, similarity=no_sim)
    assert trio is not None and stray not in trio


def test_search_trio_takes_repeated_off_list_answers_as_a_decline():
    cands = initial_candidates(SENT, in_vocab=VOCAB.__contains__)
    stray = tok(99, "soleil", "NOUN", "obj", 4)
    calls = []

    def choose(rem, picked):
        calls.append(1)
        return stray

    trio = search_trio(SENT, cands, choose=choose, similarity=no_sim)
    assert trio is None
    assert len(calls) <= MAX_OFF_LIST * (2 + 1)  # never an endless loop



def test_initial_candidates_drop_the_commonest_words_and_common_adverbs():
    sent = SENT + [tok(14, "bien", "ADV", "advmod", 13), tok(15, "pensivement", "ADV", "advmod", 13)]
    ranks = {"bien": 3, "pensivement": 9000, "chat": MAX_COMMON_RANK - 1, "lune": MAX_COMMON_RANK}
    cands = initial_candidates(sent, in_vocab=lambda s: True, frequency_rank=lambda t: ranks.get(t.text))
    texts = [c.text for c in cands]
    assert "bien" not in texts and "chat" not in texts
    assert "pensivement" in texts and "lune" in texts
    assert MAX_COMMON_RANK_ADV > MAX_COMMON_RANK
