"""Deterministic, curriculum-only evidence-packet contract (#84)."""

from __future__ import annotations

import copy
import json
from pathlib import Path

from curriculum_io import read_data_bytes
import strategy_evidence as se


def _record(number, split, path, target="secret"):
    return {
        "number": number,
        "split": split,
        "path": path,
        "sha256": f"{number:064x}",
        "sentence": f"la phrase contient {target}",
        "targets": [
            {
                "word": target,
                "slug": target,
                "pos": "noun",
                "gender": "m",
                "semantic_class": "abstract",
                "frequency_rank": number,
                "frequency_band": "common",
                "start": "depart",
                "start_rank": 125,
            }
        ],
    }


def _puzzle(rank_items, target="secret"):
    return {
        "lang": "fr",
        "words": ["la", "phrase", "contient", target],
        "holes": [
            {
                "pos": 3,
                "secret": {"word": target, "slug": target},
                "start": {"word": "départ", "slug": "depart"},
                "start_rank": 125,
            }
        ],
        "ranks": {target: dict(rank_items)},
    }


def _manifest(records):
    return {
        "dataset_id": "fixture",
        "dataset_content_sha256": "d" * 64,
        "lang": "fr",
        "counts": {
            "puzzles": len(records),
            "curriculum": sum(r["split"] == "curriculum" for r in records),
            "holdout": sum(r["split"] == "holdout" for r in records),
        },
        "puzzles": records,
    }


def test_packet_builder_never_opens_or_serializes_holdout_records(tmp_path):
    curriculum = _record(1, "curriculum", "curriculum.json")
    holdout = _record(2, "holdout", "DO-NOT-OPEN.json", target="sentinelle")
    opened = []
    puzzle = _puzzle(
        {
            "secret": {"word": "secret", "rank": 0},
            "proche": {"word": "proche", "rank": 1},
        }
    )

    def loader(path):
        opened.append(path.name)
        if path.name == "DO-NOT-OPEN.json":
            raise AssertionError("packet builder opened holdout data")
        return puzzle

    packet = se.build_evidence_packet(
        _manifest([curriculum, holdout]), tmp_path, puzzle_loader=loader
    )
    assert opened == ["curriculum.json"]
    assert packet.document["content"]["curriculum_puzzle_count"] == 1
    assert packet.document["content"]["target_count"] == 1
    encoded = packet.canonical_bytes.decode("utf-8")
    assert "sentinelle" not in encoded
    assert holdout["sha256"] not in encoded
    assert "DO-NOT-OPEN" not in encoded


def test_exact_top250_and_each_band_sample_are_spec_correct_and_deterministic(
    tmp_path,
):
    entries = {
        "secret": {"word": "secret", "rank": 0},
        **{
            f"mot{rank:05d}": {"word": f"mot{rank:05d}", "rank": rank}
            for rank in range(1, 10_001)
        },
    }
    reverse_entries = dict(reversed(list(entries.items())))
    record = _record(1, "curriculum", "puzzle.json")
    manifest = _manifest([record])
    packets = []
    for rank_map in (entries, reverse_entries, entries):
        packets.append(
            se.build_evidence_packet(
                manifest,
                tmp_path,
                puzzle_loader=lambda _path, rm=rank_map: _puzzle(rm),
            )
        )

    assert packets[0].canonical_bytes == packets[1].canonical_bytes
    assert packets[0].sha256 == packets[2].sha256
    evidence = packets[0].document["content"]["puzzles"][0]["targets"][0][
        "rank_evidence"
    ]
    exact = evidence["exact_rank_1_through_250"]
    assert [entry["rank"] for entry in exact] == list(range(1, 251))
    assert evidence["exact_source_count"] == 250
    assert evidence["exact_retained_count"] == 250
    assert evidence["total_source_entries"] == 10_001
    assert evidence["represented_entries"] == 350

    for band, (lower, upper) in zip(evidence["sampled_bands"], se.SAMPLE_BANDS):
        source_count = upper - lower + 1
        expected = [
            lower + index * (source_count - 1) // (se.SAMPLES_PER_BAND - 1)
            for index in range(se.SAMPLES_PER_BAND)
        ]
        assert band["source_count"] == source_count
        assert band["retained_count"] == 20
        assert [entry["rank"] for entry in band["entries"]] == expected

    # Canonical JSON is compact, sorted, self-identifying, and byte-counted.
    packet = packets[0]
    assert packet.canonical_bytes == se.canonical_json_bytes(packet.document)
    assert packet.document["schema_version"] == se.PACKET_SCHEMA_VERSION
    assert packet.document["content_byte_count"] == packet.content_byte_count
    assert packet.document["content_sha256"] == packet.content_sha256

    first_path = tmp_path / "first.json.gz"
    second_path = tmp_path / "second.json.gz"
    se.write_evidence_packet(first_path, packet)
    se.write_evidence_packet(second_path, packet)
    assert first_path.read_bytes() == second_path.read_bytes()
    assert read_data_bytes(first_path) == packet.canonical_bytes


def test_committed_packet_has_exact_frozen_split_and_stable_identity():
    manifest_path = (
        Path(__file__).parents[1] / "datasets" / "strategy-fr-v1" / "manifest.json"
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    first = se.build_evidence_packet(manifest, manifest_path.parent)
    second = se.build_evidence_packet(manifest, manifest_path.parent)

    assert first.canonical_bytes == second.canonical_bytes
    assert first.sha256 == second.sha256
    assert first.sha256 == "ff6117bb38efc44175302361e44371f4e640119264975834cdd90227f9944f5e"
    assert len(first.canonical_bytes) == 841_729
    assert first.document["content"]["curriculum_puzzle_count"] == 15
    assert first.document["content"]["target_count"] == 45
    assert len(
        first.document["content"]["ordered_curriculum_puzzle_sha256s"]
    ) == 15
    assert all(
        puzzle["number"] <= 15
        for puzzle in first.document["content"]["puzzles"]
    )

    calibrated = copy.deepcopy(manifest)
    calibrated["dataset_id"] = "strategy-fr-v2"
    calibrated["dataset_content_sha256"] = "2" * 64
    calibrated["strategy_evidence"] = {
        "schema_version": se.PACKET_SCHEMA_VERSION,
        "dataset_id": manifest["dataset_id"],
        "dataset_content_sha256": manifest["dataset_content_sha256"],
        "packet_sha256": first.sha256,
        "content_sha256": first.content_sha256,
    }
    anchored = se.build_evidence_packet(calibrated, manifest_path.parent)
    assert anchored.canonical_bytes == first.canonical_bytes
    assert anchored.sha256 == "ff6117bb38efc44175302361e44371f4e640119264975834cdd90227f9944f5e"
