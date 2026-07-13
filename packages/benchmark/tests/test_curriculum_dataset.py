"""Deterministic-dataset contract for the strategy curriculum (#84).

The LLM only authors candidates; these tests assert that the deterministic code
is the sole gatekeeper: validation, balance, start band, split, and hashes.
"""

import json
from pathlib import Path

import pytest

import curriculum_dataset as cd
from curriculum_dataset import (
    Candidate,
    Quotas,
    Rejection,
    build_dataset,
    build_puzzle,
    curriculum_start,
    frequency_lookup,
    select_balanced,
    stratify_split,
    validate_candidate,
)

# Scaled-down world: 4 puzzles (3 curriculum + 1 holdout), 12 target slots.
QUOTAS = Quotas(
    puzzle_count=4,
    curriculum_count=3,
    per_pos={"noun": 3, "adjective": 3, "verb": 3, "adverb": 3},
    per_gender={"m": 3, "f": 3},
    per_frequency_band={"common": 6, "difficult": 6},
)

# Frequency source is V order: indexes < the patched threshold are "common".
V = [
    "maison", "grand", "manger", "vite", "arbre", "petite", "courir", "souvent",
    "falaise", "rugueux", "gravir", "jadis", "rocher", "douce", "nager", "ailleurs",
]

CANDIDATES = [
    {
        "sentence": "la maison semble grand quand on veut gravir",
        "targets": [
            {"word": "maison", "pos": "noun", "gender": "f", "semantic_class": "tangible"},
            {"word": "grand", "pos": "adjective", "gender": "m", "semantic_class": "abstract"},
            {"word": "gravir", "pos": "verb", "semantic_class": "tangible"},
        ],
    },
    {
        "sentence": "une falaise petite existait jadis",
        "targets": [
            {"word": "falaise", "pos": "noun", "gender": "f", "semantic_class": "tangible"},
            {"word": "petite", "pos": "adjective", "gender": "f", "semantic_class": "abstract"},
            {"word": "jadis", "pos": "adverb", "semantic_class": "abstract"},
        ],
    },
    {
        "sentence": "l'arbre aime manger ailleurs",
        "targets": [
            {"word": "arbre", "pos": "noun", "gender": "m", "semantic_class": "tangible"},
            {"word": "manger", "pos": "verb", "semantic_class": "tangible"},
            {"word": "ailleurs", "pos": "adverb", "semantic_class": "abstract"},
        ],
    },
    {
        "sentence": "un rugueux voulait nager vite",
        "targets": [
            {"word": "rugueux", "pos": "adjective", "gender": "m", "semantic_class": "abstract"},
            {"word": "nager", "pos": "verb", "semantic_class": "tangible"},
            {"word": "vite", "pos": "adverb", "semantic_class": "abstract"},
        ],
    },
]

CANONICAL_METADATA = {}
for candidate in CANDIDATES:
    for target in candidate["targets"]:
        CANONICAL_METADATA.setdefault(target["word"], set()).add(
            (target["pos"], target.get("gender"))
        )

SYNTHETIC_EMBEDDING = {
    "embedding_source": "fixtures/synthetic.vec",
    "embedding_sha256": "e" * 64,
}

LETTERS = "abcdefghijklmnopqrstuvwxyz"


def ranking_for(word, n=160):
    """Synthetic nearest-first ranking: distinct letter-only non-variant slugs."""
    return [
        (f"voisin{LETTERS[i // 26]}{LETTERS[i % 26]}{word}", i, 0.0)
        for i in range(n)
    ]


@pytest.fixture(autouse=True)
def _small_frequency_threshold(monkeypatch):
    monkeypatch.setattr(cd, "COMMON_MAX_FREQ_RANK", 8)


@pytest.fixture
def freq():
    return frequency_lookup(V)


def generator_output():
    return {
        "generator": {"model": "test", "effort": "none"},
        "candidates": [json.loads(json.dumps(c)) for c in CANDIDATES],
    }


def test_validate_locates_targets_with_affixes_and_frequency_bands(freq):
    result = validate_candidate(2, CANDIDATES[2], freq, CANONICAL_METADATA)
    assert isinstance(result, Candidate)
    arbre = result.targets[0]
    assert (arbre.word, arbre.prefix, arbre.suffix) == ("arbre", "l'", "")
    assert arbre.token_index == 0
    assert arbre.frequency_band == "common"
    ailleurs = result.targets[2]
    assert ailleurs.frequency_band == "difficult"


@pytest.mark.parametrize(
    ("mutation", "reason_part"),
    [
        (lambda c: c["targets"][0].update(word="absent"), "not in the reduced vocabulary"),
        (lambda c: c.update(sentence="l'arbre aime manger un arbre ailleurs"), "exactly once"),
        (lambda c: c["targets"][1].update(word="mangers"), "not in the reduced vocabulary"),
        (lambda c: [t.update(pos="noun") or t.update(gender="m") for t in c["targets"]], "not attested"),
        (lambda c: [t.update(semantic_class="abstract") for t in c["targets"]], "share one semantic domain"),
        (lambda c: c["targets"][0].pop("gender"), "needs gender"),
        (lambda c: c["targets"][1].update(gender="m"), "must not declare a gender"),
        (lambda c: c.update(sentence="l'arbre aime manger le puzzle ailleurs"), "meta-language"),
    ],
)
def test_validate_rejects_with_a_reason_and_never_rewrites(freq, mutation, reason_part):
    candidate = json.loads(json.dumps(CANDIDATES[2]))
    mutation(candidate)
    result = validate_candidate(0, candidate, freq, CANONICAL_METADATA)
    assert isinstance(result, Rejection)
    assert reason_part in result.reason


def test_exact_inflection_is_required_not_slug_equality(freq):
    candidate = json.loads(json.dumps(CANDIDATES[2]))
    # Accented sentence form vs unaccented target word: same slug, wrong inflection.
    candidate["sentence"] = "l'àrbre aime manger ailleurs"
    result = validate_candidate(0, candidate, freq, CANONICAL_METADATA)
    assert isinstance(result, Rejection)
    assert "exact inflection" in result.reason


@pytest.mark.parametrize(
    ("word", "pos", "gender"),
    [("arbre", "verb", None), ("manger", "noun", "m")],
)
def test_canonical_metadata_rejects_author_asserted_pos_and_gender(
    freq, word, pos, gender
):
    candidate = json.loads(json.dumps(CANDIDATES[2]))
    target = next(target for target in candidate["targets"] if target["word"] == word)
    target["pos"] = pos
    if gender is None:
        target.pop("gender", None)
    else:
        target["gender"] = gender
    result = validate_candidate(0, candidate, freq, CANONICAL_METADATA)
    assert isinstance(result, Rejection)
    assert "not attested by Lexique" in result.reason


def test_lexique_export_is_vocabulary_scoped_and_deterministic(tmp_path):
    source = tmp_path / "lexique.tsv"
    source.write_text(
        "ortho\tcgram\tgenre\n"
        "arbre\tNOM\tm\n"
        "manger\tVER\t\n"
        "paisible\tADJ\t\n"
        "exclu\tNOM\tm\n",
        encoding="utf-8",
    )
    output = tmp_path / "fr-lexicon.tsv.gz"
    metadata = cd.build_fr_lexicon(
        ["arbre", "manger", "paisible"], source_path=source, out_path=output
    )
    first_bytes = output.read_bytes()

    assert metadata == {
        "arbre": {("noun", "m")},
        "manger": {("verb", None)},
        "paisible": {("adjective", "m"), ("adjective", "f")},
    }
    assert cd.load_fr_lexicon(output) == metadata
    cd.build_fr_lexicon(
        ["arbre", "manger", "paisible"], source_path=source, out_path=output
    )
    assert output.read_bytes() == first_bytes


def test_selection_is_deterministic_and_quota_exact(freq):
    validated = [
        validate_candidate(i, raw, freq, CANONICAL_METADATA)
        for i, raw in enumerate(CANDIDATES)
    ]
    assert all(isinstance(v, Candidate) for v in validated)

    first = select_balanced(validated, seed=7, quotas=QUOTAS)
    second = select_balanced(validated, seed=7, quotas=QUOTAS)
    assert [c.sentence for c in first] == [c.sentence for c in second]
    assert len(first) == QUOTAS.puzzle_count

    # Removing one candidate makes the quotas unsatisfiable: hard error, no fallback.
    with pytest.raises(ValueError, match="generate more"):
        select_balanced(validated[:-1], seed=7, quotas=QUOTAS)


def test_split_is_stratified_and_sized(freq):
    validated = [
        validate_candidate(i, raw, freq, CANONICAL_METADATA)
        for i, raw in enumerate(CANDIDATES)
    ]
    selected = select_balanced(validated, seed=7, quotas=QUOTAS)
    curriculum, holdout = stratify_split(selected, quotas=QUOTAS)
    assert len(curriculum) == QUOTAS.curriculum_count
    assert len(holdout) == QUOTAS.holdout_count
    assert {c.sentence for c in curriculum} | {c.sentence for c in holdout} == {
        c.sentence for c in selected
    }


def test_curriculum_start_stays_in_band_and_never_falls_back():
    import random

    rank_map = cd.build_rank_map("maison", ranking_for("maison"))
    rng = random.Random(1)
    start = curriculum_start("maison", rank_map, rng=rng, used_start_slugs=set())
    assert start is not None
    _, rank = start
    assert cd.START_RANK_LO <= rank <= cd.START_RANK_HI

    # A ranking too short to reach the band yields None — never a fallback.
    short_map = cd.build_rank_map("maison", ranking_for("maison", n=50))
    assert (
        curriculum_start("maison", short_map, rng=rng, used_start_slugs=set()) is None
    )


def test_build_puzzle_produces_the_canonical_schema(freq):
    import random

    candidate = validate_candidate(2, CANDIDATES[2], freq, CANONICAL_METADATA)
    puzzle = build_puzzle(candidate, ranking_for=ranking_for, rng=random.Random(3))
    assert puzzle["lang"] == "fr"
    assert puzzle["words"] == ["l'arbre", "aime", "manger", "ailleurs"]
    assert [hole["pos"] for hole in puzzle["holes"]] == [0, 2, 3]
    first = puzzle["holes"][0]
    assert first["secret"] == {"word": "arbre", "slug": "arbre"}
    assert first["prefix"] == "l'"
    assert cd.START_RANK_LO <= first["start_rank"] <= cd.START_RANK_HI
    for hole in puzzle["holes"]:
        secret_slug = hole["secret"]["slug"]
        assert puzzle["ranks"][secret_slug][secret_slug]["rank"] == 0
        assert (
            puzzle["ranks"][secret_slug][hole["start"]["slug"]]["rank"]
            == hole["start_rank"]
        )


def test_build_dataset_writes_manifest_puzzles_and_stable_hashes(tmp_path):
    first_dir = tmp_path / "one"
    second_dir = tmp_path / "two"
    manifest = build_dataset(
        generator_output(),
        V=V,
        ranking_for=ranking_for,
        seed=42,
        out_dir=first_dir,
        quotas=QUOTAS,
        canonical_metadata=CANONICAL_METADATA,
        **SYNTHETIC_EMBEDDING,
    )
    again = build_dataset(
        generator_output(),
        V=V,
        ranking_for=ranking_for,
        seed=42,
        out_dir=second_dir,
        quotas=QUOTAS,
        canonical_metadata=CANONICAL_METADATA,
        **SYNTHETIC_EMBEDDING,
    )

    assert manifest["counts"] == {"puzzles": 4, "curriculum": 3, "holdout": 1}
    assert manifest["start_band"] == {"lo": 100, "hi": 150}
    assert len(manifest["puzzles"]) == 4
    assert [p["split"] for p in manifest["puzzles"]] == ["curriculum"] * 3 + [
        "holdout"
    ]
    assert manifest["balance"]["verified"]["pos"] == {
        "noun": 3, "adjective": 3, "verb": 3, "adverb": 3
    }
    assert manifest["balance"]["verified"]["gender"] == {"m": 3, "f": 3}
    assert manifest["balance"]["verified"]["frequency_band"] == {
        "common": 6,
        "difficult": 6,
    }
    assert "semantic_class" not in manifest["balance"]["verified"]
    assert manifest["balance"]["declared"]["semantic_class"]
    assert manifest["canonical_metadata"]["verified_fields"] == ["pos", "gender"]
    assert manifest["canonical_metadata"]["declared_fields"] == [
        "semantic_class"
    ]
    assert manifest["embedding"] == {
        "source": "fixtures/synthetic.vec",
        "sha256": "e" * 64,
    }

    for record in manifest["puzzles"]:
        path = first_dir / record["path"]
        assert record["path"].endswith(".json.gz")
        assert cd.sha256_bytes(cd.read_data_bytes(path)) == record["sha256"]
        puzzle = cd.load_puzzle_json(path)
        assert len(puzzle["holes"]) == 3
        for hole in puzzle["holes"]:
            assert 100 <= hole["start_rank"] <= 150
        for target in record["targets"]:
            assert target["frequency_band"] in ("common", "difficult")
            assert target["slug"]

    # Determinism: identical bytes for every puzzle, identical manifests minus time.
    for record in manifest["puzzles"]:
        assert (first_dir / record["path"]).read_bytes() == (
            second_dir / record["path"]
        ).read_bytes()
    for key in ("puzzles", "balance", "vocabulary", "seed"):
        assert manifest[key] == again[key]
    assert manifest["dataset_content_sha256"] == again["dataset_content_sha256"]
    changed_timestamp = dict(manifest, generated_at="2099-01-01T00:00:00+00:00")
    assert cd.dataset_content_sha256(changed_timestamp) == manifest[
        "dataset_content_sha256"
    ]
    changed_split = json.loads(json.dumps(manifest))
    changed_split["puzzles"][0]["split"] = "holdout"
    assert cd.dataset_content_sha256(changed_split) != manifest[
        "dataset_content_sha256"
    ]

    # The generator output is archived verbatim.
    archived = json.loads(
        (first_dir / "generator-output.json").read_text(encoding="utf-8")
    )
    assert archived["candidates"] == generator_output()["candidates"]


def test_dry_run_reports_without_writing(tmp_path):
    out_dir = tmp_path / "nothing"
    report = build_dataset(
        generator_output(),
        V=V,
        ranking_for=lambda word: [],
        seed=42,
        out_dir=out_dir,
        quotas=QUOTAS,
        canonical_metadata=CANONICAL_METADATA,
        dry_run=True,
    )
    assert report["dry_run"] is True
    assert report["valid_candidates"] == 4
    assert not out_dir.exists()


def test_default_quotas_match_the_issue_dataset_shape():
    quotas = Quotas()
    assert quotas.puzzle_count == 20
    assert quotas.curriculum_count == 15
    assert quotas.holdout_count == 5
    assert quotas.per_pos == {"noun": 15, "adjective": 15, "verb": 15, "adverb": 15}
    assert quotas.per_gender == {"m": 15, "f": 15}
    assert quotas.per_frequency_band == {"common": 30, "difficult": 30}
    assert cd.TARGETS_PER_PUZZLE == 3


COMMITTED_DATASET = (
    Path(__file__).resolve().parent.parent / "datasets" / "strategy-fr-v1"
)


@pytest.mark.skipif(
    not (COMMITTED_DATASET / "manifest.json").exists(),
    reason="committed dataset not built yet",
)
def test_committed_dataset_satisfies_every_invariant():
    manifest = json.loads(
        (COMMITTED_DATASET / "manifest.json").read_text(encoding="utf-8")
    )
    assert manifest["dataset_id"] == "strategy-fr-v1"
    assert manifest["counts"] == {"puzzles": 20, "curriculum": 15, "holdout": 5}
    assert len(manifest["puzzles"]) == 20
    splits = [record["split"] for record in manifest["puzzles"]]
    assert splits == ["curriculum"] * 15 + ["holdout"] * 5

    seen_slugs = set()
    canonical_metadata = cd.load_fr_lexicon()
    for record in manifest["puzzles"]:
        path = COMMITTED_DATASET / record["path"]
        assert record["path"].endswith(".json.gz")
        assert cd.sha256_bytes(cd.read_data_bytes(path)) == record["sha256"]
        puzzle = cd.load_puzzle_json(path)
        assert puzzle["lang"] == "fr"
        assert len(puzzle["holes"]) == 3
        for hole in puzzle["holes"]:
            assert 100 <= hole["start_rank"] <= 150
        for target in record["targets"]:
            assert target["slug"] not in seen_slugs
            seen_slugs.add(target["slug"])
            assert (target["pos"], target["gender"]) in canonical_metadata[
                target["word"]
            ]

    assert manifest["balance"]["verified"]["pos"] == {
        "noun": 15, "adjective": 15, "verb": 15, "adverb": 15
    }
    assert manifest["balance"]["verified"]["gender"] == {"m": 15, "f": 15}
    assert manifest["balance"]["verified"]["frequency_band"] == {
        "common": 30,
        "difficult": 30,
    }
    assert manifest["dataset_content_sha256"] == cd.dataset_content_sha256(manifest)
