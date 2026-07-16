"""Sequential neutral calibration and frozen train/test allocation (#86).

Candidates are processed in the manifest's frozen order, one complete candidate
at a time.  After both fixed-roster medians (and any declared extensions) are
complete, the deterministic joint selector checks the completed prefix for a
balanced 15-puzzle training split and a disjoint 15-puzzle test split.  The first
feasible prefix is frozen and the unneeded suffix remains explicitly unrun.

This module performs calibration and split certification only.  It never makes a
strategy-distillation or final-evaluation provider call.  Finalization emits
separate training/test views plus model-isolated training-run evidence for #84.
"""

from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import hashlib
import json
import math
import sys
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator

SCRIPT_DIR = Path(__file__).resolve().parent
BENCHMARK_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

import curriculum_dataset as cd  # noqa: E402
from curriculum_io import (  # noqa: E402
    load_json,
    read_data_bytes,
    sha256_bytes,
    write_deterministic_gzip,
)
from curriculum_run import (  # noqa: E402
    CurriculumError,
    _auth_preflight,
    _play_once,
    derive_run_metrics,
)
from llm_play import (  # noqa: E402
    NoProgressReplyError,
    PROMPT_VERSION,
    PuzzleReferee,
    UnparseableReplyError,
    _transport_name,
    _validate_provider_effort,
    load_vocab,
    parse_single_word,
    play_puzzle,
    provider_reply,
    select_model,
)
from strategy_evidence import (  # noqa: E402
    MODEL_RUN_EVIDENCE_SCHEMA_VERSION,
    PACKET_SCHEMA_VERSION,
    build_evidence_packet,
)


CALIBRATION_SCHEMA_VERSION = 2
CALIBRATION_RULE_VERSION = "2"
CALIBRATION_EFFORT = "medium"
CALIBRATION_CAP = 75
INITIAL_RUNS = 3
EXTENDED_RUNS = 5
ELIGIBLE_MIN_TRIES = 5
ELIGIBLE_MAX_TRIES = 50
MAX_MODEL_MEDIAN_SPREAD = 20
TIER_QUOTA = 5
SELECTED_PER_TIER = TIER_QUOTA * 2
SELECTED_PER_SPLIT = TIER_QUOTA * 3
SELECTED_TOTAL = SELECTED_PER_SPLIT * 2
RULE_V2_MAX_CATEGORY_COUNT_SPREAD = 1
TIER_RANGES: dict[str, tuple[int, int]] = {
    "easy": (5, 15),
    "medium": (16, 30),
    "difficult": (31, 50),
}
TIER_ORDER = tuple(TIER_RANGES)

COHORT_ORDER = (
    "selected_training",
    "selected_test",
    "eligible_unselected",
    "training_only_spread",
    "cap_stress",
)
CAP_STRESS_REASON_CODES = frozenset({"dnf", "over_cap", "median_out_of_range"})
VALID_REJECTION_REASON_CODES = CAP_STRESS_REASON_CODES

ROSTER_SELECTORS = ("SONNET", "GPT-SOL")
ROSTER_MODEL_IDS = ("claude-sonnet-5", "gpt-5.6-sol")

BALANCE_FIELDS: dict[str, tuple[str, ...]] = {
    "pos": tuple(cd.POS_VALUES),
    "gender": tuple(cd.GENDER_VALUES),
    "frequency_band": ("common", "difficult"),
    "semantic_class": tuple(cd.SEMANTIC_CLASSES),
}

OUTPUT_ROOT = BENCHMARK_DIR / "output" / "calibration"

_VOLATILE_KEYS = {
    "started_at",
    "updated_at",
    "completed_at",
    "finalized_at",
    "requested_at",
    "verified_at",
    "duration",
    "wall_duration",
}


class CalibrationError(CurriculumError):
    """A calibration identity, result, or orchestration invariant failed."""


class CalibrationShortfallError(CalibrationError):
    """All requested runs finished, but the fixed selection contract failed."""

    def __init__(self, report: dict[str, Any]):
        self.report = report
        super().__init__(
            "calibration selection shortfall: "
            + json.dumps(report, ensure_ascii=False, sort_keys=True)
        )


def resolve_path(path: Path, *, destination: bool = False) -> Path:
    if path.is_absolute():
        return path
    repo_root = BENCHMARK_DIR.parent.parent
    candidates = (Path.cwd() / path, repo_root / path, BENCHMARK_DIR / path)
    for candidate in candidates:
        if candidate.is_file() or (destination and candidate.parent.is_dir()):
            return candidate.resolve()
    if destination and path.parts[:1] == ("output",):
        return (BENCHMARK_DIR / path).resolve()
    if destination and path.parts[:2] == ("packages", "benchmark"):
        return (repo_root / path).resolve()
    return path


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _without_volatile(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _without_volatile(item)
            for key, item in value.items()
            if key not in _VOLATILE_KEYS and key != "hashes"
        }
    if isinstance(value, list):
        return [_without_volatile(item) for item in value]
    return value


def _artifact_identity(state: dict[str, Any]) -> dict[str, Any]:
    identity = _without_volatile(state)
    identity.pop("auth_verifications", None)
    identity.get("candidate_pool", {}).pop("manifest_path", None)
    return identity


def _content_identity(state: dict[str, Any]) -> dict[str, Any]:
    pool = state["candidate_pool"]
    return _without_volatile(
        {
            "config": state["config"],
            "candidate_pool": {
                key: value for key, value in pool.items() if key != "manifest_path"
            },
            "candidates": state["candidates"],
            "selection": state["selection"],
        }
    )


def update_artifact_hashes(state: dict[str, Any]) -> None:
    selection = state.get("selection", {})
    selection_payload = _without_volatile(selection)
    state["hashes"] = {
        "artifact_sha256": hashlib.sha256(
            _canonical_bytes(_artifact_identity(state))
        ).hexdigest(),
        "content_sha256": hashlib.sha256(
            _canonical_bytes(_content_identity(state))
        ).hexdigest(),
        "selection_sha256": (
            hashlib.sha256(_canonical_bytes(selection_payload)).hexdigest()
            if selection.get("status") in {"selected", "shortfall"}
            else None
        ),
    }


def _validate_artifact_hashes(state: dict[str, Any]) -> None:
    prior = copy.deepcopy(state.get("hashes"))
    if not isinstance(prior, dict):
        raise CalibrationError("calibration artifact has no hashes")
    probe = copy.deepcopy(state)
    update_artifact_hashes(probe)
    if prior != probe["hashes"]:
        raise CalibrationError("calibration artifact hashes do not replay")


def save_artifact(path: Path, state: dict[str, Any]) -> None:
    update_artifact_hashes(state)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    tmp.replace(path)


def _validate_pool_record_puzzle(
    record: dict[str, Any], puzzle: Any, *, lang: str
) -> None:
    """Bind selection metadata to the exact puzzle content used for paid play."""
    label = str(record.get("path", record.get("candidate_id", "<unknown>")))
    if not isinstance(puzzle, dict):
        raise CalibrationError(f"candidate-pool puzzle {label} is not an object")
    if puzzle.get("lang") != lang:
        raise CalibrationError(
            f"candidate-pool puzzle {label} language does not match the manifest"
        )
    words = puzzle.get("words")
    if not isinstance(words, list) or not all(isinstance(word, str) for word in words):
        raise CalibrationError(f"candidate-pool puzzle {label} has malformed words")
    if record.get("sentence") != " ".join(words):
        raise CalibrationError(
            f"candidate-pool puzzle {label} sentence does not match puzzle words"
        )

    targets = record.get("targets")
    holes = puzzle.get("holes")
    ranks = puzzle.get("ranks")
    if (
        not isinstance(targets, list)
        or not isinstance(holes, list)
        or len(holes) != len(targets)
        or not isinstance(ranks, dict)
    ):
        raise CalibrationError(
            f"candidate-pool puzzle {label} target/hole structure does not match"
        )
    holes_by_slug: dict[str, dict[str, Any]] = {}
    for hole in holes:
        secret = hole.get("secret") if isinstance(hole, dict) else None
        secret_slug = secret.get("slug") if isinstance(secret, dict) else None
        if (
            not isinstance(secret_slug, str)
            or not secret_slug
            or secret_slug in holes_by_slug
        ):
            raise CalibrationError(
                f"candidate-pool puzzle {label} has malformed or duplicate secrets"
            )
        holes_by_slug[secret_slug] = hole

    target_slugs = [
        target.get("slug") if isinstance(target, dict) else None for target in targets
    ]
    if set(target_slugs) != set(holes_by_slug) or len(set(target_slugs)) != len(
        target_slugs
    ):
        raise CalibrationError(
            f"candidate-pool puzzle {label} target slugs do not match puzzle secrets"
        )

    for target in targets:
        target_slug = target["slug"]
        hole = holes_by_slug[target_slug]
        secret = hole.get("secret")
        start = hole.get("start")
        if not isinstance(secret, dict) or secret.get("word") != target.get("word"):
            raise CalibrationError(
                f"candidate-pool puzzle {label} secret metadata does not match"
            )
        if not isinstance(start, dict) or start.get("word") != target.get("start"):
            raise CalibrationError(
                f"candidate-pool puzzle {label} start metadata does not match"
            )
        if hole.get("start_rank") != target.get("start_rank"):
            raise CalibrationError(
                f"candidate-pool puzzle {label} start rank metadata does not match"
            )

        rank_map = ranks.get(target_slug)
        if not isinstance(rank_map, dict):
            raise CalibrationError(
                f"candidate-pool puzzle {label} has no rank map for {target_slug!r}"
            )
        secret_entry = rank_map.get(target_slug)
        if (
            not isinstance(secret_entry, dict)
            or secret_entry.get("rank") != 0
            or secret_entry.get("word") != secret.get("word")
        ):
            raise CalibrationError(
                f"candidate-pool puzzle {label} secret rank parity does not match"
            )
        start_slug = start.get("slug")
        start_entry = rank_map.get(start_slug) if isinstance(start_slug, str) else None
        if (
            not isinstance(start_entry, dict)
            or start_entry.get("rank") != hole.get("start_rank")
            or start_entry.get("word") != start.get("word")
        ):
            raise CalibrationError(
                f"candidate-pool puzzle {label} start rank-map parity does not match"
            )


def load_candidate_pool(
    manifest_path: Path,
) -> tuple[dict[str, Any], str, str]:
    """Validate a frozen candidate-pool manifest and every referenced input."""
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("manifest_kind") != cd.CALIBRATION_POOL_KIND:
        raise CalibrationError("manifest is not a calibration candidate pool")
    dataset_dir = manifest_path.parent
    records = manifest.get("puzzles")
    if not isinstance(records, list):
        raise CalibrationError("candidate pool puzzles must be a list")
    curriculum = [record for record in records if record.get("split") == "curriculum"]
    candidates = [
        record
        for record in records
        if record.get("split") == cd.CALIBRATION_CANDIDATE_SPLIT
    ]
    if len(curriculum) + len(candidates) != len(records):
        raise CalibrationError("candidate pool contains an unknown puzzle split")
    counts = manifest.get("counts", {})
    expected_counts = {
        "curriculum": len(curriculum),
        "calibration_candidates": len(candidates),
        "puzzles": len(records),
    }
    if counts != expected_counts:
        raise CalibrationError("candidate pool counts do not match its records")
    if len(curriculum) != cd.CURRICULUM_COUNT:
        raise CalibrationError(
            f"candidate pool needs exactly {cd.CURRICULUM_COUNT} curriculum puzzles"
        )
    minimum = manifest.get("minimum_calibration_candidates")
    if (
        not isinstance(minimum, int)
        or isinstance(minimum, bool)
        or minimum < cd.MIN_CALIBRATION_CANDIDATES
        or len(candidates) < minimum
    ):
        raise CalibrationError(
            "candidate pool must declare and contain at least "
            f"{cd.MIN_CALIBRATION_CANDIDATES} calibration candidates"
        )
    candidate_ids = [record.get("candidate_id") for record in candidates]
    if any(not isinstance(value, str) or not value for value in candidate_ids) or len(
        candidate_ids
    ) != len(set(candidate_ids)):
        raise CalibrationError("candidate pool candidate ids are not unique")
    for record in candidates:
        sentence = record.get("sentence")
        expected_id = (
            hashlib.sha256(sentence.encode("utf-8")).hexdigest()
            if isinstance(sentence, str)
            else None
        )
        if record["candidate_id"] != expected_id:
            raise CalibrationError("candidate id does not match its sentence identity")
    pool_indexes = [record.get("pool_index") for record in candidates]
    if any(
        not isinstance(value, int) or isinstance(value, bool) for value in pool_indexes
    ) or sorted(pool_indexes) != list(range(1, len(candidates) + 1)):
        raise CalibrationError("candidate pool indexes are not contiguous")
    curriculum_slugs: set[str] = set()
    for record in records:
        targets = record.get("targets")
        if not isinstance(targets, list) or len(targets) != cd.TARGETS_PER_PUZZLE:
            raise CalibrationError("candidate-pool puzzle needs exactly three targets")
        slugs = [target.get("slug") for target in targets]
        if any(not isinstance(value, str) or not value for value in slugs) or len(
            slugs
        ) != len(set(slugs)):
            raise CalibrationError("candidate-pool puzzle target slugs are not unique")
        if record.get("split") == "curriculum":
            if curriculum_slugs & set(slugs):
                raise CalibrationError("candidate-pool curriculum slugs are not unique")
            curriculum_slugs.update(slugs)
    for record in candidates:
        slugs = {target["slug"] for target in record["targets"]}
        if curriculum_slugs & slugs:
            raise CalibrationError(
                "calibration candidate overlaps a frozen curriculum target slug"
            )
    for record in records:
        content = read_data_bytes(dataset_dir / record["path"])
        actual = sha256_bytes(content)
        if actual != record.get("sha256"):
            raise CalibrationError(
                f"candidate-pool puzzle {record.get('path')} does not match its sha256"
            )
        try:
            puzzle = json.loads(content.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise CalibrationError(
                f"candidate-pool puzzle {record.get('path')} is not valid JSON"
            ) from exc
        _validate_pool_record_puzzle(record, puzzle, lang=manifest.get("lang"))
    generator = manifest.get("generator_output", {})
    generator_path = dataset_dir / str(generator.get("path", ""))
    if not generator_path.is_file() or _sha256_file(generator_path) != generator.get(
        "sha256"
    ):
        raise CalibrationError("candidate-pool generator output identity changed")
    content_sha = cd.calibration_pool_content_sha256(manifest)
    if content_sha != manifest.get("candidate_pool_content_sha256"):
        raise CalibrationError("candidate-pool content identity does not replay")
    return manifest, content_sha, _sha256_file(manifest_path)


def _fixed_roster(auth: str) -> list[dict[str, Any]]:
    roster = []
    for selector, expected_id in zip(ROSTER_SELECTORS, ROSTER_MODEL_IDS):
        config = select_model(selector)
        if config["model_id"] != expected_id:
            raise CalibrationError(
                f"fixed calibration selector {selector} resolved to "
                f"{config['model_id']!r}, expected {expected_id!r}"
            )
        try:
            _validate_provider_effort(config["provider"], auth, CALIBRATION_EFFORT)
        except ValueError as exc:
            raise CalibrationError(str(exc)) from exc
        roster.append(
            {
                "model_id": config["model_id"],
                "provider": config["provider"],
                "transport": _transport_name(config, auth),
                "auth": auth,
                "effort": CALIBRATION_EFFORT,
            }
        )
    return roster


def _ordered_candidate_records(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the one frozen processing order pinned by ``pool_index``."""
    return sorted(
        (
            record
            for record in manifest["puzzles"]
            if record.get("split") == cd.CALIBRATION_CANDIDATE_SPLIT
        ),
        key=lambda record: record["pool_index"],
    )


def _candidate_order_identity(manifest: dict[str, Any]) -> tuple[list[str], str]:
    order = [record["candidate_id"] for record in _ordered_candidate_records(manifest)]
    return order, hashlib.sha256(_canonical_bytes(order)).hexdigest()


def _run_config(
    manifest: dict[str, Any], content_sha: str, manifest_sha: str, *, auth: str
) -> dict[str, Any]:
    candidate_order, candidate_order_sha256 = _candidate_order_identity(manifest)
    return {
        "artifact_schema_version": CALIBRATION_SCHEMA_VERSION,
        "calibration_rule_version": CALIBRATION_RULE_VERSION,
        "dataset_id": manifest["dataset_id"],
        "lang": manifest["lang"],
        "candidate_pool_content_sha256": content_sha,
        "candidate_pool_manifest_sha256": manifest_sha,
        "prompt_version": PROMPT_VERSION,
        "gameplay_prompt_hash_scope": "per_run_opening_prompt_sha256",
        "neutral_prompt_only": True,
        "fresh_context_per_run": True,
        "fresh_stateless_context_per_turn": True,
        "effort": CALIBRATION_EFFORT,
        "cap": CALIBRATION_CAP,
        "initial_runs_per_model": INITIAL_RUNS,
        "extended_runs_per_model": EXTENDED_RUNS,
        "eligibility": {
            "training": {
                "minimum_model_median": ELIGIBLE_MIN_TRIES,
                "maximum_model_median": ELIGIBLE_MAX_TRIES,
                "every_run_must_solve": True,
                "maximum_model_median_spread": None,
            },
            "test": {
                "requires_training_eligibility": True,
                "maximum_model_median_spread": MAX_MODEL_MEDIAN_SPREAD,
            },
        },
        "tiers": {
            tier: {
                "minimum": bounds[0],
                "maximum": bounds[1],
                "training_quota": TIER_QUOTA,
                "test_quota": TIER_QUOTA,
            }
            for tier, bounds in TIER_RANGES.items()
        },
        "balance": {
            "scope": "each tier of each split and each complete split",
            "maximum_category_count_spread": RULE_V2_MAX_CATEGORY_COUNT_SPREAD,
            "fields": {key: list(values) for key, values in BALANCE_FIELDS.items()},
        },
        "sequential_stopping": {
            "candidate_order": candidate_order,
            "candidate_order_sha256": candidate_order_sha256,
            "minimum_initial_paid_units": SELECTED_TOTAL
            * len(ROSTER_MODEL_IDS)
            * INITIAL_RUNS,
            "maximum_initial_paid_units": len(candidate_order)
            * len(ROSTER_MODEL_IDS)
            * INITIAL_RUNS,
            "check_after_each_completed_candidate": True,
            "stop_at_first_feasible_prefix": True,
            "extension_decision_window": {
                "reopen_selected_stopping_candidate_before_finalization": True,
                "additional_runs": EXTENDED_RUNS - INITIAL_RUNS,
            },
        },
        "roster": _fixed_roster(auth),
    }


def _candidate_state(
    record: dict[str, Any], roster: list[dict[str, Any]]
) -> dict[str, Any]:
    return {
        "candidate_id": record["candidate_id"],
        "pool_index": record["pool_index"],
        "path": record["path"],
        "sha256": record["sha256"],
        "sentence": record["sentence"],
        "targets": copy.deepcopy(record["targets"]),
        "models": [
            {
                **copy.deepcopy(model),
                "required_runs": INITIAL_RUNS,
                "extension": None,
                "runs": [],
            }
            for model in roster
        ],
        "summary": {"status": "pending"},
    }


def new_artifact_state(
    manifest_path: Path,
    manifest: dict[str, Any],
    content_sha: str,
    manifest_sha: str,
    *,
    auth: str,
) -> dict[str, Any]:
    config = _run_config(manifest, content_sha, manifest_sha, auth=auth)
    candidates = _ordered_candidate_records(manifest)
    curriculum = [
        record for record in manifest["puzzles"] if record.get("split") == "curriculum"
    ]
    if not candidates:
        raise CalibrationError("candidate pool has no calibration candidates")
    reserved_slugs = sorted(
        target["slug"] for record in curriculum for target in record["targets"]
    )
    if len(reserved_slugs) != len(set(reserved_slugs)):
        raise CalibrationError("candidate-pool curriculum target slugs are not unique")
    state = {
        "config": config,
        "candidate_pool": {
            "manifest_path": str(manifest_path),
            "manifest_sha256": manifest_sha,
            "content_sha256": content_sha,
            "curriculum_puzzle_count": len(curriculum),
            "candidate_count": len(candidates),
            "candidate_order": [record["candidate_id"] for record in candidates],
            "candidate_order_sha256": config["sequential_stopping"][
                "candidate_order_sha256"
            ],
            "reserved_target_slugs": reserved_slugs,
        },
        "started_at": _utc_now(),
        "auth_verifications": [],
        "checkpoint": {
            "sequence": 0,
            "completed_paid_units": 0,
            "completed_prefix_count": 0,
            "next_candidate_id": candidates[0]["candidate_id"],
            "next_pool_index": candidates[0]["pool_index"],
            "updated_at": _utc_now(),
        },
        "candidates": [
            _candidate_state(record, config["roster"]) for record in candidates
        ],
        "selection": {
            "status": "pending",
            "completed_prefix_count": 0,
            "next_candidate_id": candidates[0]["candidate_id"],
            "next_pool_index": candidates[0]["pool_index"],
        },
    }
    _refresh_derived(state)
    update_artifact_hashes(state)
    return state


def dnf_aware_median_tries(runs: list[dict[str, Any]]) -> int | None:
    """Return the middle score with every DNF ordered after numeric scores."""
    if not runs:
        return None
    values = [
        value
        if (isinstance(value, int) and not isinstance(value, bool)) or value is None
        else None
        for run in runs
        for value in (run.get("tries"),)
    ]
    ordered = sorted(
        values,
        key=lambda tries: (tries is None, tries if isinstance(tries, int) else 0),
    )
    return ordered[len(ordered) // 2]


def _tier_for_difficulty(difficulty: int) -> str:
    for tier, (lower, upper) in TIER_RANGES.items():
        if lower <= difficulty <= upper:
            return tier
    raise CalibrationError(f"eligible difficulty {difficulty} has no tier")


def summarize_candidate(candidate: dict[str, Any]) -> dict[str, Any]:
    medians: dict[str, int | None] = {}
    reasons: list[dict[str, Any]] = []
    pending: list[dict[str, Any]] = []
    for model in candidate["models"]:
        model_id = model["model_id"]
        runs = model.get("runs", [])
        required = model.get("required_runs")
        if required not in {INITIAL_RUNS, EXTENDED_RUNS}:
            raise CalibrationError(f"{model_id} has invalid required run count")
        if len(runs) < required:
            pending.append(
                {"model_id": model_id, "completed": len(runs), "required": required}
            )
            continue
        if len(runs) > required:
            raise CalibrationError(f"{model_id} has more runs than requested")

        invalid_values = [
            run.get("tries")
            for run in runs
            if run.get("tries") is not None
            and (
                not isinstance(run.get("tries"), int)
                or isinstance(run.get("tries"), bool)
                or run["tries"] <= 0
            )
        ]
        if invalid_values:
            reasons.append(
                {
                    "code": "invalid_score",
                    "model_id": model_id,
                    "values": invalid_values,
                }
            )
        dnf_runs = [
            index for index, run in enumerate(runs, start=1) if run.get("tries") is None
        ]
        if dnf_runs:
            reasons.append(
                {"code": "dnf", "model_id": model_id, "run_numbers": dnf_runs}
            )
        over_cap = [
            {"run_number": index, "tries": run.get("tries")}
            for index, run in enumerate(runs, start=1)
            if isinstance(run.get("tries"), int)
            and not isinstance(run.get("tries"), bool)
            and run["tries"] > CALIBRATION_CAP
        ]
        if over_cap:
            reasons.append({"code": "over_cap", "model_id": model_id, "runs": over_cap})
        median = dnf_aware_median_tries(runs)
        medians[model_id] = median
        if median is None or not ELIGIBLE_MIN_TRIES <= median <= ELIGIBLE_MAX_TRIES:
            reasons.append(
                {
                    "code": "median_out_of_range",
                    "model_id": model_id,
                    "median_tries": median,
                    "minimum": ELIGIBLE_MIN_TRIES,
                    "maximum": ELIGIBLE_MAX_TRIES,
                }
            )

    if pending:
        return {"status": "pending", "pending": pending}

    numeric_medians = [value for value in medians.values() if isinstance(value, int)]
    spread = max(numeric_medians) - min(numeric_medians) if numeric_medians else None
    if reasons:
        return {
            "status": "rejected",
            "eligible": False,
            "training_eligible": False,
            "test_eligible": False,
            "model_medians": medians,
            "model_median_spread": spread,
            "reasons": reasons,
        }
    difficulty = max(numeric_medians)
    return {
        "status": "eligible",
        "eligible": True,
        "training_eligible": True,
        "test_eligible": spread is not None
        and spread <= MAX_MODEL_MEDIAN_SPREAD,
        "model_medians": medians,
        "model_median_spread": spread,
        "difficulty": difficulty,
        "tier": _tier_for_difficulty(difficulty),
    }


def _target_slugs(candidate: dict[str, Any]) -> set[str]:
    slugs = {target["slug"] for target in candidate["targets"]}
    if len(slugs) != len(candidate["targets"]):
        raise CalibrationError(
            f"candidate {candidate['candidate_id']} contains duplicate target slugs"
        )
    return slugs


def _empty_counts() -> dict[str, dict[str, int]]:
    return {
        field: {category: 0 for category in categories}
        for field, categories in BALANCE_FIELDS.items()
    }


def _add_targets(
    counts: dict[str, dict[str, int]], targets: Iterable[dict[str, Any]], sign: int = 1
) -> None:
    for target in targets:
        for field, categories in BALANCE_FIELDS.items():
            value = target.get(field)
            if field == "gender" and value is None:
                continue
            if value not in categories:
                raise CalibrationError(
                    f"target {target.get('slug')!r} has invalid {field} {value!r}"
                )
            counts[field][value] += sign


def _merge_counts(
    left: dict[str, dict[str, int]], right: dict[str, dict[str, int]]
) -> dict[str, dict[str, int]]:
    merged = _empty_counts()
    for field, categories in BALANCE_FIELDS.items():
        for category in categories:
            merged[field][category] = left[field][category] + right[field][category]
    return merged


def _balanced(counts: dict[str, dict[str, int]]) -> bool:
    return all(
        max(field_counts.values()) - min(field_counts.values())
        <= RULE_V2_MAX_CATEGORY_COUNT_SPREAD
        for field_counts in counts.values()
    )


def _balance_report(counts: dict[str, dict[str, int]]) -> dict[str, Any]:
    return {
        field: {
            "counts": dict(field_counts),
            "spread": max(field_counts.values()) - min(field_counts.values()),
        }
        for field, field_counts in counts.items()
    }


def _counts_signature(counts: dict[str, dict[str, int]]) -> tuple[int, ...]:
    return tuple(
        counts[field][category]
        for field, categories in BALANCE_FIELDS.items()
        for category in categories
    )


def _selection_key(candidate: dict[str, Any], salt: str) -> str:
    return hashlib.sha256(
        f"{salt}:{candidate['candidate_id']}".encode("utf-8")
    ).hexdigest()


def _with_cohort_report(
    selection: dict[str, Any], candidates: list[dict[str, Any]]
) -> dict[str, Any]:
    """Attach the deterministic disposition of the completed prefix and unrun suffix."""
    selected_training_ids = {
        entry["candidate_id"]
        for entry in selection.get("selected_training", [])
    }
    selected_test_ids = {
        entry["candidate_id"] for entry in selection.get("selected_test", [])
    }
    if selected_training_ids & selected_test_ids:
        raise CalibrationError("a candidate was assigned to both frozen splits")
    selected_ids = selected_training_ids | selected_test_ids
    candidate_ids = {candidate["candidate_id"] for candidate in candidates}
    unknown_selected = selected_ids - candidate_ids
    if unknown_selected:
        raise CalibrationError(
            "selection refers to unknown candidates: "
            + ", ".join(sorted(unknown_selected))
        )

    cohorts: dict[str, list[dict[str, Any]]] = {
        cohort: [] for cohort in COHORT_ORDER
    }
    unrun: list[dict[str, Any]] = []
    for candidate in sorted(
        candidates,
        key=lambda row: (row.get("pool_index", sys.maxsize), row["candidate_id"]),
    ):
        candidate_id = candidate["candidate_id"]
        summary = candidate.get("summary", {})
        status = summary.get("status")
        reasons = copy.deepcopy(summary.get("reasons", []))
        if status == "unrun":
            if candidate_id in selected_ids:
                raise CalibrationError(
                    f"unrun candidate {candidate_id} appears in the selection"
                )
            unrun.append(
                {
                    "candidate_id": candidate_id,
                    "pool_index": candidate.get("pool_index"),
                    "path": candidate.get("path"),
                    "sha256": candidate.get("sha256"),
                    "status": "unrun",
                }
            )
            continue
        if status == "eligible":
            if candidate_id in selected_training_ids:
                cohort = "selected_training"
            elif candidate_id in selected_test_ids:
                if not summary.get("test_eligible"):
                    raise CalibrationError(
                        f"test selection contains spread-ineligible candidate {candidate_id}"
                    )
                cohort = "selected_test"
            elif summary.get("test_eligible"):
                cohort = "eligible_unselected"
            else:
                cohort = "training_only_spread"
            if reasons:
                raise CalibrationError(
                    f"eligible candidate {candidate_id} has rejection reasons"
                )
        elif status == "rejected":
            if candidate_id in selected_ids:
                raise CalibrationError(
                    f"rejected candidate {candidate_id} appears in the selection"
                )
            reason_codes = {reason.get("code") for reason in reasons}
            if "invalid_score" in reason_codes:
                raise CalibrationError(
                    f"candidate {candidate_id} has a malformed calibration score"
                )
            unknown_codes = reason_codes - VALID_REJECTION_REASON_CODES
            if not reasons or unknown_codes:
                rendered = ", ".join(sorted(str(code) for code in unknown_codes))
                raise CalibrationError(
                    f"candidate {candidate_id} has unclassifiable rejection reasons"
                    + (f": {rendered}" if rendered else "")
                )
            if reason_codes & CAP_STRESS_REASON_CODES:
                cohort = "cap_stress"
            else:  # Defensive: the accepted code set is deliberately exhaustive above.
                raise CalibrationError(
                    f"candidate {candidate_id} has no deterministic cohort"
                )
        else:
            raise CalibrationError(
                f"candidate {candidate_id} is incomplete and cannot be certified"
            )

        model_run_counts = {
            model["model_id"]: len(model.get("runs", []))
            for model in candidate.get("models", [])
        }
        cohorts[cohort].append(
            {
                "candidate_id": candidate_id,
                "pool_index": candidate.get("pool_index"),
                "path": candidate.get("path"),
                "sha256": candidate.get("sha256"),
                "cohort": cohort,
                "tier": summary.get("tier"),
                "difficulty": summary.get("difficulty"),
                "model_medians": copy.deepcopy(summary.get("model_medians", {})),
                "model_median_spread": summary.get("model_median_spread"),
                "model_run_counts": dict(sorted(model_run_counts.items())),
                "rejection_reasons": reasons,
            }
        )

    return {
        **selection,
        "cohort_report": {
            "schema_version": 1,
            "total_candidates": len(candidates),
            "completed_candidates": sum(len(rows) for rows in cohorts.values()),
            "unrun_candidates": len(unrun),
            "counts": {cohort: len(cohorts[cohort]) for cohort in COHORT_ORDER},
            "cohorts": cohorts,
            "unrun": unrun,
        },
    }


def _tier_combinations(
    candidates: list[dict[str, Any]],
    *,
    reserved_slugs: set[str],
    salt: str,
) -> Iterator[tuple[list[dict[str, Any]], set[str], dict[str, dict[str, int]]]]:
    ordered = sorted(candidates, key=lambda candidate: _selection_key(candidate, salt))
    chosen: list[dict[str, Any]] = []
    used = set(reserved_slugs)
    counts = _empty_counts()
    targets_per_tier = cd.TARGETS_PER_PUZZLE * TIER_QUOTA
    max_pos_category = math.ceil(targets_per_tier / len(cd.POS_VALUES))
    # Under rule v2 POS balance, each gendered POS can occupy at most the POS
    # category bound. Their sum is therefore the safe upper bound for gendered
    # targets before the gender categories themselves are balanced.
    max_gendered_targets = max_pos_category * sum(
        pos in cd.GENDERED_POS for pos in cd.POS_VALUES
    )
    max_per_category = {
        "pos": max_pos_category,
        "gender": math.ceil(max_gendered_targets / len(cd.GENDER_VALUES)),
        "frequency_band": math.ceil(targets_per_tier / 2),
        "semantic_class": math.ceil(targets_per_tier / 2),
    }

    def visit(
        start: int,
    ) -> Iterator[tuple[list[dict[str, Any]], set[str], dict[str, dict[str, int]]]]:
        if len(chosen) == TIER_QUOTA:
            if _balanced(counts):
                yield list(chosen), set(used), copy.deepcopy(counts)
            return
        needed = TIER_QUOTA - len(chosen)
        if len(ordered) - start < needed:
            return
        for index in range(start, len(ordered)):
            candidate = ordered[index]
            slugs = _target_slugs(candidate)
            if slugs & used:
                continue
            _add_targets(counts, candidate["targets"], +1)
            if any(
                any(value > max_per_category[field] for value in field_counts.values())
                for field, field_counts in counts.items()
            ):
                _add_targets(counts, candidate["targets"], -1)
                continue
            chosen.append(candidate)
            used.update(slugs)
            yield from visit(index + 1)
            used.difference_update(slugs)
            chosen.pop()
            _add_targets(counts, candidate["targets"], -1)

    yield from visit(0)


def _tier_role_pairs(
    *,
    training_candidates: list[dict[str, Any]],
    test_candidates: list[dict[str, Any]],
    reserved_slugs: set[str],
    selection_salt: str,
    tier: str,
) -> Iterator[
    tuple[
        list[dict[str, Any]],
        list[dict[str, Any]],
        set[str],
        dict[str, dict[str, int]],
        dict[str, dict[str, int]],
    ]
]:
    """Yield deterministic disjoint balanced training/test choices for one tier."""
    for test_combo, test_used, test_counts in _tier_combinations(
        test_candidates,
        reserved_slugs=reserved_slugs,
        salt=f"{selection_salt}:test:{tier}",
    ):
        test_ids = {candidate["candidate_id"] for candidate in test_combo}
        remaining = [
            candidate
            for candidate in training_candidates
            if candidate["candidate_id"] not in test_ids
            and not (_target_slugs(candidate) & test_used)
        ]
        remaining.sort(
            key=lambda candidate: _selection_key(
                candidate, f"{selection_salt}:training:{tier}"
            )
        )
        if len(remaining) < TIER_QUOTA:
            continue
        if len(remaining) == TIER_QUOTA:
            training_counts = _empty_counts()
            training_used = set(test_used)
            valid = True
            for candidate in remaining:
                slugs = _target_slugs(candidate)
                if slugs & training_used:
                    valid = False
                    break
                training_used.update(slugs)
                _add_targets(training_counts, candidate["targets"])
            if valid and _balanced(training_counts):
                yield (
                    remaining,
                    test_combo,
                    training_used,
                    training_counts,
                    test_counts,
                )
            continue
        for training_combo, training_used, training_counts in _tier_combinations(
            remaining,
            reserved_slugs=test_used,
            salt=f"{selection_salt}:training:{tier}",
        ):
            yield (
                training_combo,
                test_combo,
                training_used,
                training_counts,
                test_counts,
            )


def _split_counts_can_finish(
    counts: dict[str, dict[str, int]], *, completed_tiers: int
) -> bool:
    """Safe feasibility bounds for the still-unselected balanced tiers."""
    remaining = len(TIER_ORDER) - completed_tiers
    total_targets = cd.TARGETS_PER_PUZZLE * SELECTED_PER_SPLIT
    for field in ("pos", "frequency_band", "semantic_class"):
        categories = BALANCE_FIELDS[field]
        final_floor = total_targets // len(categories)
        final_ceiling = math.ceil(total_targets / len(categories))
        per_tier_ceiling = math.ceil(
            cd.TARGETS_PER_PUZZLE * TIER_QUOTA / len(categories)
        )
        for value in counts[field].values():
            if value > final_ceiling:
                return False
            if value + remaining * per_tier_ceiling < final_floor:
                return False
    gender_values = list(counts["gender"].values())
    if len(gender_values) == 2 and abs(gender_values[0] - gender_values[1]) > remaining + 1:
        return False
    return True


def _joint_role_solution(
    training_grouped: dict[str, list[dict[str, Any]]],
    test_grouped: dict[str, list[dict[str, Any]]],
    *,
    reserved_slugs: set[str],
    selection_salt: str,
) -> tuple[
    dict[str, list[dict[str, Any]]],
    dict[str, list[dict[str, Any]]],
    dict[str, dict[str, dict[str, dict[str, int]]]],
] | None:
    selected = {"training": {}, "test": {}}
    tier_counts = {"training": {}, "test": {}}
    overall = {"training": _empty_counts(), "test": _empty_counts()}

    def visit(tier_index: int, used_slugs: set[str]) -> bool:
        nonlocal overall
        if tier_index == len(TIER_ORDER):
            return _balanced(overall["training"]) and _balanced(overall["test"])

        tier = TIER_ORDER[tier_index]
        for (
            training_combo,
            test_combo,
            next_used,
            training_counts,
            test_counts,
        ) in _tier_role_pairs(
            training_candidates=training_grouped[tier],
            test_candidates=test_grouped[tier],
            reserved_slugs=used_slugs,
            selection_salt=selection_salt,
            tier=tier,
        ):
            merged = {
                "training": _merge_counts(overall["training"], training_counts),
                "test": _merge_counts(overall["test"], test_counts),
            }
            if not all(
                _split_counts_can_finish(
                    merged[role], completed_tiers=tier_index + 1
                )
                for role in ("training", "test")
            ):
                continue
            selected["training"][tier] = training_combo
            selected["test"][tier] = test_combo
            tier_counts["training"][tier] = training_counts
            tier_counts["test"][tier] = test_counts
            previous = overall
            overall = merged
            if visit(tier_index + 1, next_used):
                return True
            overall = previous
            del selected["training"][tier]
            del selected["test"][tier]
            del tier_counts["training"][tier]
            del tier_counts["test"][tier]
        return False

    if not visit(0, set(reserved_slugs)):
        return None
    return (
        copy.deepcopy(selected["training"]),
        copy.deepcopy(selected["test"]),
        copy.deepcopy(tier_counts),
    )


def _selected_rows(
    selected_by_tier: dict[str, list[dict[str, Any]]], *, role: str
) -> list[dict[str, Any]]:
    return [
        {
            "candidate_id": candidate["candidate_id"],
            "role": role,
            "tier": tier,
            "difficulty": candidate["summary"]["difficulty"],
            "model_medians": candidate["summary"]["model_medians"],
            "model_median_spread": candidate["summary"]["model_median_spread"],
        }
        for tier in TIER_ORDER
        for candidate in selected_by_tier[tier]
    ]


def select_calibrated_candidates(
    candidates: list[dict[str, Any]],
    *,
    reserved_slugs: set[str],
    selection_salt: str,
) -> dict[str, Any]:
    """Jointly assign the first deterministic balanced 15+15 allocation."""
    training_eligible = [
        candidate
        for candidate in candidates
        if candidate.get("summary", {}).get("training_eligible") is True
    ]
    test_eligible = [
        candidate
        for candidate in training_eligible
        if candidate["summary"].get("test_eligible") is True
    ]
    training_grouped = {
        tier: [candidate for candidate in training_eligible if candidate["summary"]["tier"] == tier]
        for tier in TIER_ORDER
    }
    test_grouped = {
        tier: [candidate for candidate in test_eligible if candidate["summary"]["tier"] == tier]
        for tier in TIER_ORDER
    }
    available = {
        "training": {tier: len(training_grouped[tier]) for tier in TIER_ORDER},
        "test": {tier: len(test_grouped[tier]) for tier in TIER_ORDER},
    }
    deficits = {
        "training_total": {
            tier: max(0, SELECTED_PER_TIER - available["training"][tier])
            for tier in TIER_ORDER
        },
        "test": {
            tier: max(0, TIER_QUOTA - available["test"][tier])
            for tier in TIER_ORDER
        },
    }
    base = {
        "rule_version": CALIBRATION_RULE_VERSION,
        "required_per_tier": {
            "training": TIER_QUOTA,
            "test": TIER_QUOTA,
        },
        "eligible_per_tier": available,
        "balance_constraint": {
            "maximum_category_count_spread": RULE_V2_MAX_CATEGORY_COUNT_SPREAD,
            "scope": "each tier of each split and each complete split",
            "fields": {key: list(values) for key, values in BALANCE_FIELDS.items()},
        },
        "automatic_relaxation": False,
        "test_maximum_model_median_spread": MAX_MODEL_MEDIAN_SPREAD,
        "training_maximum_model_median_spread": None,
        "global_unique_target_slugs_required": True,
        "reserved_curriculum_target_slug_count": len(reserved_slugs),
    }
    if any(value for role in deficits.values() for value in role.values()):
        return _with_cohort_report(
            {
                **base,
                "status": "shortfall",
                "reason": "insufficient_eligible_candidates",
                "tier_deficits": deficits,
            },
            candidates,
        )

    solution = _joint_role_solution(
        training_grouped,
        test_grouped,
        reserved_slugs=reserved_slugs,
        selection_salt=selection_salt,
    )
    if solution is None:
        selected_training = selected_test = selected_counts = None
    else:
        selected_training, selected_test, selected_counts = solution

    if selected_training is None or selected_test is None or selected_counts is None:
        return _with_cohort_report(
            {
                **base,
                "status": "shortfall",
                "reason": "no_balanced_unique_selection",
                "tier_deficits": deficits,
                "shortfall": (
                    "eligible counts meet the role quotas, but no joint 15-training/"
                    "15-test assignment satisfies global target uniqueness and category-"
                    "count spread <= 1 within every split tier and complete split"
                ),
            },
            candidates,
        )

    balance: dict[str, Any] = {}
    for role in ("training", "test"):
        overall = _empty_counts()
        for counts in selected_counts[role].values():
            overall = _merge_counts(overall, counts)
        balance[role] = {
            "tiers": {
                tier: _balance_report(selected_counts[role][tier])
                for tier in TIER_ORDER
            },
            "overall": _balance_report(overall),
        }
    return _with_cohort_report(
        {
            **base,
            "status": "selected",
            "tier_deficits": deficits,
            "selected_training": _selected_rows(
                selected_training, role="training"
            ),
            "selected_test": _selected_rows(selected_test, role="test"),
            "counts": {
                role: {tier: TIER_QUOTA for tier in TIER_ORDER}
                for role in ("training", "test")
            },
            "balance": balance,
        },
        candidates,
    )


def _earliest_prefix_feasibility(
    completed_prefix: list[dict[str, Any]],
    *,
    reserved_slugs: set[str],
    selection_salt: str,
) -> tuple[int | None, dict[str, Any]]:
    """Return the first feasible completed prefix and its exact allocation."""
    first_count = min(SELECTED_TOTAL, len(completed_prefix))
    counts = (
        range(SELECTED_TOTAL, len(completed_prefix) + 1)
        if len(completed_prefix) >= SELECTED_TOTAL
        else (first_count,)
    )
    last: dict[str, Any] | None = None
    for prefix_count in counts:
        feasibility = select_calibrated_candidates(
            completed_prefix[:prefix_count],
            reserved_slugs=reserved_slugs,
            selection_salt=selection_salt,
        )
        feasibility.pop("cohort_report", None)
        last = feasibility
        if feasibility["status"] == "selected":
            return prefix_count, feasibility
    if last is None:
        last = select_calibrated_candidates(
            [], reserved_slugs=reserved_slugs, selection_salt=selection_salt
        )
        last.pop("cohort_report", None)
    return None, last


def _refresh_derived(state: dict[str, Any]) -> None:
    candidates = state["candidates"]
    completed_prefix: list[dict[str, Any]] = []
    incomplete_index: int | None = None

    for index, candidate in enumerate(candidates):
        derived = summarize_candidate(candidate)
        has_work = any(
            model.get("runs")
            or model.get("extension") is not None
            or model.get("required_runs") != INITIAL_RUNS
            for model in candidate["models"]
        )
        if incomplete_index is None and derived["status"] != "pending":
            candidate["summary"] = derived
            completed_prefix.append(candidate)
            continue
        if incomplete_index is None:
            incomplete_index = index
            candidate["summary"] = derived if has_work else {"status": "unrun"}
            continue
        if has_work:
            raise CalibrationError(
                "calibration contains paid work beyond the first incomplete candidate"
            )
        candidate["summary"] = {"status": "unrun"}

    prefix_count = len(completed_prefix)
    next_candidate = candidates[prefix_count] if prefix_count < len(candidates) else None
    state["checkpoint"].update(
        {
            "completed_prefix_count": prefix_count,
            "next_candidate_id": (
                next_candidate["candidate_id"] if next_candidate is not None else None
            ),
            "next_pool_index": (
                next_candidate["pool_index"] if next_candidate is not None else None
            ),
        }
    )

    earliest_prefix_count, feasibility = _earliest_prefix_feasibility(
        completed_prefix,
        reserved_slugs=set(state["candidate_pool"]["reserved_target_slugs"]),
        selection_salt=state["config"]["candidate_pool_content_sha256"],
    )

    if earliest_prefix_count is not None:
        first_late = next(
            (
                candidate
                for candidate in candidates[earliest_prefix_count:]
                if any(model.get("runs") for model in candidate["models"])
            ),
            None,
        )
        if first_late is not None:
            raise CalibrationError(
                "paid work continued beyond the earliest feasible completed prefix "
                f"{earliest_prefix_count}; candidate {first_late['pool_index']} "
                "must remain unrun"
            )
        stopping_candidate = completed_prefix[earliest_prefix_count - 1]
        stopping_checkpoint = max(
            run["checkpoint"]
            for candidate in completed_prefix[:earliest_prefix_count]
            for model in candidate["models"]
            for run in model["runs"]
        )
        selection = {
            **feasibility,
            "completed_prefix_count": earliest_prefix_count,
            "stopping_candidate_id": stopping_candidate["candidate_id"],
            "stopping_pool_index": stopping_candidate["pool_index"],
            "stopping_checkpoint": stopping_checkpoint,
        }
        selection["allocation_sha256"] = hashlib.sha256(
            _canonical_bytes(
                {
                    "rule_version": selection["rule_version"],
                    "completed_prefix_count": earliest_prefix_count,
                    "stopping_candidate_id": selection["stopping_candidate_id"],
                    "stopping_checkpoint": selection["stopping_checkpoint"],
                    "selected_training": selection["selected_training"],
                    "selected_test": selection["selected_test"],
                    "balance": selection["balance"],
                }
            )
        ).hexdigest()
        state["selection"] = _with_cohort_report(selection, candidates)
        return

    if next_candidate is None:
        state["selection"] = _with_cohort_report(
            {
                **feasibility,
                "status": "shortfall",
                "completed_prefix_count": prefix_count,
                "pool_exhausted": True,
                "stopping_checkpoint": state["checkpoint"]["sequence"],
            },
            candidates,
        )
        return

    state["selection"] = {
        "status": "pending",
        "rule_version": CALIBRATION_RULE_VERSION,
        "completed_prefix_count": prefix_count,
        "next_candidate_id": next_candidate["candidate_id"],
        "next_pool_index": next_candidate["pool_index"],
        "next_candidate_status": next_candidate["summary"]["status"],
        "last_completed_prefix_feasibility": feasibility,
    }
    state["selection"]["pending_paid_units"] = len(_pending_units(state))


def _pending_units(
    state: dict[str, Any],
) -> list[tuple[dict[str, Any], dict[str, Any], int]]:
    if state.get("selection", {}).get("status") in {"selected", "shortfall"}:
        return []
    prefix_count = state.get("checkpoint", {}).get("completed_prefix_count", 0)
    if not isinstance(prefix_count, int) or not 0 <= prefix_count < len(
        state["candidates"]
    ):
        return []
    candidate = state["candidates"][prefix_count]
    pending = []
    for model in candidate["models"]:
        for number in range(len(model["runs"]) + 1, model["required_runs"] + 1):
            pending.append((candidate, model, number))
    return pending


def _expected_candidate_core(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "candidate_id": record["candidate_id"],
        "pool_index": record["pool_index"],
        "path": record["path"],
        "sha256": record["sha256"],
        "sentence": record["sentence"],
        "targets": record["targets"],
    }


def _validate_state(
    state: dict[str, Any],
    *,
    manifest_path: Path,
    manifest: dict[str, Any],
    expected_config: dict[str, Any],
) -> None:
    _validate_artifact_hashes(state)
    if state.get("config") != expected_config:
        prior = state.get("config", {})
        differing = sorted(
            key
            for key in set(prior) | set(expected_config)
            if prior.get(key) != expected_config.get(key)
        )
        raise CalibrationError(
            "resume calibration configuration changed " + f"({', '.join(differing)})"
        )
    pool = state.get("candidate_pool", {})
    if pool.get("manifest_path") != str(manifest_path):
        raise CalibrationError("resume artifact points at a different candidate pool")
    records = _ordered_candidate_records(manifest)
    if len(state.get("candidates", [])) != len(records):
        raise CalibrationError("resume artifact candidate count changed")
    expected_order = [record["candidate_id"] for record in records]
    if (
        pool.get("candidate_order") != expected_order
        or pool.get("candidate_order_sha256")
        != expected_config["sequential_stopping"]["candidate_order_sha256"]
    ):
        raise CalibrationError("resume artifact frozen candidate order changed")
    checkpoints: list[int] = []
    extension_records: list[dict[str, Any]] = []
    for candidate, record in zip(state["candidates"], records):
        actual_core = {
            key: candidate.get(key) for key in _expected_candidate_core(record)
        }
        if actual_core != _expected_candidate_core(record):
            raise CalibrationError(
                f"candidate {record['candidate_id']} identity changed on resume"
            )
        if [
            {key: model.get(key) for key in expected}
            for model, expected in zip(candidate["models"], expected_config["roster"])
        ] != expected_config["roster"]:
            raise CalibrationError(
                f"candidate {record['candidate_id']} roster identity changed"
            )
        if len(candidate["models"]) != len(expected_config["roster"]):
            raise CalibrationError("candidate roster length changed")
        for model in candidate["models"]:
            required = model.get("required_runs")
            if required not in {INITIAL_RUNS, EXTENDED_RUNS}:
                raise CalibrationError("artifact has an invalid requested run count")
            if required == INITIAL_RUNS and model.get("extension") is not None:
                raise CalibrationError("three-run result has unexpected extension metadata")
            if required == EXTENDED_RUNS and not isinstance(
                model.get("extension"), dict
            ):
                raise CalibrationError(
                    "five-run result has no recorded extension reason"
                )
            if required == EXTENDED_RUNS and model["extension"].get("reason") not in {
                "unstable",
                "tier_boundary",
            }:
                raise CalibrationError("five-run result has an invalid extension reason")
            if required == EXTENDED_RUNS:
                extension = model["extension"]
                reopened = extension.get("reopened_selection")
                if (
                    not isinstance(extension.get("requested_at"), str)
                    or not extension["requested_at"]
                    or not isinstance(extension.get("requested_checkpoint"), int)
                    or isinstance(extension["requested_checkpoint"], bool)
                    or (
                        reopened is not None
                        and (
                            not isinstance(reopened, dict)
                            or set(reopened)
                            != {
                                "selection_sha256",
                                "stopping_checkpoint",
                                "allocation_sha256",
                            }
                            or not all(
                                isinstance(reopened.get(key), str)
                                and len(reopened[key]) == 64
                                for key in ("selection_sha256", "allocation_sha256")
                            )
                            or not isinstance(reopened.get("stopping_checkpoint"), int)
                        )
                    )
                ):
                    raise CalibrationError("five-run extension audit metadata is malformed")
                extension_records.append(extension)
            runs = model.get("runs")
            if not isinstance(runs, list) or len(runs) > required:
                raise CalibrationError("artifact has an invalid completed run count")
            if [run.get("number") for run in runs] != list(range(1, len(runs) + 1)):
                raise CalibrationError("artifact run numbers are not contiguous")
            checkpoints.extend(run.get("checkpoint") for run in runs)
    if any(not isinstance(value, int) for value in checkpoints):
        raise CalibrationError("artifact run checkpoint is malformed")
    if sorted(checkpoints) != list(range(1, len(checkpoints) + 1)):
        raise CalibrationError("artifact paid-unit checkpoints are not contiguous")
    checkpoint = state.get("checkpoint", {})
    if checkpoint.get("sequence") != len(checkpoints) or checkpoint.get(
        "completed_paid_units"
    ) != len(checkpoints):
        raise CalibrationError(
            "artifact checkpoint count does not match completed runs"
        )
    if any(
        not 0 <= extension["requested_checkpoint"] <= checkpoint["sequence"]
        for extension in extension_records
    ):
        raise CalibrationError("extension request checkpoint is outside the artifact")

    probe = copy.deepcopy(state)
    _refresh_derived(probe)
    if [candidate["summary"] for candidate in probe["candidates"]] != [
        candidate.get("summary") for candidate in state["candidates"]
    ]:
        raise CalibrationError("artifact candidate summaries do not replay")
    if probe["selection"] != state.get("selection"):
        raise CalibrationError("artifact selection report does not replay")
    for field in (
        "completed_prefix_count",
        "next_candidate_id",
        "next_pool_index",
    ):
        if probe["checkpoint"].get(field) != checkpoint.get(field):
            raise CalibrationError(f"artifact checkpoint {field} does not replay")


def _validate_completed_runs(
    state: dict[str, Any], manifest_path: Path, vocab: set[str]
) -> None:
    completed_run_count = sum(
        len(model.get("runs", []))
        for candidate in state["candidates"]
        for model in candidate["models"]
    )
    if completed_run_count:
        verifications = state.get("auth_verifications")
        if not isinstance(verifications, list) or not verifications:
            raise CalibrationError("calibration authentication verification is missing")
        expected_models = {
            row["model_id"]: row for row in state["config"]["roster"]
        }
        for batch in verifications:
            if (
                not isinstance(batch, dict)
                or not isinstance(batch.get("verified_at"), str)
                or not batch["verified_at"]
            ):
                raise CalibrationError(
                    "calibration authentication verification is malformed"
                )
            rows = batch.get("models")
            if (
                not isinstance(rows, list)
                or len(rows) != len(expected_models)
                or {
                    row.get("model_id") for row in rows if isinstance(row, dict)
                }
                != set(expected_models)
            ):
                raise CalibrationError(
                    "calibration authentication verification roster changed"
                )
            for row in rows:
                expected = expected_models[row["model_id"]]
                if row.get("mode") != expected["auth"] or row.get("status") not in {
                    "verified_key_present",
                    "verified",
                }:
                    raise CalibrationError(
                        "calibration authentication verification is incomplete"
                    )

    dataset_dir = manifest_path.parent
    for candidate in state["candidates"]:
        puzzle = load_json(dataset_dir / candidate["path"])
        for model in candidate["models"]:
            for run in model["runs"]:
                tried_word_rows = run.get("tried_words")
                if not isinstance(tried_word_rows, list) or not all(
                    isinstance(word, str) and word for word in tried_word_rows
                ):
                    raise CalibrationError("recorded calibration words are missing")
                tried_words = tuple(tried_word_rows)
                if run.get("counted_tries") != len(tried_words):
                    raise CalibrationError("recorded calibration count/word mismatch")
                cap = run.get("cap")
                if cap != state["config"]["cap"]:
                    raise CalibrationError("recorded calibration cap identity changed")
                turns = run.get("turns")
                if (
                    not isinstance(turns, int)
                    or isinstance(turns, bool)
                    or turns <= 0
                    or turns < len(tried_words)
                ):
                    raise CalibrationError("recorded calibration turn count is malformed")
                for field in ("duration", "wall_duration"):
                    value = run.get(field)
                    if (
                        not isinstance(value, (int, float))
                        or isinstance(value, bool)
                        or not math.isfinite(value)
                        or value < 0
                    ):
                        raise CalibrationError(
                            f"recorded calibration {field} is missing or malformed"
                        )
                token_usage = run.get("turn_token_usage")
                if (
                    not isinstance(token_usage, list)
                    or len(token_usage) != turns
                    or not all(isinstance(item, dict) and item for item in token_usage)
                ):
                    raise CalibrationError(
                        "recorded calibration token usage is missing or incomplete"
                    )
                metrics = derive_run_metrics(puzzle, vocab, tried_words)
                if run.get("metrics") != metrics:
                    raise CalibrationError("recorded calibration rank trace changed")
                expected_tries = len(tried_words) if metrics["solved"] else None
                if run.get("tries") != expected_tries:
                    raise CalibrationError("recorded calibration score does not replay")
                conversation = run.get("conversation")
                if (
                    not isinstance(conversation, list)
                    or not conversation
                    or not all(
                        isinstance(message, dict)
                        and message.get("role") in {"user", "assistant"}
                        and isinstance(message.get("content"), str)
                        and bool(message["content"])
                        for message in conversation
                    )
                    or conversation[0]["role"] != "user"
                    or sum(
                        message["role"] == "assistant" for message in conversation
                    )
                    != turns
                ):
                    raise CalibrationError(
                        "recorded calibration conversation is missing or malformed"
                    )
                opening = conversation[0].get("content")
                if not isinstance(opening, str) or hashlib.sha256(
                    opening.encode("utf-8")
                ).hexdigest() != run.get("opening_prompt_sha256"):
                    raise CalibrationError("recorded neutral prompt identity changed")
                for key in ("model_id", "provider", "transport", "auth", "effort"):
                    if run.get(key) != model[key]:
                        raise CalibrationError(
                            f"recorded calibration run changed {key} identity"
                        )
                if not isinstance(run.get("completed_at"), str) or not run[
                    "completed_at"
                ]:
                    raise CalibrationError(
                        "recorded calibration completion identity is missing"
                    )

                def recorded_reply(messages: list[dict[str, str]]) -> str:
                    if messages != conversation[: len(messages)]:
                        raise CalibrationError(
                            "recorded calibration transcript does not replay"
                        )
                    if len(messages) >= len(conversation):
                        raise CalibrationError(
                            "recorded calibration transcript ended before the run"
                        )
                    response = conversation[len(messages)]
                    if response["role"] != "assistant":
                        raise CalibrationError(
                            "recorded calibration transcript role order changed"
                        )
                    return response["content"]

                try:
                    replayed = play_puzzle(
                        puzzle,
                        vocab,
                        recorded_reply,
                        cap=cap,
                        strategy=None,
                        rules_only=True,
                    )
                except UnparseableReplyError as exc:
                    replayed = getattr(exc, "partial_result", None)
                    termination_reason = "unparseable_replies"
                except NoProgressReplyError as exc:
                    replayed = getattr(exc, "partial_result", None)
                    termination_reason = "no_progress_replies"
                else:
                    termination_reason = "solved" if replayed.tries is not None else "cap"
                if replayed is None:
                    raise CalibrationError(
                        "recorded calibration transcript has no replayable result"
                    )
                if (
                    list(replayed.conversation) != conversation
                    or replayed.tried_words != tried_words
                    or replayed.counted_tries != run["counted_tries"]
                    or replayed.turns != turns
                    or replayed.tries != run["tries"]
                    or run.get("termination_reason") != termination_reason
                ):
                    raise CalibrationError(
                        "recorded calibration transcript result changed on replay"
                    )


def calibration_plan(
    state: dict[str, Any], *, maximum_units: int | None
) -> dict[str, Any]:
    pending = _pending_units(state)
    planned = pending if maximum_units is None else pending[:maximum_units]
    candidate_count = state["candidate_pool"]["candidate_count"]
    declared_extension_units = sum(
        max(0, model["required_runs"] - INITIAL_RUNS)
        for candidate in state["candidates"]
        for model in candidate["models"]
    )
    maximum_remaining = (
        0
        if state["selection"]["status"] in {"selected", "shortfall"}
        else sum(
            model["required_runs"] - len(model["runs"])
            for candidate in state["candidates"]
            for model in candidate["models"]
        )
    )
    next_candidate = (
        {
            "candidate_id": state["checkpoint"]["next_candidate_id"],
            "pool_index": state["checkpoint"]["next_pool_index"],
        }
        if state["checkpoint"].get("next_candidate_id") is not None
        else None
    )
    return {
        "dry_run": True,
        "config": state["config"],
        "candidate_pool": state["candidate_pool"],
        "minimum_initial_paid_units": SELECTED_TOTAL
        * len(ROSTER_MODEL_IDS)
        * INITIAL_RUNS,
        "maximum_initial_paid_units": candidate_count
        * len(ROSTER_MODEL_IDS)
        * INITIAL_RUNS,
        "declared_extension_paid_units": declared_extension_units,
        "maximum_paid_units_with_declared_extensions": candidate_count
        * len(ROSTER_MODEL_IDS)
        * INITIAL_RUNS
        + declared_extension_units,
        "completed_paid_units": state["checkpoint"]["completed_paid_units"],
        "completed_prefix_count": state["checkpoint"]["completed_prefix_count"],
        "next_candidate": next_candidate,
        "pending_paid_units": len(pending),
        "maximum_remaining_paid_units": maximum_remaining,
        "planned_paid_units": [
            {
                "candidate_id": candidate["candidate_id"],
                "pool_index": candidate["pool_index"],
                "model_id": model["model_id"],
                "run_number": number,
            }
            for candidate, model, number in planned
        ],
        "provider_calls": 0,
        "strategy_distillation_calls": 0,
        "final_evaluation_calls": 0,
    }


def _default_artifact_path(output_root: Path, dataset_id: str) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return output_root / dataset_id / f"neutral-calibration.{stamp}.json"


def run_calibration(
    manifest_path: Path,
    *,
    auth: str = "api",
    resume: Path | None = None,
    artifact_path: Path | None = None,
    maximum_units: int | None = 1,
    dry_run: bool = False,
    verbose: bool = False,
    provider_factory: Callable[..., Any] = provider_reply,
    vocab_loader: Callable[[str], set[str]] = load_vocab,
    output_root: Path = OUTPUT_ROOT,
    raise_on_shortfall: bool = True,
) -> Path | dict[str, Any]:
    """Plan or execute fixed neutral calibration, checkpointing every paid run."""
    if maximum_units is not None and (
        not isinstance(maximum_units, int)
        or isinstance(maximum_units, bool)
        or maximum_units <= 0
    ):
        raise CalibrationError("maximum_units must be a positive integer or None")
    manifest_path = manifest_path.resolve()
    manifest, content_sha, manifest_sha = load_candidate_pool(manifest_path)
    expected_config = _run_config(manifest, content_sha, manifest_sha, auth=auth)
    if resume is not None and artifact_path is not None:
        raise CalibrationError("artifact_path cannot be combined with resume")
    if resume is not None:
        destination = resume.resolve()
        state = json.loads(destination.read_text(encoding="utf-8"))
        _validate_state(
            state,
            manifest_path=manifest_path,
            manifest=manifest,
            expected_config=expected_config,
        )
    else:
        destination = (
            artifact_path.resolve()
            if artifact_path is not None
            else _default_artifact_path(output_root, manifest["dataset_id"])
        )
        if destination.exists():
            raise CalibrationError(f"refusing to overwrite artifact {destination}")
        state = new_artifact_state(
            manifest_path,
            manifest,
            content_sha,
            manifest_sha,
            auth=auth,
        )

    if dry_run:
        return calibration_plan(state, maximum_units=maximum_units)

    pending = _pending_units(state)
    vocab: set[str] | None = None
    if resume is not None:
        vocab = vocab_loader(manifest["lang"])
        _validate_completed_runs(state, manifest_path, vocab)
    if not pending:
        if state["selection"].get("status") == "shortfall" and raise_on_shortfall:
            raise CalibrationShortfallError(state["selection"])
        return destination

    if vocab is None:
        vocab = vocab_loader(manifest["lang"])
    if resume is None:
        save_artifact(destination, state)

    api_keys: dict[str, str | None] = {}
    verification_batch = {"verified_at": _utc_now(), "models": []}
    for roster_entry in expected_config["roster"]:
        config = select_model(roster_entry["model_id"])
        api_key, verification = _auth_preflight(config=config, auth=auth, dry_run=False)
        api_keys[config["provider"]] = api_key
        verification_batch["models"].append(
            {"model_id": config["model_id"], **verification}
        )
    state["auth_verifications"].append(verification_batch)
    save_artifact(destination, state)

    budget = math.inf if maximum_units is None else maximum_units
    executed = 0
    while executed < budget:
        pending = _pending_units(state)
        if not pending:
            break
        candidate, model, run_number = pending[0]
        config = select_model(model["model_id"])
        if verbose:
            print(
                f"[calibration] START candidate {candidate['pool_index']} "
                f"{model['model_id']} run {run_number}/{model['required_runs']}",
                flush=True,
            )
        completed = _play_once(
            puzzle=load_json(manifest_path.parent / candidate["path"]),
            vocab=vocab,
            strategy=None,
            config=config,
            api_key=api_keys[config["provider"]],
            play_effort=CALIBRATION_EFFORT,
            auth=auth,
            cap=CALIBRATION_CAP,
            provider_factory=provider_factory,
            on_try=(
                lambda progress: (
                    print(
                        f"[calibration] try={progress.number} word="
                        f"{json.dumps(progress.word, ensure_ascii=False)} "
                        f"progress={progress.progress:.2f}%",
                        flush=True,
                    )
                    if verbose
                    else None
                )
            ),
        )
        checkpoint = state["checkpoint"]["sequence"] + 1
        conversation = completed.get("conversation", [])
        opening = conversation[0]["content"] if conversation else ""
        completed.update(
            {
                "number": run_number,
                "model_id": model["model_id"],
                "provider": model["provider"],
                "transport": model["transport"],
                "auth": model["auth"],
                "effort": model["effort"],
                "cap": CALIBRATION_CAP,
                "opening_prompt_sha256": hashlib.sha256(
                    opening.encode("utf-8")
                ).hexdigest(),
                "checkpoint": checkpoint,
                "completed_at": _utc_now(),
            }
        )
        model["runs"].append(completed)
        state["checkpoint"].update(
            {
                "sequence": checkpoint,
                "completed_paid_units": checkpoint,
                "updated_at": _utc_now(),
            }
        )
        _refresh_derived(state)
        if state["selection"]["status"] in {"selected", "shortfall"}:
            state["completed_at"] = _utc_now()
        save_artifact(destination, state)
        executed += 1
        if verbose:
            score = completed["tries"] if completed["tries"] is not None else "DNF"
            print(
                f"[calibration] DONE checkpoint {checkpoint} score={score}", flush=True
            )

    if state["selection"]["status"] == "shortfall":
        if raise_on_shortfall:
            raise CalibrationShortfallError(state["selection"])
    return destination


def _validate_extension_source(state: dict[str, Any]) -> None:
    """Reject legacy/incompatible artifacts before extension can mutate them."""
    config = state.get("config")
    if not isinstance(config, dict):
        raise CalibrationError("extension artifact has no calibration configuration")
    expected_versions = {
        "artifact_schema_version": CALIBRATION_SCHEMA_VERSION,
        "calibration_rule_version": CALIBRATION_RULE_VERSION,
        "prompt_version": PROMPT_VERSION,
    }
    incompatible = [
        key for key, value in expected_versions.items() if config.get(key) != value
    ]
    if incompatible:
        raise CalibrationError(
            "extension refuses a legacy or incompatible calibration artifact "
            f"({', '.join(incompatible)})"
        )

    roster = config.get("roster")
    auth_modes = {
        row.get("auth") for row in roster if isinstance(row, dict)
    } if isinstance(roster, list) else set()
    if len(auth_modes) != 1 or not all(isinstance(value, str) for value in auth_modes):
        raise CalibrationError("extension artifact calibration auth identity is malformed")
    manifest_value = state.get("candidate_pool", {}).get("manifest_path")
    if not isinstance(manifest_value, str) or not manifest_value:
        raise CalibrationError("extension artifact candidate-pool path is missing")
    manifest_path = Path(manifest_value)
    if not manifest_path.is_file():
        raise CalibrationError(
            "extension needs the original candidate-pool manifest for identity validation"
        )
    manifest, content_sha, manifest_sha = load_candidate_pool(manifest_path)
    expected_config = _run_config(
        manifest, content_sha, manifest_sha, auth=next(iter(auth_modes))
    )
    _validate_state(
        state,
        manifest_path=manifest_path,
        manifest=manifest,
        expected_config=expected_config,
    )


def request_extension(
    artifact_path: Path,
    *,
    candidate_selector: str,
    model_selector: str,
    reason: str,
) -> Path:
    """Record an auditable 3->5 run extension without making a provider call."""
    if reason not in {"unstable", "tier_boundary"}:
        raise CalibrationError("extension reason must be unstable or tier_boundary")
    state = json.loads(artifact_path.read_text(encoding="utf-8"))
    _validate_artifact_hashes(state)
    if state.get("finalization") is not None:
        raise CalibrationError("extension cannot change a finalized calibration artifact")
    seal_path = _finalization_seal_path(artifact_path)
    if seal_path.exists():
        try:
            seal = json.loads(seal_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise CalibrationError("calibration finalization seal is malformed") from exc
        if seal.get("run_artifact_file_sha256") != _sha256_file(artifact_path):
            raise CalibrationError(
                "calibration artifact does not match its finalization seal"
            )
        raise CalibrationError("extension cannot change a finalized calibration artifact")
    _validate_extension_source(state)
    selection_status = state.get("selection", {}).get("status")
    if selection_status == "shortfall":
        raise CalibrationError(
            "extension cannot change a calibration experiment after its stopping check"
        )
    matches = [
        candidate
        for candidate in state["candidates"]
        if candidate_selector
        in {candidate["candidate_id"], str(candidate["pool_index"])}
    ]
    if len(matches) != 1:
        raise CalibrationError(
            f"candidate selector {candidate_selector!r} matched {len(matches)} candidates"
        )
    candidate = matches[0]
    candidate_index = state["candidates"].index(candidate)
    if selection_status == "selected" and candidate["candidate_id"] != state[
        "selection"
    ].get("stopping_candidate_id"):
        raise CalibrationError(
            "a selected calibration can reopen only its stopping candidate"
        )
    if any(
        model.get("runs")
        for later in state["candidates"][candidate_index + 1 :]
        for model in later["models"]
    ):
        raise CalibrationError(
            "extension cannot be declared after a later candidate has paid work"
        )
    requested_model = select_model(model_selector)["model_id"]
    models = [
        model for model in candidate["models"] if model["model_id"] == requested_model
    ]
    if len(models) != 1:
        raise CalibrationError(
            f"model {requested_model} is not in the calibration roster"
        )
    model = models[0]
    if model["required_runs"] == EXTENDED_RUNS:
        if model.get("extension", {}).get("reason") != reason:
            raise CalibrationError("model already has a different extension reason")
        return artifact_path
    if len(model["runs"]) != INITIAL_RUNS:
        raise CalibrationError(
            "extension can be requested only after exactly three completed runs"
        )
    reopened_selection = None
    if selection_status == "selected":
        reopened_selection = {
            "selection_sha256": state["hashes"]["selection_sha256"],
            "stopping_checkpoint": state["selection"]["stopping_checkpoint"],
            "allocation_sha256": state["selection"]["allocation_sha256"],
        }
    model["required_runs"] = EXTENDED_RUNS
    model["extension"] = {
        "reason": reason,
        "requested_at": _utc_now(),
        "requested_checkpoint": state["checkpoint"]["sequence"],
        "reopened_selection": reopened_selection,
    }
    state.pop("completed_at", None)
    _refresh_derived(state)
    state["checkpoint"]["updated_at"] = _utc_now()
    save_artifact(artifact_path, state)
    return artifact_path


def _manifest_balance(records: list[dict[str, Any]]) -> dict[str, Any]:
    counts = _empty_counts()
    _add_targets(counts, (target for record in records for target in record["targets"]))
    return {
        "verified": {
            "pos": counts["pos"],
            "gender": counts["gender"],
            "frequency_band": counts["frequency_band"],
        },
        "declared": {"semantic_class": counts["semantic_class"]},
    }


def _all_runs_solved_within_cap(candidate: dict[str, Any]) -> bool:
    runs = [run for model in candidate["models"] for run in model["runs"]]
    return bool(runs) and all(
        isinstance(run.get("tries"), int)
        and not isinstance(run["tries"], bool)
        and 0 < run["tries"] <= CALIBRATION_CAP
        for run in runs
    )


TRAINING_RUN_EVIDENCE_SCHEMA_VERSION = MODEL_RUN_EVIDENCE_SCHEMA_VERSION


def _json_file_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _write_atomic(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(content)
    tmp.replace(path)


def _finalization_seal_path(artifact_path: Path) -> Path:
    return artifact_path.with_suffix(artifact_path.suffix + ".finalization.json")


def _write_finalization_seal(artifact_path: Path, artifact_file_sha256: str) -> Path:
    path = _finalization_seal_path(artifact_path)
    content = _json_file_bytes(
        {
            "schema_version": 1,
            "kind": "calibration_finalization_seal",
            "run_artifact_file_sha256": artifact_file_sha256,
        }
    )
    if path.exists():
        if path.read_bytes() != content:
            raise CalibrationError(
                "existing calibration finalization seal has a different identity"
            )
        return path
    _write_atomic(path, content)
    return path


def _role_selection_sha256(rows: list[dict[str, Any]]) -> str:
    return hashlib.sha256(_canonical_bytes(rows)).hexdigest()


def _rejected_reply_events(
    puzzle: dict[str, Any], vocab: set[str], conversation: list[dict[str, str]]
) -> tuple[list[dict[str, Any]], list[str]]:
    """Replay assistant replies into compact non-counting events and counted words."""
    referee = PuzzleReferee(puzzle, vocab)
    events: list[dict[str, Any]] = []
    counted: list[str] = []
    turn = 0
    for message in conversation:
        if message["role"] != "assistant":
            continue
        turn += 1
        reply = message["content"]
        guess = parse_single_word(reply, lang=referee.lang)
        if guess is None:
            events.append({"turn": turn, "kind": "malformed", "reply": reply})
            continue
        feedback = referee.submit(guess)
        if feedback.kind == "counted":
            counted.append(guess)
            continue
        events.append(
            {
                "turn": turn,
                "kind": feedback.kind,
                "reply": reply,
                "guess": guess,
                "folded": feedback.folded,
            }
        )
    return events, counted


def _training_run_view(
    run: dict[str, Any], *, puzzle: dict[str, Any], vocab: set[str]
) -> dict[str, Any]:
    """Project a raw audit run into complete, compact distillation evidence."""
    metrics = run["metrics"]
    trace = metrics.get("guess_trace")
    if not isinstance(trace, list):
        raise CalibrationError("training run has no replayable guess trajectory")
    trajectory = []
    for step in trace:
        current = step.get("current_best_ranks")
        if not isinstance(current, dict):
            raise CalibrationError("training run trajectory has no current ranks")
        projected = copy.deepcopy(step)
        projected["solved_locks"] = sorted(
            int(number) for number, rank in current.items() if rank == 0
        )
        trajectory.append(projected)

    rejected_events, counted = _rejected_reply_events(
        puzzle, vocab, run["conversation"]
    )
    if counted != run["tried_words"] or len(trajectory) != run["counted_tries"]:
        raise CalibrationError("training run compact trajectory does not replay")
    if len(rejected_events) + len(counted) != run["turns"]:
        raise CalibrationError("training run compact reply events do not match turns")
    compact_metrics = {
        key: copy.deepcopy(value)
        for key, value in metrics.items()
        if key != "guess_trace"
    }
    return {
        key: copy.deepcopy(run[key])
        for key in (
            "number",
            "model_id",
            "provider",
            "transport",
            "auth",
            "effort",
            "cap",
            "tries",
            "counted_tries",
            "turns",
            "termination_reason",
            "opening_prompt_sha256",
        )
    } | {
        "counted_guesses": copy.deepcopy(run["tried_words"]),
        "trajectory": trajectory,
        "rejected_events": rejected_events,
        "metrics": compact_metrics,
    }


def _training_evidence_document(
    *,
    model_id: str,
    selected_rows: list[dict[str, Any]],
    candidates_by_id: dict[str, dict[str, Any]],
    training_selection_sha256: str,
    prompt_version: str,
    dataset_dir: Path,
    vocab: set[str],
) -> dict[str, Any]:
    puzzles = []
    for row in selected_rows:
        candidate = candidates_by_id[row["candidate_id"]]
        models = [
            model for model in candidate["models"] if model["model_id"] == model_id
        ]
        if len(models) != 1:
            raise CalibrationError(
                f"training evidence cannot isolate calibration model {model_id}"
            )
        model = models[0]
        puzzle = load_json(dataset_dir / candidate["path"])
        puzzles.append(
            {
                "candidate_id": candidate["candidate_id"],
                "source_sha256": candidate["sha256"],
                "tier": row["tier"],
                "difficulty": row["difficulty"],
                "extension": copy.deepcopy(model.get("extension")),
                "runs": [
                    _training_run_view(run, puzzle=puzzle, vocab=vocab)
                    for run in model["runs"]
                ],
            }
        )
    return {
        "schema_version": TRAINING_RUN_EVIDENCE_SCHEMA_VERSION,
        "calibration_rule_version": CALIBRATION_RULE_VERSION,
        "prompt_version": prompt_version,
        "model_id": model_id,
        "training_selection_sha256": training_selection_sha256,
        "puzzle_count": len(puzzles),
        "run_count": sum(len(puzzle["runs"]) for puzzle in puzzles),
        "puzzles": puzzles,
    }


def _split_record(
    *,
    pool_record: dict[str, Any],
    candidate: dict[str, Any],
    selection_row: dict[str, Any],
    number: int,
    split: str,
) -> dict[str, Any]:
    record = copy.deepcopy(pool_record)
    record.pop("pool_index", None)
    record.pop("candidate_id", None)
    record["number"] = number
    record["split"] = split
    record["calibration"] = {
        "candidate_id": selection_row["candidate_id"],
        "role": selection_row["role"],
        "tier": selection_row["tier"],
        "difficulty": selection_row["difficulty"],
        "model_medians": selection_row["model_medians"],
        "model_median_spread": selection_row["model_median_spread"],
        "model_run_counts": {
            model["model_id"]: len(model["runs"]) for model in candidate["models"]
        },
        "all_runs_solved_within_cap": _all_runs_solved_within_cap(candidate),
    }
    return record


def _role_provenance(
    *,
    role: str,
    pool_manifest: dict[str, Any],
    pool_content_sha256: str,
    selection_rows: list[dict[str, Any]],
    selection_sha256: str,
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "kind": "calibration_split_provenance",
        "role": role,
        "candidate_pool": {
            "dataset_id": pool_manifest["dataset_id"],
            "content_sha256": pool_content_sha256,
        },
        "selection_sha256": selection_sha256,
        "selected": [
            {
                "candidate_id": row["candidate_id"],
                "tier": row["tier"],
                "difficulty": row["difficulty"],
            }
            for row in selection_rows
        ],
    }


def _resolve_split_destination(
    pool_manifest_path: Path, value: Path | None, default_name: str
) -> Path:
    destination = (
        pool_manifest_path.with_name(default_name)
        if value is None
        else (value if value.is_absolute() else pool_manifest_path.parent / value)
    ).resolve()
    if destination.parent != pool_manifest_path.parent:
        raise CalibrationError(
            "final split manifests must stay beside the candidate pool and puzzle files"
        )
    if destination == pool_manifest_path:
        raise CalibrationError("final split manifest must not overwrite the candidate pool")
    return destination


def finalize_manifests(
    pool_manifest_path: Path,
    artifact_path: Path,
    *,
    training_out: Path | None = None,
    test_out: Path | None = None,
    certified_artifact_out: Path | None = None,
    vocab_loader: Callable[[str], set[str]] = load_vocab,
) -> dict[str, Path]:
    """Certify and write isolated training/test views plus the full lab receipt."""
    pool_manifest_path = pool_manifest_path.resolve()
    artifact_path = artifact_path.resolve()
    manifest, content_sha, manifest_sha = load_candidate_pool(pool_manifest_path)
    artifact_bytes = artifact_path.read_bytes()
    state = json.loads(artifact_bytes.decode("utf-8"))
    artifact_file_sha256 = hashlib.sha256(artifact_bytes).hexdigest()
    expected = _run_config(
        manifest,
        content_sha,
        manifest_sha,
        auth=state.get("config", {}).get("roster", [{}])[0].get("auth", ""),
    )
    _validate_state(
        state,
        manifest_path=pool_manifest_path,
        manifest=manifest,
        expected_config=expected,
    )
    vocab = vocab_loader(manifest["lang"])
    _validate_completed_runs(state, pool_manifest_path, vocab)
    if not isinstance(state.get("completed_at"), str) or not state["completed_at"]:
        raise CalibrationError("calibration artifact is not marked complete")
    selection = state["selection"]
    if selection.get("status") != "selected":
        raise CalibrationError("calibration has no complete selected set")
    training_rows = selection.get("selected_training", [])
    test_rows = selection.get("selected_test", [])
    for role, rows in (("training", training_rows), ("test", test_rows)):
        if len(rows) != SELECTED_PER_SPLIT:
            raise CalibrationError(f"calibration {role} selection is not 15 puzzles")
        if {
            tier: sum(row["tier"] == tier for row in rows) for tier in TIER_ORDER
        } != {tier: TIER_QUOTA for tier in TIER_ORDER}:
            raise CalibrationError(f"calibration {role} selection is not 5/5/5")
    if {row["candidate_id"] for row in training_rows} & {
        row["candidate_id"] for row in test_rows
    }:
        raise CalibrationError("training and test selections overlap")

    by_id = {candidate["candidate_id"]: candidate for candidate in state["candidates"]}
    pool_by_id = {
        record["candidate_id"]: record
        for record in manifest["puzzles"]
        if record.get("split") == cd.CALIBRATION_CANDIDATE_SPLIT
    }
    for row in training_rows + test_rows:
        candidate = by_id[row["candidate_id"]]
        if not _all_runs_solved_within_cap(candidate):
            raise CalibrationError(
                f"selected candidate {row['candidate_id']} has a non-solving run"
            )
        if row["role"] == "test" and not candidate["summary"].get("test_eligible"):
            raise CalibrationError(
                f"test candidate {row['candidate_id']} violates the spread boundary"
            )

    training_records = [
        _split_record(
            pool_record=pool_by_id[row["candidate_id"]],
            candidate=by_id[row["candidate_id"]],
            selection_row=row,
            number=number,
            split="curriculum",
        )
        for number, row in enumerate(training_rows, start=1)
    ]
    test_records = [
        _split_record(
            pool_record=pool_by_id[row["candidate_id"]],
            candidate=by_id[row["candidate_id"]],
            selection_row=row,
            number=number,
            split="holdout",
        )
        for number, row in enumerate(test_rows, start=1)
    ]

    training_destination = _resolve_split_destination(
        pool_manifest_path, training_out, "training-manifest.json"
    )
    test_destination = _resolve_split_destination(
        pool_manifest_path, test_out, "test-manifest.json"
    )
    if training_destination == test_destination:
        raise CalibrationError("training and test manifests need different paths")

    training_selection_sha256 = _role_selection_sha256(training_rows)
    test_selection_sha256 = _role_selection_sha256(test_rows)
    evidence_records: dict[str, dict[str, Any]] = {}
    evidence_paths: dict[str, Path] = {}
    for model_id in ROSTER_MODEL_IDS:
        document = _training_evidence_document(
            model_id=model_id,
            selected_rows=training_rows,
            candidates_by_id=by_id,
            training_selection_sha256=training_selection_sha256,
            prompt_version=state["config"]["prompt_version"],
            dataset_dir=pool_manifest_path.parent,
            vocab=vocab,
        )
        content = _canonical_bytes(document)
        path = pool_manifest_path.parent / "training-evidence" / f"{model_id}.json.gz"
        write_deterministic_gzip(path, content)
        evidence_paths[model_id] = path
        evidence_records[model_id] = {
            "schema_version": document["schema_version"],
            "path": path.relative_to(pool_manifest_path.parent).as_posix(),
            "sha256": sha256_bytes(content),
            "puzzle_count": document["puzzle_count"],
            "run_count": document["run_count"],
        }

    training_provenance_path = pool_manifest_path.with_name(
        "training-provenance.json"
    )
    test_provenance_path = pool_manifest_path.with_name("test-provenance.json")
    training_provenance_bytes = _json_file_bytes(
        _role_provenance(
            role="training",
            pool_manifest=manifest,
            pool_content_sha256=content_sha,
            selection_rows=training_rows,
            selection_sha256=training_selection_sha256,
        )
    )
    test_provenance_bytes = _json_file_bytes(
        _role_provenance(
            role="test",
            pool_manifest=manifest,
            pool_content_sha256=content_sha,
            selection_rows=test_rows,
            selection_sha256=test_selection_sha256,
        )
    )
    _write_atomic(training_provenance_path, training_provenance_bytes)
    _write_atomic(test_provenance_path, test_provenance_bytes)

    common = {
        "schema_version": cd.CALIBRATED_DATASET_SCHEMA_VERSION,
        "lang": manifest["lang"],
        "seed": manifest["seed"],
        "generator": manifest["generator"],
        "vocabulary": manifest["vocabulary"],
        "embedding": manifest["embedding"],
        "canonical_metadata": manifest["canonical_metadata"],
        "frequency_bands": manifest["frequency_bands"],
        "start_band": manifest["start_band"],
    }
    calibration_common = {
            "schema_version": CALIBRATION_SCHEMA_VERSION,
            "rule_version": CALIBRATION_RULE_VERSION,
            "artifact_sha256": state["hashes"]["artifact_sha256"],
            "run_artifact_sha256": state["hashes"]["artifact_sha256"],
            "artifact_file_sha256": artifact_file_sha256,
            "run_artifact_file_sha256": artifact_file_sha256,
            "content_sha256": state["hashes"]["content_sha256"],
            "selection_sha256": state["hashes"]["selection_sha256"],
            "allocation_sha256": selection["allocation_sha256"],
            "candidate_pool_content_sha256": content_sha,
            "candidate_order_sha256": state["candidate_pool"][
                "candidate_order_sha256"
            ],
            "completed_prefix_count": selection["completed_prefix_count"],
            "stopping_candidate_id": selection["stopping_candidate_id"],
            "stopping_pool_index": selection["stopping_pool_index"],
            "stopping_checkpoint": selection["stopping_checkpoint"],
            "prompt_version": state["config"]["prompt_version"],
            "roster": copy.deepcopy(state["config"]["roster"]),
            "effort": CALIBRATION_EFFORT,
            "cap": CALIBRATION_CAP,
            "initial_runs_per_model": INITIAL_RUNS,
            "extended_runs_per_model": EXTENDED_RUNS,
            "lab_only": True,
    }

    training = {
        **copy.deepcopy(common),
        "manifest_kind": cd.CALIBRATION_TRAINING_MANIFEST_KIND,
        "dataset_id": f"{manifest['dataset_id']}-training",
        "generator_output": {
            "path": training_provenance_path.name,
            "sha256": sha256_bytes(training_provenance_bytes),
        },
        "counts": {"puzzles": SELECTED_PER_SPLIT, "curriculum": SELECTED_PER_SPLIT, "holdout": 0},
        "balance": copy.deepcopy(selection["balance"]["training"]),
        "calibration": {
            **copy.deepcopy(calibration_common),
            "role": "training",
            "split_selection_sha256": training_selection_sha256,
            "selected_tier_counts": {tier: TIER_QUOTA for tier in TIER_ORDER},
        },
        "strategy_evidence": {
            "schema_version": PACKET_SCHEMA_VERSION,
            "dataset_id": f"{manifest['dataset_id']}-training",
            "training_selection_sha256": training_selection_sha256,
            "calibration_roster_model_ids": list(ROSTER_MODEL_IDS),
            "model_run_evidence": evidence_records,
            "non_roster_model_evidence": "static_training_puzzles_only",
        },
        "puzzles": training_records,
        "generated_at": state["completed_at"],
    }
    training["dataset_content_sha256"] = cd.dataset_content_sha256(training)
    training["strategy_evidence"]["dataset_content_sha256"] = training[
        "dataset_content_sha256"
    ]
    if cd.dataset_content_sha256(training) != training["dataset_content_sha256"]:
        raise CalibrationError("training manifest content identity is not stable")
    training_bytes = _json_file_bytes(training)
    _write_atomic(training_destination, training_bytes)
    training_file_sha256 = sha256_bytes(training_bytes)

    test = {
        **copy.deepcopy(common),
        "manifest_kind": cd.CALIBRATION_TEST_MANIFEST_KIND,
        "dataset_id": f"{manifest['dataset_id']}-test",
        "generator_output": {
            "path": test_provenance_path.name,
            "sha256": sha256_bytes(test_provenance_bytes),
        },
        "counts": {"puzzles": SELECTED_PER_SPLIT, "curriculum": 0, "holdout": SELECTED_PER_SPLIT},
        "balance": copy.deepcopy(selection["balance"]["test"]),
        "calibration": {
            **copy.deepcopy(calibration_common),
            "role": "test",
            "split_selection_sha256": test_selection_sha256,
            "selected_tier_counts": {tier: TIER_QUOTA for tier in TIER_ORDER},
        },
        "strategy_evidence": {
            "schema_version": PACKET_SCHEMA_VERSION,
            "dataset_id": training["dataset_id"],
            "dataset_content_sha256": training["dataset_content_sha256"],
            "training_manifest_file_sha256": training_file_sha256,
            "training_selection_sha256": training_selection_sha256,
            "model_specific": True,
        },
        "puzzles": test_records,
        "generated_at": state["completed_at"],
    }
    test["dataset_content_sha256"] = cd.dataset_content_sha256(test)
    test_bytes = _json_file_bytes(test)
    _write_atomic(test_destination, test_bytes)
    test_file_sha256 = sha256_bytes(test_bytes)

    certified_destination = (
        artifact_path.with_name(f"{artifact_path.stem}.finalized.json")
        if certified_artifact_out is None
        else certified_artifact_out.resolve()
    )
    if certified_destination == artifact_path:
        raise CalibrationError("certified artifact must not overwrite the paid-run artifact")
    certified_state = copy.deepcopy(state)
    certified_state["finalization"] = {
        "schema_version": 1,
        "finalized_at": _utc_now(),
        "run_artifact_path": str(artifact_path),
        "run_artifact_file_sha256": artifact_file_sha256,
        "training_manifest": {
            "path": str(training_destination),
            "dataset_content_sha256": training["dataset_content_sha256"],
            "file_sha256": training_file_sha256,
        },
        "test_manifest": {
            "path": str(test_destination),
            "dataset_content_sha256": test["dataset_content_sha256"],
            "file_sha256": test_file_sha256,
        },
        "training_selection_sha256": training_selection_sha256,
        "test_selection_sha256": test_selection_sha256,
        "model_training_evidence": copy.deepcopy(evidence_records),
    }
    save_artifact(certified_destination, certified_state)
    finalization_seal = _write_finalization_seal(
        artifact_path, artifact_file_sha256
    )

    return {
        "training_manifest": training_destination,
        "test_manifest": test_destination,
        "certified_artifact": certified_destination,
        "finalization_seal": finalization_seal,
        **{
            f"training_evidence_{model_id}": path
            for model_id, path in evidence_paths.items()
        },
    }


def finalize_manifest(
    pool_manifest_path: Path,
    artifact_path: Path,
    *,
    out_path: Path | None = None,
    vocab_loader: Callable[[str], set[str]] = load_vocab,
) -> Path:
    """Compatibility wrapper returning the test view while still writing both views."""
    return finalize_manifests(
        pool_manifest_path,
        artifact_path,
        test_out=out_path,
        vocab_loader=vocab_loader,
    )["test_manifest"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    run_parser = sub.add_parser("run", help="plan or run neutral calibration")
    run_parser.add_argument("candidate_manifest", type=Path)
    run_parser.add_argument("--auth", choices=("api", "subscription"), default="api")
    run_parser.add_argument("--resume", type=Path)
    run_parser.add_argument("--artifact", type=Path)
    units = run_parser.add_mutually_exclusive_group()
    units.add_argument("--max-units", type=int, default=1)
    units.add_argument("--all", action="store_true")
    run_parser.add_argument("--dry-run", action="store_true")
    run_parser.add_argument("-v", "--verbose", action="store_true")

    extend_parser = sub.add_parser("extend", help="request two additional neutral runs")
    extend_parser.add_argument("artifact", type=Path)
    extend_parser.add_argument("--candidate", required=True)
    extend_parser.add_argument("--model", required=True)
    extend_parser.add_argument(
        "--reason", required=True, choices=("unstable", "tier_boundary")
    )

    finalize_parser = sub.add_parser(
        "finalize", help="write isolated training/test manifests and certification"
    )
    finalize_parser.add_argument("candidate_manifest", type=Path)
    finalize_parser.add_argument("artifact", type=Path)
    finalize_parser.add_argument("--training-out", type=Path)
    finalize_parser.add_argument("--test-out", type=Path)
    finalize_parser.add_argument("--certified-artifact-out", type=Path)

    args = parser.parse_args(argv)
    if args.command == "run":
        maximum_units = None if args.all else args.max_units
        try:
            result = run_calibration(
                resolve_path(args.candidate_manifest),
                auth=args.auth,
                resume=resolve_path(args.resume) if args.resume else None,
                artifact_path=(
                    resolve_path(args.artifact, destination=True)
                    if args.artifact
                    else None
                ),
                maximum_units=maximum_units,
                dry_run=args.dry_run,
                verbose=args.verbose,
            )
        except CalibrationShortfallError as exc:
            print(json.dumps(exc.report, ensure_ascii=False, indent=2), file=sys.stderr)
            return 2
        if isinstance(result, dict):
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            state = json.loads(result.read_text(encoding="utf-8"))
            print(
                f"calibration artifact: {result} "
                f"({state['checkpoint']['completed_paid_units']} paid units; "
                f"selection={state['selection']['status']})"
            )
        return 0
    if args.command == "extend":
        result = request_extension(
            resolve_path(args.artifact),
            candidate_selector=args.candidate,
            model_selector=args.model,
            reason=args.reason,
        )
        print(f"calibration extension recorded: {result}")
        return 0
    result = finalize_manifests(
        resolve_path(args.candidate_manifest),
        resolve_path(args.artifact),
        training_out=args.training_out,
        test_out=args.test_out,
        certified_artifact_out=args.certified_artifact_out,
    )
    print(
        json.dumps(
            {key: str(path) for key, path in result.items()},
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
