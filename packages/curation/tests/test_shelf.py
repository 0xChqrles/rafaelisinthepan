from datetime import date, timedelta
import json

import pytest

import _paths
import shelf


def _write(root, rel, puzzle):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(puzzle), encoding="utf-8")
    return path


def test_forget_deletes_the_work_s_puzzles_only(tmp_path, monkeypatch):
    monkeypatch.setattr(_paths, "GENERATION_OUTPUT_DIR", tmp_path)
    mine = _write(tmp_path, "fr/book/hugo/les-miserables/a_b_c.json",
                  {"source": {"kind": "book", "author": "Victor Hugo", "work": "Les Misérables"}})
    other = _write(tmp_path, "fr/book/camus/la-peste/d_e_f.json",
                   {"source": {"kind": "book", "author": "Albert Camus", "work": "La Peste"}})
    sourceless = _write(tmp_path, "fr/g_h_i.json", {"words": ["un", "mot"]})
    kind_only = _write(tmp_path, "fr/book/j_k_l.json", {"source": {"kind": "book"}})
    index = {"books": {"hugo.epub": {"read": "2026-09-07", "sentences": []}}}
    work = {"file": "hugo.epub", "author": "Victor Hugo", "title": "Les misérables"}
    assert shelf.forget(index, work, "fr") == [str(mine)]
    assert "hugo.epub" not in index["books"]
    assert not mine.exists() and not mine.parent.exists()
    assert other.exists() and sourceless.exists() and kind_only.exists()


def test_forget_deletes_the_judge_scores_beside_a_work_s_puzzle(tmp_path, monkeypatch):
    monkeypatch.setattr(_paths, "GENERATION_OUTPUT_DIR", tmp_path)
    mine = _write(tmp_path, "fr/book/hugo/les-miserables/a_b_c.json",
                  {"source": {"kind": "book", "author": "Victor Hugo", "work": "Les Misérables"}})
    scores = _write(tmp_path, "fr/book/hugo/les-miserables/a_b_c.contextual.json", {"holes": []})
    work = {"file": "hugo.epub", "author": "Victor Hugo", "title": "Les misérables"}
    assert shelf.forget({"books": {}}, work, "fr") == [str(mine)]
    assert not scores.exists() and not mine.parent.exists()


def test_forget_of_one_numbered_volume_keeps_the_other_volume_s_puzzles(tmp_path, monkeypatch):
    monkeypatch.setattr(_paths, "GENERATION_OUTPUT_DIR", tmp_path)
    one = _write(tmp_path, "fr/book/despentes/vernon-subutex-1/a_b_c.json",
                 {"source": {"kind": "book", "author": "Virginie Despentes", "work": "Vernon Subutex 1"}})
    two = _write(tmp_path, "fr/book/despentes/vernon-subutex-2/d_e_f.json",
                 {"source": {"kind": "book", "author": "Virginie Despentes", "work": "Vernon Subutex 2"}})
    work = {"file": "vernon-1.epub", "author": "Virginie Despentes", "title": "Vernon Subutex 1"}
    assert shelf.forget({"books": {}}, work, "fr") == [str(one)]
    assert not one.exists() and two.exists()


def test_forget_of_an_untitled_work_deletes_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(_paths, "GENERATION_OUTPUT_DIR", tmp_path)
    sourceless = _write(tmp_path, "fr/g_h_i.json", {"words": ["un", "mot"]})
    kind_only = _write(tmp_path, "fr/book/j_k_l.json", {"source": {"kind": "book"}})
    index = {"books": {"broken.epub": {"read": "2026-09-07", "sentences": []}}}
    assert shelf.forget(index, {"file": "broken.epub", "author": "", "title": ""}, "fr") == []
    assert "broken.epub" not in index["books"]
    assert sourceless.exists() and kind_only.exists()


def _ledger(monkeypatch, tmp_path, entries):
    path = tmp_path / "published.jsonl"
    path.write_text("".join(json.dumps(e) + "\n" for e in entries) + "{broken\n", encoding="utf-8")
    monkeypatch.setattr(_paths, "PUBLISHED_LEDGER", path)
    return path


def test_a_missing_ledger_is_never_read_as_an_empty_archive(tmp_path, monkeypatch):
    # an empty archive would re-propose every published day: the curator refuses to run
    monkeypatch.setattr(_paths, "PUBLISHED_LEDGER", tmp_path / "published.jsonl")
    with pytest.raises(FileNotFoundError):
        shelf.archive("fr")


def test_archive_sentences_match_a_mined_sentence_by_key(tmp_path, monkeypatch):
    _ledger(monkeypatch, tmp_path, [{"day": "2026-09-01", "lang": "fr", "publishedAt": "x", "revision": "r",
                                     "sentence": "il aimait ce moment, disait-il.", "holes": [],
                                     "source": {"kind": "book", "author": "X", "work": "Y"}}])
    arch = shelf.archive("fr")
    mined = "Il aimait ce moment, disait-il."
    assert shelf.sentence_key(mined) in arch["sentences"]
    assert mined not in arch["sentences"]  # the raw string never matched: the ledger stores lowercased tokens
    assert arch["works"] == [{"author": "X", "work": "Y"}]


def test_archive_cools_secrets_down_but_blacklists_pairs_for_good(tmp_path, monkeypatch):
    _ledger(monkeypatch, tmp_path, [
        {"day": "2026-05-01", "lang": "fr", "sentence": "x", "source": {"author": "Annie Ernaux", "work": "R"},
         "holes": [{"secret": "cimetiere", "word": "cimetière", "start": "tombeau", "startRank": 120}]},
        {"day": "2026-09-01", "lang": "fr", "sentence": "y", "source": {"author": "Machado", "work": "B"},
         "holes": [{"secret": "argent", "word": "argent", "start": "monnaie", "startRank": 110}]},
        {"day": "2026-09-01", "lang": "fr", "sentence": "y corrected", "source": {"author": "Machado", "work": "B"},
         "holes": [{"secret": "argent", "word": "argent", "start": "billets", "startRank": 130}]},
        {"day": "2026-09-01", "lang": "en", "sentence": "z", "holes": [{"secret": "money", "word": "money", "start": "cash", "startRank": 100}]},
    ])
    arch = shelf.archive("fr", date(2026, 9, 8))
    assert arch["secrets"] == {"argent"}                        # cimetière is past its 90-day cooldown
    assert arch["pairs"] == {"cimetiere": {"tombeau"}, "argent": {"monnaie", "billets"}}   # pairs never expire — a corrected day's earlier start was played too
    assert shelf.sentence_key("y corrected") in arch["sentences"] and shelf.sentence_key("y") not in arch["sentences"]
    assert arch["last_used"][shelf.slug("Machado")] == date(2026, 9, 1)
    assert "money" not in arch["secrets"]                       # another language's day is not this archive


def test_a_secret_comes_back_ninety_days_after_its_game_day(tmp_path, monkeypatch):
    day = date(2026, 6, 1)
    _ledger(monkeypatch, tmp_path, [
        {"day": day.isoformat(), "lang": "fr", "sentence": "x",
         "holes": [{"secret": "cimetiere", "word": "cimetière", "start": "tombeau", "startRank": 120}]}])
    assert shelf.SECRET_COOLDOWN_DAYS == 90
    assert shelf.archive("fr", day + timedelta(days=89))["secrets"] == {"cimetiere"}
    assert shelf.archive("fr", day + timedelta(days=90))["secrets"] == set()


def test_archive_dates_the_last_music_day_and_each_author_s_last_day(tmp_path, monkeypatch):
    def line(day, lang, kind, author):
        return {"day": day, "lang": lang, "sentence": day, "holes": [],
                "source": {"kind": kind, "author": author, "work": day}}

    _ledger(monkeypatch, tmp_path, [
        line("2026-09-01", "fr", "music", "Népal"),
        line("2026-09-10", "fr", "music", "Alpha Wann"),
        line("2026-09-05", "fr", "music", "Népal"),
        line("2026-09-20", "fr", "book", "Victor Hugo"),
        line("2026-09-25", "en", "music", "Nas"),
    ])
    arch = shelf.archive("fr", date(2026, 9, 30))
    assert arch["last_music"] == date(2026, 9, 10)       # the latest MUSIC day of this language
    assert arch["last_used"] == {shelf.slug("Népal"): date(2026, 9, 5), shelf.slug("Alpha Wann"): date(2026, 9, 10),
                                 shelf.slug("Victor Hugo"): date(2026, 9, 20)}
    assert shelf.archive("en", date(2026, 9, 30))["last_music"] == date(2026, 9, 25)


def test_archive_keeps_every_published_volume_of_a_work(tmp_path, monkeypatch):
    # the works are told apart by the key in_archive compares: two volumes are two works
    def line(day, work):
        return {"day": day, "lang": "fr", "sentence": day, "holes": [],
                "source": {"kind": "book", "author": "Virginie Despentes", "work": work}}

    _ledger(monkeypatch, tmp_path, [line("2026-09-01", "Vernon Subutex 1"), line("2026-09-10", "Vernon Subutex 2")])
    works = shelf.archive("fr", date(2026, 9, 30))["works"]
    assert works == [{"author": "Virginie Despentes", "work": "Vernon Subutex 1"},
                     {"author": "Virginie Despentes", "work": "Vernon Subutex 2"}]
    assert shelf.in_archive({"title": "Vernon Subutex 2", "author": "Virginie Despentes"}, works)


def test_an_archive_with_no_music_day_has_no_music_clock(tmp_path, monkeypatch):
    _ledger(monkeypatch, tmp_path, [{"day": "2026-09-20", "lang": "fr", "sentence": "x", "holes": [],
                                     "source": {"kind": "book", "author": "Victor Hugo", "work": "W"}}])
    assert shelf.archive("fr", date(2026, 9, 30))["last_music"] is None


def test_a_shelf_book_whose_title_is_published_is_in_the_archive():
    # never the same book twice
    works = [{"author": "Victor Hugo", "work": "Les Misérables"}]
    assert shelf.in_archive({"title": "Les Misérables"}, works)
    assert not shelf.in_archive({"title": "Germinal"}, works)


def test_a_different_book_whose_title_holds_a_published_title_is_not_in_the_archive():
    # pairs off the real fr shelf and ledger: one title inside the other, another author
    works = [{"author": "Ernaux Annie", "work": "Les années"},
             {"author": "Osamu Dazai", "work": "La Déchéance d'un homme"},
             {"author": "Jules Renard", "work": "Journal (1905-1910)"}]
    assert not shelf.in_archive({"title": "Les Années douces", "author": "Hiromi Kawakami"}, works)
    assert not shelf.in_archive({"title": "D.", "author": "Robert Harris"}, works)
    assert not shelf.in_archive({"title": "Journal d'un écrivain en pyjama", "author": "Dany Laferrière"}, works)
    assert not shelf.in_archive({"title": "Journal d'un curé de campagne", "author": "Georges Bernanos"}, works)


def test_another_volume_of_a_published_work_is_not_in_the_archive():
    # a title's digits are part of it: « Souvenirs entomologiques 9 » is not « … Livre X »
    works = [{"author": "Jean-Henri Fabre", "work": "Souvenirs entomologiques - Livre X"},
             {"author": "Virginie Despentes", "work": "Vernon Subutex 1"}]
    assert not shelf.in_archive({"title": "Souvenirs entomologiques 9", "author": "Jean-Henri Fabre"}, works)
    assert not shelf.in_archive({"title": "Vernon Subutex 2", "author": "Virginie Despentes"}, works)
    assert shelf.in_archive({"title": "Vernon Subutex 1", "author": "Virginie Despentes"}, works)


def test_a_volume_number_is_never_read_inside_a_longer_number():
    # « … 1 » is not « … 10 » nor « … 12 », at either end of the title, in either direction
    fabre, despentes = "Jean-Henri Fabre", "Virginie Despentes"
    assert not shelf.in_archive({"title": "Souvenirs entomologiques 1", "author": fabre},
                                [{"author": fabre, "work": "Souvenirs entomologiques 10"}])
    assert not shelf.in_archive({"title": "Vernon Subutex 12", "author": despentes},
                                [{"author": despentes, "work": "Vernon Subutex 1"}])
    assert not shelf.in_archive({"title": "14 juillet", "author": "Éric Vuillard"},
                                [{"author": "Éric Vuillard", "work": "4 juillet"}])
    assert not shelf.in_archive({"title": "4 juillet", "author": "Éric Vuillard"},
                                [{"author": "Éric Vuillard", "work": "14 juillet"}])
    # a key that ends on a letter, or whose number stands whole, is still inside
    assert shelf.in_archive({"title": "Vernon Subutex", "author": despentes},
                            [{"author": despentes, "work": "Vernon Subutex 1"}])
    assert shelf.in_archive({"title": "Vernon Subutex 1 (French Edition)", "author": despentes},
                            [{"author": despentes, "work": "Vernon Subutex 1"}])


def test_dashes_never_tell_two_titles_apart():
    works = [{"author": "Romain Rolland", "work": "Jean-Christophe"}]
    assert shelf.in_archive({"title": "Jean - Christophe", "author": "Romain Rolland"}, works)
    assert shelf.in_archive({"title": "Jean Christophe", "author": "Romain Rolland"}, works)
    assert shelf.title_key("Jean - Christophe") == shelf.title_key("Jean-Christophe")


def test_an_identical_author_is_the_same_author_even_when_same_person_cannot_read_the_name():
    # `same_person` drops name parts under three letters: « Oé » has none left
    works = [{"author": "Oé", "work": "Le Postier"}]
    assert shelf.in_archive({"title": "Le Postier (Edition 2)", "author": "Oé"}, works)
    assert not shelf.in_archive({"title": "Le Postier (Edition 2)", "author": "Mo Yan"}, works)


def test_a_published_book_stays_in_the_archive_under_another_edition_s_title_or_author_spelling():
    works = [{"author": "Charles Bukowski", "work": "Le postier V2"},
             {"author": "Joël Dicker", "work": "La Disparition de Stephanie Mailer (French Edition)"},
             {"author": "Fyodor Dostoevsky", "work": "Les Démons"},
             {"author": "Jules Renard", "work": "Journal (1905-1910)"},
             {"author": "Hrabal, Bohumil", "work": "Une trop bruyante solitude"}]
    # an edition pads the title, the author is the same person
    assert shelf.in_archive({"title": "Le Postier", "author": "Charles Bukowski"}, works)
    assert shelf.in_archive({"title": "La Disparition de Stephanie Mailer", "author": "Joël Dicker"}, works)
    assert shelf.in_archive({"title": "Journal", "author": "Jules Renard"}, works)
    assert shelf.in_archive({"title": "Une trop bruyante solitude", "author": "Bohumil Hrabal"}, works)
    # the same title is the same book, however the author is transliterated
    assert shelf.in_archive({"title": "Les Démons", "author": "Fédor Dostoïevski"}, works)
    # an author missing on either side does not tell two books apart
    assert shelf.in_archive({"title": "Le Postier", "author": ""}, works)
    assert shelf.in_archive({"title": "Le Postier"}, works)
    assert shelf.in_archive({"title": "Le Postier", "author": "Charles Bukowski"},
                            [{"author": "", "work": "Le postier V2"}])


# --- retrying one sentence (--sentence) --------------------------------------------

def test_find_unit_matches_a_lowercased_puzzle_sentence_to_the_source_unit():
    from shelf import find_unit
    mined = ["Son magasin s’appelait Revolver.", "Il avait confié les clefs du magasin à un collègue."]
    assert find_unit(mined, "il avait confié les clefs du magasin à un collègue.") == mined[1]
    assert find_unit(mined, "il avait confié les clefs") is None


def test_work_of_reads_the_shelf_work_off_a_puzzle_source():
    from shelf import work_of
    works = [{"file": "a.epub", "kind": "book", "author": "Despentes Virginie", "title": "Vernon Subutex 1"},
             {"file": "b.txt", "kind": "music", "author": "Nepal", "title": "Trajectoire"}]
    assert work_of({"author": "despentes virginie", "work": "Vernon Subutex 1"}, works)["file"] == "a.epub"
    assert work_of({"kind": "music", "author": "Népal", "work": "Trajectoire"}, works)["file"] == "b.txt"
    assert work_of({"author": "Despentes Virginie", "work": "Vernon Subutex 2"}, works) is None
    assert work_of({}, works) is None


def test_list_works_reports_a_file_it_cannot_open(tmp_path):
    # A shelf file that is not a readable epub is LISTED with its error, never raised:
    # the curator skips it instead of spending a pick on a work it cannot read.
    (tmp_path / "broken.epub").write_bytes(b"not a zip at all")
    works = shelf.list_works(tmp_path)
    assert [w["file"] for w in works] == ["broken.epub"]
    assert works[0]["error"] and works[0]["title"] == "broken" and works[0]["author"] == ""


# --- one shelf per language (#317) ---------------------------------------------------

def test_each_language_has_its_own_shelf_index_and_quotes(tmp_path, monkeypatch):
    import quotes
    monkeypatch.setattr(_paths, "SHELF_ROOT", tmp_path)
    assert shelf.LANGS == ("fr", "en")
    assert _paths.shelf_dir("en") == tmp_path / "en" and _paths.shelf_dir("fr") == tmp_path / "fr"
    assert shelf.index_file("en") == tmp_path / "en" / "index.json"
    assert quotes.quotes_dir("en") == tmp_path / "en" / "quotes"
    # an index written for one language is not the other's
    shelf.save_index({"books": {"slaughterhouse.epub": {"read": "x", "sentences": []}}}, "en")
    assert shelf.load_index("fr") == {"books": {}}
    assert "slaughterhouse.epub" in shelf.load_index("en")["books"]


def test_list_works_reads_one_language_s_shelf(tmp_path, monkeypatch):
    monkeypatch.setattr(_paths, "SHELF_ROOT", tmp_path)
    for lang, name in (("fr", "etranger.epub"), ("en", "stranger.epub")):
        _paths.shelf_dir(lang).mkdir(parents=True)
        (_paths.shelf_dir(lang) / name).write_bytes(b"not a zip")
    assert [w["file"] for w in shelf.list_works(_paths.shelf_dir("en"))] == ["stranger.epub"]
    assert [w["file"] for w in shelf.list_works(_paths.shelf_dir("fr"))] == ["etranger.epub"]
