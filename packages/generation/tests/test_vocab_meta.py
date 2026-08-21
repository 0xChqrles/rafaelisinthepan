"""CONTRACT: the vocab metadata generation emits into packages/shared (#200).

  - it is written by the SAME call that writes the existence set (slug.write_vocab), from
    the same slugs, so the numbers can never describe a different vocabulary;
  - per language: `vocabSize` (distinct slugs — the sentence score ceiling),
    `maxSlugLength` (the longest key — the guess-length cap) and the corpus build
    (`embedding` + `builtAt`);
  - `embedding` names the corpus, not the file: the raw source and its `_reduced`
    output answer the same name, so reduce / gen_phrase / build_vocab agree;
  - a language's entry is updated ALONE — the other one is kept, and a file that will
    not parse is refused rather than silently rewritten without it;
  - a REDIRECTED existence set takes its record with it, so a run pointed away from
    web/public leaves nothing in packages/shared;
  - an unchanged rebuild keeps its recorded `builtAt`, so re-running the pipeline over
    the same corpus leaves the committed file byte-identical.
"""

import json

import pytest

import slug as slug_mod  # noqa: E402  (importable via conftest's sys.path)


def _meta(tmp_path, words, lang, source, *, name="vocab.generated.json"):
    """Run the real writer into tmp_path and return the metadata it wrote."""
    path = tmp_path / name
    slug_mod.write_vocab(words, lang, source,
                         vocab_dir=str(tmp_path / "vocab"), meta_path=str(path))
    return json.loads(path.read_text(encoding="utf-8"))


# --- what the entry measures --------------------------------------------------------

def test_entry_measures_the_set_that_was_just_written(tmp_path):
    # "chevaux" twice and "forêt"/"foret" both fold to ONE slug each: the metadata counts
    # the DISTINCT slugs of the existence set, never the raw words handed in.
    meta = _meta(tmp_path, ["forêt", "foret", "chevaux", "chevaux", "arc-en-ciel"],
                 "fr", "/e/fr/cc.fr.300.vec")

    assert meta["fr"]["vocabSize"] == 3
    assert meta["fr"]["maxSlugLength"] == len("arc-en-ciel")
    # And it describes exactly the file written beside it — one vocabulary, one record.
    written = json.loads((tmp_path / "vocab" / "fr.json").read_text(encoding="utf-8"))
    assert meta["fr"]["vocabSize"] == len(written)
    assert meta["fr"]["maxSlugLength"] == max(len(s) for s in written)


def test_empty_words_measure_zero_rather_than_crash(tmp_path):
    meta = _meta(tmp_path, [], "en", "/e/en/glove.6B.300d.txt")
    assert meta["en"]["vocabSize"] == 0
    assert meta["en"]["maxSlugLength"] == 0


# --- naming the corpus build --------------------------------------------------------

def test_corpus_name_is_the_same_from_either_side_of_the_reduction():
    # reduce holds the raw source; the neighbor modules hold the _reduced file they load.
    # Both must name ONE corpus, or the record would depend on which command last ran.
    assert slug_mod.corpus_name("/e/fr/cc.fr.300.vec") == "cc.fr.300"
    assert slug_mod.corpus_name("/e/fr/cc.fr.300_reduced.vec") == "cc.fr.300"
    assert slug_mod.corpus_name("/e/en/glove.6B.300d.txt") == "glove.6B.300d"
    assert slug_mod.corpus_name("/e/en/glove.6B.300d_reduced.txt") == "glove.6B.300d"


def test_the_recorded_corpus_is_the_one_the_words_came_from(tmp_path):
    meta = _meta(tmp_path, ["forêt"], "fr", "/e/fr/cc.fr.300_reduced.vec")
    assert meta["fr"]["embedding"] == "cc.fr.300"


# --- one language at a time ---------------------------------------------------------

def test_rebuilding_one_language_keeps_the_other(tmp_path):
    # A run only ever rebuilds one language; the file holds both, so the untouched entry
    # must survive verbatim — otherwise every reduce:fr would wipe en's numbers.
    _meta(tmp_path, ["forêt", "chevaux"], "fr", "/e/fr/cc.fr.300.vec")
    before = _meta(tmp_path, ["ocean"], "en", "/e/en/glove.6B.300d.txt")
    assert before["fr"]["vocabSize"] == 2 and before["en"]["vocabSize"] == 1

    after = _meta(tmp_path, ["forêt", "chevaux", "phare"], "fr", "/e/fr/cc.fr.300.vec")
    assert after["fr"]["vocabSize"] == 3
    assert after["en"] == before["en"]


# --- builtAt dates the corpus build, not the run ------------------------------------

def test_an_unchanged_rebuild_keeps_its_recorded_date(tmp_path):
    first = _meta(tmp_path, ["forêt", "chevaux"], "fr", "/e/fr/cc.fr.300.vec")
    dated = dict(first["fr"], builtAt="2020-01-01")
    (tmp_path / "vocab.generated.json").write_text(
        json.dumps({"fr": dated}), encoding="utf-8")

    again = _meta(tmp_path, ["chevaux", "forêt"], "fr", "/e/fr/cc.fr.300_reduced.vec")
    # Same corpus, same set: nothing new was built, so the date does not move (and the
    # committed file stays byte-identical instead of churning on every puzzle commit).
    assert again["fr"]["builtAt"] == "2020-01-01"


def test_a_changed_vocabulary_redates_the_entry(tmp_path):
    (tmp_path / "vocab.generated.json").write_text(json.dumps({
        "fr": {"embedding": "cc.fr.300", "vocabSize": 2, "maxSlugLength": 7,
               "builtAt": "2020-01-01"},
    }), encoding="utf-8")

    grown = _meta(tmp_path, ["forêt", "chevaux", "phare"], "fr", "/e/fr/cc.fr.300.vec")
    assert grown["fr"]["builtAt"] != "2020-01-01"

    swapped = _meta(tmp_path, ["forêt", "chevaux", "phare"], "fr", "/e/fr/cc.fr.301.vec")
    assert swapped["fr"]["embedding"] == "cc.fr.301"
    assert swapped["fr"]["builtAt"] != "2020-01-01"


def test_a_missing_file_is_the_ordinary_cold_start(tmp_path):
    # Nothing to keep, so the run that is about to write it just does.
    meta = _meta(tmp_path, ["forêt"], "fr", "/e/fr/cc.fr.300.vec")
    assert meta["fr"]["vocabSize"] == 1


def test_an_unreadable_file_fails_loud_rather_than_dropping_a_language(tmp_path):
    # The file carries BOTH languages and a run rebuilds ONE, so "unparseable means
    # empty" would write en out of existence — and a language absent from the record is
    # a 400 on every live route for it. A conflict-markered merge is how a committed
    # file realistically stops parsing; the repair is restoring it, not overwriting it.
    path = tmp_path / "vocab.generated.json"
    path.write_text("{ not json", encoding="utf-8")

    with pytest.raises(SystemExit):
        _meta(tmp_path, ["forêt"], "fr", "/e/fr/cc.fr.300.vec")
    assert path.read_text(encoding="utf-8") == "{ not json"  # left for the human
    # And it failed BEFORE the set moved: the pair is one statement about one
    # vocabulary, so a refused record must not leave a rewritten set beside it.
    assert not (tmp_path / "vocab" / "fr.json").exists()


def test_a_non_object_file_fails_loud_too(tmp_path):
    (tmp_path / "vocab.generated.json").write_text("[]", encoding="utf-8")
    with pytest.raises(SystemExit):
        _meta(tmp_path, ["forêt"], "fr", "/e/fr/cc.fr.300.vec")


# --- a redirected set takes its record with it --------------------------------------

def test_redirecting_the_set_redirects_its_metadata(tmp_path, monkeypatch):
    # `--vocab-dir` alone must isolate a run COMPLETELY: an experiment that keeps its
    # existence set out of web/public must not leave that set's numbers in the real
    # packages/shared, where the backend reads its score ceiling.
    default = tmp_path / "committed" / "vocab.generated.json"   # stands in for the real one
    monkeypatch.setattr(slug_mod, "VOCAB_META_PATH", str(default))
    vocab_dir = tmp_path / "scratch"

    slug_mod.write_vocab(["forêt", "chevaux"], "fr", "/e/fr/cc.fr.300.vec",
                         vocab_dir=str(vocab_dir))

    # The set landed in the redirect, and its record landed BESIDE it.
    assert (vocab_dir / "fr.json").exists()
    beside = json.loads((vocab_dir / "vocab.generated.json").read_text(encoding="utf-8"))
    assert beside["fr"]["vocabSize"] == 2
    assert not default.exists()          # the committed location was never touched


def test_an_explicit_meta_path_still_wins_over_the_redirect(tmp_path):
    vocab_dir = tmp_path / "scratch"
    explicit = tmp_path / "elsewhere.json"
    slug_mod.write_vocab(["forêt"], "fr", "/e/fr/cc.fr.300.vec",
                         vocab_dir=str(vocab_dir), meta_path=str(explicit))

    assert json.loads(explicit.read_text(encoding="utf-8"))["fr"]["vocabSize"] == 1
    assert not (vocab_dir / "vocab.generated.json").exists()
