"""Deterministic, neutral-only holdout calibration contract (#86)."""

from __future__ import annotations

import copy
import hashlib
import json
import random
from pathlib import Path

import pytest

import calibration_run as cal
import curriculum_dataset as cd
from curriculum_io import read_data_bytes, sha256_bytes, write_deterministic_gzip
import curriculum_run as cr
from slug import slug
import strategy_profiles as sp
from strategy_evidence import build_evidence_packet


def _alpha(index: int) -> str:
    value = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        value = chr(ord("a") + remainder) + value
    return value


def _runs(*tries: int | None) -> list[dict]:
    return [{"tries": value} for value in tries]


def _score_candidate(sonnet: list[int | None], gpt: list[int | None]) -> dict:
    return {
        "candidate_id": "candidate",
        "targets": [],
        "models": [
            {
                "model_id": "claude-sonnet-5",
                "required_runs": len(sonnet),
                "extension": (
                    {"reason": "unstable"} if len(sonnet) == cal.EXTENDED_RUNS else None
                ),
                "runs": _runs(*sonnet),
            },
            {
                "model_id": "gpt-5.6-sol",
                "required_runs": len(gpt),
                "extension": (
                    {"reason": "tier_boundary"}
                    if len(gpt) == cal.EXTENDED_RUNS
                    else None
                ),
                "runs": _runs(*gpt),
            },
        ],
    }


@pytest.mark.parametrize(
    ("score", "tier"),
    [
        (5, "easy"),
        (15, "easy"),
        (16, "medium"),
        (30, "medium"),
        (31, "difficult"),
        (50, "difficult"),
    ],
)
def test_exact_eligibility_and_tier_boundaries_are_inclusive(score, tier):
    summary = cal.summarize_candidate(_score_candidate([score] * 3, [score] * 3))

    assert summary["status"] == "eligible"
    assert summary["difficulty"] == score
    assert summary["tier"] == tier


@pytest.mark.parametrize("score", [4, 51])
def test_model_median_outside_5_through_50_is_rejected(score):
    summary = cal.summarize_candidate(_score_candidate([score] * 3, [10] * 3))

    assert summary["status"] == "rejected"
    assert "median_out_of_range" in {reason["code"] for reason in summary["reasons"]}


def test_any_dnf_or_over_cap_run_rejects_even_when_the_median_would_pass():
    dnf = cal.summarize_candidate(_score_candidate([10, 10, None], [10, 10, 10]))
    over_cap = cal.summarize_candidate(
        _score_candidate([10, 10, cal.CALIBRATION_CAP + 1], [10, 10, 10])
    )

    assert "dnf" in {reason["code"] for reason in dnf["reasons"]}
    assert "over_cap" in {reason["code"] for reason in over_cap["reasons"]}


def test_training_permits_spread_over_20_while_test_rejects_it():
    accepted = cal.summarize_candidate(_score_candidate([5] * 3, [25] * 3))
    training_only = cal.summarize_candidate(_score_candidate([5] * 3, [26] * 3))

    assert accepted["status"] == "eligible"
    assert accepted["model_median_spread"] == 20
    assert accepted["training_eligible"] is accepted["test_eligible"] is True
    assert training_only["status"] == "eligible"
    assert training_only["training_eligible"] is True
    assert training_only["test_eligible"] is False
    assert training_only["model_median_spread"] == 21
    assert "reasons" not in training_only


def test_five_run_extension_uses_the_actual_dnf_aware_five_run_median():
    summary = cal.summarize_candidate(
        _score_candidate([5, 10, 15, 40, 50], [6, 11, 16, 41, 49])
    )

    assert summary["model_medians"] == {
        "claude-sonnet-5": 15,
        "gpt-5.6-sol": 16,
    }
    assert summary["difficulty"] == 16
    assert summary["tier"] == "medium"


def _balanced_targets(
    prefix: str,
    *,
    low_pos: str = "adverb",
    common_high: bool = True,
    tangible_high: bool = True,
) -> list[dict]:
    positions = list(cd.POS_VALUES) * 4
    positions.pop(len(positions) - 1 - list(reversed(positions)).index(low_pos))
    gender_index = 0
    targets = []
    for index, pos in enumerate(positions):
        word = f"mot{prefix}{_alpha(index)}"
        gender = None
        if pos in cd.GENDERED_POS:
            gender = cd.GENDER_VALUES[gender_index % 2]
            gender_index += 1
        targets.append(
            {
                "word": word,
                "slug": slug(word),
                "pos": pos,
                "gender": gender,
                "frequency_rank": index,
                "frequency_band": (
                    "common"
                    if (index < 8 if common_high else index < 7)
                    else "difficult"
                ),
                "semantic_class": (
                    "tangible" if ((index % 2 == 0) == tangible_high) else "abstract"
                ),
                "start": f"indice{prefix}{_alpha(index)}",
                "start_rank": 120,
            }
        )
    return targets


def _eligible_selection_world() -> list[dict]:
    difficulties = {"easy": 10, "medium": 20, "difficult": 40}
    low_positions = {"easy": "adverb", "medium": "verb", "difficult": "adjective"}
    candidates = []
    for tier_index, tier in enumerate(cal.TIER_ORDER):
        for batch in range(2):
            prefix = f"{tier[0]}{_alpha(batch)}"
            targets = _balanced_targets(
                prefix,
                low_pos=low_positions[tier],
                common_high=tier_index != 1,
                tangible_high=tier_index != 1,
            )
            for index in range(cal.TIER_QUOTA):
                candidate = {
                    "candidate_id": hashlib.sha256(
                        f"{tier}:{batch}:{index}".encode()
                    ).hexdigest(),
                    "pool_index": len(candidates) + 1,
                    "targets": targets[index * 3 : index * 3 + 3],
                    "models": [],
                    "summary": {
                        "status": "eligible",
                        "eligible": True,
                        "training_eligible": True,
                        "test_eligible": True,
                        "model_medians": {
                            "claude-sonnet-5": difficulties[tier],
                            "gpt-5.6-sol": difficulties[tier],
                        },
                        "model_median_spread": 0,
                        "difficulty": difficulties[tier],
                        "tier": tier,
                    },
                }
                candidates.append(candidate)
    return candidates


def test_joint_selection_is_deterministic_disjoint_5_plus_5_per_tier_and_balanced():
    candidates = _eligible_selection_world()
    first = cal.select_calibrated_candidates(
        candidates, reserved_slugs={"curriculum"}, selection_salt="pool"
    )
    shuffled = list(candidates)
    random.Random(86).shuffle(shuffled)
    second = cal.select_calibrated_candidates(
        shuffled, reserved_slugs={"curriculum"}, selection_salt="pool"
    )

    assert first == second
    assert first["status"] == "selected"
    assert first["rule_version"] == "2"
    assert first["counts"] == {
        role: {tier: 5 for tier in cal.TIER_ORDER}
        for role in ("training", "test")
    }
    assert len(first["selected_training"]) == len(first["selected_test"]) == 15
    assert not (
        {row["candidate_id"] for row in first["selected_training"]}
        & {row["candidate_id"] for row in first["selected_test"]}
    )
    assert first["balance_constraint"]["maximum_category_count_spread"] == 1
    assert first["automatic_relaxation"] is False
    for role in ("training", "test"):
        for scope in [
            *first["balance"][role]["tiers"].values(),
            first["balance"][role]["overall"],
        ]:
            assert all(field["spread"] <= 1 for field in scope.values())


def test_selection_fails_with_explicit_tier_and_balance_shortfalls():
    candidates = _eligible_selection_world()
    insufficient = cal.select_calibrated_candidates(
        candidates[:-1], reserved_slugs=set(), selection_salt="pool"
    )
    assert insufficient["status"] == "shortfall"
    assert insufficient["reason"] == "insufficient_eligible_candidates"
    assert insufficient["tier_deficits"]["training_total"]["difficult"] == 1

    unbalanced = copy.deepcopy(candidates)
    difficult = [
        candidate
        for candidate in unbalanced
        if candidate["summary"]["tier"] == "difficult"
    ]
    target = next(
        target
        for candidate in difficult
        for target in candidate["targets"]
        if target["pos"] == "adverb"
    )
    target["pos"] = "noun"
    target["gender"] = "m"
    no_balance = cal.select_calibrated_candidates(
        unbalanced, reserved_slugs=set(), selection_salt="pool"
    )
    assert no_balance["status"] == "shortfall"
    assert no_balance["reason"] == "no_balanced_unique_selection"
    assert no_balance["rule_version"] == "2"
    assert "selected_training" not in no_balance
    assert no_balance["automatic_relaxation"] is False

    colliding = cal.select_calibrated_candidates(
        candidates,
        reserved_slugs={candidates[0]["targets"][0]["slug"]},
        selection_salt="pool",
    )
    assert colliding["status"] == "shortfall"
    assert colliding["reason"] == "no_balanced_unique_selection"


def test_cohort_report_classifies_every_completed_candidate_deterministically():
    candidates = copy.deepcopy(_eligible_selection_world())
    for pool_index, candidate in enumerate(candidates, start=1):
        candidate.update(
            pool_index=pool_index,
            path=f"puzzles/candidates/{candidate['candidate_id']}.json.gz",
            sha256=f"{pool_index:064x}",
        )
        candidate["models"] = [
            {
                "model_id": model_id,
                "required_runs": cal.INITIAL_RUNS,
                "runs": _runs(*([median] * cal.INITIAL_RUNS)),
            }
            for model_id, median in candidate["summary"]["model_medians"].items()
        ]

    extra_eligible = copy.deepcopy(candidates[0])
    extra_eligible["candidate_id"] = hashlib.sha256(b"extra-eligible").hexdigest()
    extra_eligible["pool_index"] = len(candidates) + 1
    extra_eligible["path"] = (
        f"puzzles/candidates/{extra_eligible['candidate_id']}.json.gz"
    )
    extra_eligible["sha256"] = "e" * 64
    for index, target in enumerate(extra_eligible["targets"]):
        target["word"] = f"supplement{_alpha(index)}"
        target["slug"] = slug(target["word"])
    candidates.append(extra_eligible)

    training_only = _score_candidate([5] * 3, [26] * 3)
    training_only.update(
        candidate_id=hashlib.sha256(b"spread-only").hexdigest(),
        pool_index=len(candidates) + 1,
        path="puzzles/candidates/spread-only.json.gz",
        sha256="f" * 64,
    )
    training_only["summary"] = cal.summarize_candidate(training_only)
    candidates.append(training_only)

    cap_stress = _score_candidate([10, 10, None], [10] * 3)
    cap_stress.update(
        candidate_id=hashlib.sha256(b"cap-stress").hexdigest(),
        pool_index=len(candidates) + 1,
        path="puzzles/candidates/cap-stress.json.gz",
        sha256="a" * 64,
    )
    cap_stress["summary"] = cal.summarize_candidate(cap_stress)
    candidates.append(cap_stress)

    first = cal.select_calibrated_candidates(
        candidates, reserved_slugs={"curriculum"}, selection_salt="pool"
    )
    shuffled = list(candidates)
    random.Random(8600).shuffle(shuffled)
    second = cal.select_calibrated_candidates(
        shuffled, reserved_slugs={"curriculum"}, selection_salt="pool"
    )

    assert first == second
    report = first["cohort_report"]
    assert report["total_candidates"] == len(candidates)
    assert report["counts"] == {
        "selected_training": 15,
        "selected_test": 15,
        "eligible_unselected": 1,
        "training_only_spread": 1,
        "cap_stress": 1,
    }
    assert sum(report["counts"].values()) == len(candidates)
    for rows in report["cohorts"].values():
        assert [row["pool_index"] for row in rows] == sorted(
            row["pool_index"] for row in rows
        )

    spread_row = report["cohorts"]["training_only_spread"][0]
    assert spread_row["candidate_id"] == training_only["candidate_id"]
    assert spread_row["pool_index"] == training_only["pool_index"]
    assert spread_row["path"] == training_only["path"]
    assert spread_row["sha256"] == training_only["sha256"]
    assert spread_row["model_medians"] == {
        "claude-sonnet-5": 5,
        "gpt-5.6-sol": 26,
    }
    assert spread_row["model_median_spread"] == 21
    assert spread_row["model_run_counts"] == {
        "claude-sonnet-5": 3,
        "gpt-5.6-sol": 3,
    }
    assert spread_row["rejection_reasons"] == []

    stress_row = report["cohorts"]["cap_stress"][0]
    assert stress_row["candidate_id"] == cap_stress["candidate_id"]
    assert {reason["code"] for reason in stress_row["rejection_reasons"]} == {
        "dnf",
    }


def test_cohort_report_rejects_malformed_scores_instead_of_classifying_them():
    candidates = _eligible_selection_world()
    malformed = _score_candidate([0, 10, 10], [10] * 3)
    malformed["candidate_id"] = hashlib.sha256(b"malformed").hexdigest()
    malformed["summary"] = cal.summarize_candidate(malformed)
    candidates.append(malformed)

    with pytest.raises(cal.CalibrationError, match="malformed calibration score"):
        cal.select_calibrated_candidates(
            candidates, reserved_slugs=set(), selection_salt="pool"
        )


def _puzzle(words: list[str], starts: list[str] | None = None) -> dict:
    ranks = {}
    holes = []
    for index, word in enumerate(words):
        secret = slug(word)
        start_word = starts[index] if starts is not None else f"depart{_alpha(index)}"
        rank_map = {
            slug(other): {
                "word": other,
                "rank": 0 if other == word else 10 + other_index,
            }
            for other_index, other in enumerate(words)
        }
        rank_map[slug(start_word)] = {"word": start_word, "rank": 120}
        ranks[secret] = rank_map
        holes.append(
            {
                "pos": index,
                "secret": {"word": word, "slug": secret},
                "start": {"word": start_word, "slug": slug(start_word)},
                "start_rank": 120,
            }
        )
    return {"lang": "fr", "words": words, "holes": holes, "ranks": ranks}


def _write_puzzle(path: Path, puzzle: dict) -> str:
    content = (json.dumps(puzzle, ensure_ascii=False, indent=2) + "\n").encode()
    write_deterministic_gzip(path, content)
    return sha256_bytes(content)


def _target_metadata(words: list[str], prefix: str) -> list[dict]:
    rows = []
    for index, word in enumerate(words):
        pos = cd.POS_VALUES[index % len(cd.POS_VALUES)]
        rows.append(
            {
                "word": word,
                "slug": slug(word),
                "pos": pos,
                "gender": "m" if pos in cd.GENDERED_POS else None,
                "frequency_rank": index,
                "frequency_band": "common" if index % 2 == 0 else "difficult",
                "semantic_class": "tangible" if index % 2 == 0 else "abstract",
                "start": f"depart{_alpha(index)}",
                "start_rank": 120,
            }
        )
    return rows


def _write_pool(
    root: Path,
    *,
    curriculum_records: list[dict],
    candidate_records: list[dict],
    minimum_candidates: int,
) -> Path:
    generator_bytes = b'{"generator":"scripted"}\n'
    (root / "generator-output.json").write_bytes(generator_bytes)
    records = curriculum_records + candidate_records
    manifest = {
        "schema_version": cd.CALIBRATION_POOL_SCHEMA_VERSION,
        "manifest_kind": cd.CALIBRATION_POOL_KIND,
        "dataset_id": "strategy-fr-calibrated-test",
        "lang": "fr",
        "seed": 86,
        "curriculum_base": {
            "dataset_id": "base",
            "dataset_content_sha256": "b" * 64,
            "manifest_sha256": "m" * 64,
        },
        "generator": {"model": "scripted"},
        "generator_output": {
            "path": "generator-output.json",
            "sha256": sha256_bytes(generator_bytes),
        },
        "vocabulary": {"source": "test", "size": 100, "sha256": "v" * 64},
        "embedding": {"source": "test.vec", "sha256": "e" * 64},
        "canonical_metadata": {
            "source": "test.tsv",
            "sha256": "l" * 64,
            "verified_fields": ["pos", "gender"],
            "declared_fields": ["semantic_class"],
        },
        "frequency_bands": {"common": "test", "difficult": "test"},
        "start_band": {"lo": 100, "hi": 150},
        "minimum_calibration_candidates": minimum_candidates,
        "counts": {
            "curriculum": len(curriculum_records),
            "calibration_candidates": len(candidate_records),
            "puzzles": len(records),
        },
        "balance": {
            "curriculum": cd._counts_for_records(curriculum_records),
            "calibration_candidates": cd._counts_for_records(candidate_records),
        },
        "rejections": [],
        "puzzles": records,
        "generated_at": "2026-07-15T00:00:00+00:00",
    }
    manifest["candidate_pool_content_sha256"] = cd.calibration_pool_content_sha256(
        manifest
    )
    path = root / "candidate-manifest.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return path


def _runner_pool(
    tmp_path: Path,
    *,
    curriculum_count: int = cd.CURRICULUM_COUNT,
    candidate_count: int = cd.MIN_CALIBRATION_CANDIDATES,
    minimum_candidates: int = cd.MIN_CALIBRATION_CANDIDATES,
) -> tuple[Path, list[str], set[str]]:
    root = tmp_path / "pool"
    curriculum = []
    candidates = []
    candidate_words_by_id = {}
    vocab = {slug(f"depart{_alpha(index)}") for index in range(3)}
    word_counter = 0
    for number in range(1, curriculum_count + 1):
        words = [f"cours{_alpha(word_counter + offset)}" for offset in range(3)]
        word_counter += 3
        relative = f"puzzles/curriculum-{number:03d}.json.gz"
        sha = _write_puzzle(root / relative, _puzzle(words))
        curriculum.append(
            {
                "number": number,
                "split": "curriculum",
                "path": relative,
                "sha256": sha,
                "sentence": " ".join(words),
                "targets": _target_metadata(words, f"curriculum{number}"),
            }
        )
        vocab.update(map(slug, words))
    for pool_index in range(1, candidate_count + 1):
        words = [f"cible{_alpha(word_counter + offset)}" for offset in range(3)]
        word_counter += 3
        sentence = " ".join(words)
        candidate_id = hashlib.sha256(sentence.encode()).hexdigest()
        relative = f"puzzles/candidate-{pool_index:03d}.json.gz"
        sha = _write_puzzle(root / relative, _puzzle(words))
        candidates.append(
            {
                "candidate_id": candidate_id,
                "pool_index": pool_index,
                "split": cd.CALIBRATION_CANDIDATE_SPLIT,
                "path": relative,
                "sha256": sha,
                "sentence": sentence,
                "targets": _target_metadata(words, f"candidate{pool_index}"),
            }
        )
        candidate_words_by_id[candidate_id] = words
        vocab.update(map(slug, words))
    path = _write_pool(
        root,
        curriculum_records=curriculum,
        candidate_records=candidates,
        minimum_candidates=minimum_candidates,
    )
    first_candidate_id = candidates[0]["candidate_id"]
    return path, candidate_words_by_id[first_candidate_id], vocab


def _sequential_pool(
    tmp_path: Path, *, force_shortfall: bool = False
) -> tuple[Path, dict[str, int], set[str]]:
    """Frozen 30-feasible-prefix pool plus a 15-candidate unneeded suffix."""
    root = tmp_path / "sequential-pool"
    curriculum = []
    vocab: set[str] = set()
    word_counter = 0
    for number in range(1, cd.CURRICULUM_COUNT + 1):
        words = [f"legacy{_alpha(word_counter + offset)}" for offset in range(3)]
        word_counter += 3
        relative = f"puzzles/curriculum-{number:03d}.json.gz"
        sha = _write_puzzle(root / relative, _puzzle(words))
        targets = _target_metadata(words, f"legacy{number}")
        curriculum.append(
            {
                "number": number,
                "split": "curriculum",
                "path": relative,
                "sha256": sha,
                "sentence": " ".join(words),
                "targets": targets,
            }
        )
        vocab.update(slug(word) for word in words)
        vocab.update(slug(target["start"]) for target in targets)

    candidates = []
    scores: dict[str, int] = {}
    for source in _eligible_selection_world():
        targets = copy.deepcopy(source["targets"])
        words = [target["word"] for target in targets]
        sentence = " ".join(words)
        candidate_id = hashlib.sha256(sentence.encode()).hexdigest()
        relative = f"puzzles/candidates/{candidate_id}.json.gz"
        sha = _write_puzzle(
            root / relative,
            _puzzle(words, [target["start"] for target in targets]),
        )
        candidates.append(
            {
                "candidate_id": candidate_id,
                "pool_index": len(candidates) + 1,
                "split": cd.CALIBRATION_CANDIDATE_SPLIT,
                "path": relative,
                "sha256": sha,
                "sentence": sentence,
                "targets": targets,
            }
        )
        scores[slug(words[0])] = source["summary"]["difficulty"]
        vocab.update(slug(word) for word in words)
        vocab.update(slug(target["start"]) for target in targets)

    if force_shortfall:
        last_difficult = next(
            record
            for record in reversed(candidates)
            if scores[slug(record["targets"][0]["word"])] == 40
        )
        scores[slug(last_difficult["targets"][0]["word"])] = 3

    while len(candidates) < cd.MIN_CALIBRATION_CANDIDATES:
        words = [f"suffix{_alpha(word_counter + offset)}" for offset in range(3)]
        word_counter += 3
        sentence = " ".join(words)
        candidate_id = hashlib.sha256(sentence.encode()).hexdigest()
        relative = f"puzzles/candidates/{candidate_id}.json.gz"
        targets = _target_metadata(words, f"suffix{len(candidates)}")
        sha = _write_puzzle(
            root / relative,
            _puzzle(words, [target["start"] for target in targets]),
        )
        candidates.append(
            {
                "candidate_id": candidate_id,
                "pool_index": len(candidates) + 1,
                "split": cd.CALIBRATION_CANDIDATE_SPLIT,
                "path": relative,
                "sha256": sha,
                "sentence": sentence,
                "targets": targets,
            }
        )
        scores[slug(words[0])] = 3
        vocab.update(slug(word) for word in words)
        vocab.update(slug(target["start"]) for target in targets)

    return (
        _write_pool(
            root,
            curriculum_records=curriculum,
            candidate_records=candidates,
            minimum_candidates=cd.MIN_CALIBRATION_CANDIDATES,
        ),
        scores,
        vocab,
    )


def _scripted_paid_unit(scores: dict[str, int], calls: list[str]):
    def play_once(*, puzzle, **_kwargs):
        secret = puzzle["holes"][0]["secret"]["slug"]
        calls.append(secret)
        score = scores[secret]
        return {
            "tries": score,
            "counted_tries": score,
            "turns": score,
            "duration": 0.0,
            "wall_duration": 0.0,
            "tried_words": [f"guess{index}" for index in range(score)],
            "conversation": [
                {"role": "user", "content": "fixed neutral prompt"},
                {"role": "assistant", "content": "guess"},
            ],
            "turn_token_usage": [{"input_tokens": 1, "output_tokens": 1}],
            "metrics": {"solved": True},
            "termination_reason": "solved",
        }

    return play_once


class ScriptedProvider:
    def __init__(self, words: list[str]):
        self.words = words
        self.constructions = []
        self.players = []

    def __call__(self, config, api_key, *, effort, auth, output):
        self.constructions.append(
            {
                "model_id": config["model_id"],
                "provider": config["provider"],
                "api_key": api_key,
                "effort": effort,
                "auth": auth,
                "output": output,
            }
        )
        assert output == "word"
        replies = iter(self.words)
        calls = []

        def player(messages):
            calls.append(copy.deepcopy(messages))
            player.last_token_usage = {"input_tokens": 3, "output_tokens": 1}
            return next(replies)

        player.last_token_usage = None
        player.calls = calls
        self.players.append(player)
        return player


def test_dry_run_plans_fixed_roster_and_makes_no_provider_or_vocab_calls(tmp_path):
    manifest_path, _words, _vocab = _runner_pool(tmp_path)

    def explode(*_args, **_kwargs):
        raise AssertionError("dry-run made an external call")

    plan = cal.run_calibration(
        manifest_path,
        artifact_path=tmp_path / "never-written.json",
        maximum_units=1,
        dry_run=True,
        provider_factory=explode,
        vocab_loader=explode,
    )

    assert plan["provider_calls"] == 0
    assert [row["model_id"] for row in plan["config"]["roster"]] == list(
        cal.ROSTER_MODEL_IDS
    )
    assert plan["config"]["effort"] == "medium"
    assert plan["config"]["cap"] == 75
    assert plan["config"]["initial_runs_per_model"] == 3
    assert plan["completed_paid_units"] == 0
    assert plan["minimum_initial_paid_units"] == 30 * 2 * 3
    assert plan["maximum_initial_paid_units"] == 45 * 2 * 3
    assert plan["completed_prefix_count"] == 0
    assert plan["next_candidate"]["pool_index"] == 1
    assert plan["pending_paid_units"] == 2 * 3
    assert plan["execution_model_filter"] is None
    assert plan["execution_prefetch_through_pool_index"] is None
    assert plan["filtered_pending_paid_units"] == 2 * 3
    assert plan["maximum_remaining_paid_units"] == 45 * 2 * 3
    assert len(plan["planned_paid_units"]) == 1
    assert not (tmp_path / "never-written.json").exists()


def test_model_filter_dry_run_prefetches_only_the_guaranteed_gpt_prefix(
    tmp_path,
):
    manifest_path, _words, _vocab = _runner_pool(tmp_path)

    def explode(*_args, **_kwargs):
        raise AssertionError("filtered dry-run made an external call")

    plan = cal.run_calibration(
        manifest_path,
        artifact_path=tmp_path / "never-written.json",
        maximum_units=10,
        model_selector="GPT-SOL",
        dry_run=True,
        provider_factory=explode,
        vocab_loader=explode,
    )

    assert [row["model_id"] for row in plan["config"]["roster"]] == list(
        cal.ROSTER_MODEL_IDS
    )
    assert plan["pending_paid_units"] == 6
    assert plan["execution_model_filter"] == "gpt-5.6-sol"
    assert plan["execution_prefetch_through_pool_index"] == cal.SELECTED_TOTAL
    assert plan["filtered_pending_paid_units"] == cal.SELECTED_TOTAL * 3
    assert [
        (unit["pool_index"], unit["model_id"], unit["run_number"])
        for unit in plan["planned_paid_units"]
    ] == [
        (1, "gpt-5.6-sol", 1),
        (1, "gpt-5.6-sol", 2),
        (1, "gpt-5.6-sol", 3),
        (2, "gpt-5.6-sol", 1),
        (2, "gpt-5.6-sol", 2),
        (2, "gpt-5.6-sol", 3),
        (3, "gpt-5.6-sol", 1),
        (3, "gpt-5.6-sol", 2),
        (3, "gpt-5.6-sol", 3),
        (4, "gpt-5.6-sol", 1),
    ]
    assert all(
        unit["pool_index"] <= cal.SELECTED_TOTAL
        for unit in plan["planned_paid_units"]
    )
    assert not (tmp_path / "never-written.json").exists()


@pytest.mark.parametrize("selector", ["OPUS", "gpt-unknown"])
def test_model_filter_rejects_non_roster_or_unknown_selectors_before_writes(
    tmp_path, selector
):
    manifest_path, _words, _vocab = _runner_pool(tmp_path)
    artifact = tmp_path / "never-written.json"

    with pytest.raises(cal.CalibrationError, match="fixed calibration roster"):
        cal.run_calibration(
            manifest_path,
            artifact_path=artifact,
            maximum_units=1,
            model_selector=selector,
            dry_run=True,
        )

    assert not artifact.exists()


def test_frozen_pool_index_order_drives_processing_even_if_manifest_rows_are_shuffled(
    tmp_path,
):
    manifest_path, _words, _vocab = _runner_pool(tmp_path)
    manifest = json.loads(manifest_path.read_text())
    curriculum = [row for row in manifest["puzzles"] if row["split"] == "curriculum"]
    candidates = [
        row
        for row in manifest["puzzles"]
        if row["split"] == cd.CALIBRATION_CANDIDATE_SPLIT
    ]
    manifest["puzzles"] = curriculum + list(reversed(candidates))
    manifest["candidate_pool_content_sha256"] = cd.calibration_pool_content_sha256(
        manifest
    )
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

    loaded, content_sha, manifest_sha = cal.load_candidate_pool(manifest_path)
    state = cal.new_artifact_state(
        manifest_path.resolve(), loaded, content_sha, manifest_sha, auth="api"
    )

    assert [row["pool_index"] for row in state["candidates"]] == list(
        range(1, len(candidates) + 1)
    )
    assert state["candidate_pool"]["candidate_order"] == [
        row["candidate_id"] for row in sorted(candidates, key=lambda row: row["pool_index"])
    ]
    assert state["checkpoint"]["next_pool_index"] == 1


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        ("sentence", "sentence does not match puzzle words"),
        ("target_slug", "target slugs do not match puzzle secrets"),
        ("secret_word", "secret metadata does not match"),
        ("start_word", "start metadata does not match"),
        ("start_rank", "start rank metadata does not match"),
        ("rank_map", "start rank-map parity does not match"),
    ],
)
def test_paid_loader_binds_manifest_metadata_to_puzzle_content(
    tmp_path, mutation, message
):
    manifest_path, _words, _vocab = _runner_pool(tmp_path)
    manifest = json.loads(manifest_path.read_text())
    candidate = next(
        row
        for row in manifest["puzzles"]
        if row["split"] == cd.CALIBRATION_CANDIDATE_SPLIT
    )
    target = candidate["targets"][0]
    if mutation == "sentence":
        candidate["sentence"] += " falsifie"
        candidate["candidate_id"] = hashlib.sha256(
            candidate["sentence"].encode()
        ).hexdigest()
    elif mutation == "target_slug":
        target["slug"] = "cible-falsifiee"
    elif mutation == "secret_word":
        target["word"] = "cible-falsifiee"
    elif mutation == "start_word":
        target["start"] = "depart-falsifie"
    elif mutation == "start_rank":
        target["start_rank"] += 1
    else:
        puzzle_path = manifest_path.parent / candidate["path"]
        puzzle = json.loads(read_data_bytes(puzzle_path))
        hole = puzzle["holes"][0]
        rank_entry = puzzle["ranks"][hole["secret"]["slug"]][hole["start"]["slug"]]
        rank_entry["rank"] += 1
        candidate["sha256"] = _write_puzzle(puzzle_path, puzzle)
    manifest["candidate_pool_content_sha256"] = cd.calibration_pool_content_sha256(
        manifest
    )
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    with pytest.raises(cal.CalibrationError, match=message):
        cal.load_candidate_pool(manifest_path)


def test_completed_prefix_advances_only_after_both_models_finish():
    candidate = _score_candidate([10] * 3, [])
    candidate["candidate_id"] = "first"
    candidate["pool_index"] = 1
    candidate["path"] = "first.json.gz"
    candidate["sha256"] = "a" * 64
    candidate["sentence"] = "first"
    candidate["targets"] = _balanced_targets("prefix")[:3]
    candidate["models"][1]["required_runs"] = cal.INITIAL_RUNS
    state = {
        "config": {"candidate_pool_content_sha256": "pool"},
        "candidate_pool": {"reserved_target_slugs": []},
        "checkpoint": {"sequence": 3, "completed_paid_units": 3},
        "candidates": [candidate],
        "selection": {"status": "pending"},
    }

    cal._refresh_derived(state)
    assert state["checkpoint"]["completed_prefix_count"] == 0
    assert state["candidates"][0]["summary"]["status"] == "pending"

    candidate["models"][1]["runs"] = _runs(10, 10, 10)
    state["checkpoint"].update(sequence=6, completed_paid_units=6)
    cal._refresh_derived(state)
    assert state["checkpoint"]["completed_prefix_count"] == 1
    assert state["selection"]["status"] == "shortfall"


def test_prefetched_work_is_allowed_only_inside_the_guaranteed_minimum_prefix(
    tmp_path,
):
    manifest_path, _words, _vocab = _runner_pool(tmp_path)
    manifest, content_sha, manifest_sha = cal.load_candidate_pool(manifest_path)
    state = cal.new_artifact_state(
        manifest_path.resolve(), manifest, content_sha, manifest_sha, auth="api"
    )

    state["candidates"][cal.SELECTED_TOTAL - 1]["models"][1]["runs"] = _runs(10)
    cal._refresh_derived(state)
    assert state["checkpoint"]["completed_prefix_count"] == 0
    assert (
        state["candidates"][cal.SELECTED_TOTAL - 1]["summary"]["status"]
        == "pending"
    )

    state["candidates"][cal.SELECTED_TOTAL]["models"][1]["runs"] = _runs(10)
    with pytest.raises(
        cal.CalibrationError,
        match=(
            "paid work beyond guaranteed prefetch frontier 30; candidate 31 "
            "is not yet guaranteed to be needed"
        ),
    ):
        cal._refresh_derived(state)

    state["candidates"][cal.SELECTED_TOTAL]["models"][1]["runs"] = []
    for candidate in state["candidates"][: cal.SELECTED_TOTAL]:
        for model in candidate["models"]:
            model["runs"] = _runs(10, 10, 10)
    cal._refresh_derived(state)
    assert state["checkpoint"]["completed_prefix_count"] == cal.SELECTED_TOTAL
    assert state["selection"]["status"] == "pending"

    state["candidates"][cal.SELECTED_TOTAL]["models"][1]["runs"] = _runs(10)
    cal._refresh_derived(state)
    assert state["candidates"][cal.SELECTED_TOTAL]["summary"]["status"] == "pending"

    state["candidates"][cal.SELECTED_TOTAL + 1]["models"][1]["runs"] = _runs(10)
    with pytest.raises(
        cal.CalibrationError,
        match=(
            "paid work beyond guaranteed prefetch frontier 31; candidate 32 "
            "is not yet guaranteed to be needed"
        ),
    ):
        cal._refresh_derived(state)


def test_first_feasible_prefix_stops_every_suffix_call_and_marks_it_unrun(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "anthropic-test")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-test")
    manifest_path, scores, vocab = _sequential_pool(tmp_path)
    calls: list[str] = []
    monkeypatch.setattr(cal, "_play_once", _scripted_paid_unit(scores, calls))
    artifact = tmp_path / "sequential.json"

    cal.run_calibration(
        manifest_path,
        artifact_path=artifact,
        maximum_units=None,
        vocab_loader=lambda _lang: vocab,
    )
    state = json.loads(artifact.read_text())

    assert state["selection"]["status"] == "selected"
    assert state["selection"]["completed_prefix_count"] == 30
    assert state["selection"]["stopping_pool_index"] == 30
    assert state["selection"]["stopping_checkpoint"] == 30 * 2 * 3
    assert len(calls) == 30 * 2 * 3
    assert state["selection"]["cohort_report"]["unrun_candidates"] == 15
    assert all(
        candidate["summary"] == {"status": "unrun"}
        and not any(model["runs"] for model in candidate["models"])
        for candidate in state["candidates"][30:]
    )
    assert cal._pending_units(state) == []
    with pytest.raises(
        cal.CalibrationError,
        match="can reopen only its stopping candidate",
    ):
        cal.request_extension(
            artifact,
            candidate_selector=state["candidates"][0]["candidate_id"],
            model_selector="SONNET",
            reason="unstable",
        )
    stopping = state["candidates"][state["selection"]["completed_prefix_count"] - 1]
    frozen_selection_sha = state["hashes"]["selection_sha256"]
    frozen_allocation_sha = state["selection"]["allocation_sha256"]
    frozen_checkpoint = state["selection"]["stopping_checkpoint"]

    cal.request_extension(
        artifact,
        candidate_selector=stopping["candidate_id"],
        model_selector="GPT-SOL",
        reason="tier_boundary",
    )
    reopened = json.loads(artifact.read_text())
    extension = reopened["candidates"][29]["models"][1]["extension"]
    assert reopened["selection"]["status"] == "pending"
    assert reopened["checkpoint"]["completed_prefix_count"] == 29
    assert reopened["selection"]["pending_paid_units"] == 2
    assert "completed_at" not in reopened
    assert extension["reason"] == "tier_boundary"
    assert extension["requested_checkpoint"] == frozen_checkpoint
    assert extension["reopened_selection"] == {
        "selection_sha256": frozen_selection_sha,
        "stopping_checkpoint": frozen_checkpoint,
        "allocation_sha256": frozen_allocation_sha,
    }
    assert len(calls) == 30 * 2 * 3


def test_exhausted_pool_fails_with_deterministic_shortfall_and_no_relaxation(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "anthropic-test")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-test")
    manifest_path, scores, vocab = _sequential_pool(tmp_path, force_shortfall=True)
    calls: list[str] = []
    monkeypatch.setattr(cal, "_play_once", _scripted_paid_unit(scores, calls))
    artifact = tmp_path / "shortfall.json"

    cal.run_calibration(
        manifest_path,
        artifact_path=artifact,
        maximum_units=None,
        vocab_loader=lambda _lang: vocab,
        raise_on_shortfall=False,
    )
    state = json.loads(artifact.read_text())

    assert state["selection"]["status"] == "shortfall"
    assert state["selection"]["pool_exhausted"] is True
    assert state["selection"]["automatic_relaxation"] is False
    assert state["selection"]["completed_prefix_count"] == 45
    assert state["selection"]["reason"] == "insufficient_eligible_candidates"
    assert len(calls) == 45 * 2 * 3


def test_main_resolves_package_relative_artifact_destination(
    tmp_path, monkeypatch, capsys
):
    candidate_manifest = tmp_path / "candidate-manifest.json"
    candidate_manifest.write_text("{}\n", encoding="utf-8")
    captured = {}

    def fake_run_calibration(manifest_path, **kwargs):
        captured["manifest_path"] = manifest_path
        captured["artifact_path"] = kwargs["artifact_path"]
        captured["model_selector"] = kwargs["model_selector"]
        return {"dry_run": True}

    monkeypatch.setattr(cal, "run_calibration", fake_run_calibration)
    monkeypatch.chdir(cal.BENCHMARK_DIR.parent.parent)

    assert (
        cal.main(
            [
                "run",
                str(candidate_manifest),
                "--artifact",
                "output/calibration/planned.json",
                "--model",
                "GPT-SOL",
                "--dry-run",
            ]
        )
        == 0
    )
    assert captured == {
        "manifest_path": candidate_manifest,
        "artifact_path": (
            cal.BENCHMARK_DIR / "output/calibration/planned.json"
        ).resolve(),
        "model_selector": "GPT-SOL",
    }
    assert json.loads(capsys.readouterr().out) == {"dry_run": True}


@pytest.mark.parametrize(
    ("curriculum_count", "candidate_count", "minimum_candidates", "message"),
    [
        (14, 45, 45, "exactly 15 curriculum"),
        (15, 44, 44, "at least 45 calibration candidates"),
    ],
)
def test_runner_rejects_undersized_pools_before_any_external_call(
    tmp_path,
    curriculum_count,
    candidate_count,
    minimum_candidates,
    message,
):
    manifest_path, _words, _vocab = _runner_pool(
        tmp_path,
        curriculum_count=curriculum_count,
        candidate_count=candidate_count,
        minimum_candidates=minimum_candidates,
    )

    def explode(*_args, **_kwargs):
        raise AssertionError("invalid pool reached an external call")

    with pytest.raises(cal.CalibrationError, match=message):
        cal.run_calibration(
            manifest_path,
            maximum_units=1,
            provider_factory=explode,
            vocab_loader=explode,
        )


def test_prompt_v21_refuses_to_resume_a_v20_paid_artifact(tmp_path):
    manifest_path, _words, _vocab = _runner_pool(tmp_path)
    manifest, content_sha, manifest_sha = cal.load_candidate_pool(manifest_path)
    state = cal.new_artifact_state(
        manifest_path.resolve(),
        manifest,
        content_sha,
        manifest_sha,
        auth="api",
    )
    state["config"]["prompt_version"] = "20"
    artifact = tmp_path / "v20-calibration.json"
    cal.save_artifact(artifact, state)

    with pytest.raises(
        cal.CalibrationError,
        match=r"configuration changed \(prompt_version\)",
    ):
        cal.run_calibration(
            manifest_path,
            resume=artifact,
            maximum_units=1,
            dry_run=True,
        )


def test_rule_v2_refuses_to_resume_an_exhaustive_rule_v1_artifact(tmp_path):
    manifest_path, _words, _vocab = _runner_pool(tmp_path)
    manifest, content_sha, manifest_sha = cal.load_candidate_pool(manifest_path)
    state = cal.new_artifact_state(
        manifest_path.resolve(), manifest, content_sha, manifest_sha, auth="api"
    )
    state["config"]["calibration_rule_version"] = "1"
    artifact = tmp_path / "rule-v1-calibration.json"
    cal.save_artifact(artifact, state)

    with pytest.raises(
        cal.CalibrationError,
        match=r"configuration changed \(calibration_rule_version\)",
    ):
        cal.run_calibration(
            manifest_path,
            resume=artifact,
            maximum_units=1,
            dry_run=True,
        )


def test_extension_refuses_legacy_rule_and_prompt_artifacts_without_rewriting(
    tmp_path,
):
    manifest_path, _words, _vocab = _runner_pool(tmp_path)
    manifest, content_sha, manifest_sha = cal.load_candidate_pool(manifest_path)
    state = cal.new_artifact_state(
        manifest_path.resolve(), manifest, content_sha, manifest_sha, auth="api"
    )
    state["config"].update(
        artifact_schema_version=1,
        calibration_rule_version="1",
        prompt_version="16",
    )
    artifact = tmp_path / "legacy-calibration.json"
    cal.save_artifact(artifact, state)
    before = artifact.read_bytes()

    with pytest.raises(
        cal.CalibrationError,
        match="extension refuses a legacy or incompatible calibration artifact",
    ):
        cal.request_extension(
            artifact,
            candidate_selector=state["candidates"][0]["candidate_id"],
            model_selector="SONNET",
            reason="unstable",
        )

    assert artifact.read_bytes() == before


def test_checkpointed_resume_repeats_no_completed_paid_run(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "anthropic-test")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-test")
    manifest_path, words, vocab = _runner_pool(tmp_path)
    artifact = tmp_path / "calibration.json"
    first_provider = ScriptedProvider(words)

    result = cal.run_calibration(
        manifest_path,
        artifact_path=artifact,
        maximum_units=1,
        provider_factory=first_provider,
        vocab_loader=lambda _lang: vocab,
    )
    first_state = json.loads(result.read_text())
    first_run = copy.deepcopy(first_state["candidates"][0]["models"][0]["runs"][0])
    replica = tmp_path / "calibration-replica.json"
    cal.run_calibration(
        manifest_path,
        artifact_path=replica,
        maximum_units=1,
        provider_factory=ScriptedProvider(words),
        vocab_loader=lambda _lang: vocab,
    )
    assert json.loads(replica.read_text())["hashes"] == first_state["hashes"]

    resumed_provider = ScriptedProvider(words)
    cal.run_calibration(
        manifest_path,
        resume=artifact,
        maximum_units=1,
        provider_factory=resumed_provider,
        vocab_loader=lambda _lang: vocab,
    )
    resumed = json.loads(artifact.read_text())

    runs = resumed["candidates"][0]["models"][0]["runs"]
    assert runs[0] == first_run
    assert [run["number"] for run in runs] == [1, 2]
    assert [run["checkpoint"] for run in runs] == [1, 2]
    assert resumed["checkpoint"]["completed_paid_units"] == 2
    assert len(first_provider.constructions) == len(resumed_provider.constructions) == 1
    assert all(len(player.calls[0]) == 1 for player in resumed_provider.players)
    assert all(
        "YOUR STRATEGY" not in player.calls[0][0]["content"]
        for player in resumed_provider.players
    )
    calibration_opening = first_provider.players[0].calls[0][0]["content"]
    assert first_state["config"]["prompt_version"] == cal.PROMPT_VERSION == "21"
    assert len(calibration_opening.split()) <= 650
    assert "MANDATORY REPLY CONTRACT" in calibration_opening
    assert "limit of 75 counted tries" in calibration_opening
    assert "Apostrophes are forbidden" in calibration_opening
    assert "Reason privately as needed" in calibration_opening
    assert (
        "multi-step deduction over the CLOZE, ranked clues, and exclusion sets"
        in calibration_opening
    )
    assert "Reply now" not in calibration_opening
    assert (
        "your entire visible reply must be exactly one bare French"
        in calibration_opening
    )
    assert "Singular/plural, masculine/feminine" in calibration_opening
    assert (
        "tested against every unsolved word"
        in calibration_opening
    )
    assert "A valid MISS still counts" in calibration_opening
    for forbidden_strategy in (
        "YOUR METHOD",
        "Choose your own solving method",
        "Decide for yourself how to adapt",
        "counted guess as a costly hypothesis",
    ):
        assert forbidden_strategy not in calibration_opening
    assert runs[1]["model_id"] == "claude-sonnet-5"
    assert runs[1]["provider"] == "anthropic"
    assert runs[1]["transport"] == "api"
    assert runs[1]["auth"] == "api"
    assert runs[1]["effort"] == "medium"
    assert runs[1]["turn_token_usage"]
    assert runs[1]["wall_duration"] >= 0


def test_model_filter_prefetches_next_gpt_then_sonnet_catches_up_same_artifact(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "anthropic-test")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-test")
    manifest_path, words, vocab = _runner_pool(tmp_path)
    artifact = tmp_path / "calibration.json"

    gpt_provider = ScriptedProvider(words)
    cal.run_calibration(
        manifest_path,
        artifact_path=artifact,
        maximum_units=3,
        model_selector="GPT-SOL",
        provider_factory=gpt_provider,
        vocab_loader=lambda _lang: vocab,
    )
    gpt_state = json.loads(artifact.read_text())
    candidate = gpt_state["candidates"][0]
    sonnet, gpt = candidate["models"]

    assert [row["model_id"] for row in gpt_state["config"]["roster"]] == list(
        cal.ROSTER_MODEL_IDS
    )
    assert sonnet["runs"] == []
    assert [run["number"] for run in gpt["runs"]] == [1, 2, 3]
    assert [run["checkpoint"] for run in gpt["runs"]] == [1, 2, 3]
    assert gpt_state["checkpoint"]["completed_prefix_count"] == 0
    assert gpt_state["selection"]["status"] == "pending"
    assert {
        row["model_id"] for row in gpt_state["auth_verifications"][-1]["models"]
    } == set(cal.ROSTER_MODEL_IDS)
    assert {
        construction["model_id"] for construction in gpt_provider.constructions
    } == {"gpt-5.6-sol"}

    pool = json.loads(manifest_path.read_text())
    second_record = next(
        record
        for record in pool["puzzles"]
        if record.get("split") == cd.CALIBRATION_CANDIDATE_SPLIT
        and record["pool_index"] == 2
    )
    second_puzzle = json.loads(
        read_data_bytes(manifest_path.parent / second_record["path"])
    )
    second_words = [hole["secret"]["word"] for hole in second_puzzle["holes"]]
    next_gpt_provider = ScriptedProvider(second_words)
    cal.run_calibration(
        manifest_path,
        resume=artifact,
        maximum_units=3,
        model_selector="GPT-SOL",
        provider_factory=next_gpt_provider,
        vocab_loader=lambda _lang: vocab,
    )
    prefetched = json.loads(artifact.read_text())
    second_sonnet, second_gpt = prefetched["candidates"][1]["models"]

    assert second_sonnet["runs"] == []
    assert [run["number"] for run in second_gpt["runs"]] == [1, 2, 3]
    assert [run["checkpoint"] for run in second_gpt["runs"]] == [4, 5, 6]
    assert prefetched["checkpoint"]["completed_prefix_count"] == 0
    assert prefetched["candidates"][1]["summary"]["status"] == "pending"
    assert {
        construction["model_id"]
        for construction in next_gpt_provider.constructions
    } == {"gpt-5.6-sol"}

    sonnet_provider = ScriptedProvider(words)
    cal.run_calibration(
        manifest_path,
        resume=artifact,
        maximum_units=3,
        model_selector="SONNET",
        provider_factory=sonnet_provider,
        vocab_loader=lambda _lang: vocab,
    )
    completed = json.loads(artifact.read_text())
    sonnet, completed_gpt = completed["candidates"][0]["models"]

    assert [run["number"] for run in sonnet["runs"]] == [1, 2, 3]
    assert [run["checkpoint"] for run in sonnet["runs"]] == [7, 8, 9]
    assert completed_gpt["runs"] == gpt["runs"]
    assert completed["candidates"][1]["models"][1]["runs"] == second_gpt["runs"]
    assert completed["checkpoint"]["completed_paid_units"] == 9
    assert completed["checkpoint"]["completed_prefix_count"] == 1
    assert {
        construction["model_id"] for construction in sonnet_provider.constructions
    } == {"claude-sonnet-5"}
    cal._validate_completed_runs(completed, manifest_path, vocab)


def test_extension_is_offline_auditable_and_adds_exactly_two_pending_runs(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "anthropic-test")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-test")
    manifest_path, words, vocab = _runner_pool(tmp_path)
    artifact = tmp_path / "calibration.json"
    cal.run_calibration(
        manifest_path,
        artifact_path=artifact,
        maximum_units=3,
        provider_factory=ScriptedProvider(words),
        vocab_loader=lambda _lang: vocab,
    )
    before = json.loads(artifact.read_text())
    candidate_id = before["candidates"][0]["candidate_id"]
    pending_before = before["selection"]["pending_paid_units"]

    cal.request_extension(
        artifact,
        candidate_selector=candidate_id,
        model_selector="SONNET",
        reason="unstable",
    )
    state = json.loads(artifact.read_text())
    sonnet = state["candidates"][0]["models"][0]

    assert sonnet["required_runs"] == 5
    assert sonnet["extension"]["reason"] == "unstable"
    assert len(sonnet["runs"]) == 3
    assert state["selection"]["status"] == "pending"
    assert state["selection"]["pending_paid_units"] == pending_before + 2


def test_training_run_projection_keeps_complete_trajectory_without_prompt_snapshots():
    puzzle = _puzzle(["alpha", "beta", "gamma"])
    vocab = {
        slug(word)
        for word in ["alpha", "beta", "gamma", "departa", "departb", "departc"]
    }
    run = cr._play_once(
        puzzle=puzzle,
        vocab=vocab,
        strategy=None,
        config={"model_id": "claude-sonnet-5", "provider": "anthropic"},
        api_key=None,
        play_effort=cal.CALIBRATION_EFFORT,
        auth="api",
        cap=cal.CALIBRATION_CAP,
        provider_factory=ScriptedProvider(
            ["two words", "horsjeu", "alpha", "alpha", "beta", "gamma"]
        ),
        on_try=lambda _progress: None,
    )
    opening = run["conversation"][0]["content"]
    run.update(
        {
            "number": 1,
            "model_id": "claude-sonnet-5",
            "provider": "anthropic",
            "transport": "api",
            "auth": "api",
            "effort": cal.CALIBRATION_EFFORT,
            "cap": cal.CALIBRATION_CAP,
            "opening_prompt_sha256": hashlib.sha256(opening.encode()).hexdigest(),
        }
    )

    compact = cal._training_run_view(run, puzzle=puzzle, vocab=vocab)
    serialized = json.dumps(compact, ensure_ascii=False)

    assert compact["counted_guesses"] == ["alpha", "beta", "gamma"]
    assert [event["kind"] for event in compact["rejected_events"]] == [
        "malformed",
        "invalid",
        "duplicate",
    ]
    assert [event["turn"] for event in compact["rejected_events"]] == [1, 2, 4]
    assert [step["try"] for step in compact["trajectory"]] == [1, 2, 3]
    assert compact["trajectory"][-1]["solved_locks"] == [1, 2, 3]
    assert compact["metrics"]["solved"] is True
    for raw_only in ("conversation", "tried_words", "turn_token_usage"):
        assert raw_only not in compact
    assert "WHIPPIN WORD GAME" not in serialized
    assert len(serialized.encode()) < len(json.dumps(run, ensure_ascii=False).encode())


def test_artifact_and_content_hashes_ignore_wall_clock_noise_but_pin_results():
    base = {
        "config": {"rule": "fixed"},
        "candidate_pool": {
            "manifest_path": "/tmp/pool.json",
            "content_sha256": "p" * 64,
        },
        "started_at": "one",
        "auth_verifications": [{"verified_at": "one", "status": "ok"}],
        "checkpoint": {"sequence": 1, "completed_paid_units": 1, "updated_at": "one"},
        "candidates": [
            {
                "candidate_id": "c",
                "models": [
                    {
                        "model_id": "m",
                        "runs": [
                            {
                                "tries": 10,
                                "duration": 1.0,
                                "wall_duration": 2.0,
                                "completed_at": "one",
                            }
                        ],
                    }
                ],
            }
        ],
        "selection": {"status": "selected", "selected": ["c"]},
    }
    noisy = copy.deepcopy(base)
    noisy["started_at"] = "two"
    noisy["candidate_pool"]["manifest_path"] = "/another-machine/pool.json"
    noisy["checkpoint"]["updated_at"] = "two"
    noisy["candidates"][0]["models"][0]["runs"][0].update(
        duration=99.0, wall_duration=100.0, completed_at="two"
    )
    cal.update_artifact_hashes(base)
    cal.update_artifact_hashes(noisy)

    assert base["hashes"] == noisy["hashes"]
    changed = copy.deepcopy(base)
    changed["candidates"][0]["models"][0]["runs"][0]["tries"] = 11
    cal.update_artifact_hashes(changed)
    assert changed["hashes"]["content_sha256"] != base["hashes"]["content_sha256"]


def _large_complete_pool(tmp_path: Path) -> tuple[Path, Path, str, set[str]]:
    root = tmp_path / "large-pool"
    curriculum = []
    word_counter = 0
    for number in range(1, 16):
        words = [f"cours{_alpha(word_counter + offset)}" for offset in range(3)]
        word_counter += 3
        relative = f"puzzles/curriculum-{number:03d}.json.gz"
        sha = _write_puzzle(root / relative, _puzzle(words))
        curriculum.append(
            {
                "number": number,
                "split": "curriculum",
                "path": relative,
                "sha256": sha,
                "sentence": " ".join(words),
                "targets": _target_metadata(words, f"curriculum{number}"),
            }
        )

    candidates = []
    difficulty: dict[str, int] = {}
    candidate_words: dict[str, list[str]] = {}
    selected_canary = ""
    vocab = {
        slug(target["word"])
        for record in curriculum
        for target in record["targets"]
    } | {
        slug(target["start"])
        for record in curriculum
        for target in record["targets"]
    }
    low_positions = {"easy": "adverb", "medium": "verb", "difficult": "adjective"}
    for tier_index, tier in enumerate(cal.TIER_ORDER):
        balanced = []
        for batch in range(2):
            balanced.extend(
                _balanced_targets(
                    f"z{_alpha(tier_index)}{_alpha(batch)}",
                    low_pos=low_positions[tier],
                    common_high=tier_index != 1,
                    tangible_high=tier_index != 1,
                )
            )
        for local_index in range(15):
            if local_index < 10:
                targets = copy.deepcopy(balanced[local_index * 3 : local_index * 3 + 3])
                score = {"easy": 10, "medium": 20, "difficult": 40}[tier]
            else:
                targets = []
                for target_index in range(3):
                    word = f"reserve{_alpha(word_counter)}"
                    word_counter += 1
                    targets.append(
                        {
                            "word": word,
                            "slug": slug(word),
                            "pos": cd.POS_VALUES[target_index],
                            "gender": "m" if target_index < 2 else None,
                            "frequency_rank": word_counter,
                            "frequency_band": (
                                "common" if target_index % 2 == 0 else "difficult"
                            ),
                            "semantic_class": (
                                "tangible" if target_index % 2 == 0 else "abstract"
                            ),
                            "start": f"indice{_alpha(word_counter)}",
                            "start_rank": 120,
                        }
                    )
                score = 3
            words = [target["word"] for target in targets]
            sentence = " ".join(words)
            candidate_id = hashlib.sha256(sentence.encode()).hexdigest()
            relative = f"puzzles/candidates/{candidate_id}.json.gz"
            sha = _write_puzzle(
                root / relative,
                _puzzle(words, [target["start"] for target in targets]),
            )
            candidates.append(
                {
                    "candidate_id": candidate_id,
                    "pool_index": len(candidates) + 1,
                    "split": cd.CALIBRATION_CANDIDATE_SPLIT,
                    "path": relative,
                    "sha256": sha,
                    "sentence": sentence,
                    "targets": targets,
                }
            )
            difficulty[candidate_id] = score
            candidate_words[candidate_id] = words
            vocab.update(slug(target["word"]) for target in targets)
            vocab.update(slug(target["start"]) for target in targets)

    pool_path = _write_pool(
        root,
        curriculum_records=curriculum,
        candidate_records=candidates,
        minimum_candidates=45,
    )
    manifest, content_sha, manifest_sha = cal.load_candidate_pool(pool_path)
    state = cal.new_artifact_state(
        pool_path.resolve(), manifest, content_sha, manifest_sha, auth="api"
    )
    checkpoint = 0
    for candidate in state["candidates"]:
        score = difficulty[candidate["candidate_id"]]
        words = candidate_words[candidate["candidate_id"]]
        filler_prefix = "".join(
            char for char in candidate["candidate_id"] if char.isalpha()
        )[:8]
        filler_words = [
            f"essai{filler_prefix}{_alpha(index)}"
            for index in range(score - len(words))
        ]
        guesses = filler_words + words
        vocab.update(map(slug, filler_words))
        puzzle = cd.load_puzzle_json(pool_path.parent / candidate["path"])
        template = cr._play_once(
            puzzle=puzzle,
            vocab=vocab,
            strategy=None,
            config={
                "model_id": candidate["models"][0]["model_id"],
                "provider": candidate["models"][0]["provider"],
            },
            api_key=None,
            play_effort=cal.CALIBRATION_EFFORT,
            auth="api",
            cap=cal.CALIBRATION_CAP,
            provider_factory=ScriptedProvider(guesses),
            on_try=lambda _progress: None,
        )
        for model in candidate["models"]:
            model["runs"] = []
            for run_number in range(1, 4):
                checkpoint += 1
                run = copy.deepcopy(template)
                opening = run["conversation"][0]["content"]
                run.update(
                    {
                        "number": run_number,
                        "model_id": model["model_id"],
                        "provider": model["provider"],
                        "transport": model["transport"],
                        "auth": model["auth"],
                        "effort": model["effort"],
                        "cap": cal.CALIBRATION_CAP,
                        "opening_prompt_sha256": hashlib.sha256(
                            opening.encode()
                        ).hexdigest(),
                        "checkpoint": checkpoint,
                        "completed_at": "2026-07-15T00:00:00+00:00",
                    }
                )
                model["runs"].append(run)
        state["checkpoint"].update(
            {
                "sequence": checkpoint,
                "completed_paid_units": checkpoint,
                "updated_at": "2026-07-15T00:00:00+00:00",
            }
        )
        cal._refresh_derived(state)
        if state["selection"]["status"] == "selected":
            break
    state["auth_verifications"] = [
        {
            "verified_at": "2026-07-15T00:00:00+00:00",
            "models": [
                {
                    "model_id": model["model_id"],
                    "mode": model["auth"],
                    "status": "verified_key_present",
                }
                for model in state["config"]["roster"]
            ],
        }
    ]
    assert state["selection"]["status"] == "selected"
    selected_test_id = state["selection"]["selected_test"][0]["candidate_id"]
    selected_canary = candidate_words[selected_test_id][0]
    state["completed_at"] = "2026-07-15T00:00:00+00:00"
    artifact = tmp_path / "complete-calibration.json"
    cal.save_artifact(artifact, state)
    return pool_path, artifact, selected_canary, vocab


def _tree_bytes(root: Path) -> dict[str, bytes]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in root.rglob("*")
        if path.is_file()
    }


def test_finalization_path_plan_resolves_and_rejects_every_role_collision(tmp_path):
    pool_path = tmp_path / "candidate-manifest.json"
    artifact_path = tmp_path / "paid-artifact.json"
    generator_path = tmp_path / "generator-output.json"
    puzzle_path = tmp_path / "puzzles" / "candidate.json.gz"
    puzzle_path.parent.mkdir()
    for path in (pool_path, artifact_path, generator_path, puzzle_path):
        path.write_bytes(path.name.encode())
    manifest = {
        "generator_output": {"path": generator_path.name},
        "puzzles": [{"path": puzzle_path.relative_to(tmp_path).as_posix()}],
    }

    inputs, outputs = cal._resolve_finalization_paths(
        pool_path,
        artifact_path,
        manifest,
        training_out=None,
        test_out=None,
        certified_artifact_out=None,
    )
    assert all(path.is_absolute() for path in (*inputs.values(), *outputs.values()))

    collisions = [
        {"training_out": Path("candidate-manifest.json")},
        {"training_out": Path("paid-artifact.json")},
        {"training_out": Path("generator-output.json")},
        {"training_out": Path("training-provenance.json")},
        {"test_out": Path("training-manifest.json")},
        {"certified_artifact_out": pool_path},
        {"certified_artifact_out": artifact_path},
        {"certified_artifact_out": generator_path},
        {"certified_artifact_out": puzzle_path},
        {"certified_artifact_out": tmp_path / "test-provenance.json"},
        {
            "certified_artifact_out": (
                tmp_path
                / "training-evidence"
                / f"{cal.ROSTER_MODEL_IDS[0]}.json.gz"
            )
        },
        {"certified_artifact_out": cal._finalization_seal_path(artifact_path)},
    ]
    for overrides in collisions:
        with pytest.raises(cal.CalibrationError, match="finalization path collision"):
            cal._resolve_finalization_paths(
                pool_path,
                artifact_path,
                manifest,
                training_out=overrides.get("training_out"),
                test_out=overrides.get("test_out"),
                certified_artifact_out=overrides.get("certified_artifact_out"),
            )

    hardlink = tmp_path / "pool-hardlink.json"
    hardlink.hardlink_to(pool_path)
    with pytest.raises(cal.CalibrationError, match="finalization path collision"):
        cal._resolve_finalization_paths(
            pool_path,
            artifact_path,
            manifest,
            training_out=None,
            test_out=None,
            certified_artifact_out=hardlink,
        )


@pytest.mark.parametrize(
    ("training_name", "test_name"),
    [
        ("SPLIT-MANIFEST.json", "split-manifest.json"),
        ("caf\u00e9-manifest.json", "cafe\u0301-manifest.json"),
    ],
)
def test_finalization_path_plan_rejects_fresh_portable_filename_aliases(
    tmp_path, training_name, test_name
):
    pool_path = tmp_path / "candidate-manifest.json"
    artifact_path = tmp_path / "paid-artifact.json"
    generator_path = tmp_path / "generator-output.json"
    puzzle_path = tmp_path / "candidate.json.gz"
    for path in (pool_path, artifact_path, generator_path, puzzle_path):
        path.write_bytes(path.name.encode())
    manifest = {
        "generator_output": {"path": generator_path.name},
        "puzzles": [{"path": puzzle_path.name}],
    }

    assert not (tmp_path / training_name).exists()
    assert not (tmp_path / test_name).exists()
    with pytest.raises(cal.CalibrationError, match="finalization path collision"):
        cal._resolve_finalization_paths(
            pool_path,
            artifact_path,
            manifest,
            training_out=Path(training_name),
            test_out=Path(test_name),
            certified_artifact_out=None,
        )


def test_finalization_collision_preflight_preserves_every_input_and_writes_nothing(
    tmp_path,
):
    pool_path, artifact, _selected_canary, _vocab = _large_complete_pool(tmp_path)
    paid_beside_pool = pool_path.with_name("paid-calibration.json")
    paid_beside_pool.write_bytes(artifact.read_bytes())
    before = _tree_bytes(tmp_path)

    def explode(_lang):
        raise AssertionError("path collision reached vocabulary loading")

    cases = [
        {"training_out": Path("training-provenance.json")},
        {"training_out": Path(paid_beside_pool.name)},
        {"certified_artifact_out": pool_path},
    ]
    for overrides in cases:
        with pytest.raises(cal.CalibrationError, match="finalization path collision"):
            cal.finalize_manifests(
                pool_path,
                paid_beside_pool,
                training_out=overrides.get("training_out"),
                certified_artifact_out=overrides.get("certified_artifact_out"),
                vocab_loader=explode,
            )

    assert _tree_bytes(tmp_path) == before


def test_output_transaction_rolls_back_after_mid_publication_failure(
    tmp_path, monkeypatch
):
    first = tmp_path / "first.json"
    second = tmp_path / "second.json"
    third = tmp_path / "third.json"
    first.write_bytes(b"old-first")
    second.write_bytes(b"old-second")
    real_replace = cal.os.replace
    failed = False

    def fail_second_once(source, destination):
        nonlocal failed
        if (
            not failed
            and Path(destination) == second
            and ".stage-" in Path(source).name
        ):
            failed = True
            raise OSError("scripted publication failure")
        return real_replace(source, destination)

    monkeypatch.setattr(cal.os, "replace", fail_second_once)
    with pytest.raises(cal.CalibrationError, match="output transaction failed"):
        cal._publish_output_transaction(
            [(first, b"new-first"), (second, b"new-second"), (third, b"new-third")]
        )

    assert first.read_bytes() == b"old-first"
    assert second.read_bytes() == b"old-second"
    assert not third.exists()
    assert sorted(path.name for path in tmp_path.iterdir()) == [
        "first.json",
        "second.json",
    ]


def test_output_transaction_rejects_portable_aliases_before_staging(tmp_path):
    upper = tmp_path / "SPLIT-MANIFEST.json"
    lower = tmp_path / "split-manifest.json"

    with pytest.raises(cal.CalibrationError, match="duplicate paths"):
        cal._publish_output_transaction([(upper, b"training"), (lower, b"test")])

    assert _tree_bytes(tmp_path) == {}


@pytest.mark.parametrize(
    ("input_name", "error"),
    [
        (
            "candidate manifest",
            "candidate pool manifest exact identity changed during finalization",
        ),
        ("generator output", "candidate-pool generator output identity changed"),
    ],
)
def test_finalization_revalidates_the_complete_pool_before_publication(
    tmp_path, input_name, error
):
    pool_path, artifact, _selected_canary, vocab = _large_complete_pool(tmp_path)
    bytes_after_mutation = {}

    def mutate_input_during_vocab_load(_lang):
        if input_name == "candidate manifest":
            # Whitespace preserves the semantic pool identity while changing the
            # exact frozen-manifest identity.
            pool_path.write_bytes(pool_path.read_bytes() + b"\n")
        else:
            manifest = json.loads(pool_path.read_text())
            generator_path = pool_path.parent / manifest["generator_output"]["path"]
            generator_path.write_bytes(b'{"generator":"mutated"}\n')
        bytes_after_mutation.update(_tree_bytes(tmp_path))
        return vocab

    with pytest.raises(cal.CalibrationError, match=error):
        cal.finalize_manifests(
            pool_path,
            artifact,
            vocab_loader=mutate_input_during_vocab_load,
        )

    # Staging may create empty parent directories, but no destination may be
    # published and no preexisting input/output byte may change again.
    assert _tree_bytes(tmp_path) == bytes_after_mutation


def test_finalization_rejects_replayable_work_after_earliest_feasible_prefix(
    tmp_path,
):
    pool_path, artifact, _selected_canary, vocab = _large_complete_pool(tmp_path)
    state = json.loads(artifact.read_text())
    earliest = state["selection"]["completed_prefix_count"]
    assert earliest < len(state["candidates"])
    late_candidate = state["candidates"][earliest]
    puzzle = cd.load_puzzle_json(pool_path.parent / late_candidate["path"])
    guesses = [target["word"] for target in late_candidate["targets"]]
    template = cr._play_once(
        puzzle=puzzle,
        vocab=vocab,
        strategy=None,
        config={
            "model_id": late_candidate["models"][0]["model_id"],
            "provider": late_candidate["models"][0]["provider"],
        },
        api_key=None,
        play_effort=cal.CALIBRATION_EFFORT,
        auth="api",
        cap=cal.CALIBRATION_CAP,
        provider_factory=ScriptedProvider(guesses),
        on_try=lambda _progress: None,
    )
    checkpoint = state["checkpoint"]["sequence"]
    for model in late_candidate["models"]:
        for run_number in range(1, cal.INITIAL_RUNS + 1):
            checkpoint += 1
            run = copy.deepcopy(template)
            opening = run["conversation"][0]["content"]
            run.update(
                {
                    "number": run_number,
                    "model_id": model["model_id"],
                    "provider": model["provider"],
                    "transport": model["transport"],
                    "auth": model["auth"],
                    "effort": model["effort"],
                    "cap": cal.CALIBRATION_CAP,
                    "opening_prompt_sha256": hashlib.sha256(
                        opening.encode()
                    ).hexdigest(),
                    "checkpoint": checkpoint,
                    "completed_at": "2026-07-16T00:00:00+00:00",
                }
            )
            model["runs"].append(run)
    state["checkpoint"].update(
        sequence=checkpoint,
        completed_paid_units=checkpoint,
        updated_at="2026-07-16T00:00:00+00:00",
    )
    partial = copy.deepcopy(state)
    for model in partial["candidates"][earliest]["models"]:
        model["runs"] = []
    partial["candidates"][earliest]["models"][0]["runs"] = [
        copy.deepcopy(late_candidate["models"][0]["runs"][0])
    ]
    partial_checkpoint = state["selection"]["stopping_checkpoint"] + 1
    partial["checkpoint"].update(
        sequence=partial_checkpoint,
        completed_paid_units=partial_checkpoint,
    )
    with pytest.raises(
        cal.CalibrationError,
        match="paid work continued beyond the earliest feasible completed prefix",
    ):
        cal._refresh_derived(partial)

    # The six late runs and their transcripts are individually valid. Certification
    # must still reject them because the preceding prefix was already feasible.
    cal._validate_completed_runs(state, pool_path, vocab)
    adversarial = tmp_path / "late-work-calibration.json"
    cal.save_artifact(adversarial, state)

    with pytest.raises(
        cal.CalibrationError,
        match="paid work continued beyond the earliest feasible completed prefix",
    ):
        cal.finalize_manifests(
            pool_path, adversarial, vocab_loader=lambda _lang: vocab
        )


def test_finalization_writes_deterministic_isolated_training_and_test_views(
    tmp_path, capsys
):
    pool_path, artifact, selected_canary, vocab = _large_complete_pool(tmp_path)
    outputs = cal.finalize_manifests(
        pool_path, artifact, vocab_loader=lambda _lang: vocab
    )
    training_path = outputs["training_manifest"]
    test_path = outputs["test_manifest"]
    training = json.loads(training_path.read_text())
    test = json.loads(test_path.read_text())
    state = json.loads(artifact.read_text())
    certified = json.loads(outputs["certified_artifact"].read_text())
    repeated = cal.finalize_manifests(
        pool_path,
        artifact,
        training_out=Path("training-manifest-repeat.json"),
        test_out=Path("test-manifest-repeat.json"),
        certified_artifact_out=tmp_path / "complete-calibration.repeat.finalized.json",
        vocab_loader=lambda _lang: vocab,
    )
    assert repeated["training_manifest"].read_bytes() == training_path.read_bytes()
    assert repeated["test_manifest"].read_bytes() == test_path.read_bytes()
    assert repeated["finalization_seal"] == outputs["finalization_seal"]
    assert json.loads(outputs["finalization_seal"].read_text()) == {
        "schema_version": 1,
        "kind": "calibration_finalization_seal",
        "run_artifact_file_sha256": cal._sha256_file(artifact),
    }
    stopping_candidate = state["selection"]["stopping_candidate_id"]
    with pytest.raises(
        cal.CalibrationError,
        match="cannot change a finalized calibration artifact",
    ):
        cal.request_extension(
            artifact,
            candidate_selector=stopping_candidate,
            model_selector="GPT-SOL",
            reason="unstable",
        )

    assert state["selection"]["cohort_report"]["counts"] == {
        "selected_training": 15,
        "selected_test": 15,
        "eligible_unselected": 0,
        "training_only_spread": 0,
        "cap_stress": 10,
    }
    assert state["selection"]["cohort_report"]["unrun_candidates"] == 5
    assert training["manifest_kind"] == cd.CALIBRATION_TRAINING_MANIFEST_KIND
    assert test["manifest_kind"] == cd.CALIBRATION_TEST_MANIFEST_KIND
    assert training["counts"] == {"puzzles": 15, "curriculum": 15, "holdout": 0}
    assert test["counts"] == {"puzzles": 15, "curriculum": 0, "holdout": 15}
    for manifest, role in ((training, "training"), (test, "test")):
        assert manifest["dataset_content_sha256"] == cd.dataset_content_sha256(
            manifest
        )
        assert {
            tier: sum(
                record["calibration"]["tier"] == tier
                for record in manifest["puzzles"]
            )
            for tier in cal.TIER_ORDER
        } == {tier: 5 for tier in cal.TIER_ORDER}
        assert all(
            record["calibration"]["role"] == role
            and record["calibration"]["all_runs_solved_within_cap"]
            for record in manifest["puzzles"]
        )
        serialized = json.dumps(manifest)
        assert '"runs"' not in serialized
        assert '"conversation"' not in serialized
        assert '"cohort_report"' not in serialized
        assert manifest["calibration"]["run_artifact_file_sha256"] == cal._sha256_file(
            artifact
        )

    assert certified["finalization"]["training_manifest"]["file_sha256"] == cal._sha256_file(
        training_path
    )
    assert certified["finalization"]["test_manifest"]["file_sha256"] == cal._sha256_file(
        test_path
    )
    assert certified["finalization"]["run_artifact_file_sha256"] == cal._sha256_file(
        artifact
    )
    assert test["strategy_evidence"]["training_manifest_file_sha256"] == cal._sha256_file(
        training_path
    )

    # The training view and both model-isolated sidecars contain no selected-test
    # identity or puzzle material. Sonnet and GPT packets receive only their own
    # compact trajectories; raw repeated conversations stay in the lab artifact.
    assert selected_canary not in json.dumps(training, ensure_ascii=False)
    for model_id, reference in training["strategy_evidence"][
        "model_run_evidence"
    ].items():
        evidence_bytes = read_data_bytes(training_path.parent / reference["path"])
        evidence = json.loads(evidence_bytes)
        assert evidence["schema_version"] == reference["schema_version"] == 2
        assert b'"conversation"' not in evidence_bytes
        assert b'"turn_token_usage"' not in evidence_bytes
        for puzzle in evidence["puzzles"]:
            for run in puzzle["runs"]:
                assert run["model_id"] == model_id
                assert len(run["counted_guesses"]) == run["counted_tries"]
                assert len(run["trajectory"]) == run["counted_tries"]
                assert len(run["counted_guesses"]) + len(
                    run["rejected_events"]
                ) == run["turns"]
                assert "guess_trace" not in run["metrics"]
    packets = {
        model_id: build_evidence_packet(
            training, training_path.parent, model_id=model_id
        )
        for model_id in (*cal.ROSTER_MODEL_IDS, "claude-opus-4-8")
    }
    for packet in packets.values():
        assert selected_canary not in packet.canonical_bytes.decode()
        assert b'"conversation"' not in packet.canonical_bytes
    sonnet_text = packets["claude-sonnet-5"].canonical_bytes.decode()
    gpt_text = packets["gpt-5.6-sol"].canonical_bytes.decode()
    assert '"model_id":"claude-sonnet-5"' in sonnet_text
    assert '"model_id":"gpt-5.6-sol"' not in sonnet_text
    assert '"model_id":"gpt-5.6-sol"' in gpt_text
    assert '"model_id":"claude-sonnet-5"' not in gpt_text
    assert packets["claude-opus-4-8"].document["content"][
        "model_calibration_evidence"
    ]["source"] == "none_for_non_roster_model"
    packet = packets["claude-opus-4-8"]
    prompt = cr.distillation_prompt(packet, play_effort="medium")
    assert selected_canary not in prompt

    def explode(*_args, **_kwargs):
        raise AssertionError("dry-run made a provider/vocab call")

    with pytest.raises(cr.CurriculumError, match="re-distillation is forbidden"):
        cr.run_curriculum(
            test_path,
            model="OPUS",
            strategy_effort="max",
            play_effort="medium",
            auth="api",
            cap=300,
            dry_run=True,
            provider_factory=explode,
            vocab_loader=explode,
            output_root=tmp_path / "never-written",
            v7_strategy="frozen control",
        )
    capsys.readouterr()

    profile = sp.build_profile(
        strategy_id="strategy-fr-v2-training/claude-opus-4-8/frozen",
        model_id="claude-opus-4-8",
        provider="anthropic",
        transport="api",
        auth="api",
        strategy_effort="max",
        play_effort="medium",
        lang="fr",
        dataset_id=packet.document["content"]["dataset_id"],
        dataset_sha256=packet.document["content"]["dataset_content_sha256"],
        evidence_packet_schema_version=packet.document["schema_version"],
        evidence_packet_sha256=packet.sha256,
        distillation_prompt_sha256=hashlib.sha256(prompt.encode()).hexdigest(),
        prompt_version=cr.PROMPT_VERSION,
        curriculum_prompt_version=cr.CURRICULUM_PROMPT_VERSION,
        created_at="2026-07-15T00:00:00+00:00",
        final_strategy=["Use the frozen curriculum strategy."],
    )
    profile_path = tmp_path / "frozen.profile.json"
    sp.write_profile(profile_path, profile)
    with pytest.raises(
        cr.CurriculumError,
        match="calibrated datasets require --play-effort 'medium'",
    ):
        cr.run_curriculum(
            test_path,
            model="OPUS",
            strategy_effort="max",
            play_effort="high",
            auth="api",
            cap=300,
            dry_run=True,
            provider_factory=explode,
            vocab_loader=explode,
            output_root=tmp_path / "never-written",
            v7_strategy="frozen control",
            frozen_profile=profile_path,
        )
    assert (
        cr.run_curriculum(
            test_path,
            model="OPUS",
            strategy_effort="max",
            play_effort="medium",
            auth="api",
            cap=300,
            dry_run=True,
            provider_factory=explode,
            vocab_loader=explode,
            output_root=tmp_path / "never-written",
            v7_strategy="frozen control",
            frozen_profile=profile_path,
        )
        is None
    )
    final_plan = json.loads(capsys.readouterr().out)
    assert final_plan["holdout_puzzles"] == 15
    assert final_plan["planned_holdout_runs"] == 15 * 3 * 3
    assert final_plan["pending_holdout_runs"] == final_plan["planned_holdout_runs"]
    assert all(
        arm["fresh_context_per_run"] for arm in final_plan["call_plan"]["holdout"]
    )
    assert final_plan["curriculum_play_calls"] == 0
    assert final_plan["planned_distillation_stage"] == 0
    assert final_plan["config"]["strategy_source"] == "frozen_profile"
    assert final_plan["call_plan"]["distillation"]["pending"] is False
    assert final_plan["evidence_packet"]["source"] == "frozen_profile_only"

    # The training view is independently runnable for a fresh model-specific
    # distillation and has no final-test calls.
    assert (
        cr.run_curriculum(
            training_path,
            model="OPUS",
            strategy_effort="max",
            play_effort="medium",
            auth="api",
            cap=300,
            dry_run=True,
            provider_factory=explode,
            vocab_loader=explode,
            output_root=tmp_path / "never-written",
            v7_strategy="frozen control",
        )
        is None
    )
    training_plan = json.loads(capsys.readouterr().out)
    assert training_plan["curriculum_puzzles"] == 15
    assert training_plan["planned_distillation_stage"] == 1
    assert training_plan["holdout_puzzles"] == 0
    assert training_plan["planned_holdout_runs"] == 0

    pinned_file_sha = test["calibration"]["run_artifact_file_sha256"]
    semantic_hashes = copy.deepcopy(state["hashes"])
    state["candidates"][0]["models"][0]["runs"][0]["duration"] += 1
    state["auth_verifications"][0]["verified_at"] = "2099-01-01T00:00:00+00:00"
    cal.save_artifact(artifact, state)
    changed_state = json.loads(artifact.read_text())
    assert changed_state["hashes"] == semantic_hashes
    assert cal._sha256_file(artifact) != pinned_file_sha
    before_conflict = _tree_bytes(tmp_path)

    def seal_explode(_lang):
        raise AssertionError("seal conflict reached vocabulary loading")

    with pytest.raises(
        cal.CalibrationError,
        match="existing calibration finalization seal has a different identity",
    ):
        cal.finalize_manifests(
            pool_path,
            artifact,
            vocab_loader=seal_explode,
        )
    assert _tree_bytes(tmp_path) == before_conflict


@pytest.mark.parametrize(
    ("tries", "expected"),
    [
        (1, True),
        (cal.CALIBRATION_CAP, True),
        (None, False),
        (cal.CALIBRATION_CAP + 1, False),
    ],
)
def test_all_runs_solved_within_cap_is_derived_from_paid_runs(tries, expected):
    candidate = {"models": [{"runs": [{"tries": tries}]}]}

    assert cal._all_runs_solved_within_cap(candidate) is expected


def test_finalization_replays_and_requires_complete_paid_run_records(tmp_path):
    pool_path, artifact, _selected_canary, vocab = _large_complete_pool(tmp_path)
    valid = json.loads(artifact.read_text())

    def first_run(state):
        return state["candidates"][0]["models"][0]["runs"][0]

    def make_skeletal(state):
        run = first_run(state)
        skeletal = {key: run[key] for key in ("number", "tries", "checkpoint")}
        run.clear()
        run.update(skeletal)

    corruptions = {
        "skeletal": make_skeletal,
        "conversation": lambda state: first_run(state).pop("conversation"),
        "metrics": lambda state: first_run(state).pop("metrics"),
        "token usage": lambda state: first_run(state).pop("turn_token_usage"),
        "duration": lambda state: first_run(state).pop("duration"),
        "identity": lambda state: first_run(state).pop("model_id"),
        "authentication": lambda state: state.update(auth_verifications=[]),
    }
    for label, corrupt in corruptions.items():
        state = copy.deepcopy(valid)
        corrupt(state)
        corrupt_path = tmp_path / f"corrupt-{label.replace(' ', '-')}.json"
        cal.save_artifact(corrupt_path, state)
        with pytest.raises(cal.CalibrationError):
            cal.finalize_manifest(
                pool_path,
                corrupt_path,
                vocab_loader=lambda _lang: vocab,
            )
