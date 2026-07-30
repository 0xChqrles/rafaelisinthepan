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

Addendum — the START word has the mirror problem. The rank band can only offer a form
that HAS a vector, but the sentence's grammar may demand one it lacks (« tu t'___ » must
read "amuses" while only "amuse" has a vector), and the hint is shown to the player:

  - wherever a start word is chosen interactively, its DISPLAY form can be overridden;
    Enter keeps the band word, and off a TTY nothing is asked (batch is unchanged);
  - the override is validated like a donor pair: a form of the same word, and typable;
  - start_rank and the geometry stay the band word's — only the displayed form moves;
  - the display slug is registered as an alias at that same rank, so typing the word
    printed in the hole reads its distance instead of a MISS; an existing CLOSER entry
    keeps the key (the smallest-rank collision rule, unchanged).
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
    # the start-word family (addendum): "amuses" is a real form the embedding lacks,
    # "amusions" one nothing in the vocabulary folds to.
    "amuse": ("amuser",),
    "amuses": ("amuser",),
    "amuser": ("amuser",),
    "amusions": ("amuser",),
}
FORMS = gen_phrase.invert_lemmas(TABLE)

# The reduced vocabulary, in the reduced file's FREQUENCY order. "accoutumes" and
# "chanter" are the vector-less forms; "accoutumés" folds to the former's slug.
# "amusés" carries the "amuses" slug into the existence set without being a form the
# table knows — exactly what makes "amuses" typable but unranked.
VOCAB = ["jardin", "doucement", "vermine", "accoutumé", "accoutumés", "accoutume",
         "accoutumer", "chante", "amuse", "amuser", "amusés"]
VSET = set(VOCAB)
# The walk is stubbed, but the road clustering (#115) reads the vectors of the groups
# ahead of the departure, so the fake embedding has to be subscriptable. The coordinates
# are arbitrary: what the donor contract cares about is WHICH word the walk started from,
# not where it landed.
KV = {w: [float(i + 1), 1.0, 0.0] for i, w in enumerate(VOCAB)}

SENTENCE = "tu t'accoutumes doucement au jardin."
# Every stub walk must leave at least TWO groups once the secret's own is dropped, with
# distinct similarities: a one-group neighborhood has no distance span to quantize, and
# #115 makes that a hard error rather than shipping all-zero dq.
RANKINGS = {
    "accoutume": [("accoutumés", 0, 0.99), ("vermine", 1, 0.8), ("jardin", 2, 0.7)],
}
DEFAULT_RANKING = [("vermine", 0, 0.9), ("jardin", 1, 0.8), ("chante", 2, 0.7)]


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
        kv=KV, V=VOCAB, M=object(), Vset=VSET,
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
    merged, donor_map = gen_phrase.build_puzzle_rank_map(
        "accoutume", RANKINGS["accoutume"], TABLE, FORMS, VSET)
    # The stub starts every hole on "vermine", the rank-1 group, so the road zone is
    # exactly it (#115 cuts the roads from the departure in).
    gen_phrase.annotate_roads(donor_map, merged, KV, start_rank=1)
    far = {k: v for k, v in ranks["accoutumes"].items() if v["rank"] > 0}
    # identical entry for entry — the borrowed geometry (#115 dq/road) included.
    assert far == {k: v for k, v in donor_map.items() if v["rank"] > 0}
    assert {k: (v["word"], v["rank"]) for k, v in far.items()} == {
        "vermine": ("vermine", 1), "jardin": ("jardin", 2)}


def test_missing_form_without_any_candidate_keeps_the_reduction_error(monkeypatch, capsys):
    _stub_closest(monkeypatch)
    with pytest.raises(SystemExit):
        gen_phrase.holes_from_words(
            ["zorglub", "doucement", "jardin"],
            _words("tu zorglub doucement au jardin."), FR, "fr",
            kv=KV, V=VOCAB, M=object(), Vset=VSET,
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
    # each commit ends on the display-form question; Entrée keeps the band word.
    monkeypatch.setattr("builtins.input", lambda _p="": "")

    donors = _resolver(interactive=True)
    try:
        holes, ranks = gen_phrase.select_holes_interactive(
            _words(), FR, "fr", kv=KV, V=VOCAB, M=object(), Vset=VSET,
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


def test_answering_the_donor_question_is_not_using_the_donor():
    # Availability checks resolve donors for words that may never be holed; only a
    # borrow that reached the puzzle may be reported.
    donors = _resolver(explicit={"accoutumes": "accoutume"})
    assert donors.resolved("accoutumes") == "accoutume"
    assert not gen_phrase.spent_candidate("accoutumes", set(), set(), TABLE, donors)
    assert donors.used == {}

    assert donors.note_used("accoutumes", "accoutume") == "accoutume"
    assert donors.used == {"accoutumes": ("accoutumes", "accoutume")}
    # a secret that is its own vector is never a substitution
    donors.note_used("jardin", "jardin")
    assert "jardin" not in donors.used


def test_selector_reports_no_substitution_for_a_word_it_never_holed(monkeypatch):
    """An interactive run may carry a --donor pair for a word the author ends up not
    selecting. The final preview must stay silent about it."""
    import os
    import termios
    import tty

    _stub_closest(monkeypatch)
    monkeypatch.setattr(gen_phrase, "start_band",
                        lambda _s, merged: [(w, r + 1) for w, r, _ in merged][:1])

    fd = os.open(os.devnull, os.O_RDONLY)
    monkeypatch.setattr(gen_phrase.sys, "stdin",
                        type("Stdin", (), {"fileno": lambda self: fd,
                                           "isatty": lambda self: True})())
    monkeypatch.setattr(termios, "tcgetattr", lambda _fd: None)
    monkeypatch.setattr(termios, "tcsetattr", lambda *_a: None)
    monkeypatch.setattr(tty, "setcbreak", lambda _fd: None)
    # the cursor lands on "accoutumes" first every time: step over it, hole the rest.
    keys = iter(["RIGHT", "ENTER", "1", "ENTER"] * 3)
    monkeypatch.setattr(gen_phrase, "_read_key", lambda _fd: next(keys))
    monkeypatch.setattr("builtins.input", lambda _p="": "")

    donors = _resolver(explicit={"accoutumes": "accoutume"}, interactive=True)
    try:
        holes, _ranks = gen_phrase.select_holes_interactive(
            _words("tu t'accoutumes doucement au jardin sans vermine."),
            FR, "fr", kv=KV, V=VOCAB, M=object(), Vset=VSET,
            lemma_table=TABLE, forms_by_lemma=FORMS, donors=donors)
    finally:
        os.close(fd)

    assert [h["secret"]["word"] for h in holes] == ["doucement", "jardin", "vermine"]
    assert donors.used == {}


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
    monkeypatch.setattr("builtins.input", lambda _p="": "")

    words = _words("il accoutume et tu t'accoutumes doucement au jardin.")
    donors = _resolver(interactive=True)
    assert [c["secret"] for c in gen_phrase.extract_candidates(words, FR, VSET, donors)] == [
        "accoutume", "accoutumes", "doucement", "jardin",
    ]
    try:
        holes, ranks = gen_phrase.select_holes_interactive(
            words, FR, "fr", kv=KV, V=VOCAB, M=object(), Vset=VSET,
            lemma_table=TABLE, forms_by_lemma=FORMS, donors=donors)
    finally:
        os.close(fd)

    assert [h["secret"]["word"] for h in holes] == ["accoutume", "doucement", "jardin"]
    assert set(ranks) == {"accoutume", "doucement", "jardin"}
    assert donors.used == {}  # no substitution was needed, none was invented


def test_main_writes_the_puzzle_and_names_the_substitution(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(FR["module"], "load_vectors", lambda: KV, raising=False)
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


# --- Start-word display override (addendum) -------------------------------------
# The band can only offer a form that HAS a vector; the sentence may demand one it
# lacks. Only the DISPLAYED form moves — the rank and the geometry stay the band word's.

START_SENTENCE = "il chante doucement au jardin sans vermine."
START_SELECTORS = ("doucement", "jardin", "vermine")
# every secret's walk reaches the band word "amuse" at rank 1 (its family aliases there).
START_RANKING = [("amuse", 0, 0.9), ("amuser", 1, 0.85), ("jardin", 2, 0.8),
                 ("vermine", 3, 0.75), ("doucement", 4, 0.7)]


def _start_run(monkeypatch, answers, selectors=START_SELECTORS,
               sentence=START_SENTENCE, start="amuse"):
    """Generate through the --words path on a TTY, scripting the display prompt."""
    monkeypatch.setattr(FR["module"], "closest",
                        lambda _w, _kv, _v, _m, *, n: START_RANKING, raising=False)
    monkeypatch.setattr(gen_phrase, "choose_start",
                        lambda _secret, _ranking, _rank_map, _rank_by_display: start)
    monkeypatch.setattr(gen_phrase.sys.stdin, "isatty", lambda: True, raising=False)
    replies = iter(answers)
    monkeypatch.setattr("builtins.input", lambda _p="": next(replies))
    return gen_phrase.holes_from_words(
        list(selectors), _words(sentence), FR, "fr",
        kv=KV, V=VOCAB, M=object(), Vset=VSET,
        lemma_table=TABLE, forms_by_lemma=FORMS, donors=_resolver(interactive=True),
    )


def test_start_display_override_moves_the_form_not_the_rank(monkeypatch):
    holes, ranks = _start_run(monkeypatch, ["amuses", "", ""])

    hole = next(h for h in holes if h["secret"]["slug"] == "doucement")
    # the hint reads as the sentence demands...
    assert hole["start"] == {"word": "amuses", "slug": "amuses"}
    # ...at the band word's own rank: the geometry did not move.
    assert hole["start_rank"] == 1
    # the band word keeps its own key, untouched...
    band = ranks["doucement"]["amuse"]
    assert band["word"] == "amuse" and band["rank"] == 1
    # ...and typing the word printed in the hole reads its distance, not a MISS: the
    # alias is the same GROUP, so it carries the band word's rank AND its geometry
    # (#115 dq/road) — only the displayed form moves.
    assert ranks["doucement"]["amuses"] == {**band, "word": "amuses"}
    # Entrée kept the band word for the two holes that did not need an override.
    assert [h["start"]["word"] for h in holes
            if h["secret"]["slug"] != "doucement"] == ["amuse", "amuse"]
    assert "amuses" not in ranks["jardin"]


def test_start_display_override_must_be_a_form_of_the_start_word(monkeypatch, capsys):
    # "jardin" is a real, typable word — but not a form of "amuse": accepting it would
    # print one word at another word's rank.
    assert "aucun lemme commun" in _resolver().start_display_error("amuse", "jardin")

    holes, _ranks = _start_run(monkeypatch, ["jardin", "amuses", "", ""])
    assert "aucun lemme commun" in capsys.readouterr().out
    # refused, reprompted, and the next answer stands: the start word itself was already
    # chosen, so there is nothing to unwind.
    hole = next(h for h in holes if h["secret"]["slug"] == "doucement")
    assert hole["start"]["word"] == "amuses"


def test_start_display_override_must_be_typable(monkeypatch, capsys):
    # "amusions" IS a form of "amuse" in the table, but no reduced word folds to its
    # slug: the hole would display a hint the player could never type back.
    assert "jamais taper" in _resolver().start_display_error("amuse", "amusions")

    holes, ranks = _start_run(monkeypatch, ["amusions", "", "", ""])
    assert "jamais taper" in capsys.readouterr().out
    hole = next(h for h in holes if h["secret"]["slug"] == "doucement")
    assert hole["start"] == {"word": "amuse", "slug": "amuse"}
    assert "amusions" not in ranks["doucement"]


def test_start_display_alias_obeys_the_smallest_rank_collision_rule():
    rmap = {"amuse": {"word": "amuse", "rank": 40},
            "amuses": {"word": "amusés", "rank": 12}}
    gen_phrase.alias_start_display(rmap, "amuse", "amuses", 40)
    # a closer entry keeps the key — typing the hint reads its true distance, still not
    # a MISS, which is all the alias exists for.
    assert rmap["amuses"] == {"word": "amusés", "rank": 12}
    # an accent-only override shares the band word's slug: the entry is already there.
    gen_phrase.alias_start_display(rmap, "amuse", "amusé", 40)
    assert rmap["amuse"] == {"word": "amuse", "rank": 40}
    # a farther entry loses it.
    gen_phrase.alias_start_display(rmap, "amuse", "amuser", 40)
    assert rmap["amuser"] == {"word": "amuser", "rank": 40}


def test_off_tty_is_never_asked_for_a_display_form(monkeypatch):
    # batch runs keep the silent random start with its own form (unchanged contract),
    # and so does any path with no lemma knowledge to validate an override against.
    monkeypatch.setattr(gen_phrase.sys.stdin, "isatty", lambda: False, raising=False)
    assert gen_phrase.choose_start_display("amuse", 87, _resolver()) == "amuse"
    monkeypatch.setattr(gen_phrase.sys.stdin, "isatty", lambda: True, raising=False)
    assert gen_phrase.choose_start_display("amuse", 87, None) == "amuse"


def test_selector_asks_for_the_display_form_too(monkeypatch):
    """Both selection paths must offer the override — the selector drops out of raw
    mode for it, so the one free-text answer gets accents and line editing."""
    import os
    import termios
    import tty

    monkeypatch.setattr(FR["module"], "closest",
                        lambda _w, _kv, _v, _m, *, n: START_RANKING, raising=False)
    monkeypatch.setattr(gen_phrase, "start_band", lambda _secret, _ranking: [("amuse", 1)])

    fd = os.open(os.devnull, os.O_RDONLY)
    monkeypatch.setattr(gen_phrase.sys, "stdin",
                        type("Stdin", (), {"fileno": lambda self: fd,
                                           "isatty": lambda self: True})())
    monkeypatch.setattr(termios, "tcgetattr", lambda _fd: None)
    monkeypatch.setattr(termios, "tcsetattr", lambda *_a: None)
    monkeypatch.setattr(tty, "setcbreak", lambda _fd: None)
    keys = iter(["ENTER", "1", "ENTER"] * 3)
    monkeypatch.setattr(gen_phrase, "_read_key", lambda _fd: next(keys))
    replies = iter(["amuses", "", ""])
    monkeypatch.setattr("builtins.input", lambda _p="": next(replies))

    try:
        holes, ranks = gen_phrase.select_holes_interactive(
            _words(START_SENTENCE), FR, "fr", kv=KV, V=VOCAB, M=object(),
            Vset=VSET, lemma_table=TABLE, forms_by_lemma=FORMS,
            donors=_resolver(interactive=True))
    finally:
        os.close(fd)

    first = holes[0]
    assert first["start"] == {"word": "amuses", "slug": "amuses"}
    assert first["start_rank"] == 1
    rmap = ranks[first["secret"]["slug"]]
    assert rmap["amuses"] == {**rmap["amuse"], "word": "amuses"}
    # and the raw-mode loop carried on normally after the detour.
    assert [h["start"]["word"] for h in holes[1:]] == ["amuse", "amuse"]


def test_selector_stamps_the_geometry_when_it_commits_a_start(monkeypatch):
    """#115's roads cannot be stamped until the start word is known, so BOTH selection
    paths have to do it once they have one. The --words path is covered by the geometry
    tests (test_distances.py); this covers the selector, whose call site is otherwise
    reachable only through the raw-mode loop — and a start committed there without the
    call ships a road-less puzzle that draws as a single trunk with no error anywhere."""
    import os
    import termios
    import tty

    monkeypatch.setattr(FR["module"], "closest",
                        lambda _w, _kv, _v, _m, *, n: START_RANKING, raising=False)
    monkeypatch.setattr(gen_phrase, "start_band", lambda _secret, _ranking: [("amuse", 1)])

    fd = os.open(os.devnull, os.O_RDONLY)
    monkeypatch.setattr(gen_phrase.sys, "stdin",
                        type("Stdin", (), {"fileno": lambda self: fd,
                                           "isatty": lambda self: True})())
    monkeypatch.setattr(termios, "tcgetattr", lambda _fd: None)
    monkeypatch.setattr(termios, "tcsetattr", lambda *_a: None)
    monkeypatch.setattr(tty, "setcbreak", lambda _fd: None)
    keys = iter(["ENTER", "1", "ENTER"] * 3)
    monkeypatch.setattr(gen_phrase, "_read_key", lambda _fd: next(keys))
    monkeypatch.setattr("builtins.input", lambda _p="": "")

    try:
        holes, ranks = gen_phrase.select_holes_interactive(
            _words(START_SENTENCE), FR, "fr", kv=KV, V=VOCAB, M=object(),
            Vset=VSET, lemma_table=TABLE, forms_by_lemma=FORMS,
            donors=_resolver(interactive=True))
    finally:
        os.close(fd)

    for hole in holes:
        rmap = ranks[hole["secret"]["slug"]]
        start_rank = hole["start_rank"]
        # dq has no opt-out: every ranked group carries it, the secret none.
        assert all("dq" in e for e in rmap.values() if e["rank"] != 0)
        assert "dq" not in rmap[hole["secret"]["slug"]]
        # And the roads cover the journey — the departure included, nothing behind it.
        assert all("road" in e for e in rmap.values() if 1 <= e["rank"] <= start_rank)
        assert not any("road" in e for e in rmap.values() if e["rank"] > start_rank)
