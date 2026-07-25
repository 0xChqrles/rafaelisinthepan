"""CONTRACT: lemma-donor vector substitution (#119).

A sentence form can be a valid inflection with NO vector in the reduced embedding while
its SLUG is still typable through an accent sibling ("accoutumes" is absent,
"accoutumés" is present and folds to the same slug). Such a secret may borrow a
same-lemma form's vector, under these rules:

  - the borrow is the GEOMETRY source only: the hole keeps the true sentence form, the
    rank map stays keyed by the secret's slug, and ranks >= 1 are exactly the donor's;
  - the donor is absorbed as a rank-0 alias by the #104 merge walk (typing it solves);
  - the donor's lemmas are claimed by the secret's group, so its whole family solves;
  - a missing form the lemma table does not know at all is bridged through the
    reduced-vocab forms sharing its SLUG (the real Lexique has no "accoutumes" row);
  - nothing is ever guessed: off a TTY the donor must be spelled out with --donor,
    validated as an in-vocabulary form sharing a lemma with the missing one;
  - no candidate at all -> the pre-#119 reduction error, unchanged;
  - typability guard: a secret whose slug is absent from the existence set is a hard
    error even when donors exist — the player could never type it;
  - suggestions are ordered by accent-aware edit distance, then by frequency; the
    ordering is a convenience, the choice is the human's.
"""

import json

import pytest

import gen_phrase


FR = gen_phrase.CONFIG["fr"]

# A slice of the REAL committed fr table: Lexique has rows for accoutume / accoutumé /
# accoutumés / accoutumer but NONE for "accoutumes" (the missing 2sg present), so that
# form belongs to no lemma group of its own — only its accent sibling can name one.
# "chanter" is the untypable counter-example: a donor exists, the slug is unreachable.
TABLE = {
    "accoutume": ("accoutumer",),
    "accoutumé": ("accoutumé", "accoutumer"),
    "accoutumés": ("accoutumé", "accoutumer"),
    "accoutumer": ("accoutumer",),
    "chanter": ("chanter",),
    "chante": ("chanter",),
    "doucement": ("doucement",),
    "jardin": ("jardin",),
    "vermine": ("vermine",),
}
FORMS = gen_phrase.invert_lemmas(TABLE)

# The reduced vocabulary, in the reduced file's FREQUENCY order. "accoutumes" and
# "chanter" are the vector-less forms; "accoutumés" folds to the former's slug.
VOCAB = ["jardin", "doucement", "vermine", "accoutumé", "accoutumés", "accoutume",
         "accoutumer", "chante"]
VSET = set(VOCAB)

SENTENCE = "tu t'accoutumes doucement au jardin."
RANKINGS = {
    "accoutume": [("accoutumés", 0, 0.99), ("vermine", 1, 0.8), ("jardin", 2, 0.7)],
}
DEFAULT_RANKING = [("vermine", 0, 0.9), ("jardin", 1, 0.8)]


def _words(sentence=SENTENCE):
    return [gen_phrase.display_token(t) for t in sentence.split()]


def _resolver(explicit=None, interactive=False):
    return gen_phrase.DonorResolver(
        TABLE, FORMS, VOCAB, VSET, "fr",
        explicit=explicit or {}, interactive=interactive,
    )


def _stub_closest(monkeypatch):
    """Record which word each neighbor walk started from."""
    calls = []

    def closest(word, _kv, _v, _m, *, n):
        calls.append(word)
        return RANKINGS.get(word, DEFAULT_RANKING)

    monkeypatch.setattr(FR["module"], "closest", closest, raising=False)
    monkeypatch.setattr(
        gen_phrase, "choose_start",
        lambda _secret, _ranking, _rank_map, _rank_by_display: "vermine",
    )
    return calls


def _generate(monkeypatch, selectors=("accoutumes", "doucement", "jardin"),
              sentence=SENTENCE, explicit=None):
    calls = _stub_closest(monkeypatch)
    holes, ranks = gen_phrase.holes_from_words(
        list(selectors), _words(sentence), FR, "fr",
        kv=object(), V=VOCAB, M=object(), Vset=VSET,
        lemma_table=TABLE, forms_by_lemma=FORMS,
        donors=_resolver(explicit),
    )
    return holes, ranks, calls


def test_donor_flag_lends_its_vector_and_the_hole_keeps_the_true_form(monkeypatch):
    holes, ranks, calls = _generate(
        monkeypatch, explicit={"accoutumes": "accoutume"})

    # the walk started from the DONOR; the other two secrets are their own source.
    assert calls == ["accoutume", "doucement", "jardin"]

    # the hole still displays the sentence's own form, with its clitic kept apart.
    hole = next(h for h in holes if h["secret"]["slug"] == "accoutumes")
    assert hole["secret"] == {"word": "accoutumes", "slug": "accoutumes"}
    assert hole["prefix"] == "t'"

    # ranks stay keyed by the SECRET slug, secret at rank 0...
    rmap = ranks["accoutumes"]
    assert rmap["accoutumes"] == {"word": "accoutumes", "rank": 0}
    # ...and the donor is absorbed as a rank-0 alias: typing it solves the hole, and
    # what the front displays is the true secret.
    assert rmap["accoutume"] == {"word": "accoutumes", "rank": 0}
    assert rmap["accoutumer"] == {"word": "accoutumes", "rank": 0}


def test_borrowed_ranks_are_the_donors_own_ranks(monkeypatch):
    _holes, ranks, _calls = _generate(
        monkeypatch, explicit={"accoutumes": "accoutume"})

    # Everything past the secret's own group is exactly what a map built directly on
    # the donor would hold: the substitution moves the walk's origin, nothing else.
    _merged, donor_map = gen_phrase.build_merged_rank_map(
        "accoutume", RANKINGS["accoutume"], TABLE, FORMS, VSET)
    far = {k: v for k, v in ranks["accoutumes"].items() if v["rank"] > 0}
    assert far == {k: v for k, v in donor_map.items() if v["rank"] > 0}
    assert far == {"vermine": {"word": "vermine", "rank": 1},
                   "jardin": {"word": "jardin", "rank": 2}}


def test_missing_form_without_any_candidate_keeps_the_reduction_error(monkeypatch, capsys):
    _stub_closest(monkeypatch)
    with pytest.raises(SystemExit):
        gen_phrase.holes_from_words(
            ["zorglub", "doucement", "jardin"],
            _words("tu zorglub doucement au jardin."), FR, "fr",
            kv=object(), V=VOCAB, M=object(), Vset=VSET,
            lemma_table=TABLE, forms_by_lemma=FORMS, donors=_resolver(),
        )
    assert "n'a pas survécu à la réduction" in capsys.readouterr().err


def test_off_tty_without_donor_lists_the_candidates(monkeypatch, capsys):
    _stub_closest(monkeypatch)
    with pytest.raises(SystemExit):
        _generate(monkeypatch)
    err = capsys.readouterr().err
    for form in ("accoutumés", "accoutume", "accoutumer", "accoutumé"):
        assert form in err
    assert "--donor accoutumes=" in err


def test_donor_must_share_a_lemma_with_the_missing_form(monkeypatch, capsys):
    with pytest.raises(SystemExit):
        _generate(monkeypatch, explicit={"accoutumes": "vermine"})
    assert "ne partage aucun lemme" in capsys.readouterr().err


def test_donor_must_have_a_vector(monkeypatch, capsys):
    with pytest.raises(SystemExit):
        _generate(monkeypatch, explicit={"accoutumes": "accoutumions"})
    assert "absent du vocabulaire réduit" in capsys.readouterr().err


def test_untypable_secret_is_a_hard_error_even_with_a_valid_donor(monkeypatch, capsys):
    # "chanter" has a same-lemma donor with a vector ("chante"), but NO reduced word
    # folds to its slug: the player could never type the secret, so the hole is refused.
    assert _resolver().candidates("chanter") == ["chante"]
    with pytest.raises(SystemExit):
        _generate(monkeypatch, selectors=("chanter", "doucement", "jardin"),
                  sentence="tu vas chanter doucement au jardin.",
                  explicit={"chanter": "chante"})
    assert "ne pourrait jamais taper" in capsys.readouterr().err


def test_lemma_lookup_bridges_a_form_the_table_does_not_know():
    resolver = _resolver()
    # the table knows this one: it answers directly.
    assert resolver.lemmas_for("accoutumés") == ("accoutumé", "accoutumer")
    # it has no row for "accoutumes"; the reduced form sharing its slug — the very
    # word that makes the secret typable — names the group instead.
    assert resolver.lemmas_for("accoutumes") == ("accoutumé", "accoutumer")
    # nothing to bridge to: no group, hence no donor.
    assert resolver.lemmas_for("zorglub") == ()
    assert resolver.candidates("zorglub") == []


def test_the_donors_whole_family_solves_the_borrowed_hole(monkeypatch):
    # The secret's group claims the donor's lemma, so every inflection of it aliases
    # to rank 0 — the #104 rule ("an inflection of the secret solves") holds for a
    # borrowed identity too, even though the table knows nothing about "accoutumes".
    _holes, ranks, _calls = _generate(
        monkeypatch, explicit={"accoutumes": "accoutume"})
    rmap = ranks["accoutumes"]
    for form in ("accoutume", "accoutumer", "accoutumé", "accoutumés"):
        assert rmap[gen_phrase.slug(form)]["rank"] == 0
        assert rmap[gen_phrase.slug(form)]["word"] == "accoutumes"


def test_candidates_are_sorted_by_edit_distance_then_frequency():
    # Three forms are one edit away from "accoutumes" (accoutumés: e->é, accoutume:
    # drop s, accoutumer: s->r) and rank by frequency; "accoutumé" is two edits away
    # and comes last DESPITE being the most frequent of them all.
    assert _resolver().candidates("accoutumes") == [
        "accoutumés", "accoutume", "accoutumer", "accoutumé",
    ]
    # distance is measured on the DISPLAY forms: the accent sibling is not distance 0.
    assert gen_phrase.edit_distance("accoutumes", "accoutumés") == 1
    assert gen_phrase.edit_distance("accoutumes", "accoutumes") == 0


def test_selector_offers_a_donor_eligible_word_and_hides_the_rest():
    words = _words("tu t'accoutumes doucement au jardin.")
    # without a resolver the vector-less core is not selectable (pre-#119 behaviour)
    assert [c["secret"] for c in gen_phrase.extract_candidates(words, FR, VSET)] == [
        "doucement", "jardin",
    ]
    # with one it is offered, in sentence order, with its affixes intact
    cands = gen_phrase.extract_candidates(words, FR, VSET, _resolver())
    assert [c["secret"] for c in cands] == ["accoutumes", "doucement", "jardin"]
    assert cands[0]["prefix"] == "t'"

    # an untypable vector-less word stays out, resolver or not.
    chant = gen_phrase.extract_candidates(
        _words("tu vas chanter doucement."), FR, VSET, _resolver())
    assert [c["secret"] for c in chant] == ["doucement"]


def test_tty_prompt_defaults_to_the_suggestion_and_accepts_a_number(monkeypatch):
    resolver = _resolver(interactive=True)
    cands = resolver.candidates("accoutumes")

    monkeypatch.setattr("builtins.input", lambda _p="": "")
    assert resolver.choose_donor("accoutumes", cands) == "accoutumés"
    monkeypatch.setattr("builtins.input", lambda _p="": "2")
    assert resolver.choose_donor("accoutumes", cands) == "accoutume"


def test_donor_flag_parsing_rejects_a_malformed_pair(capsys):
    assert gen_phrase.parse_donor_args(["Accoutumes=Accoutume"]) == {
        "accoutumes": "accoutume",
    }
    with pytest.raises(SystemExit):
        gen_phrase.parse_donor_args(["accoutumes"])
    assert "MANQUANT=DONNEUR" in capsys.readouterr().err


def test_selector_asks_for_the_donor_before_ranking(monkeypatch, capsys):
    """The interactive path must reach the same puzzle: hovering a vector-less word
    ranks nothing, committing it asks for the donor, and the walk then starts there."""
    import os
    import termios
    import tty

    calls = _stub_closest(monkeypatch)
    monkeypatch.setattr(gen_phrase, "start_band", lambda _secret, _ranking: [("vermine", 1)])

    fd = os.open(os.devnull, os.O_RDONLY)
    monkeypatch.setattr(gen_phrase.sys, "stdin",
                        type("Stdin", (), {"fileno": lambda self: fd,
                                           "isatty": lambda self: True})())
    monkeypatch.setattr(termios, "tcgetattr", lambda _fd: None)
    monkeypatch.setattr(termios, "tcsetattr", lambda *_a: None)
    monkeypatch.setattr(tty, "setcbreak", lambda _fd: None)
    # accoutumes: commit -> Entrée keeps the suggested donor -> start word 1;
    # then the two ordinary words go straight to their start word.
    keys = iter(["ENTER", "ENTER", "1", "ENTER",
                 "ENTER", "1", "ENTER",
                 "ENTER", "1", "ENTER"])
    monkeypatch.setattr(gen_phrase, "_read_key", lambda _fd: next(keys))

    donors = _resolver(interactive=True)
    try:
        holes, ranks = gen_phrase.select_holes_interactive(
            _words(), FR, "fr", kv=object(), V=VOCAB, M=object(), Vset=VSET,
            lemma_table=TABLE, forms_by_lemma=FORMS, donors=donors)
    finally:
        os.close(fd)

    assert [h["secret"]["word"] for h in holes] == [
        "accoutumes", "doucement", "jardin",
    ]
    # Entrée took the suggestion, and the walk started from it — not from the secret.
    assert donors.used == {"accoutumes": ("accoutumes", "accoutumés")}
    assert calls[0] == "accoutumés"
    assert ranks["accoutumes"]["accoutumes"] == {"word": "accoutumes", "rank": 0}
    assert ranks["accoutumes"]["accoutume"]["rank"] == 0


def test_a_committed_lemma_spends_every_donor_of_a_vector_less_word():
    # Holing "accoutume" claims the accoutumer group. "accoutumes" has no lemma of its
    # own in the table — a singleton that clashes with nothing — but every donor it
    # could borrow belongs to that spent group, so it must stop being selectable.
    donors = _resolver()
    fresh, spent = set(), set(gen_phrase.group_lemmas("accoutume", "accoutume", TABLE))
    assert spent == {"accoutumer"}

    assert gen_phrase.free_donors("accoutumes", fresh, TABLE, donors)
    assert not gen_phrase.spent_candidate("accoutumes", set(), fresh, TABLE, donors)

    assert gen_phrase.free_donors("accoutumes", spent, TABLE, donors) == []
    assert gen_phrase.spent_candidate("accoutumes", set(), spent, TABLE, donors)
    # and the ordinary rule is untouched: a form of the spent group is spent too.
    assert gen_phrase.spent_candidate("accoutumer", set(), spent, TABLE, donors)
    assert not gen_phrase.spent_candidate("jardin", set(), spent, TABLE, donors)


def test_selector_will_not_hole_a_donors_lemma_twice(monkeypatch):
    """Committing "accoutume" spends the accoutumer group, so the vector-less
    "accoutumes" — whose every donor belongs to that same group — must stop being
    selectable. Its own lemmas cannot say so: the table does not know the form, so it
    is a singleton that clashes with nothing."""
    import os
    import termios
    import tty

    _stub_closest(monkeypatch)
    monkeypatch.setattr(gen_phrase, "start_band", lambda _secret, _ranking: [("vermine", 1)])

    fd = os.open(os.devnull, os.O_RDONLY)
    monkeypatch.setattr(gen_phrase.sys, "stdin",
                        type("Stdin", (), {"fileno": lambda self: fd,
                                           "isatty": lambda self: True})())
    monkeypatch.setattr(termios, "tcgetattr", lambda _fd: None)
    monkeypatch.setattr(termios, "tcsetattr", lambda *_a: None)
    monkeypatch.setattr(tty, "setcbreak", lambda _fd: None)
    # three plain commits: whatever the cursor lands on after "accoutume" is committed
    # must NOT be "accoutumes" — otherwise these keys would hole it as the second word.
    keys = iter(["ENTER", "1", "ENTER"] * 3)
    monkeypatch.setattr(gen_phrase, "_read_key", lambda _fd: next(keys))

    words = _words("il accoutume et tu t'accoutumes doucement au jardin.")
    donors = _resolver(interactive=True)
    assert [c["secret"] for c in gen_phrase.extract_candidates(words, FR, VSET, donors)] == [
        "accoutume", "accoutumes", "doucement", "jardin",
    ]
    try:
        holes, ranks = gen_phrase.select_holes_interactive(
            words, FR, "fr", kv=object(), V=VOCAB, M=object(), Vset=VSET,
            lemma_table=TABLE, forms_by_lemma=FORMS, donors=donors)
    finally:
        os.close(fd)

    assert [h["secret"]["word"] for h in holes] == ["accoutume", "doucement", "jardin"]
    assert set(ranks) == {"accoutume", "doucement", "jardin"}
    assert donors.used == {}  # no substitution was needed, none was invented


def test_main_writes_the_puzzle_and_names_the_substitution(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(FR["module"], "load_vectors", lambda: object(), raising=False)
    monkeypatch.setattr(FR["module"], "build_vocab", lambda _kv: VOCAB, raising=False)
    monkeypatch.setattr(FR["module"], "build_matrix", lambda _kv, _v: object(), raising=False)
    _stub_closest(monkeypatch)
    monkeypatch.setattr(gen_phrase, "write_vocab", lambda _v, _lang: None)
    monkeypatch.setattr(gen_phrase, "load_lemma_table", lambda _lang, disabled=False: TABLE)
    monkeypatch.setattr(gen_phrase.sys.stdin, "isatty", lambda: False, raising=False)
    monkeypatch.setattr(gen_phrase.sys, "argv", [
        "gen_phrase.py", SENTENCE, "--lang", "fr",
        "--words", "accoutumes", "doucement", "jardin",
        "--donor", "accoutumes=accoutume",
        "--out-dir", str(tmp_path),
    ])

    gen_phrase.main()

    data = json.loads((tmp_path / "fr" / "accoutumes_doucement_jardin.json")
                      .read_text(encoding="utf-8"))
    assert [h["secret"]["word"] for h in data["holes"]] == [
        "accoutumes", "doucement", "jardin",
    ]
    assert data["ranks"]["accoutumes"]["accoutume"]["rank"] == 0
    # the borrow is surfaced, never silent.
    out = capsys.readouterr().out
    assert "secret « accoutumes » : rangs calculés depuis le donneur « accoutume »" in out
