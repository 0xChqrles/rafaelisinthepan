"""Deterministic neutral-play holdout calibration (#86).

Calibration is a separate, selection-only experiment.  It plays every candidate
with the fixed Sonnet/GPT roster under the ordinary neutral referee, checkpoints
one completed puzzle run at a time, derives DNF-aware difficulty, and selects a
strictly balanced 5/5/5 holdout.  It never builds evidence, distils a strategy, or
runs the final neutral/learned/v7 evaluation.
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
from curriculum_io import load_json, read_data_bytes, sha256_bytes  # noqa: E402
from curriculum_run import (  # noqa: E402
    CurriculumError,
    _auth_preflight,
    _play_once,
    derive_run_metrics,
)
from llm_play import (  # noqa: E402
    NoProgressReplyError,
    PROMPT_VERSION,
    UnparseableReplyError,
    _transport_name,
    _validate_provider_effort,
    load_vocab,
    play_puzzle,
    provider_reply,
    select_model,
)
from strategy_evidence import (  # noqa: E402
    PACKET_SCHEMA_VERSION,
    build_evidence_packet,
)


CALIBRATION_SCHEMA_VERSION = 1
CALIBRATION_RULE_VERSION = "1"
CALIBRATION_EFFORT = "medium"
CALIBRATION_CAP = 75
INITIAL_RUNS = 3
EXTENDED_RUNS = 5
ELIGIBLE_MIN_TRIES = 5
ELIGIBLE_MAX_TRIES = 50
MAX_MODEL_MEDIAN_SPREAD = 20
TIER_QUOTA = 5
TIER_RANGES: dict[str, tuple[int, int]] = {
    "easy": (5, 15),
    "medium": (16, 30),
    "difficult": (31, 50),
}
TIER_ORDER = tuple(TIER_RANGES)

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


def resolve_path(path: Path) -> Path:
    if path.is_absolute():
        return path
    repo_root = BENCHMARK_DIR.parent.parent
    for candidate in (Path.cwd() / path, repo_root / path, BENCHMARK_DIR / path):
        if candidate.is_file():
            return candidate.resolve()
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
        actual = sha256_bytes(read_data_bytes(dataset_dir / record["path"]))
        if actual != record.get("sha256"):
            raise CalibrationError(
                f"candidate-pool puzzle {record.get('path')} does not match its sha256"
            )
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


def _run_config(
    manifest: dict[str, Any], content_sha: str, manifest_sha: str, *, auth: str
) -> dict[str, Any]:
    return {
        "artifact_schema_version": CALIBRATION_SCHEMA_VERSION,
        "calibration_rule_version": CALIBRATION_RULE_VERSION,
        "dataset_id": manifest["dataset_id"],
        "lang": manifest["lang"],
        "candidate_pool_content_sha256": content_sha,
        "candidate_pool_manifest_sha256": manifest_sha,
        "prompt_version": PROMPT_VERSION,
        "neutral_prompt_only": True,
        "fresh_context_per_run": True,
        "effort": CALIBRATION_EFFORT,
        "cap": CALIBRATION_CAP,
        "initial_runs_per_model": INITIAL_RUNS,
        "extended_runs_per_model": EXTENDED_RUNS,
        "eligibility": {
            "minimum_model_median": ELIGIBLE_MIN_TRIES,
            "maximum_model_median": ELIGIBLE_MAX_TRIES,
            "every_run_must_solve": True,
            "maximum_model_median_spread": MAX_MODEL_MEDIAN_SPREAD,
        },
        "tiers": {
            tier: {"minimum": bounds[0], "maximum": bounds[1], "quota": TIER_QUOTA}
            for tier, bounds in TIER_RANGES.items()
        },
        "balance": {
            "scope": "each tier and all selected holdout targets",
            "maximum_category_count_spread": 1,
            "fields": {key: list(values) for key, values in BALANCE_FIELDS.items()},
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
    candidates = sorted(
        (
            record
            for record in manifest["puzzles"]
            if record.get("split") == cd.CALIBRATION_CANDIDATE_SPLIT
        ),
        key=lambda record: record["candidate_id"],
    )
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
            "reserved_target_slugs": reserved_slugs,
        },
        "started_at": _utc_now(),
        "auth_verifications": [],
        "checkpoint": {
            "sequence": 0,
            "completed_paid_units": 0,
            "updated_at": _utc_now(),
        },
        "candidates": [
            _candidate_state(record, config["roster"]) for record in candidates
        ],
        "selection": {"status": "pending"},
    }
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
    if spread is None or spread > MAX_MODEL_MEDIAN_SPREAD:
        reasons.append(
            {
                "code": "model_median_spread",
                "spread": spread,
                "maximum": MAX_MODEL_MEDIAN_SPREAD,
            }
        )
    if reasons:
        return {
            "status": "rejected",
            "eligible": False,
            "model_medians": medians,
            "model_median_spread": spread,
            "reasons": reasons,
        }
    difficulty = max(numeric_medians)
    return {
        "status": "eligible",
        "eligible": True,
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
        max(field_counts.values()) - min(field_counts.values()) <= 1
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
    max_per_category = {
        "pos": math.ceil(cd.TARGETS_PER_PUZZLE * TIER_QUOTA / len(cd.POS_VALUES)),
        "gender": math.ceil(8 / len(cd.GENDER_VALUES)),
        "frequency_band": math.ceil(cd.TARGETS_PER_PUZZLE * TIER_QUOTA / 2),
        "semantic_class": math.ceil(cd.TARGETS_PER_PUZZLE * TIER_QUOTA / 2),
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


def select_calibrated_candidates(
    candidates: list[dict[str, Any]],
    *,
    reserved_slugs: set[str],
    selection_salt: str,
) -> dict[str, Any]:
    """Select the first deterministic exact-balance 5/5/5 solution."""
    eligible = [
        candidate
        for candidate in candidates
        if candidate.get("summary", {}).get("status") == "eligible"
    ]
    grouped = {
        tier: [
            candidate for candidate in eligible if candidate["summary"]["tier"] == tier
        ]
        for tier in TIER_ORDER
    }
    available = {tier: len(values) for tier, values in grouped.items()}
    deficits = {tier: max(0, TIER_QUOTA - count) for tier, count in available.items()}
    base = {
        "rule_version": CALIBRATION_RULE_VERSION,
        "required_per_tier": TIER_QUOTA,
        "eligible_per_tier": available,
        "balance_constraint": {
            "maximum_category_count_spread": 1,
            "scope": "each tier and overall",
            "fields": {key: list(values) for key, values in BALANCE_FIELDS.items()},
        },
        "reserved_curriculum_target_slug_count": len(reserved_slugs),
    }
    if any(deficits.values()):
        return {
            **base,
            "status": "shortfall",
            "reason": "insufficient_eligible_candidates",
            "tier_deficits": deficits,
        }

    # Precompute each tier once.  A larger candidate pool can have thousands of
    # balanced five-puzzle combinations; recomputing medium/difficult combinations
    # for every earlier choice would make a legitimate shortfall needlessly costly.
    tier_combinations: dict[
        str,
        list[
            tuple[
                list[dict[str, Any]],
                set[str],
                dict[str, dict[str, int]],
            ]
        ],
    ] = {}
    for tier in TIER_ORDER:
        tier_combinations[tier] = [
            (combo, used - reserved_slugs, counts)
            for combo, used, counts in _tier_combinations(
                grouped[tier],
                reserved_slugs=reserved_slugs,
                salt=f"{selection_salt}:{tier}",
            )
        ]

    selected_by_tier: dict[str, list[dict[str, Any]]] | None = None
    tier_counts: dict[str, dict[str, dict[str, int]]] | None = None
    if all(tier_combinations.values()):
        easy_tier, medium_tier, difficult_tier = TIER_ORDER
        medium_groups: dict[
            tuple[int, ...],
            list[
                tuple[
                    list[dict[str, Any]],
                    set[str],
                    dict[str, dict[str, int]],
                ]
            ],
        ] = {}
        difficult_groups: dict[
            tuple[int, ...],
            list[
                tuple[
                    list[dict[str, Any]],
                    set[str],
                    dict[str, dict[str, int]],
                ]
            ],
        ] = {}
        for combo in tier_combinations[medium_tier]:
            medium_groups.setdefault(_counts_signature(combo[2]), []).append(combo)
        for combo in tier_combinations[difficult_tier]:
            difficult_groups.setdefault(_counts_signature(combo[2]), []).append(combo)

        for easy_combo, easy_slugs, easy_counts in tier_combinations[easy_tier]:
            if selected_by_tier is not None:
                break
            for medium_options in medium_groups.values():
                medium_counts = medium_options[0][2]
                partial = _merge_counts(easy_counts, medium_counts)
                compatible_difficult = [
                    options
                    for options in difficult_groups.values()
                    if _balanced(_merge_counts(partial, options[0][2]))
                ]
                if not compatible_difficult:
                    continue
                for medium_combo, medium_slugs, _counts in medium_options:
                    if easy_slugs & medium_slugs:
                        continue
                    used = easy_slugs | medium_slugs
                    for difficult_options in compatible_difficult:
                        for (
                            difficult_combo,
                            difficult_slugs,
                            difficult_counts,
                        ) in difficult_options:
                            if used & difficult_slugs:
                                continue
                            selected_by_tier = {
                                easy_tier: easy_combo,
                                medium_tier: medium_combo,
                                difficult_tier: difficult_combo,
                            }
                            tier_counts = {
                                easy_tier: easy_counts,
                                medium_tier: medium_counts,
                                difficult_tier: difficult_counts,
                            }
                            break
                        if selected_by_tier is not None:
                            break
                    if selected_by_tier is not None:
                        break
                if selected_by_tier is not None:
                    break

    if selected_by_tier is None or tier_counts is None:
        return {
            **base,
            "status": "shortfall",
            "reason": "no_balanced_unique_selection",
            "tier_deficits": deficits,
            "shortfall": (
                "eligible counts meet 5/5/5, but no set satisfies unique target "
                "slugs and category-count spread <= 1 within every tier and overall"
            ),
        }

    selected = [
        {
            "candidate_id": candidate["candidate_id"],
            "tier": tier,
            "difficulty": candidate["summary"]["difficulty"],
            "model_medians": candidate["summary"]["model_medians"],
        }
        for tier in TIER_ORDER
        for candidate in selected_by_tier[tier]
    ]
    overall = _empty_counts()
    for counts in tier_counts.values():
        overall = _merge_counts(overall, counts)
    return {
        **base,
        "status": "selected",
        "tier_deficits": deficits,
        "selected": selected,
        "counts": {tier: TIER_QUOTA for tier in TIER_ORDER},
        "balance": {
            "tiers": {tier: _balance_report(tier_counts[tier]) for tier in TIER_ORDER},
            "overall": _balance_report(overall),
        },
    }


def _refresh_derived(state: dict[str, Any]) -> None:
    for candidate in state["candidates"]:
        candidate["summary"] = summarize_candidate(candidate)
    if any(
        candidate["summary"]["status"] == "pending" for candidate in state["candidates"]
    ):
        state["selection"] = {
            "status": "pending",
            "pending_paid_units": len(_pending_units(state)),
        }
        return
    state["selection"] = select_calibrated_candidates(
        state["candidates"],
        reserved_slugs=set(state["candidate_pool"]["reserved_target_slugs"]),
        selection_salt=state["config"]["candidate_pool_content_sha256"],
    )


def _pending_units(
    state: dict[str, Any],
) -> list[tuple[dict[str, Any], dict[str, Any], int]]:
    pending = []
    for candidate in state["candidates"]:
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
    records = sorted(
        (
            record
            for record in manifest["puzzles"]
            if record.get("split") == cd.CALIBRATION_CANDIDATE_SPLIT
        ),
        key=lambda record: record["candidate_id"],
    )
    if len(state.get("candidates", [])) != len(records):
        raise CalibrationError("resume artifact candidate count changed")
    checkpoints: list[int] = []
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
            if required == EXTENDED_RUNS and not isinstance(
                model.get("extension"), dict
            ):
                raise CalibrationError(
                    "five-run result has no recorded extension reason"
                )
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

    probe = copy.deepcopy(state)
    _refresh_derived(probe)
    if [candidate["summary"] for candidate in probe["candidates"]] != [
        candidate.get("summary") for candidate in state["candidates"]
    ]:
        raise CalibrationError("artifact candidate summaries do not replay")
    if probe["selection"] != state.get("selection"):
        raise CalibrationError("artifact selection report does not replay")


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
    return {
        "dry_run": True,
        "config": state["config"],
        "candidate_pool": state["candidate_pool"],
        "completed_paid_units": state["checkpoint"]["completed_paid_units"],
        "pending_paid_units": len(pending),
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

    budget = len(pending) if maximum_units is None else maximum_units
    for candidate, model, run_number in pending[:budget]:
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
        if not _pending_units(state) and state["selection"]["status"] == "selected":
            state["completed_at"] = _utc_now()
        save_artifact(destination, state)
        if verbose:
            score = completed["tries"] if completed["tries"] is not None else "DNF"
            print(
                f"[calibration] DONE checkpoint {checkpoint} score={score}", flush=True
            )

    if not _pending_units(state) and state["selection"]["status"] == "shortfall":
        if raise_on_shortfall:
            raise CalibrationShortfallError(state["selection"])
    return destination


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
    requested_model = select_model(model_selector)["model_id"]
    models = [
        model for model in matches[0]["models"] if model["model_id"] == requested_model
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
    model["required_runs"] = EXTENDED_RUNS
    model["extension"] = {"reason": reason, "requested_at": _utc_now()}
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


def finalize_manifest(
    pool_manifest_path: Path,
    artifact_path: Path,
    *,
    out_path: Path | None = None,
    vocab_loader: Callable[[str], set[str]] = load_vocab,
) -> Path:
    """Write a final 15+15 manifest with lean, hash-pinned calibration summaries."""
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
    _validate_completed_runs(
        state, pool_manifest_path, vocab_loader(manifest["lang"])
    )
    if not isinstance(state.get("completed_at"), str) or not state["completed_at"]:
        raise CalibrationError("calibration artifact is not marked complete")
    selection = state["selection"]
    if selection.get("status") != "selected":
        raise CalibrationError("calibration has no complete selected set")
    selected_rows = selection.get("selected", [])
    if len(selected_rows) != len(TIER_ORDER) * TIER_QUOTA:
        raise CalibrationError("calibration selection is not exactly 15 puzzles")
    if {
        tier: sum(row["tier"] == tier for row in selected_rows) for tier in TIER_ORDER
    } != {tier: TIER_QUOTA for tier in TIER_ORDER}:
        raise CalibrationError("calibration selection is not 5/5/5")

    curriculum = sorted(
        (
            copy.deepcopy(record)
            for record in manifest["puzzles"]
            if record.get("split") == "curriculum"
        ),
        key=lambda record: record["number"],
    )
    if len(curriculum) != cd.CURRICULUM_COUNT:
        raise CalibrationError(
            f"final calibrated dataset needs {cd.CURRICULUM_COUNT} curriculum puzzles"
        )
    if len(curriculum) != state["candidate_pool"]["curriculum_puzzle_count"]:
        raise CalibrationError("candidate-pool curriculum count changed")
    by_id = {candidate["candidate_id"]: candidate for candidate in state["candidates"]}
    pool_by_id = {
        record["candidate_id"]: record
        for record in manifest["puzzles"]
        if record.get("split") == cd.CALIBRATION_CANDIDATE_SPLIT
    }
    holdout = []
    for offset, row in enumerate(selected_rows, start=1):
        candidate = by_id[row["candidate_id"]]
        record = copy.deepcopy(pool_by_id[row["candidate_id"]])
        record.pop("pool_index", None)
        record.pop("candidate_id", None)
        record["number"] = len(curriculum) + offset
        record["split"] = "holdout"
        record["calibration"] = {
            "candidate_id": row["candidate_id"],
            "tier": row["tier"],
            "difficulty": row["difficulty"],
            "model_medians": row["model_medians"],
            "model_run_counts": {
                model["model_id"]: len(model["runs"]) for model in candidate["models"]
            },
            "all_runs_solved_within_cap": True,
        }
        holdout.append(record)

    records = curriculum + holdout
    calibrated = {
        "schema_version": cd.CALIBRATED_DATASET_SCHEMA_VERSION,
        "dataset_id": manifest["dataset_id"],
        "lang": manifest["lang"],
        "seed": manifest["seed"],
        "generator": manifest["generator"],
        "generator_output": manifest["generator_output"],
        "vocabulary": manifest["vocabulary"],
        "embedding": manifest["embedding"],
        "canonical_metadata": manifest["canonical_metadata"],
        "frequency_bands": manifest["frequency_bands"],
        "start_band": manifest["start_band"],
        "curriculum_base": copy.deepcopy(manifest["curriculum_base"]),
        "counts": {
            "puzzles": len(records),
            "curriculum": len(curriculum),
            "holdout": len(holdout),
        },
        "balance": _manifest_balance(records),
        "calibration": {
            "schema_version": CALIBRATION_SCHEMA_VERSION,
            "rule_version": CALIBRATION_RULE_VERSION,
            "artifact_sha256": state["hashes"]["artifact_sha256"],
            "artifact_file_sha256": artifact_file_sha256,
            "content_sha256": state["hashes"]["content_sha256"],
            "selection_sha256": state["hashes"]["selection_sha256"],
            "candidate_pool_content_sha256": content_sha,
            "prompt_version": PROMPT_VERSION,
            "roster": copy.deepcopy(state["config"]["roster"]),
            "effort": CALIBRATION_EFFORT,
            "cap": CALIBRATION_CAP,
            "initial_runs_per_model": INITIAL_RUNS,
            "extended_runs_per_model": EXTENDED_RUNS,
            "selected_tier_counts": {tier: TIER_QUOTA for tier in TIER_ORDER},
            "lab_only": True,
        },
        "puzzles": records,
        "generated_at": _utc_now(),
    }
    evidence_base = manifest["curriculum_base"]
    calibrated["strategy_evidence"] = {
        "schema_version": PACKET_SCHEMA_VERSION,
        "dataset_id": evidence_base["dataset_id"],
        "dataset_content_sha256": evidence_base["dataset_content_sha256"],
    }
    frozen_packet = build_evidence_packet(calibrated, pool_manifest_path.parent)
    calibrated["strategy_evidence"].update(
        {
            "packet_sha256": frozen_packet.sha256,
            "content_sha256": frozen_packet.content_sha256,
        }
    )
    calibrated["dataset_content_sha256"] = cd.dataset_content_sha256(calibrated)
    if out_path is None:
        destination = pool_manifest_path.with_name("manifest.json")
    else:
        destination = (
            out_path if out_path.is_absolute() else pool_manifest_path.parent / out_path
        )
    destination = destination.resolve()
    if destination.parent != pool_manifest_path.parent:
        raise CalibrationError(
            "final manifest must stay beside the candidate pool and puzzle files"
        )
    if destination == pool_manifest_path:
        raise CalibrationError("final manifest must not overwrite the candidate pool")
    tmp = destination.with_suffix(destination.suffix + ".tmp")
    tmp.write_text(
        json.dumps(calibrated, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    tmp.replace(destination)
    return destination


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
        "finalize", help="write the selected evaluation dataset manifest"
    )
    finalize_parser.add_argument("candidate_manifest", type=Path)
    finalize_parser.add_argument("artifact", type=Path)
    finalize_parser.add_argument("--out", type=Path)

    args = parser.parse_args(argv)
    if args.command == "run":
        maximum_units = None if args.all else args.max_units
        try:
            result = run_calibration(
                resolve_path(args.candidate_manifest),
                auth=args.auth,
                resume=resolve_path(args.resume) if args.resume else None,
                artifact_path=args.artifact,
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
    result = finalize_manifest(
        resolve_path(args.candidate_manifest),
        resolve_path(args.artifact),
        out_path=args.out,
    )
    print(f"calibrated dataset manifest: {result}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
