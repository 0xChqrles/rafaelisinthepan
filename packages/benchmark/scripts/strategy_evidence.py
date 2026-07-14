"""Deterministic, curriculum-only evidence packets for strategy distillation.

The packet is deliberately smaller than the raw ~10k-neighbor maps while keeping
the closest region exact and representing the remaining rank range with fixed,
evenly-spaced samples.  It is model-independent and never opens holdout files.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
from typing import Any, Callable

from curriculum_io import load_json, write_deterministic_gzip


PACKET_SCHEMA_VERSION = 1
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


def build_evidence_packet(
    manifest: dict[str, Any],
    dataset_dir: Path,
    *,
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

    content = {
        "dataset_id": manifest["dataset_id"],
        "dataset_content_sha256": manifest["dataset_content_sha256"],
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
    content_bytes = canonical_json_bytes(content)
    content_sha = hashlib.sha256(content_bytes).hexdigest()
    document = {
        "schema_version": PACKET_SCHEMA_VERSION,
        "content_sha256": content_sha,
        "content_byte_count": len(content_bytes),
        "content": content,
    }
    packet_bytes = canonical_json_bytes(document)
    return EvidencePacket(
        document=document,
        canonical_bytes=packet_bytes,
        sha256=hashlib.sha256(packet_bytes).hexdigest(),
        content_sha256=content_sha,
        content_byte_count=len(content_bytes),
    )


def write_evidence_packet(path: Path, packet: EvidencePacket) -> None:
    """Persist exact canonical packet bytes in a deterministic gzip container."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    write_deterministic_gzip(tmp, packet.canonical_bytes)
    tmp.replace(path)
