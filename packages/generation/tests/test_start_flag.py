"""`--start MOT=DEPART` (#260): the hole's hint named explicitly, off a TTY."""

import pytest

import gen_phrase
from test_donor import (FORMS, FR, KV, START_RANKING, START_SELECTORS, START_SENTENCE,
                        TABLE, VOCAB, VSET, _resolver, _words)


def _run(monkeypatch, starts):
    monkeypatch.setattr(FR["module"], "closest",
                        lambda _w, _kv, _v, _m, *, n: START_RANKING, raising=False)
    monkeypatch.setattr(gen_phrase.sys.stdin, "isatty", lambda: False, raising=False)
    # the fixture ranking is too small for the real band; the other holes take "amuse"
    monkeypatch.setattr(gen_phrase, "choose_start",
                        lambda _secret, _ranking, _rank_map, _rank_by_display: "amuse")
    return gen_phrase.holes_from_words(
        list(START_SELECTORS), _words(START_SENTENCE), FR, "fr",
        kv=KV, V=VOCAB, M=object(), Vset=VSET,
        lemma_table=TABLE, forms_by_lemma=FORMS, donors=_resolver(interactive=False),
        starts=starts,
    )


def test_parse_start_args():
    assert gen_phrase.parse_start_args(["savoir=usage", "Archives = Dossiers"]) == {
        "savoir": "usage", "archives": "dossiers",
    }
    with pytest.raises(SystemExit):
        gen_phrase.parse_start_args(["savoir"])


def test_explicit_start_replaces_the_band_pick_for_that_hole_only(monkeypatch):
    holes, _ranks = _run(monkeypatch, {"doucement": "vermine"})
    by_secret = {h["secret"]["slug"]: h for h in holes}
    assert by_secret["doucement"]["start"]["word"] == "vermine"
    assert by_secret["doucement"]["start_rank"] > 0
    # the other holes keep the band pick
    assert by_secret["jardin"]["start"]["word"] == "amuse"


def test_explicit_start_must_be_a_word_of_the_hole_not_its_secret(monkeypatch):
    with pytest.raises(SystemExit):
        _run(monkeypatch, {"doucement": "doucement"})
    with pytest.raises(SystemExit):
        _run(monkeypatch, {"doucement": "zzzz"})
