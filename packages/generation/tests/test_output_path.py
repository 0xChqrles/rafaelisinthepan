"""CONTRACT: a puzzle is filed under its SOURCE (issue #137).

gen_phrase writes to <out-dir>/<lang>/<kind>/<author>/<work>/<s1>_<s2>_<s3>.json.
The rules those directory levels obey:

  - segments are path_slug()s — READABLE ASCII names, a different question from
    slug()'s comparison key: separators are kept as dashes and DIGITS SURVIVE,
    because works are named "1, 2, 3" and "Joueur 1";
  - `kind` is an OPEN union — nothing is validated against KNOWN_KINDS;
  - a missing (or unnamable) level is OMITTED along with everything under it, so a
    puzzle with no `source` lands at <lang>/ exactly as it did before the layout
    existed — but an UNNAMABLE one is reported on stderr, since that level WAS
    provided and the resulting path is indistinguishable from a source-less one;
  - the FILENAME is unchanged: the three distinct secret slugs in sentence order.
"""

import json

import gen_phrase  # noqa: E402
from slug import path_slug, slug  # noqa: E402


FR = gen_phrase.CONFIG["fr"]


# --- path_slug: a NAME, not a key ---------------------------------------------


def test_separators_become_dashes_instead_of_disappearing():
    # This is the whole point of a second function: slug() would run the words
    # together, which is unreadable for something a human browses.
    assert path_slug("Victor Hugo") == "victor-hugo"
    assert path_slug("Les Misérables") == "les-miserables"
    assert slug("Les Misérables") == "lesmiserables"


def test_digits_are_kept():
    # A real album is named "1, 2, 3": dropping digits leaves NO name at all.
    assert path_slug("1, 2, 3") == "1-2-3"
    assert path_slug("Joueur 1") == "joueur-1"
    assert path_slug("Vœux présidentiels du 31 décembre 2022") == (
        "voeux-presidentiels-du-31-decembre-2022"
    )


def test_apostrophes_separate_in_both_forms():
    assert path_slug("L'Usage du monde") == "l-usage-du-monde"      # ASCII
    assert path_slug("L’enfant fou") == "l-enfant-fou"              # typographic
    assert path_slug("Hater's Killah") == "hater-s-killah"


def test_accents_and_ligatures_fold_like_slug():
    assert path_slug("Généalogie de la morale") == "genealogie-de-la-morale"
    assert path_slug("Cœur") == "coeur"
    assert path_slug("Émile Zola") == "emile-zola"


def test_runs_collapse_and_edges_are_trimmed():
    assert path_slug("  ¿¿ Les   Choses !! ") == "les-choses"
    assert path_slug("Au sud de la frontière, à l'ouest du soleil") == (
        "au-sud-de-la-frontiere-a-l-ouest-du-soleil"
    )


def test_unnamable_input_yields_the_empty_string():
    # The caller decides what that means; gen_phrase omits the level.
    assert path_slug("!!!") == ""
    assert path_slug("") == ""


# --- source -> directory levels ------------------------------------------------


def test_full_source_gives_three_levels():
    assert gen_phrase.source_dir_segments(
        {"kind": "book", "author": "Karl Marx", "work": "Le Capital"}
    ) == ["book", "karl-marx", "le-capital"]


def test_no_source_gives_no_levels():
    # The degenerate case IS the old behaviour: the file stays at <lang>/.
    assert gen_phrase.source_dir_segments(None) == []
    assert gen_phrase.source_dir_segments({}) == []


def test_a_missing_level_drops_everything_under_it():
    # A path cannot skip a component: an author with no kind would read AS a kind.
    assert gen_phrase.source_dir_segments({"author": "Karl Marx"}) == []
    assert gen_phrase.source_dir_segments({"kind": "book", "work": "Le Capital"}) == [
        "book"
    ]


def test_blank_and_unnamable_levels_count_as_missing():
    assert gen_phrase.source_dir_segments({"kind": "book", "author": "   "}) == ["book"]
    assert gen_phrase.source_dir_segments(
        {"kind": "music", "author": "Cami", "work": "!!!"}
    ) == ["music", "cami"]


def test_an_unnamable_level_is_reported_while_a_missing_one_is_silent(capsys):
    # Any non-Latin script names nothing ASCII. The metadata survives in the JSON,
    # so the only signal that the path dropped it is this line.
    assert gen_phrase.source_dir_segments(
        {"kind": "книга", "author": "Dostoïevski", "work": "Idiot"}
    ) == []
    reported = capsys.readouterr().err
    assert "книга" in reported and "kind" in reported

    # A level simply not provided is normal — the flat layout — and stays quiet.
    assert gen_phrase.source_dir_segments({"author": "Dostoïevski"}) == []
    assert capsys.readouterr().err == ""


def test_kind_is_an_open_union():
    # The corpus already carries kinds outside KNOWN_KINDS.
    assert "discours" not in gen_phrase.KNOWN_KINDS
    assert gen_phrase.source_dir_segments(
        {"kind": "discours", "author": "Emmanuel Macron", "work": "Vœux 2022"}
    ) == ["discours", "emmanuel-macron", "voeux-2022"]


# --- end to end: main() writes there -------------------------------------------


def _run_main(monkeypatch, tmp_path, extra_argv):
    vocab = ["chat", "poursuit", "jardin", "arbre", "forêt"]
    kv = {"arbre": [1.0, 0.0, 0.0], "forêt": [0.0, 1.0, 0.0]}
    # Path tests use a synthetic vocabulary; isolate them from real Morphalou
    # homographs so they continue testing only the output layout.
    monkeypatch.setattr(gen_phrase, "load_lemma_table", lambda *_a, **_k: {})
    monkeypatch.setattr(FR["module"], "load_vectors", lambda: kv, raising=False)
    monkeypatch.setattr(FR["module"], "build_vocab", lambda _kv: vocab, raising=False)
    monkeypatch.setattr(
        FR["module"], "build_matrix", lambda _kv, _v: object(), raising=False
    )
    monkeypatch.setattr(
        FR["module"],
        "closest",
        lambda _secret, _kv, _v, _m, *, n: [
            ("arbre", 86, 0.9), ("forêt", 87, 0.5)],
        raising=False,
    )
    monkeypatch.setattr(gen_phrase, "write_vocab", lambda _v, _lang: None)
    monkeypatch.setattr(
        gen_phrase,
        "choose_start",
        lambda _secret, _ranking, _rank_map, _rank_by_display: "arbre",
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
            "--out-dir",
            str(tmp_path),
            *extra_argv,
        ],
    )
    gen_phrase.main()


def test_main_files_the_puzzle_under_its_source(monkeypatch, tmp_path):
    _run_main(
        monkeypatch,
        tmp_path,
        [
            "--kind", "book",
            "--author", "Michel Houellebecq",
            "--work", "La Carte et le Territoire",
        ],
    )

    output = (
        tmp_path
        / "fr"
        / "book"
        / "michel-houellebecq"
        / "la-carte-et-le-territoire"
        / "chat_poursuit_jardin.json"
    )
    assert output.is_file()
    # The JSON keeps the DISPLAY forms; only the path is slugged.
    data = json.loads(output.read_text(encoding="utf-8"))
    assert data["source"] == {
        "kind": "book",
        "author": "Michel Houellebecq",
        "work": "La Carte et le Territoire",
    }


def test_main_keeps_a_source_less_puzzle_at_the_language_root(monkeypatch, tmp_path):
    _run_main(monkeypatch, tmp_path, [])

    assert (tmp_path / "fr" / "chat_poursuit_jardin.json").is_file()


def test_main_stops_at_the_last_provided_level(monkeypatch, tmp_path):
    _run_main(monkeypatch, tmp_path, ["--kind", "quote", "--author", "Nicolas Sarkozy"])

    assert (
        tmp_path / "fr" / "quote" / "nicolas-sarkozy" / "chat_poursuit_jardin.json"
    ).is_file()
