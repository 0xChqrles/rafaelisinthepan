"""CONTRACT: three distinct selected slugs expand to every sentence occurrence.

The authoring contract counts distinct folded secret identities, while the emitted puzzle
contains one independently positioned hole for every selected occurrence. Rank maps and
start hints are shared per secret slug; display affixes remain occurrence-specific.
"""

import json

import pytest

import gen_phrase  # noqa: E402


FR = gen_phrase.CONFIG["fr"]

# Generation reads the neighbors' vectors to cut the roads between the departure and the
# secret (#115), so the fake kv must answer for every word the fake walk returns.
KV = {"indice": [1.0, 0.0, 0.0], "proche": [0.0, 1.0, 0.0]}


def _sentence_words():
    return [
        gen_phrase.display_token(token)
        for token in "Le chat, poursuit le chat dans le jardin.".split()
    ]


def _run_repeated_generation(monkeypatch):
    calls = []

    def closest(secret, _kv, _vocab, _matrix, *, n):
        calls.append((secret, n))
        return [("indice", 0, 0.9), ("proche", 1, 0.8)]

    monkeypatch.setattr(FR["module"], "closest", closest, raising=False)
    monkeypatch.setattr(
        gen_phrase,
        "choose_start",
        lambda _secret, _ranking, _rank_map, _rank_by_display: "indice",
    )
    vocab = ["chat", "poursuit", "jardin", "indice", "proche"]
    holes, ranks = gen_phrase.holes_from_words(
        ["jardin", "chat", "poursuit"],
        _sentence_words(),
        FR,
        "fr",
        kv=KV,
        V=vocab,
        M=object(),
        Vset=set(vocab),
        lemma_table={},
        forms_by_lemma={},
    )
    return holes, ranks, calls


def test_words_expand_a_repeated_secret_to_all_positions_and_share_rank_start(monkeypatch):
    holes, ranks, calls = _run_repeated_generation(monkeypatch)

    assert [hole["pos"] for hole in holes] == [1, 2, 4, 7]
    assert [hole["secret"]["slug"] for hole in holes] == [
        "chat",
        "poursuit",
        "chat",
        "jardin",
    ]
    assert [hole["start"]["word"] for hole in holes] == ["indice"] * 4
    assert [hole["start_rank"] for hole in holes] == [1] * 4

    # The two chat occurrences keep their own token punctuation, while the shared
    # secret/start data stays identical.
    assert holes[0]["suffix"] == ","
    assert "suffix" not in holes[2]
    assert holes[3]["suffix"] == "."
    assert set(ranks) == {"chat", "poursuit", "jardin"}
    # The walk needs the FULL raw ranking (#104): merging collapses inflections, so
    # reaching TOP_K distinct groups can consume well over TOP_K raw neighbors.
    assert calls == [("jardin", None), ("chat", None), ("poursuit", None)]


def test_filename_dedupes_repeated_slugs_but_keeps_sentence_order(monkeypatch):
    holes, _ranks, _calls = _run_repeated_generation(monkeypatch)

    assert gen_phrase.filename_slugs_from_holes(holes) == ["chat", "poursuit", "jardin"]
    assert gen_phrase.filename_slugs_from_holes(list(reversed(holes))) == [
        "chat",
        "poursuit",
        "jardin",
    ]


def test_main_writes_one_three_slug_filename_for_repeated_holes(
        monkeypatch, tmp_path, capsys):
    vocab = ["chat", "poursuit", "jardin", "indice", "proche"]

    monkeypatch.setattr(FR["module"], "load_vectors", lambda: KV, raising=False)
    monkeypatch.setattr(FR["module"], "build_vocab", lambda _kv: vocab, raising=False)
    monkeypatch.setattr(FR["module"], "build_matrix", lambda _kv, _v: object(), raising=False)
    monkeypatch.setattr(
        FR["module"],
        "closest",
        lambda _secret, _kv, _v, _m, *, n: [("indice", 86, 0.9), ("proche", 87, 0.5)],
        raising=False,
    )
    monkeypatch.setattr(gen_phrase, "write_vocab", lambda _v, _lang: None)
    monkeypatch.setattr(
        gen_phrase,
        "choose_start",
        lambda _secret, _ranking, _rank_map, _rank_by_display: "indice",
    )
    monkeypatch.setattr(
        gen_phrase.sys,
        "argv",
        [
            "gen_phrase.py",
            "Le chat, poursuit le chat dans le jardin.",
            "--lang",
            "fr",
            "--words",
            "jardin",
            "chat",
            "poursuit",
            # #133 makes a fr batch run without --form a hard error; agreement is
            # out of scope here, so opt out explicitly.
            "--no-inflect",
            "--out-dir",
            str(tmp_path),
        ],
    )

    gen_phrase.main()

    output = tmp_path / "fr" / "chat_poursuit_jardin.json"
    assert output.is_file()
    data = json.loads(output.read_text(encoding="utf-8"))
    assert len(data["holes"]) == 4
    assert set(data["ranks"]) == {"chat", "poursuit", "jardin"}
    # #135 is wired into the real batch path: one neutral report per selected
    # secret, with --no-inflect reported as unmeasured rather than made an error.
    printed = capsys.readouterr().out
    assert printed.count("secret «") >= 3
    assert printed.count("formes : non mesurées") == 3


def test_duplicate_words_selectors_are_rejected_after_slug_normalization(capsys):
    with pytest.raises(SystemExit):
        gen_phrase.holes_from_words(
            ["chat", "CHAT", "jardin"],
            [],
            FR,
            "fr",
            kv=None,
            V=[],
            M=None,
            Vset=set(),
            lemma_table={},
            forms_by_lemma={},
        )

    assert "exactement 3 mots distincts" in capsys.readouterr().err


def test_interactive_group_contains_every_repeated_occurrence():
    candidates = gen_phrase.extract_candidates(
        _sentence_words(),
        FR,
        {"chat", "poursuit", "jardin"},
    )

    chat_group = gen_phrase.candidates_for_slug(candidates, "chat")
    assert [(candidate["pos"], candidate["secret"]) for candidate in chat_group] == [
        (1, "chat"),
        (4, "chat"),
    ]
    assert len({gen_phrase.slug(candidate["secret"]) for candidate in candidates}) == 3
