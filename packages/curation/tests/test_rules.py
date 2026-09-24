"""The trio rules, asserted against the spec in the package AGENTS.md / issue #260."""

from rules import (
    COSINE_MAX,
    MAX_COMMON_RANK,
    MAX_COMMON_RANK_ADV,
    FILLER_NEAR_MAX,
    MIN_GAP,
    OBVIOUS_MAX,
    PLAIN_WORD_RANK,
    TWIN_RANK,
    SearchLog,
    Token,
    initial_candidates,
    is_twin,
    open_candidates,
    map_nearest_filler,
    out_of_reach,
    conflicts,
    pair_conflict,
    prune,
    refusals,
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


def test_initial_candidates_drop_the_commonest_words_and_common_adverbs():
    sent = SENT + [tok(14, "bien", "ADV", "advmod", 13), tok(15, "pensivement", "ADV", "advmod", 13)]
    ranks = {"bien": 3, "pensivement": 9000, "chat": MAX_COMMON_RANK - 1, "lune": MAX_COMMON_RANK}
    cands = initial_candidates(sent, in_vocab=lambda s: True, frequency_rank=lambda t: ranks.get(t.text))
    texts = [c.text for c in cands]
    assert "bien" not in texts and "chat" not in texts
    assert "pensivement" in texts and "lune" in texts
    assert MAX_COMMON_RANK_ADV > MAX_COMMON_RANK


def test_weak_verbs_are_never_candidates():
    from rules import MIN_CANDIDATES, WEAK_VERBS
    assert "croire" in WEAK_VERBS and MIN_CANDIDATES >= 3
    sent = [tok(0, "je", "PRON", "nsubj", 1, stop=True), tok(1, "crois", "VERB", "ROOT", 1, lemma="croire"),
            tok(2, "chat", "NOUN", "obj", 1), tok(3, "dort", "VERB", "conj", 1, lemma="dormir")]
    assert [t.text for t in initial_candidates(sent, in_vocab=lambda s: True)] == ["chat", "dort"]


# --- the obviousness filter (user-decided 2026-09-10) -----------------------------

no_rank = lambda t, w: None  # noqa: E731


def test_open_candidates_strike_a_word_with_at_most_two_possibilities():
    cands = initial_candidates(SENT, in_vocab=VOCAB.__contains__)
    assert OBVIOUS_MAX == 2
    # « [arrêt] cardiaque » with « crise » expected: the reader names one other word
    # and the secret — two possibilities, out (even though the secret is not the one named).
    fillers = lambda t: (["chien", "chat"], "chien") if t.text == "chat" else (["neige", "mer", "nuit"], None)  # noqa: E731
    log = SearchLog()
    kept = open_candidates(cands, fillers=fillers, neighbour_rank=no_rank, log=log)
    assert {t.text for t in kept} == {t.text for t in cands} - {"chat"}
    assert any("'chat' is obvious — 2 possible" in e and "chien, chat" in e for e in log.events)


def test_open_candidates_keep_a_word_with_three_possibilities():
    cands = initial_candidates(SENT, in_vocab=VOCAB.__contains__)
    # Another word expected, the secret among the alternatives: a hole.
    fillers = lambda t: (["autre", t.text, "encore"], "autre")  # noqa: E731
    kept = open_candidates(cands, fillers=fillers, neighbour_rank=no_rank)
    assert [t.text for t in kept] == [t.text for t in cands]


def test_open_candidates_strike_the_expected_word_even_with_alternatives():
    cands = initial_candidates(SENT, in_vocab=VOCAB.__contains__)
    # « quinze [jours] plus tard »: the secret is what most readers write, mois/ans/années behind it.
    fillers = lambda t: (["chat", "chien", "rat", "lion"], "chat") if t.text == "chat" else (["autre", t.text, "encore"], None)  # noqa: E731
    log = SearchLog()
    kept = open_candidates(cands, fillers=fillers, neighbour_rank=no_rank, log=log)
    assert "chat" not in {t.text for t in kept}
    assert any("'chat' is the EXPECTED word" in e and "« chat »" in e for e in log.events)
    # A twin named (« clés » for « clefs ») is the secret named.
    fillers = lambda t: (["chats", "chien", "rat", "lion"], "chats") if t.text == "chat" else (["autre", t.text, "encore"], None)  # noqa: E731
    assert "chat" not in {t.text for t in open_candidates(cands, fillers=fillers, neighbour_rank=no_rank)}


def test_the_expected_word_is_the_one_named_never_the_first_of_the_list():
    cands = initial_candidates(SENT, in_vocab=VOCAB.__contains__)
    # The model lists the true word first (it knows the text) but says readers would
    # split: a hole. The list-position reading struck it (2026-09-15, Orwell).
    fillers = lambda t: ([t.text, "chien", "rat", "lion"], None)  # noqa: E731
    log = SearchLog()
    kept = {t.text for t in open_candidates(cands, fillers=fillers, neighbour_rank=no_rank, log=log)}
    assert kept == {t.text for t in cands}
    assert any("'chat' is open" in e and "readers split" in e for e in log.events)
    # Readers agree on ANOTHER word: it counts as an alternative even when the list
    # omits it (« photos » for « [cartes] »: cartes, photos, images — three, a hole).
    fillers = lambda t: ([t.text, "images"], "photos")  # noqa: E731
    assert {t.text for t in open_candidates(cands, fillers=fillers, neighbour_rank=no_rank)} == {t.text for t in cands}
    fillers = lambda t: ([t.text], "photos")  # noqa: E731
    assert open_candidates(cands, fillers=fillers, neighbour_rank=no_rank) == []


def test_open_candidates_count_the_secret_even_when_the_reader_misses_it():
    cands = initial_candidates(SENT, in_vocab=VOCAB.__contains__)
    # Two other words, the secret not among them: three possibilities, open.
    fillers = lambda t: (["autre", "encore"], None)  # noqa: E731
    assert len(open_candidates(cands, fillers=fillers, neighbour_rank=no_rank)) == len(cands)
    # One other word only: two possibilities, obvious.
    fillers = lambda t: (["autre"], None)  # noqa: E731
    assert open_candidates(cands, fillers=fillers, neighbour_rank=no_rank) == []


def test_a_twin_is_a_variant_or_a_near_neighbour_in_the_ranking():
    chat = next(t for t in SENT if t.text == "chat")
    ranks = {"chien": TWIN_RANK, "souris": TWIN_RANK + 1, "clés": 0}
    neighbour_rank = lambda t, w: ranks.get(w)  # noqa: E731
    assert is_twin(chat, "Chats", no_rank)  # a variant, accent and case aside
    assert is_twin(chat, "chien", neighbour_rank)  # within TWIN_RANK
    assert not is_twin(chat, "souris", neighbour_rank)  # just past it
    assert not is_twin(chat, "lion", neighbour_rank)  # unknown to the vectors


def test_open_candidates_fold_twins_into_the_secret_and_dedupe_fillers():
    cands = initial_candidates(SENT, in_vocab=VOCAB.__contains__)
    ranks = {("chat", "minet"): 1, ("pierre", "roche"): 40}
    neighbour_rank = lambda t, w: ranks.get((t.text, w))  # noqa: E731
    fillers = lambda t: {"chat": (["chien", "chats", "minet", "Chien"], "minet"),  # noqa: E731
                         "pierre": (["roche", "pierre", "dalle"], "roche")}.get(t.text, (["x", "y", "z"], None))
    kept = {t.text for t in open_candidates(cands, fillers=fillers, neighbour_rank=neighbour_rank)}
    assert "chat" not in kept  # chien, then a variant and a rank-1 synonym of the secret: two possibilities
    assert "pierre" in kept  # roche expected, the secret and dalle behind it: three, a hole


def test_open_candidates_judge_a_repeated_word_once():
    twice = [
        tok(0, "chat", "NOUN", "nsubj", 1),
        tok(1, "dort", "VERB", "ROOT", 1, lemma="dormir"),
        tok(2, "chat", "NOUN", "conj", 0),
    ]
    asked = []

    def fillers(t):
        asked.append(t.i)
        return (["chat"], "chat") if t.text == "chat" else (["ronfle", "dort", "veille"], None)

    kept = open_candidates(twice, fillers=fillers, neighbour_rank=no_rank)
    assert asked == [0, 1]  # one question per distinct slug
    assert [t.i for t in kept] == [1]  # the secret alone: obvious, both occurrences gone


def test_initial_candidates_drop_a_hyphenated_compound():
    sent = SENT + [tok(14, "sud-américain", "ADJ", "amod", 11)]
    vocab = VOCAB | {"sud-americain"}
    assert "sud-américain" not in {t.text for t in initial_candidates(sent, in_vocab=vocab.__contains__)}


def test_the_expected_strike_spares_a_rare_word_the_count_rule_still_judges():
    cands = initial_candidates(SENT, in_vocab=VOCAB.__contains__)
    # « je lance à la [cantonade] »: the reader completes the idiom, but the word is
    # past the plain-word boundary — a player may not have it. Three fillers: a hole.
    fillers = lambda t: ([t.text, "ronde", "volée"], t.text)  # noqa: E731
    rank = lambda t: PLAIN_WORD_RANK + 1 if t.text == "chat" else 100  # noqa: E731
    log = SearchLog()
    kept = {t.text for t in open_candidates(cands, fillers=fillers, neighbour_rank=no_rank, frequency_rank=rank, log=log)}
    assert "chat" in kept and "pierre" not in kept  # pierre is plain and expected: struck
    assert any("'chat' is open — rare" in e for e in log.events)
    # Rare but with only one alternative: the count rule strikes it all the same.
    fillers = lambda t: ([t.text, "ronde"], t.text)  # noqa: E731
    assert "chat" not in {t.text for t in open_candidates(cands, fillers=fillers, neighbour_rank=no_rank, frequency_rank=rank)}


def test_an_expected_word_with_alternatives_is_kept_as_a_possible_entry():
    cands = initial_candidates(SENT, in_vocab=VOCAB.__contains__)
    # « chat » is what most readers write, chien/rat/lion behind it: never a hole of its
    # own, but it may open the day (user-decided 2026-09-24). « lune »: expected with one
    # alternative only — obvious, never an entry either.
    def fillers(t):
        if t.text == "chat":
            return ["chat", "chien", "rat", "lion"], "chat"
        if t.text == "lune":
            return ["lune", "nuit"], "lune"
        return ["autre", t.text, "encore"], None
    entries = []
    log = SearchLog()
    kept = open_candidates(cands, fillers=fillers, neighbour_rank=no_rank, log=log, entries=entries)
    assert "chat" not in {t.text for t in kept} and "lune" not in {t.text for t in kept}
    assert [t.text for t in entries] == ["chat"]
    assert any("'chat' is the EXPECTED word" in e and "possible ENTRY" in e for e in log.events)


def test_static_distance_does_not_reject_an_otherwise_open_hole():
    cands = initial_candidates(SENT, in_vocab=VOCAB.__contains__)
    # The static ranking cannot say whether a filler is close in the shipped map (a
    # sense the static vector misses): reach is judged on the built map, not here.
    kept = open_candidates(cands, fillers=lambda _t: (["table", "chaise", "place"], None),
                           neighbour_rank=lambda _t, _w: 1100)
    assert kept == cands


MAP = {  # a built rank map: slug -> entry (the secret « héros » is rank 0)
    "heros": {"word": "héros", "rank": 0},
    "heroine": {"word": "héroïne", "rank": 2},
    "capitaine": {"word": "capitaine", "rank": FILLER_NEAR_MAX},
    "garcon": {"word": "garçon", "rank": 404},
    "type": {"word": "type", "rank": 900},
}


def test_a_hole_whose_readers_land_far_in_its_map_is_out_of_reach():
    # « héros »: a reader puts garçon, gars, type — nothing near the secret in its map.
    nearest = map_nearest_filler(MAP, "heros", ["garçon", "gars", "type"])
    assert nearest == ("garçon", 404) and out_of_reach(nearest)
    # One filler within reach is enough: the natural guesses can warm up.
    assert not out_of_reach(map_nearest_filler(MAP, "heros", ["garçon", "capitaine"]))


def test_a_filler_past_the_map_is_far_and_one_that_cannot_be_typed_is_no_filler():
    assert out_of_reach(map_nearest_filler(MAP, "heros", ["gars"]))            # past the map
    assert map_nearest_filler(MAP, "heros", ["tout exprès", "rien que"]) is None
    assert not out_of_reach(None)                                               # nothing to judge


def test_the_secret_and_its_variants_are_not_their_own_filler_in_the_map():
    assert map_nearest_filler(MAP, "heros", ["héros", "héroïne", "type"]) == ("héroïne", 2)
    assert map_nearest_filler(MAP, "heros", ["héros"]) is None


# --- taste first, checks after (2026-09-24): code's verdict on the model's trio ---------
def _by(text):
    return next(t for t in SENT if t.text == text)


def test_pair_conflict_names_the_rule():
    assert pair_conflict(_by("dort"), _by("brille"), SENT, similarity=no_sim) == "two verbs (at most one verb)"
    assert "head" in pair_conflict(_by("chat"), _by("dort"), SENT, similarity=no_sim)
    assert "too close" in pair_conflict(_by("gris"), _by("dort"), SENT, similarity=no_sim)
    assert pair_conflict(_by("vieux"), _by("gris"), SENT, similarity=no_sim) == "they describe the same thing"
    assert pair_conflict(_by("chat"), _by("pierre"), SENT, similarity=no_sim) is None
    assert pair_conflict(_by("chat"), _by("pierre"), SENT, similarity=lambda a, b: 0.9) == "too similar in meaning"


def open_reader(t):
    return ["autre", t.text, "encore"], None


def test_a_trio_that_stands_is_accepted():
    trio = [_by("chat"), _by("pierre"), _by("lune")]
    problems, easy = refusals(trio, SENT, similarity=no_sim, fillers=open_reader, handed_over=lambda ws: set())
    assert problems == [] and easy == set()


def test_the_pair_rules_refuse_before_any_reader_is_asked():
    asked = []
    trio = [_by("chat"), _by("dort"), _by("lune")]
    problems, _ = refusals(trio, SENT, similarity=no_sim,
                           fillers=lambda t: asked.append(t) or open_reader(t), handed_over=lambda ws: set())
    assert problems and "chat + dort" == problems[0][0] and asked == []


def test_one_easy_word_may_open_the_day_never_more():
    expected_chat = lambda t: (["chat", "chien", "rat", "lion"], "chat") if t.text == "chat" else open_reader(t)  # noqa: E731
    first = [_by("chat"), _by("pierre"), _by("lune")]
    problems, easy = refusals(first, SENT, similarity=no_sim, fillers=expected_chat, handed_over=lambda ws: set())
    assert problems == [] and easy == {"chat"}
    later = [_by("pierre"), _by("chat"), _by("lune")]
    problems, _ = refusals(later, SENT, similarity=no_sim, fillers=expected_chat, handed_over=lambda ws: set())
    assert [w for w, _ in problems] == ["chat"] and "only OPEN the day" in problems[0][1]
    # A word the judge finds handed over is easy too: with « chat » easy, a second is refused.
    problems, _ = refusals(first, SENT, similarity=no_sim, fillers=expected_chat, handed_over=lambda ws: {"lune"})
    assert [w for w, _ in problems] == ["lune"]


def test_an_obvious_word_is_refused_even_first():
    obvious_chat = lambda t: (["chat", "chien"], "chat") if t.text == "chat" else open_reader(t)  # noqa: E731
    trio = [_by("chat"), _by("pierre"), _by("lune")]
    problems, _ = refusals(trio, SENT, similarity=no_sim, fillers=obvious_chat, handed_over=lambda ws: set())
    assert [w for w, _ in problems] == ["chat"] and "obvious" in problems[0][1]


def test_conflicts_list_every_forbidden_pair_once_with_its_rule():
    cands = initial_candidates(SENT, in_vocab=VOCAB.__contains__)
    pairs = conflicts(cands, SENT, similarity=no_sim)
    assert ("dort", "brille", "two verbs (at most one verb)") in pairs
    assert any({a, b} == {"chat", "dort"} for a, b, _ in pairs)
    assert not any({a, b} == {"chat", "pierre"} for a, b, _ in pairs)
    assert len({frozenset((a, b)) for a, b, _ in pairs}) == len(pairs)

