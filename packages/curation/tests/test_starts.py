from starts import displayed, elision_problem, previous_token, start_candidates

WORDS = ["le", "savoir", "humain", "sera", "rayé", "des", "archives", "du", "monde", "d’un", "moucheron."]
HOLES = [
    {"pos": 1, "secret": {"word": "savoir", "slug": "savoir"}, "start": {"word": "effet"}},
    {"pos": 6, "secret": {"word": "archives", "slug": "archives"}, "start": {"word": "dossiers"}},
    {"pos": 10, "secret": {"word": "moucheron", "slug": "moucheron"}, "start": {"word": "insecte"},
     "prefix": "", "suffix": "."},
]


def test_displayed_shows_start_words_and_overrides():
    assert displayed(WORDS, HOLES).startswith("le effet humain sera rayé des dossiers")
    assert displayed(WORDS, HOLES, {"savoir": "[____]"}).startswith("le [____] humain")
    assert displayed(WORDS, HOLES).endswith("d’un insecte.")


def test_elision_rule():
    assert elision_problem("le", "effet")
    assert elision_problem("que", "il")
    assert elision_problem("l’", "monde")
    assert elision_problem("l'", "monde")
    assert elision_problem("le", "monde") is None
    assert elision_problem("l’", "effet") is None
    assert elision_problem("le", "hasard") is None      # h: the model's call
    assert elision_problem("des", "archives") is None


def test_previous_token_prefers_the_hole_prefix():
    assert previous_token(WORDS, HOLES[0]) == "le"
    assert previous_token(WORDS, {"pos": 3, "prefix": "l’", "secret": {}, "start": {}}) == "l’"


def test_start_candidates_are_the_band_minus_variants_and_elision_failures():
    ranks = {
        "savoir": {"word": "savoir", "rank": 0},
        "savoirs": {"word": "savoirs", "rank": 3},
        "usage": {"word": "usage", "rank": 60},
        "esprit": {"word": "esprit", "rank": 55},
        "monde": {"word": "monde", "rank": 80},
        "effet": {"word": "effet", "rank": 104},
        "loin": {"word": "loin", "rank": 400},
    }
    words = [e["word"] for e in start_candidates(ranks, "savoir", "le", exclude={"effet"})]
    assert words == ["monde"]        # usage/esprit elide after « le », savoirs is a variant, loin is off-band
    assert [e["word"] for e in start_candidates(ranks, "savoir", "du")] == ["esprit", "usage", "monde", "effet"]
