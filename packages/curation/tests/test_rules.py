"""The facts code keeps about a candidate secret, asserted against the package AGENTS.md:
which words CAN be hidden, what counts as the secret again, the reader's note, and where
the reader's words land in a hole's map. Nothing here chooses — taste does."""

from rules import (
    MAX_COMMON_RANK,
    MAX_COMMON_RANK_ADV,
    PLAIN_WORD_RANK,
    BURIED_CROWD,
    BURIED_WOULD_SAY,
    CROWD_N,
    TWIN_RANK,
    WEAK_VERBS,
    WOULD_SAY_HARD,
    Token,
    buried,
    crowd_share,
    initial_candidates,
    is_twin,
    map_nearest_filler,
    reading,
    said,
    same_word,
    unsaid,
)


def tok(i, text, pos, lemma=None, stop=False):
    return Token(i=i, text=text, lemma=lemma or text, pos=pos,
                 slug=text.lower().replace("é", "e"), stop=stop)


# "le vieux chat gris dort sur la pierre froide et la lune blanche brille"
SENT = [
    tok(0, "le", "DET", stop=True),
    tok(1, "vieux", "ADJ"),
    tok(2, "chat", "NOUN"),
    tok(3, "gris", "ADJ"),
    tok(4, "dort", "VERB", lemma="dormir"),
    tok(5, "sur", "ADP", stop=True),
    tok(6, "la", "DET", stop=True),
    tok(7, "pierre", "NOUN"),
    tok(8, "froide", "ADJ", lemma="froid"),
    tok(9, "et", "CCONJ", stop=True),
    tok(10, "la", "DET", stop=True),
    tok(11, "lune", "NOUN"),
    tok(12, "blanche", "ADJ", lemma="blanc"),
    tok(13, "brille", "VERB", lemma="briller"),
]
VOCAB = {t.slug for t in SENT}
no_rank = lambda t, w: None  # noqa: E731
CHAT = SENT[2]


# --- which words can be hidden ------------------------------------------------------

def test_initial_candidates_keep_only_content_words_the_game_admits():
    # « encore »: an adverb the game admits, and a stopword — out like the determiners
    sent = SENT + [tok(14, "encore", "ADV", stop=True)]
    cands = initial_candidates(sent, lang="fr", in_vocab=(VOCAB | {"encore"}).__contains__)
    assert [c.text for c in cands] == [
        "vieux", "chat", "gris", "dort", "pierre", "froide", "lune", "blanche", "brille",
    ]


def test_a_word_the_parser_calls_a_proper_noun_can_be_hidden():
    # « les rolex », « en zigzag »: the parser tags them PROPN; both were secrets of a
    # favourite day. Whether a name is worth hiding is taste's call.
    sent = SENT + [tok(14, "rolex", "PROPN")]
    assert "rolex" in {t.text for t in initial_candidates(sent, lang="fr", in_vocab=lambda s: True)}


def test_initial_candidates_drop_past_secrets_and_unknown_slugs():
    cands = initial_candidates(SENT, lang="fr", in_vocab=lambda s: s != "lune", past_secrets={"chat"})
    texts = [c.text for c in cands]
    assert "lune" not in texts and "chat" not in texts


def test_initial_candidates_drop_a_same_lemma_twin_under_another_slug():
    sent = SENT + [tok(14, "dormait", "VERB", lemma="dormir")]
    cands = initial_candidates(sent, lang="fr", in_vocab=lambda s: True)
    assert "dort" not in [c.text for c in cands]
    assert "dormait" not in [c.text for c in cands]


def test_a_same_slug_repeat_stays_a_candidate():
    sent = SENT + [tok(14, "chat", "NOUN")]
    cands = initial_candidates(sent, lang="fr", in_vocab=lambda s: True)
    assert [c.text for c in cands].count("chat") == 2


def test_initial_candidates_drop_the_commonest_words_and_common_adverbs():
    sent = SENT + [tok(14, "bien", "ADV"), tok(15, "pensivement", "ADV")]
    ranks = {"bien": 3, "pensivement": 9000, "chat": MAX_COMMON_RANK - 1, "lune": MAX_COMMON_RANK}
    cands = initial_candidates(sent, lang="fr", in_vocab=lambda s: True, frequency_rank=lambda t: ranks.get(t.text))
    texts = [c.text for c in cands]
    assert "bien" not in texts and "chat" not in texts
    assert "pensivement" in texts and "lune" in texts
    assert MAX_COMMON_RANK_ADV > MAX_COMMON_RANK


def test_an_adverb_has_its_own_frequency_floor():
    # « jamais » (158) is out as an adverb; a noun as common stays
    sent = SENT + [tok(14, "jamais", "ADV"), tok(15, "presque", "ADV"), tok(16, "doucement", "ADV")]
    ranks = {"jamais": 158, "lune": 158, "presque": 499, "doucement": 500}
    cands = initial_candidates(sent, lang="fr", in_vocab=lambda s: True, frequency_rank=lambda t: ranks.get(t.text))
    texts = [c.text for c in cands]
    assert "jamais" not in texts and "presque" not in texts
    assert "lune" in texts and "doucement" in texts


def test_weak_verbs_are_never_candidates():
    assert "croire" in WEAK_VERBS["fr"]
    sent = [tok(0, "je", "PRON", stop=True), tok(1, "crois", "VERB", lemma="croire"),
            tok(2, "chat", "NOUN"), tok(3, "dort", "VERB", lemma="dormir")]
    assert [t.text for t in initial_candidates(sent, lang="fr", in_vocab=lambda s: True)] == ["chat", "dort"]


def test_the_same_word_is_its_lemma_or_a_variant_never_a_near_neighbour():
    sauva = Token(i=0, text="sauva", lemma="sauver", pos="VERB", slug="sauva", stop=False)
    assert same_word(sauva, "sauver") and same_word(sauva, "Sauva")
    fm = Token(i=0, text="faux-monnayeur", lemma="faux-monnayeur", pos="NOUN", slug="faux-monnayeur", stop=False)
    assert not same_word(fm, "faussaire") and not same_word(fm, None) and not same_word(fm, "faux monnayeur")


def test_the_crowd_is_the_share_of_the_nearest_groups_commoner_than_the_secret():
    index = {"charnier": 5000, "cimetiere": 900, "ossuaire": 9000, "fosse": 1200, "tombe": 800, "zzz": None}.get
    rank_map = {"charnier": {"rank": 0}, "charniers": {"rank": 0}, "cimetiere": {"rank": 1}, "ossuaire": {"rank": 2},
                "fosse": {"rank": 3}, "tombe:nc": {"rank": 4}, "zzz": {"rank": 5}}
    assert crowd_share(rank_map, index) == 0.75          # 3 of the 4 known neighbours are commoner
    assert crowd_share({"x": {"rank": 1}}, index) is None  # no secret group
    far = {"charnier": {"rank": 0}, **{f"w{i}": {"rank": i} for i in range(1, CROWD_N + 10)}}
    assert crowd_share(far, lambda s: 1 if s.startswith("w") and int(s[1:]) > CROWD_N else 9000 if s.startswith("w")
                       else 5000) == 0.0             # only the CROWD_N nearest groups count


def test_a_buried_word_is_half_said_and_in_a_crowd_a_rare_name_is_not():
    # User-decided 2026-10-08: « charnier » (0.475, 22 of 30 commoner) is buried; « saint-bernard »
    # (0.575, 25 of 30) is a rare name players say; « clodos » has no crowd big enough.
    assert (BURIED_WOULD_SAY, BURIED_CROWD) == (0.50, 0.70)
    assert buried(0.475, 22 / 30) and not buried(0.575, 25 / 30) and not buried(0.38, 0.5)
    assert not buried(None, 0.9) and not buried(0.3, None)


def test_the_english_weak_verbs_are_the_french_list_translated():
    # #317: the user's French list (2026-09-08), word for word — dire, croire, penser,
    # savoir, sembler, paraître, vouloir, pouvoir, devoir, falloir, trouver, avoir, être,
    # faire, aller — nothing added.
    assert WEAK_VERBS["en"] == {"say", "believe", "think", "know", "seem", "appear", "want", "can",
                                "must", "need", "find", "have", "be", "do", "make", "go"}
    sent = [tok(0, "i", "PRON", stop=True), tok(1, "think", "VERB"),
            tok(2, "the", "DET", stop=True), tok(3, "cat", "NOUN"),
            tok(4, "sleeps", "VERB", lemma="sleep"), tok(5, "said", "VERB", lemma="say")]
    assert [t.text for t in initial_candidates(sent, lang="en", in_vocab=lambda s: True)] == ["cat", "sleeps"]
    # the languages share nothing: « dire » is no English lemma, « say » no French one
    sent_fr = [tok(0, "say", "VERB", lemma="say")]
    assert [t.text for t in initial_candidates(sent_fr, lang="fr", in_vocab=lambda s: True)] == ["say"]


def test_a_hyphenated_compound_can_be_hidden():
    # « les post-it » was a secret of a favourite day (user-decided 2026-09-24, lifting the
    # 2026-09-10 exclusion).
    sent = SENT + [tok(14, "post-it", "NOUN")]
    vocab = VOCAB | {"post-it"}
    assert "post-it" in {t.text for t in initial_candidates(sent, lang="fr", in_vocab=vocab.__contains__)}


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
    # a word AT the boundary is still one a player knows
    note = reading(CHAT, ["chat", "ronde"], "chat", frequency_rank=lambda t: PLAIN_WORD_RANK)
    assert note.startswith("most readers would write the secret itself")


# --- the word players say: a note per hole, and the trio's fact past one -----------------

def test_the_said_note_gives_the_chance_and_the_word_kept_instead():
    assert said(0.8, None) == "a player who has the meaning says this exact word at 0.80"
    note = said(0.3, "faussaire")
    assert "at 0.30" in note and "« faussaire »" in note and "a word players don't say" in note
    assert "don't say" not in said(WOULD_SAY_HARD, "x")  # the cut itself is said
    assert said(None, "x") == "whether players would say this word: not measured"


def test_one_word_players_dont_say_is_a_hard_day_two_are_the_fact_to_act_on():
    # « moucheron », « mammifères », « stagnation »: a loved day hides one
    assert unsaid({"moucheron": 0.38, "humain": 0.9, "archives": 0.57}) is None
    assert unsaid({"a": 0.9, "b": 0.8, "c": None}) is None
    note = unsaid({"faux-monnayeur": 0.3, "autre": 0.2, "plain": 0.9})
    assert note is not None and "2 words" in note and "faux-monnayeur, autre" in note and "plain" not in note
    assert unsaid({"a": WOULD_SAY_HARD, "b": 0.1, "c": 0.9}) is None  # the cut itself is said
    assert unsaid({"a": None, "b": 0.1, "c": 0.2}) is not None  # an unmeasured word counts for nothing


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
