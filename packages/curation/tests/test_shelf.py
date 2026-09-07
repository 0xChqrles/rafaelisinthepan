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


def test_archive_sentences_match_a_mined_sentence_by_key(tmp_path, monkeypatch):
    monkeypatch.setattr(_paths, "GENERATION_OUTPUT_DIR", tmp_path)
    _write(tmp_path, "fr/book/x/y/a_b_c.json",
           {"words": ["il", "aimait", "ce", "moment,", "disait-il."], "holes": [],
            "source": {"kind": "book", "author": "X", "work": "Y"}})
    archived = shelf.archive("fr")["sentences"]
    mined = "Il aimait ce moment, disait-il."
    assert shelf.sentence_key(mined) in archived
    assert mined not in archived  # the raw string never matched: the puzzle stores lowercased tokens
