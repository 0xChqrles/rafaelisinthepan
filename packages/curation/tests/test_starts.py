from starts import article_problem, displayed, elision_problem, letter_problem, previous_token, start_candidates

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
        "usage": {"word": "usage", "rank": 110},
        "esprit": {"word": "esprit", "rank": 105},
        "monde": {"word": "monde", "rank": 120},
        "effet": {"word": "effet", "rank": 104},
        "proche": {"word": "proche", "rank": 60},    # closer than the band
        "loin": {"word": "loin", "rank": 300},       # the old contextual band: too far
    }
    words = [e["word"] for e in start_candidates(ranks, "savoir", "le", exclude={"effet"}, lang="fr")]
    assert words == ["monde"]        # usage/esprit elide after « le », savoirs is a variant, proche/loin are off-band
    assert [e["word"] for e in start_candidates(ranks, "savoir", "du", lang="fr")] == ["effet", "esprit", "usage", "monde"]
    # a word too rare for a player is out; an unknown frequency is kept
    rare = lambda w: {"esprit": 90000, "usage": 500}.get(w)  # noqa: E731
    assert [e["word"] for e in start_candidates(ranks, "savoir", "du", frequency_rank=rare, lang="fr")] == ["effet", "usage", "monde"]


def test_y_initial_is_the_models_call_like_h():
    assert elision_problem("le", "yaourt") is None       # « le yaourt » is right; « l'yeuse » too
    assert elision_problem("l’", "yeuse") is None
    assert [e["word"] for e in start_candidates({"yoga": {"word": "yoga", "rank": 120}}, "savoir", "le", lang="fr")] == ["yoga"]


# English's twin of elision (#317): « a » / « an » before the start word. Sounds decide,
# so code refuses only what the letters make certain and leaves the rest to the model.
def test_article_rule_refuses_only_what_the_letters_make_certain():
    assert article_problem("a", "effect")
    assert article_problem("A", "idea")
    assert article_problem("a", "orange")
    assert article_problem("an", "dog")
    assert article_problem("An", "cat")
    assert article_problem("an", "window")
    assert article_problem("a", "dog") is None
    assert article_problem("an", "effect") is None
    assert article_problem("the", "effect") is None
    # sounds, not letters: the model's call, never code's
    for prev, word in [("an", "hour"), ("a", "house"), ("a", "university"), ("an", "umbrella"),
                       ("a", "one-off"), ("a", "once-great"), ("a", "euro"), ("a", "ewe"),
                       ("an", "x-ray"), ("an", "fbi"), ("an", "mri"), ("an", "sos"),
                       ("a", "yacht"), ("an", "yttrium")]:
        assert article_problem(prev, word) is None, (prev, word)


def test_the_letter_rule_is_the_language_s_own():
    # « le effet » is a French fault, not an English one; « a effect » the reverse.
    assert letter_problem("le", "effet", "fr") and letter_problem("le", "effet", "en") is None
    assert letter_problem("a", "effect", "en") and letter_problem("a", "effect", "fr") is None
    assert letter_problem("l’", "monde", "fr") and letter_problem("l’", "monde", "en") is None


def test_english_start_candidates_pass_the_article_rule():
    ranks = {"idea": {"word": "idea", "rank": 110}, "guess": {"word": "guess", "rank": 120},
             "belief": {"word": "belief", "rank": 130}, "hour": {"word": "hour", "rank": 140}}
    # « hour » stays either way: an h is the model's call
    assert [e["word"] for e in start_candidates(ranks, "thought", "a", lang="en")] == ["guess", "belief", "hour"]
    assert [e["word"] for e in start_candidates(ranks, "thought", "an", lang="en")] == ["idea", "hour"]
    assert [e["word"] for e in start_candidates(ranks, "thought", "“the", lang="en")] == ["idea", "guess", "belief", "hour"]
