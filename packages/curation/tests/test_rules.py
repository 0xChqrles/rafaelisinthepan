"""The facts code keeps about a candidate secret, asserted against the package AGENTS.md:
which words CAN be hidden, what counts as the secret again, the reader's note, and where
the reader's words land in a hole's map. Nothing here chooses — taste does."""

from rules import (
    MAX_COMMON_RANK,
    MAX_COMMON_RANK_ADV,
    PLAIN_WORD_RANK,
    TWIN_RANK,
    WEAK_VERBS,
    Token,
    initial_candidates,
    is_twin,
    map_nearest_filler,
    reading,
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
no_rank = lambda t, w: None  # noqa: E731
CHAT = SENT[2]


# --- which words can be hidden ------------------------------------------------------

def test_initial_candidates_keep_only_content_words_the_game_admits():
    cands = initial_candidates(SENT, in_vocab=VOCAB.__contains__)
    assert [c.text for c in cands] == [
        "vieux", "chat", "gris", "dort", "pierre", "froide", "lune", "blanche", "brille",
    ]


def test_a_word_the_parser_calls_a_proper_noun_can_be_hidden():
    # « les rolex », « en zigzag »: the parser tags them PROPN; both were secrets of a
    # favourite day. Whether a name is worth hiding is taste's call.
    sent = SENT + [tok(14, "rolex", "PROPN", "obj", 13)]
    assert "rolex" in {t.text for t in initial_candidates(sent, in_vocab=lambda s: True)}


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


def test_initial_candidates_drop_the_commonest_words_and_common_adverbs():
    sent = SENT + [tok(14, "bien", "ADV", "advmod", 13), tok(15, "pensivement", "ADV", "advmod", 13)]
    ranks = {"bien": 3, "pensivement": 9000, "chat": MAX_COMMON_RANK - 1, "lune": MAX_COMMON_RANK}
    cands = initial_candidates(sent, in_vocab=lambda s: True, frequency_rank=lambda t: ranks.get(t.text))
    texts = [c.text for c in cands]
    assert "bien" not in texts and "chat" not in texts
    assert "pensivement" in texts and "lune" in texts
    assert MAX_COMMON_RANK_ADV > MAX_COMMON_RANK


def test_weak_verbs_are_never_candidates():
    assert "croire" in WEAK_VERBS
    sent = [tok(0, "je", "PRON", "nsubj", 1, stop=True), tok(1, "crois", "VERB", "ROOT", 1, lemma="croire"),
            tok(2, "chat", "NOUN", "obj", 1), tok(3, "dort", "VERB", "conj", 1, lemma="dormir")]
    assert [t.text for t in initial_candidates(sent, in_vocab=lambda s: True)] == ["chat", "dort"]


def test_initial_candidates_drop_a_hyphenated_compound():
    sent = SENT + [tok(14, "sud-américain", "ADJ", "amod", 11)]
    vocab = VOCAB | {"sud-americain"}
    assert "sud-américain" not in {t.text for t in initial_candidates(sent, in_vocab=vocab.__contains__)}


# --- the secret again ---------------------------------------------------------------

def test_a_twin_is_a_variant_or_a_near_neighbour_in_the_ranking():
    ranks = {"chien": TWIN_RANK, "souris": TWIN_RANK + 1, "clés": 0}
    neighbour_rank = lambda t, w: ranks.get(w)  # noqa: E731
    assert is_twin(CHAT, "Chats", no_rank)  # a variant, accent and case aside
    assert is_twin(CHAT, "chien", neighbour_rank)  # within TWIN_RANK
    assert not is_twin(CHAT, "souris", neighbour_rank)  # just past it
    assert not is_twin(CHAT, "lion", neighbour_rank)  # unknown to the vectors


# --- the reader's note: information for the model, never a verdict --------------------

def test_the_note_says_when_most_readers_would_write_the_secret():
    note = reading(CHAT, ["chat", "chien", "rat"], "chat")
    assert note.startswith("most readers would write the secret itself")
    assert "chien, rat" in note and "chat," not in note  # the secret is not its own alternative


def test_a_twin_named_is_the_secret_named_and_folds_out_of_the_alternatives():
    note = reading(CHAT, ["chats", "chien"], "chats")
    assert note.startswith("most readers would write the secret itself")
    assert "chats" not in note.split(":", 1)[1]


def test_the_note_names_another_expected_word_or_a_split():
    assert reading(CHAT, ["chien", "rat"], "chien").startswith("most readers would write « chien »")
    assert reading(CHAT, ["chien", "rat"], None).startswith("readers would split")
    assert reading(CHAT, [], None).endswith("nothing else")


def test_a_rare_word_is_never_said_to_be_what_most_readers_write():
    # « je lance à la [cantonade] »: the model completes the idiom; a player may not know it.
    note = reading(CHAT, ["chat", "ronde"], "chat", frequency_rank=lambda t: PLAIN_WORD_RANK + 1)
    assert not note.startswith("most readers would write the secret")


# --- where the reader's words land in the hole's own map -----------------------------

MAP = {  # a built rank map: slug -> entry (the secret « héros » is rank 0)
    "heros": {"word": "héros", "rank": 0},
    "heroine": {"word": "héroïne", "rank": 2},
    "capitaine": {"word": "capitaine", "rank": 30},
    "garcon": {"word": "garçon", "rank": 404},
    "type": {"word": "type", "rank": 900},
}


def test_the_nearest_reader_word_in_the_map():
    assert map_nearest_filler(MAP, "heros", ["garçon", "gars", "type"]) == ("garçon", 404)
    assert map_nearest_filler(MAP, "heros", ["garçon", "capitaine"]) == ("capitaine", 30)


def test_a_word_past_the_map_has_no_rank_and_a_multiword_filler_is_no_filler():
    assert map_nearest_filler(MAP, "heros", ["gars"]) == ("gars", None)
    assert map_nearest_filler(MAP, "heros", ["tout exprès", "rien que"]) is None


def test_the_secret_and_its_variants_are_not_their_own_filler_in_the_map():
    assert map_nearest_filler(MAP, "heros", ["héros", "héroïne", "type"]) == ("héroïne", 2)
    assert map_nearest_filler(MAP, "heros", ["héros"]) is None
