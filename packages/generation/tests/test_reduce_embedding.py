"""CONTRACT: reduce_embedding.py is the ONLY filter+cap stage (AGENTS.md "Pipeline").

  - rejection rules, in order: single-letter -> stopword -> hors-dico (rule 3, runs LAST
    on EVERY survivor — exact language allowlist aside, no exemption);
  - the two morphological rules cover only what hors-dico can't (single letters and
    stopwords are valid dictionary entries); uppercase / non-alphabet tokens need no
    dedicated rule — they simply aren't in the lowercase, letters+hyphens wordlist, so
    hors-dico rejects them;
  - filter-THEN-cap: the cap counts SURVIVORS, so the output has EXACTLY TOP_N kept
    words (interspersed rejects do not reduce the count), or fewer + a warning if the
    source is exhausted first;
  - header is RECOUNTED to the kept count when the source had one, and ABSENT when it
    did not;
  - reduce also emits the front's existence set (web/public/vocab/<lang>.json) in the
    same pass: the slugged/deduped/sorted set of the KEPT words (disable with --no-vocab),
    and with it the backend-facing metadata of that set (#200 — see test_vocab_meta.py).
"""

import gzip
import json
import os
import sys

import pytest

import reduce_embedding as red  # noqa: E402  (importable via conftest's sys.path)

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
DICO_FR = os.path.join(FIXTURES, "dico.fr.txt")  # small committed reference wordlist


# --- rejection rules + their order -------------------------------------------------

def test_morphological_rules_cover_only_what_the_dico_cannot():
    # make_rules() now holds ONLY the two rules hors-dico can't subsume, because their
    # targets are valid dictionary entries the wordlist would otherwise keep.
    en = red.make_rules("en")
    fr = red.make_rules("fr")

    # single letter, counted by CHARACTER (accented letter is one) — the alphabet ships
    # in Hunspell/SCOWL, so without this rule the dico would keep every letter.
    assert red.classify("a", en) == "single-letter"
    assert red.classify("é", fr) == "single-letter"
    # stopword — a real word, so the dico keeps it; this rule is what excludes it.
    assert red.classify("the", en) == "stopword"
    assert red.classify("le", fr) == "stopword"

    # NOT rejected morphologically anymore — uppercase / non-alphabet pass make_rules and
    # are left for hors-dico (they aren't in the lowercase, letters-only wordlist).
    assert red.classify("Cat", en) is None
    assert red.classify("h2o", en) is None
    assert red.classify("</s>", en) is None
    # KEPT (None): plain word, internal-dash word, accented FR word
    assert red.classify("apple", en) is None
    assert red.classify("arc-en-ciel", fr) is None
    assert red.classify("forêt", fr) is None


def test_rule_order_single_letter_before_stopword():
    # "a" is BOTH a single letter and an en stopword; the first matching rule wins.
    assert red.classify("a", red.make_rules("en")) == "single-letter"


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
    # --no-vocab: keep these cases from writing to the real web/public/vocab.
    src = tmp_path / "src.vec"
    body = (header + "\n" if header is not None else "") + "".join(lines)
    src.write_text(body, encoding="utf-8")
    out = tmp_path / "out.vec"
    monkeypatch.setattr(red, "TOP_N", top_n)
    monkeypatch.setattr(
        sys, "argv",
        ["reduce", str(src), "--lang", lang, "--no-dico", "--no-vocab", "--out", str(out)],
    )
    red.main()
    return out.read_text(encoding="utf-8").splitlines()


def test_filter_then_cap_yields_exactly_top_n_with_recounted_header(monkeypatch, tmp_path):
    # --no-dico here, so the interspersed rejects use the two surviving rules
    # (single-letter / stopword) rather than the removed uppercase/non-alphabet ones.
    lines = [
        "the 0 0 0 0\n",     # stopword      -> drop
        "i 0 0 0 0\n",       # single-letter -> drop
        "apple 0 0 0 0\n",   # keep 1
        "of 0 0 0 0\n",      # stopword      -> drop
        "banana 0 0 0 0\n",  # keep 2
        "a 0 0 0 0\n",       # single-letter -> drop
        "cherry 0 0 0 0\n",  # keep 3        -> hits the cap, reading stops here
        "date 0 0 0 0\n",    # must NOT be reached
    ]
    out = _run_reduce(monkeypatch, tmp_path, lines, top_n=3, header="999 4")

    # header recounted to the KEPT count (3), dim (4) preserved — NOT the bogus 999
    assert out[0] == "3 4"
    kept = [ln.split(" ", 1)[0] for ln in out[1:]]
    # EXACTLY TOP_N survivors despite the interspersed rejects (filter-then-cap)
    assert kept == ["apple", "banana", "cherry"]
    for absent in ("the", "i", "of", "a", "date"):
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


# --- hors-dico rule (3), applied to every survivor ---------------------------------

def _run_dico(monkeypatch, tmp_path, lines, *, lang="fr", top_n=1000, dico=DICO_FR):
    """Run reduce with the hors-dico rule active against a fixture wordlist. Returns the
    KEPT words (header stripped). --no-vocab so it doesn't touch the real web/public."""
    src = tmp_path / "src.vec"
    src.write_text("999 2\n" + "".join(lines), encoding="utf-8")
    out = tmp_path / "out.vec"
    monkeypatch.setattr(red, "TOP_N", top_n)
    monkeypatch.setattr(
        sys, "argv",
        ["reduce", str(src), "--lang", lang, "--dico", str(dico),
         "--no-vocab", "--out", str(out)],
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


def test_hors_dico_applies_to_every_non_allowlisted_survivor(monkeypatch, tmp_path):
    # Even the very FIRST (most frequent) out-of-dico, non-allowlisted token is rejected:
    # there is no frequency exemption. gksudo leads the file yet is still dropped.
    lines = [
        "gksudo 0 0\n",     # most frequent, absent -> STILL hors-dico rejected
        "forêt 0 0\n",      # in dico -> keep
        "typooo 0 0\n",     # absent -> hors-dico
        "chevaux 0 0\n",    # in dico -> keep
    ]
    kept = _run_dico(monkeypatch, tmp_path, lines)
    assert kept == ["forêt", "chevaux"]
    assert "gksudo" not in kept


def test_hors_dico_allowlist_keeps_only_the_exact_language_entry(monkeypatch, tmp_path):
    # The French raw embedding contains several case variants. Only the deliberately
    # allowlisted lowercase token survives; the exception neither folds nor lowercases.
    lines = [
        "Rolex 0 0\n",     # not an exact allowlist entry -> hors-dico
        "rolex 0 0\n",     # absent from dico, explicitly allowlisted for fr -> keep
        "gksudo 0 0\n",    # absent and not allowlisted -> hors-dico
        "forêt 0 0\n",     # in dico -> keep
    ]
    assert _run_dico(monkeypatch, tmp_path, lines) == ["rolex", "forêt"]

    # The exception is language-specific: the same custom dico does not admit it for en.
    assert _run_dico(monkeypatch, tmp_path, ["rolex 0 0\n"], lang="en") == []


def test_stopword_wins_over_hors_dico_which_runs_last(monkeypatch, tmp_path, capsys):
    # "le" is BOTH a stopword AND absent from the dico -> attributed to the EARLIER rule
    # (stopword); hors-dico runs LAST. Uppercase "Zebra" now folds INTO hors-dico (no
    # dedicated majuscule rule) because it isn't in the lowercase wordlist.
    lines = [
        "le 0 0\n",     # stopword AND absent from dico -> counted as stopword
        "Zebra 0 0\n",  # uppercase, absent from dico   -> counted as hors-dico
        "forêt 0 0\n",  # in dico -> keep
    ]
    kept = _run_dico(monkeypatch, tmp_path, lines)
    assert kept == ["forêt"]

    err = capsys.readouterr().err
    assert "le" in _report_line(err, "stopword")              # earlier rule wins...
    assert "le" not in _report_line(err, "hors-dico")         # ...not attributed to hors-dico
    assert "Zebra" in _report_line(err, "hors-dico")          # uppercase folds into hors-dico


def test_no_dico_flag_disables_the_rule(monkeypatch, tmp_path):
    # --no-dico: morphology only; out-of-dico words survive and no hors-dico line appears.
    src = tmp_path / "src.vec"
    src.write_text("999 2\ngksudo 0 0\nforêt 0 0\n", encoding="utf-8")
    out = tmp_path / "out.vec"
    monkeypatch.setattr(red, "TOP_N", 1000)
    monkeypatch.setattr(
        sys, "argv",
        ["reduce", str(src), "--lang", "fr", "--no-dico", "--no-vocab", "--out", str(out)],
    )
    red.main()
    kept = [ln.split(" ", 1)[0] for ln in out.read_text(encoding="utf-8").splitlines()[1:]]
    assert kept == ["gksudo", "forêt"]   # gksudo survives when the rule is off


def test_reduce_emits_slugged_vocab_of_kept_words(monkeypatch, tmp_path):
    # reduce writes the front's existence set in the SAME pass: the slugged, deduped,
    # sorted set of exactly the KEPT words (post-filter) — accents folded to the slug.
    # --meta-path names the metadata's destination explicitly (#200). It is not what
    # keeps this run out of the repo — --vocab-dir alone already redirects the record
    # with the set (test_vocab_meta.py) — so passing it here exercises the flag.
    src = tmp_path / "src.vec"
    src.write_text("999 2\n" + "".join(
        f"{w} 0 0\n" for w in ["forêt", "gksudo", "chevaux", "le", "arc-en-ciel"]
    ), encoding="utf-8")
    vocab_dir = tmp_path / "vocab"
    meta_path = tmp_path / "vocab.generated.json"
    monkeypatch.setattr(red, "TOP_N", 1000)
    monkeypatch.setattr(
        sys, "argv",
        ["reduce", str(src), "--lang", "fr", "--dico", str(DICO_FR),
         "--out", str(tmp_path / "out.vec"), "--vocab-dir", str(vocab_dir),
         "--meta-path", str(meta_path)],
    )
    red.main()

    data = json.loads((vocab_dir / "fr.json").read_text(encoding="utf-8"))
    # gksudo (hors-dico) + le (stopword) excluded; forêt -> slug "foret"; sorted + unique.
    assert data == ["arc-en-ciel", "chevaux", "foret"]

    # The metadata describes THAT set, and names the corpus by the source we streamed.
    meta = json.loads(meta_path.read_text(encoding="utf-8"))["fr"]
    assert meta["vocabSize"] == 3                  # the set it just wrote
    assert meta["maxSlugLength"] == len("arc-en-ciel")
    assert meta["embedding"] == "src"


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
