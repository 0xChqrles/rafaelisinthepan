"""CONTRACT: reduce_embedding.py is the ONLY filter+cap stage (AGENTS.md "Pipeline").

  - rejection rules, in order: uppercase -> single-letter -> non-alphabet -> stopword
    -> hors-dico (rule 5, runs LAST);
  - hors-dico rejects tokens absent from the language's reference wordlist, EXCEPT the
    top FREQ_EXEMPT morphological survivors (the frequency safety net), which are kept
    and flagged as exemption-saved in the report;
  - filter-THEN-cap: the cap counts SURVIVORS, so the output has EXACTLY TOP_N kept
    words (interspersed rejects do not reduce the count), or fewer + a warning if the
    source is exhausted first;
  - header is RECOUNTED to the kept count when the source had one, and ABSENT when it
    did not.
"""

import gzip
import os
import sys

import pytest

import reduce_embedding as red  # noqa: E402  (importable via conftest's sys.path)

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
DICO_FR = os.path.join(FIXTURES, "dico.fr.txt")  # small committed reference wordlist


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
    # --no-dico: these cases exercise filter-then-cap + header, not the hors-dico rule.
    src = tmp_path / "src.vec"
    body = (header + "\n" if header is not None else "") + "".join(lines)
    src.write_text(body, encoding="utf-8")
    out = tmp_path / "out.vec"
    monkeypatch.setattr(red, "TOP_N", top_n)
    monkeypatch.setattr(
        sys, "argv", ["reduce", str(src), "--lang", lang, "--no-dico", "--out", str(out)]
    )
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


# --- hors-dico rule (5) + frequency safety net -------------------------------------

def _run_dico(monkeypatch, tmp_path, lines, *, lang="fr", top_n=1000,
              freq_exempt=0, dico=DICO_FR):
    """Run reduce with the hors-dico rule active against a fixture wordlist. Returns the
    KEPT words (header stripped). freq_exempt defaults to 0 so the dico check is not
    masked by the exemption unless a test opts in."""
    src = tmp_path / "src.vec"
    src.write_text("999 2\n" + "".join(lines), encoding="utf-8")
    out = tmp_path / "out.vec"
    monkeypatch.setattr(red, "TOP_N", top_n)
    monkeypatch.setattr(red, "FREQ_EXEMPT", freq_exempt)
    monkeypatch.setattr(
        sys, "argv",
        ["reduce", str(src), "--lang", lang, "--dico", str(dico), "--out", str(out)],
    )
    red.main()
    return [ln.split(" ", 1)[0] for ln in out.read_text(encoding="utf-8").splitlines()[1:]]


def _report_line(err, reason):
    """The per-rule report line for a reason, e.g. '  - hors-dico     :  N   ex : ...'."""
    for line in err.splitlines():
        if reason in line and ":" in line:
            return line
    return ""


def test_hors_dico_rejects_noise_keeps_inflected_forms(monkeypatch, tmp_path):
    # Full inflected forms (conjugation, plural, feminine, real dash word) are IN the
    # dico and pass; typos / letter-only gibberish / dash fragments are absent and rejected.
    lines = [
        "forêt 0 0\n",        # in dico                       -> keep
        "mangeaient 0 0\n",   # conjugated, in dico           -> keep
        "gksudo 0 0\n",       # letter-only gibberish, absent -> hors-dico
        "chevaux 0 0\n",      # irregular plural, in dico     -> keep
        "forett 0 0\n",       # typo of forêt, absent         -> hors-dico
        "heureuses 0 0\n",    # feminine plural, in dico      -> keep
        "a-ligne 0 0\n",      # dash fragment, absent         -> hors-dico
        "arc-en-ciel 0 0\n",  # real dash word, in dico       -> keep
    ]
    kept = _run_dico(monkeypatch, tmp_path, lines)
    assert kept == ["forêt", "mangeaient", "chevaux", "heureuses", "arc-en-ciel"]
    for absent in ("gksudo", "forett", "a-ligne"):
        assert absent not in kept


def test_frequency_exemption_saves_frequent_out_of_dico_words(monkeypatch, tmp_path, capsys):
    # FREQ_EXEMPT=3: the top 3 morphological survivors skip the dico check.
    #   forêt(#1,in)  gksudo(#2,absent→SAVED)  chevaux(#3,in)  a-ligne(#4,absent→rejected)
    lines = [
        "forêt 0 0\n",    # morph #1, in dico
        "gksudo 0 0\n",   # morph #2, absent — within top 3 -> SAVED (kept)
        "chevaux 0 0\n",  # morph #3, in dico
        "a-ligne 0 0\n",  # morph #4, absent — beyond top 3 -> hors-dico reject
        "forêts 0 0\n",   # morph #5, in dico
    ]
    kept = _run_dico(monkeypatch, tmp_path, lines, freq_exempt=3)
    assert kept == ["forêt", "gksudo", "chevaux", "forêts"]   # a-ligne dropped, gksudo saved

    err = capsys.readouterr().err
    assert _report_line(err, "hors-dico").split(":")[1].strip().startswith("1")  # a-ligne
    exempt = _report_line(err, "exempté-freq")                # the safety-net sample line
    assert "gksudo" in exempt                                 # reported for tuning FREQ_EXEMPT


def test_hors_dico_runs_last_after_morphological_rules(monkeypatch, tmp_path, capsys):
    # A token that is BOTH a stopword AND absent from the dico is attributed to the
    # earlier rule (stopword) — hors-dico runs LAST and is never consulted for it.
    lines = [
        "le 0 0\n",     # stopword AND absent from dico -> attributed to stopword
        "Zebra 0 0\n",  # uppercase -> majuscule, never reaches the dico
        "forêt 0 0\n",  # in dico -> keep
    ]
    kept = _run_dico(monkeypatch, tmp_path, lines)
    assert kept == ["forêt"]

    err = capsys.readouterr().err
    assert "le" in _report_line(err, "stopword")              # counted as stopword...
    assert "le" not in _report_line(err, "hors-dico")         # ...not as hors-dico
    assert _report_line(err, "hors-dico").split(":")[1].strip().startswith("0")


def test_no_dico_flag_disables_the_rule(monkeypatch, tmp_path):
    # --no-dico: morphology only; out-of-dico words survive and no hors-dico line appears.
    src = tmp_path / "src.vec"
    src.write_text("999 2\ngksudo 0 0\nforêt 0 0\n", encoding="utf-8")
    out = tmp_path / "out.vec"
    monkeypatch.setattr(red, "TOP_N", 1000)
    monkeypatch.setattr(
        sys, "argv", ["reduce", str(src), "--lang", "fr", "--no-dico", "--out", str(out)]
    )
    red.main()
    kept = [ln.split(" ", 1)[0] for ln in out.read_text(encoding="utf-8").splitlines()[1:]]
    assert kept == ["gksudo", "forêt"]   # gksudo survives when the rule is off


def test_missing_wordlist_fails_loud(monkeypatch, tmp_path):
    # A missing dico must ERROR, never silently ship unfiltered vocab.
    src = tmp_path / "src.vec"
    src.write_text("999 2\nforêt 0 0\n", encoding="utf-8")
    monkeypatch.setattr(
        sys, "argv",
        ["reduce", str(src), "--lang", "fr", "--dico", str(tmp_path / "nope.txt"),
         "--out", str(tmp_path / "out.vec")],
    )
    with pytest.raises(SystemExit):
        red.main()


def test_load_dico_reads_plain_and_gzip_keeping_accents(tmp_path):
    # Both openers yield the same set; accents are preserved (compared pre-slug).
    plain = tmp_path / "d.txt"
    plain.write_text("forêt\nchevaux\n\narc-en-ciel\n", encoding="utf-8")
    gz = tmp_path / "d.txt.gz"
    with gzip.open(gz, "wt", encoding="utf-8") as f:
        f.write("forêt\nchevaux\n\narc-en-ciel\n")

    expected = {"forêt", "chevaux", "arc-en-ciel"}   # blank line ignored, accents kept
    assert red.load_dico(str(plain)) == expected
    assert red.load_dico(str(gz)) == expected
