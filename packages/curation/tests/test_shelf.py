import json

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
    from datetime import date
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
    assert arch["pairs"] == {"cimetiere": {"tombeau"}, "argent": {"billets"}}   # pairs never expire; a corrected day keeps its last line
    assert shelf.sentence_key("y corrected") in arch["sentences"] and shelf.sentence_key("y") not in arch["sentences"]
    assert arch["last_used"][shelf.slug("Machado")] == date(2026, 9, 1)
    assert "money" not in arch["secrets"]                       # another language's day is not this archive
