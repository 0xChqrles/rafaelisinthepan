"""Deterministic, training-only evidence packets for strategy distillation.

The packet is deliberately smaller than the raw ~10k-neighbor maps while keeping
the closest region exact and representing the remaining rank range with fixed,
evenly-spaced samples.  Legacy packet v1 is model-independent; #86 packet v2
adds only the selected model's own training-run evidence.  Test files are never
opened.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
from typing import Any, Callable

from curriculum_io import (
    load_json,
    read_data_bytes,
    sha256_bytes,
    write_deterministic_gzip,
)


LEGACY_PACKET_SCHEMA_VERSION = 1
PACKET_SCHEMA_VERSION = 2
MODEL_RUN_EVIDENCE_SCHEMA_VERSION = 2
EXACT_MAX_RANK = 250
SAMPLES_PER_BAND = 20
SAMPLE_BANDS: tuple[tuple[int, int], ...] = (
    (251, 500),
    (501, 1_000),
    (1_001, 2_500),
    (2_501, 5_000),
    (5_001, 10_000),
)

PuzzleLoader = Callable[[Path], dict[str, Any]]


@dataclass(frozen=True)
class EvidencePacket:
    """Exact canonical bytes plus identities used by artifacts and profiles."""

    document: dict[str, Any]
    canonical_bytes: bytes
    sha256: str
    content_sha256: str
    content_byte_count: int


def canonical_json_bytes(value: Any) -> bytes:
    """The one byte representation used for packet hashing and provider input."""
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _entry(slug: str, value: dict[str, Any]) -> dict[str, Any]:
    rank = value.get("rank")
    word = value.get("word")
    if not isinstance(rank, int) or isinstance(rank, bool) or rank < 0:
        raise ValueError(f"rank-map entry {slug!r} has invalid rank {rank!r}")
    if not isinstance(word, str) or not word:
        raise ValueError(f"rank-map entry {slug!r} has no display word")
    return {"word": word, "slug": slug, "rank": rank}


def _evenly_spaced(entries: list[dict[str, Any]], count: int) -> list[dict[str, Any]]:
    """Include both ends and select stable, unique indexes across a sorted band."""
    if len(entries) <= count:
        return list(entries)
    if count <= 0:
        return []
    if count == 1:
        return [entries[0]]
    last = len(entries) - 1
    indexes = [index * last // (count - 1) for index in range(count)]
    if len(set(indexes)) != count:
        raise AssertionError("even sampling produced duplicate indexes")
    return [entries[index] for index in indexes]


def _rank_evidence(rank_map: dict[str, Any]) -> dict[str, Any]:
    entries = sorted(
        (_entry(slug, value) for slug, value in rank_map.items()),
        key=lambda item: (item["rank"], item["slug"]),
    )
    exact = [item for item in entries if 1 <= item["rank"] <= EXACT_MAX_RANK]
    sampled_bands: list[dict[str, Any]] = []
    for lower, upper in SAMPLE_BANDS:
        candidates = [item for item in entries if lower <= item["rank"] <= upper]
        retained = _evenly_spaced(candidates, SAMPLES_PER_BAND)
        sampled_bands.append(
            {
                "lower_rank": lower,
                "upper_rank": upper,
                "source_count": len(candidates),
                "retained_count": len(retained),
                "entries": retained,
            }
        )
    represented = len(exact) + sum(
        band["retained_count"] for band in sampled_bands
    )
    return {
        "total_source_entries": len(entries),
        "represented_entries": represented,
        "exact_source_count": len(exact),
        "exact_retained_count": len(exact),
        "exact_rank_1_through_250": exact,
        "sampled_bands": sampled_bands,
    }


def _target_metadata(record: dict[str, Any], slug: str) -> dict[str, Any]:
    matches = [target for target in record["targets"] if target["slug"] == slug]
    if len(matches) != 1:
        raise ValueError(
            f"manifest puzzle {record.get('number')} has {len(matches)} metadata "
            f"records for target {slug!r}"
        )
    return matches[0]


def _packet_puzzle(record: dict[str, Any], puzzle: dict[str, Any]) -> dict[str, Any]:
    targets = []
    for hole in puzzle["holes"]:
        secret = hole["secret"]
        target = _target_metadata(record, secret["slug"])
        rank_map = puzzle["ranks"].get(secret["slug"])
        if not isinstance(rank_map, dict):
            raise ValueError(f"puzzle has no rank map for {secret['slug']!r}")
        targets.append(
            {
                "position": hole["pos"],
                "answer": secret["word"],
                "answer_slug": secret["slug"],
                "pos": target["pos"],
                "gender": target.get("gender"),
                "semantic_class": target["semantic_class"],
                "frequency_rank": target["frequency_rank"],
                "frequency_band": target["frequency_band"],
                "start": {
                    "word": hole["start"]["word"],
                    "slug": hole["start"]["slug"],
                    "rank": hole["start_rank"],
                },
                "rank_evidence": _rank_evidence(rank_map),
            }
        )
    return {
        "number": record["number"],
        "source_sha256": record["sha256"],
        "sentence": record["sentence"],
        "targets": targets,
    }


def _model_calibration_evidence(
    manifest: dict[str, Any],
    dataset_dir: Path,
    *,
    model_id: str,
    records: list[dict[str, Any]],
) -> dict[str, Any]:
    identity = manifest["strategy_evidence"]
    roster = identity.get("calibration_roster_model_ids")
    evidence = identity.get("model_run_evidence")
    if (
        not isinstance(roster, list)
        or len(roster) != len(set(roster))
        or not all(isinstance(value, str) and value for value in roster)
        or not isinstance(evidence, dict)
        or set(evidence) != set(roster)
    ):
        raise ValueError("strategy_evidence calibration roster is malformed")
    if model_id not in roster:
        return {
            "source": "none_for_non_roster_model",
            "model_id": model_id,
            "puzzle_count": 0,
            "run_count": 0,
            "puzzles": [],
        }

    reference = evidence[model_id]
    if not isinstance(reference, dict):
        raise ValueError("model calibration evidence reference is malformed")
    path = dataset_dir / str(reference.get("path", ""))
    content = read_data_bytes(path)
    if sha256_bytes(content) != reference.get("sha256"):
        raise ValueError("model calibration evidence does not match its sha256")
    try:
        document = json.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("model calibration evidence is not valid JSON") from exc
    if not isinstance(document, dict):
        raise ValueError("model calibration evidence must be an object")
    expected_ids = [record["calibration"]["candidate_id"] for record in records]
    puzzles = document.get("puzzles")
    if (
        document.get("schema_version") != MODEL_RUN_EVIDENCE_SCHEMA_VERSION
        or document.get("model_id") != model_id
        or document.get("prompt_version")
        != manifest.get("calibration", {}).get("prompt_version")
        or document.get("training_selection_sha256")
        != identity.get("training_selection_sha256")
        or not isinstance(puzzles, list)
        or [puzzle.get("candidate_id") for puzzle in puzzles] != expected_ids
        or document.get("puzzle_count") != len(puzzles)
        or document.get("run_count")
        != sum(len(puzzle.get("runs", [])) for puzzle in puzzles)
        or reference.get("puzzle_count") != document.get("puzzle_count")
        or reference.get("run_count") != document.get("run_count")
        or reference.get("schema_version") != document.get("schema_version")
    ):
        raise ValueError("model calibration evidence identity is malformed")
    for record, puzzle in zip(records, puzzles):
        if puzzle.get("source_sha256") != record["sha256"]:
            raise ValueError("model calibration evidence puzzle identity changed")
        runs = puzzle.get("runs")
        if not isinstance(runs, list) or not runs:
            raise ValueError("model calibration evidence has no runs")
        for run in runs:
            if not isinstance(run, dict) or any(
                raw_key in run
                for raw_key in ("conversation", "tried_words", "turn_token_usage")
            ):
                raise ValueError(
                    "model calibration evidence must not contain raw conversations"
                )
            guesses = run.get("counted_guesses")
            trajectory = run.get("trajectory")
            rejected = run.get("rejected_events")
            turns = run.get("turns")
            if (
                not isinstance(guesses, list)
                or not all(isinstance(word, str) and word for word in guesses)
                or not isinstance(trajectory, list)
                or len(trajectory) != len(guesses)
                or run.get("counted_tries") != len(guesses)
                or not isinstance(rejected, list)
                or not isinstance(turns, int)
                or isinstance(turns, bool)
                or turns != len(guesses) + len(rejected)
                or not isinstance(run.get("metrics"), dict)
                or run.get("model_id") != model_id
                or not all(
                    isinstance(run.get(key), str) and run[key]
                    for key in ("provider", "transport", "auth", "effort")
                )
                or not isinstance(run.get("cap"), int)
                or isinstance(run.get("cap"), bool)
                or not isinstance(run.get("opening_prompt_sha256"), str)
                or len(run["opening_prompt_sha256"]) != 64
            ):
                raise ValueError("model calibration evidence run is malformed")
            if (
                not all(
                    isinstance(step, dict)
                    and isinstance(step.get("outcomes"), list)
                    and isinstance(step.get("current_best_ranks"), dict)
                    and isinstance(step.get("solved_locks"), list)
                    and isinstance(step.get("no_improvement_streak"), int)
                    for step in trajectory
                )
                or [step["try"] for step in trajectory]
                != list(range(1, len(guesses) + 1))
                or [step["guess"] for step in trajectory] != guesses
            ):
                raise ValueError("model calibration evidence trajectory is malformed")
            if not all(
                isinstance(event, dict)
                and event.get("kind") in {"malformed", "invalid", "duplicate"}
                and isinstance(event.get("turn"), int)
                and not isinstance(event.get("turn"), bool)
                and 1 <= event["turn"] <= turns
                and isinstance(event.get("reply"), str)
                for event in rejected
            ) or len({event["turn"] for event in rejected}) != len(rejected):
                raise ValueError("model calibration rejected events are malformed")
    return document


def build_evidence_packet(
    manifest: dict[str, Any],
    dataset_dir: Path,
    *,
    model_id: str | None = None,
    puzzle_loader: PuzzleLoader = load_json,
) -> EvidencePacket:
    """Build one canonical packet, loading only manifest curriculum records."""
    records = [
        record for record in manifest["puzzles"] if record["split"] == "curriculum"
    ]
    expected = manifest.get("counts", {}).get("curriculum")
    if expected is not None and len(records) != expected:
        raise ValueError(
            f"manifest declares {expected} curriculum puzzles but contains {len(records)}"
        )

    frozen_identity = manifest.get("strategy_evidence")
    if frozen_identity is None:
        packet_schema_version = LEGACY_PACKET_SCHEMA_VERSION
        evidence_dataset_id = manifest["dataset_id"]
        evidence_dataset_sha256 = manifest["dataset_content_sha256"]
    else:
        if not isinstance(frozen_identity, dict):
            raise ValueError("strategy_evidence must be an object")
        packet_schema_version = frozen_identity.get("schema_version")
        if packet_schema_version not in {
            LEGACY_PACKET_SCHEMA_VERSION,
            PACKET_SCHEMA_VERSION,
        }:
            raise ValueError("strategy_evidence has an unsupported packet schema")
        evidence_dataset_id = frozen_identity.get("dataset_id")
        evidence_dataset_sha256 = frozen_identity.get("dataset_content_sha256")
        if not isinstance(evidence_dataset_id, str) or not evidence_dataset_id:
            raise ValueError("strategy_evidence dataset_id is missing")
        if (
            not isinstance(evidence_dataset_sha256, str)
            or len(evidence_dataset_sha256) != 64
        ):
            raise ValueError("strategy_evidence dataset content hash is malformed")

    model_calibration_evidence: dict[str, Any] | None = None
    if packet_schema_version == PACKET_SCHEMA_VERSION:
        if manifest.get("manifest_kind") != "calibration_training_split":
            raise ValueError(
                "model-specific strategy evidence can be built only from the training view"
            )
        if not isinstance(model_id, str) or not model_id:
            raise ValueError("model-specific strategy evidence requires model_id")
        model_calibration_evidence = _model_calibration_evidence(
            manifest,
            dataset_dir,
            model_id=model_id,
            records=records,
        )

    content = {
        "dataset_id": evidence_dataset_id,
        "dataset_content_sha256": evidence_dataset_sha256,
        "lang": manifest["lang"],
        "curriculum_puzzle_count": len(records),
        "target_count": sum(len(record["targets"]) for record in records),
        "sampling": {
            "exact_max_rank": EXACT_MAX_RANK,
            "samples_per_band": SAMPLES_PER_BAND,
            "sample_bands": [list(band) for band in SAMPLE_BANDS],
        },
        "ordered_curriculum_puzzle_sha256s": [
            record["sha256"] for record in records
        ],
        "puzzles": [
            _packet_puzzle(record, puzzle_loader(dataset_dir / record["path"]))
            for record in records
        ],
    }
    if packet_schema_version == PACKET_SCHEMA_VERSION:
        content.update(
            {
                "model_id": model_id,
                "model_calibration_evidence": model_calibration_evidence,
            }
        )
    content_bytes = canonical_json_bytes(content)
    content_sha = hashlib.sha256(content_bytes).hexdigest()
    document = {
        "schema_version": packet_schema_version,
        "content_sha256": content_sha,
        "content_byte_count": len(content_bytes),
        "content": content,
    }
    packet_bytes = canonical_json_bytes(document)
    packet = EvidencePacket(
        document=document,
        canonical_bytes=packet_bytes,
        sha256=hashlib.sha256(packet_bytes).hexdigest(),
        content_sha256=content_sha,
        content_byte_count=len(content_bytes),
    )
    if frozen_identity is not None:
        for field, actual in (
            ("packet_sha256", packet.sha256),
            ("content_sha256", packet.content_sha256),
        ):
            expected_hash = frozen_identity.get(field)
            if expected_hash is not None and expected_hash != actual:
                raise ValueError(
                    f"strategy_evidence {field} does not match the frozen packet"
                )
    return packet


def write_evidence_packet(path: Path, packet: EvidencePacket) -> None:
    """Persist exact canonical packet bytes in a deterministic gzip container."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    write_deterministic_gzip(tmp, packet.canonical_bytes)
    tmp.replace(path)
