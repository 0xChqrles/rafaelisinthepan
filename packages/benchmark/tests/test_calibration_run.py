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
from curriculum_io import sha256_bytes, write_deterministic_gzip
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


def test_cross_model_spread_accepts_20_and_rejects_21():
    accepted = cal.summarize_candidate(_score_candidate([5] * 3, [25] * 3))
    rejected = cal.summarize_candidate(_score_candidate([5] * 3, [26] * 3))

    assert accepted["status"] == "eligible"
    assert accepted["model_median_spread"] == 20
    assert rejected["status"] == "rejected"
    assert "model_median_spread" in {reason["code"] for reason in rejected["reasons"]}


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
        targets = _balanced_targets(
            tier[0],
            low_pos=low_positions[tier],
            common_high=tier_index != 1,
            tangible_high=tier_index != 1,
        )
        for index in range(cal.TIER_QUOTA):
            candidate = {
                "candidate_id": hashlib.sha256(f"{tier}:{index}".encode()).hexdigest(),
                "targets": targets[index * 3 : index * 3 + 3],
                "models": [],
                "summary": {
                    "status": "eligible",
                    "eligible": True,
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


def test_selection_is_deterministic_exactly_5_5_5_and_balanced_per_tier_and_overall():
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
    assert first["rule_version"] == "1"
    assert first["counts"] == {tier: 5 for tier in cal.TIER_ORDER}
    assert len(first["selected"]) == 15
    assert first["balance_constraint"]["maximum_category_count_spread"] == 1
    assert first["predeclared_balance_fallback"] == {
        "rule_version": "2",
        "activation": "explicit_rule_version_bump_only",
        "automatic": False,
        "trigger": "rule_v1_balance_only_shortfall",
        "per_tier_maximum_category_count_spread": 2,
        "overall_maximum_category_count_spread": 1,
        "unique_target_slugs_required": True,
    }
    for scope in [*first["balance"]["tiers"].values(), first["balance"]["overall"]]:
        assert all(field["spread"] <= 1 for field in scope.values())


def test_selection_fails_with_explicit_tier_and_balance_shortfalls():
    candidates = _eligible_selection_world()
    insufficient = cal.select_calibrated_candidates(
        candidates[:-1], reserved_slugs=set(), selection_salt="pool"
    )
    assert insufficient["status"] == "shortfall"
    assert insufficient["reason"] == "insufficient_eligible_candidates"
    assert insufficient["tier_deficits"]["difficult"] == 1

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
    assert no_balance["rule_version"] == "1"
    assert "selected" not in no_balance
    assert no_balance["predeclared_balance_fallback"]["rule_version"] == "2"
    assert no_balance["predeclared_balance_fallback"]["automatic"] is False

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

    spread_only = _score_candidate([5] * 3, [26] * 3)
    spread_only.update(
        candidate_id=hashlib.sha256(b"spread-only").hexdigest(),
        pool_index=len(candidates) + 1,
        path="puzzles/candidates/spread-only.json.gz",
        sha256="f" * 64,
    )
    spread_only["summary"] = cal.summarize_candidate(spread_only)
    candidates.append(spread_only)

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
        "selected": 15,
        "eligible_unselected": 1,
        "spread_only": 1,
        "cap_stress": 1,
    }
    assert sum(report["counts"].values()) == len(candidates)
    for rows in report["cohorts"].values():
        assert [row["candidate_id"] for row in rows] == sorted(
            row["candidate_id"] for row in rows
        )

    spread_row = report["cohorts"]["spread_only"][0]
    assert spread_row["candidate_id"] == spread_only["candidate_id"]
    assert spread_row["pool_index"] == spread_only["pool_index"]
    assert spread_row["path"] == spread_only["path"]
    assert spread_row["sha256"] == spread_only["sha256"]
    assert spread_row["model_medians"] == {
        "claude-sonnet-5": 5,
        "gpt-5.6-sol": 26,
    }
    assert spread_row["model_median_spread"] == 21
    assert spread_row["model_run_counts"] == {
        "claude-sonnet-5": 3,
        "gpt-5.6-sol": 3,
    }
    assert spread_row["rejection_reasons"] == spread_only["summary"]["reasons"]

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
    first_candidate_id = min(candidate_words_by_id)
    return path, candidate_words_by_id[first_candidate_id], vocab


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
    assert plan["pending_paid_units"] == 45 * 2 * 3
    assert len(plan["planned_paid_units"]) == 1
    assert not (tmp_path / "never-written.json").exists()


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
    assert runs[1]["model_id"] == "claude-sonnet-5"
    assert runs[1]["provider"] == "anthropic"
    assert runs[1]["transport"] == "api"
    assert runs[1]["auth"] == "api"
    assert runs[1]["effort"] == "medium"
    assert runs[1]["turn_token_usage"]
    assert runs[1]["wall_duration"] >= 0


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
        balanced = _balanced_targets(
            f"z{_alpha(tier_index)}",
            low_pos=low_positions[tier],
            common_high=tier_index != 1,
            tangible_high=tier_index != 1,
        )
        for local_index in range(15):
            if local_index < 5:
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
            if tier == "easy" and local_index == 0:
                selected_canary = words[0]

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
    state["checkpoint"] = {
        "sequence": checkpoint,
        "completed_paid_units": checkpoint,
        "updated_at": "2026-07-15T00:00:00+00:00",
    }
    cal._refresh_derived(state)
    assert state["selection"]["status"] == "selected"
    state["completed_at"] = "2026-07-15T00:00:00+00:00"
    artifact = tmp_path / "complete-calibration.json"
    cal.save_artifact(artifact, state)
    return pool_path, artifact, selected_canary, vocab


def test_final_manifest_pins_calibration_without_leaking_runs_into_evidence(
    tmp_path, capsys
):
    pool_path, artifact, selected_canary, vocab = _large_complete_pool(tmp_path)
    final_path = cal.finalize_manifest(
        pool_path, artifact, vocab_loader=lambda _lang: vocab
    )
    manifest = json.loads(final_path.read_text())
    state = json.loads(artifact.read_text())

    assert state["selection"]["cohort_report"]["counts"] == {
        "selected": 15,
        "eligible_unselected": 0,
        "spread_only": 0,
        "cap_stress": 30,
    }
    assert manifest["counts"] == {"puzzles": 30, "curriculum": 15, "holdout": 15}
    holdout = [record for record in manifest["puzzles"] if record["split"] == "holdout"]
    assert {
        tier: sum(row["calibration"]["tier"] == tier for row in holdout)
        for tier in cal.TIER_ORDER
    } == {tier: 5 for tier in cal.TIER_ORDER}
    assert (
        manifest["calibration"]["artifact_sha256"] == state["hashes"]["artifact_sha256"]
    )
    assert manifest["calibration"]["artifact_file_sha256"] == cal._sha256_file(
        artifact
    )
    assert (
        manifest["calibration"]["content_sha256"] == state["hashes"]["content_sha256"]
    )
    assert manifest["dataset_content_sha256"] == cd.dataset_content_sha256(manifest)
    changed_file_pin = copy.deepcopy(manifest)
    changed_file_pin["calibration"]["artifact_file_sha256"] = "0" * 64
    assert cd.dataset_content_sha256(changed_file_pin) == manifest[
        "dataset_content_sha256"
    ]
    changed_summary = copy.deepcopy(manifest)
    changed_summary["puzzles"][15]["calibration"]["difficulty"] += 1
    assert (
        cd.dataset_content_sha256(changed_summary) != manifest["dataset_content_sha256"]
    )
    serialized_holdout = json.dumps(holdout)
    assert '"runs"' not in serialized_holdout
    assert '"conversation"' not in serialized_holdout
    serialized_manifest = json.dumps(manifest)
    assert '"cohort_report"' not in serialized_manifest
    assert '"eligible_unselected"' not in serialized_manifest
    assert '"spread_only"' not in serialized_manifest
    assert '"cap_stress"' not in serialized_manifest
    assert all(
        record["calibration"]["all_runs_solved_within_cap"] for record in holdout
    )

    loaded, dataset_sha, _manifest_sha = cr.load_manifest(final_path)
    packet = build_evidence_packet(loaded, final_path.parent)
    pool_manifest = json.loads(pool_path.read_text())
    curriculum = [
        record
        for record in pool_manifest["puzzles"]
        if record["split"] == "curriculum"
    ]
    base_packet = build_evidence_packet(
        {
            "dataset_id": pool_manifest["curriculum_base"]["dataset_id"],
            "dataset_content_sha256": pool_manifest["curriculum_base"][
                "dataset_content_sha256"
            ],
            "lang": "fr",
            "counts": {"puzzles": 15, "curriculum": 15, "holdout": 0},
            "puzzles": curriculum,
        },
        final_path.parent,
    )
    prompt = cr.distillation_prompt(packet, play_effort="medium")
    packet_text = packet.canonical_bytes.decode()
    assert dataset_sha == manifest["dataset_content_sha256"]
    assert packet.canonical_bytes == base_packet.canonical_bytes
    assert manifest["strategy_evidence"]["packet_sha256"] == packet.sha256
    assert selected_canary not in packet_text
    assert selected_canary not in prompt
    assert "model_medians" not in packet_text
    assert "calibration" not in packet_text

    def explode(*_args, **_kwargs):
        raise AssertionError("final-evaluation dry-run made a provider/vocab call")

    with pytest.raises(cr.CurriculumError, match="re-distillation is forbidden"):
        cr.run_curriculum(
            final_path,
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
        strategy_id="base/claude-opus-4-8/frozen",
        model_id="claude-opus-4-8",
        provider="anthropic",
        transport="api",
        auth="api",
        strategy_effort="max",
        play_effort="medium",
        lang="fr",
        dataset_id=packet.document["content"]["dataset_id"],
        dataset_sha256=packet.document["content"]["dataset_content_sha256"],
        evidence_packet_schema_version=1,
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
            final_path,
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
            final_path,
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

    pinned_file_sha = manifest["calibration"]["artifact_file_sha256"]
    semantic_hashes = copy.deepcopy(state["hashes"])
    state["candidates"][0]["models"][0]["runs"][0]["duration"] += 1
    state["auth_verifications"][0]["verified_at"] = "2099-01-01T00:00:00+00:00"
    cal.save_artifact(artifact, state)
    changed_state = json.loads(artifact.read_text())
    assert changed_state["hashes"] == semantic_hashes
    assert cal._sha256_file(artifact) != pinned_file_sha


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
