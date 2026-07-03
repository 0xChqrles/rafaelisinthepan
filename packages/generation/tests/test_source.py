"""CONTRACT: optional `source` metadata on the per-puzzle schema (issue #5).

build_source() is the single place that assembles the puzzle's optional `source`
object. The schema rules it must enforce (AGENTS.md "Per-puzzle JSON schema", #5):

  - EVERY sub-field is optional; a partial source keeps only the provided fields;
  - blank / whitespace-only fields are dropped (not stored as "");
  - nothing provided -> None, so gen_phrase writes NO `source` key and the output
    stays byte-compatible with metadata-less puzzles;
  - values are kept verbatim as DISPLAY forms (accents preserved, never slugged),
    only edge-trimmed.
"""

import gen_phrase  # noqa: E402


def test_nothing_provided_returns_none():
    # No `source` key at all -> byte-compatible with metadata-less puzzles.
    assert gen_phrase.build_source() is None
    assert gen_phrase.build_source(None, None, None, None) is None


def test_all_blank_or_whitespace_returns_none():
    assert gen_phrase.build_source("", "  ", "\t", "\n") is None


def test_partial_keeps_only_provided_fields():
    assert gen_phrase.build_source(author="Victor Hugo") == {"author": "Victor Hugo"}
    assert gen_phrase.build_source(kind="quote") == {"kind": "quote"}


def test_full_source_keeps_all_four_fields():
    src = gen_phrase.build_source(
        kind="book",
        author="Victor Hugo",
        work="Les Misérables",
        context="…full passage…",
    )
    assert src == {
        "kind": "book",
        "author": "Victor Hugo",
        "work": "Les Misérables",
        "context": "…full passage…",
    }


def test_blank_fields_are_dropped_around_present_ones():
    assert gen_phrase.build_source(kind="movie", author="   ", work="", context="ctx") == {
        "kind": "movie",
        "context": "ctx",
    }


def test_values_kept_as_display_form_only_trimmed():
    # Accents preserved (display form, never slugged); only edge whitespace trimmed.
    src = gen_phrase.build_source(author="  Émile Zola  ", work="Germinal")
    assert src == {"author": "Émile Zola", "work": "Germinal"}
