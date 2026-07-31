"""CONTRACT: build_lemmas.py — the committed en form→lemma table (#104).

  - en ONLY since #132: the fr grouping comes from the unified lexeme inventory
    (build_forms.py); this builder keeps AGID for English;
  - one `form<TAB>lemma` pair per line, sorted + unique, lowercase;
  - a form may carry several lemmas;
  - every lemma is registered as a form of itself (self-contained artifact);
  - both sides must pass the language token rule (letters + internal hyphens);
  - AGID lines parse to (lemma, forms) with annotations stripped.
"""

import gzip

import build_lemmas


def test_parse_agid_line_slots_variants_and_annotations():
    # slots split on "|", variants on ","; a variant's level digits and glued
    # markers (?, ~, <, !) are annotations, not part of the word.
    lemma, forms = build_lemmas.parse_agid_line("be V: was, wast 2 | were | been | being")
    assert lemma == "be"
    assert forms == ["was", "wast", "were", "been", "being"]

    lemma, forms = build_lemmas.parse_agid_line("ABLS N: ABLSes?")
    assert (lemma, forms) == ("ABLS", ["ABLSes"])


def test_parse_agid_line_malformed_yields_nothing():
    assert build_lemmas.parse_agid_line("no colon here") == (None, [])


def test_collect_pairs_normalizes_filters_and_adds_identity():
    pairs = build_lemmas.collect_pairs("en", [
        ("Mice", "mouse"),        # lowercased
        ("geese", "goose"),
        ("co2", "co2"),           # digit: fails the token rule on both sides
        ("x y", "x"),             # space: not a token
    ])
    assert ("mice", "mouse") in pairs
    assert ("geese", "goose") in pairs
    # every lemma is also a form of itself
    assert ("mouse", "mouse") in pairs
    assert ("goose", "goose") in pairs
    assert all("co2" not in pair and "x y" not in pair for pair in pairs)


def test_the_builder_is_en_only():
    # fr is a decided removal (#132), not a missing entry: the fr grouping ships in
    # the unified lexeme inventory, and a second fr identity is the bug #132 fixed.
    assert tuple(build_lemmas.SOURCES) == ("en",)


def test_collect_pairs_en_token_rule_drops_accents_and_uppercase_junk():
    # en char class is a-z only: accented or non-letter tokens never enter the table.
    pairs = build_lemmas.collect_pairs("en", [("cafés", "café"), ("mice", "mouse")])
    assert pairs == {("mice", "mouse"), ("mouse", "mouse")}


def test_load_lemmas_roundtrip_multi_lemma_forms(tmp_path):
    path = str(tmp_path / "en.lemmas.tsv.gz")
    with gzip.open(path, "wt", encoding="utf-8") as f:
        f.write("porte\tporte\nportes\tporte\nportes\tporter\nporter\tporter\n")
    table = build_lemmas.load_lemmas(path)
    assert table["portes"] == ("porte", "porter")  # file (sorted) order preserved
    assert table["porte"] == ("porte",)
    assert "absent" not in table
