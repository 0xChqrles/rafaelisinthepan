"""CONTRACT: reduce_embedding.py is the ONLY filter+cap stage (AGENTS.md "Pipeline").

  - rejection rules, in order: uppercase -> single-letter -> non-alphabet -> stopword;
  - filter-THEN-cap: the cap counts SURVIVORS, so the output has EXACTLY TOP_N kept
    words (interspersed rejects do not reduce the count), or fewer + a warning if the
    source is exhausted first;
  - header is RECOUNTED to the kept count when the source had one, and ABSENT when it
    did not.
"""

import sys

import reduce_embedding as red  # noqa: E402  (importable via conftest's sys.path)


# --- rejection rules + their order -------------------------------------------------

def test_rejection_rules_and_kept_tokens():
    en = red.make_rules("en")
    fr = red.make_rules("fr")

    # uppercase (proper nouns / acronyms)
    assert red.classify("Cat", en) == "majuscule"
    # single letter, counted by CHARACTER (accented letter is one)
    assert red.classify("a", en) == "single-letter"
    assert red.classify("é", fr) == "single-letter"
    # non-alphabet: digits, markup, etc.
    assert red.classify("h2o", en) == "hors-alphabet"
    assert red.classify("</s>", en) == "hors-alphabet"
    # stopword
    assert red.classify("the", en) == "stopword"
    assert red.classify("le", fr) == "stopword"
    # KEPT (None): plain word, internal-dash word, accented FR word
    assert red.classify("apple", en) is None
    assert red.classify("arc-en-ciel", fr) is None
    assert red.classify("forêt", fr) is None


def test_rule_order_uppercase_before_stopword():
    # "The" is BOTH uppercase and a stopword; the first matching rule wins.
    assert red.classify("The", red.make_rules("en")) == "majuscule"


# --- header detection / output path ------------------------------------------------

def test_detect_header():
    assert red.detect_header("2000000 300") == (True, "300")
    assert red.detect_header("apple 0.1 0.2 0.3") == (False, None)
    assert red.detect_header("100 300 5") == (False, None)


def test_derive_path_preserves_extension():
    assert red.derive_path("/x/cc.fr.300.vec") == "/x/cc.fr.300_reduced.vec"
    assert red.derive_path("/x/glove.6B.300d.txt") == "/x/glove.6B.300d_reduced.txt"


# --- end-to-end: filter-THEN-cap + header recount ----------------------------------

def _run_reduce(monkeypatch, tmp_path, lines, *, lang="en", top_n, header):
    src = tmp_path / "src.vec"
    body = (header + "\n" if header is not None else "") + "".join(lines)
    src.write_text(body, encoding="utf-8")
    out = tmp_path / "out.vec"
    monkeypatch.setattr(red, "TOP_N", top_n)
    monkeypatch.setattr(sys, "argv", ["reduce", str(src), "--lang", lang, "--out", str(out)])
    red.main()
    return out.read_text(encoding="utf-8").splitlines()


def test_filter_then_cap_yields_exactly_top_n_with_recounted_header(monkeypatch, tmp_path):
    lines = [
        "the 0 0 0 0\n",     # stopword     -> drop
        "Cat 0 0 0 0\n",     # uppercase    -> drop
        "apple 0 0 0 0\n",   # keep 1
        "h2o 0 0 0 0\n",     # non-alphabet -> drop
        "banana 0 0 0 0\n",  # keep 2
        "a 0 0 0 0\n",       # single       -> drop
        "cherry 0 0 0 0\n",  # keep 3       -> hits the cap, reading stops here
        "date 0 0 0 0\n",    # must NOT be reached
    ]
    out = _run_reduce(monkeypatch, tmp_path, lines, top_n=3, header="999 4")

    # header recounted to the KEPT count (3), dim (4) preserved — NOT the bogus 999
    assert out[0] == "3 4"
    kept = [ln.split(" ", 1)[0] for ln in out[1:]]
    # EXACTLY TOP_N survivors despite the interspersed rejects (filter-then-cap)
    assert kept == ["apple", "banana", "cherry"]
    for absent in ("the", "Cat", "h2o", "a", "date"):
        assert absent not in kept


def test_source_exhausted_keeps_fewer_and_warns(monkeypatch, tmp_path, capsys):
    lines = ["apple 0 0\n", "banana 0 0\n", "the 0 0\n"]  # 2 keepers + 1 stopword
    out = _run_reduce(monkeypatch, tmp_path, lines, top_n=10, header="999 2")

    assert out[0] == "2 2"  # recounted to survivors, not TOP_N
    assert [ln.split(" ", 1)[0] for ln in out[1:]] == ["apple", "banana"]
    assert "épuisée" in capsys.readouterr().err  # source-exhausted warning


def test_no_header_source_produces_no_header(monkeypatch, tmp_path):
    # GloVe .txt has no "<count> <dim>" header: the first line is already data.
    lines = ["apple 0 0 0\n", "banana 0 0 0\n"]
    out = _run_reduce(monkeypatch, tmp_path, lines, top_n=10, header=None)

    assert out[0].split(" ", 1)[0] == "apple"      # no recalculated header prepended
    assert red.detect_header(out[0]) == (False, None)
