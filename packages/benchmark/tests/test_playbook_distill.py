"""Contract tests for the bounded two-pass 92-puzzle playbook distiller (#88)."""

from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path

import pytest

import playbook_distill as pd
from llm_play import MODELS


def _json_bytes(value):
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _target(word, start, *, pos="noun", gender="m"):
    return {
        "word": word,
        "slug": word,
        "pos": pos,
        "gender": gender,
        "frequency_rank": 1000,
        "frequency_band": "common",
        "semantic_class": "tangible",
        "start": start,
        "start_rank": 100,
    }


def _fixture_corpus(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(pd, "EXPECTED_PUZZLES", 1)
    monkeypatch.setattr(pd, "EXPECTED_TARGETS", 3)
    dataset = tmp_path / "dataset"
    puzzle_dir = dataset / "puzzles" / "candidates"
    puzzle_dir.mkdir(parents=True)
    targets = [
        _target("torrent", "réseau"),
        _target("farouche", "rude", pos="adjective"),
        _target("creuse", "avance", pos="verb", gender=None),
    ]
    words = ["le", "torrent", "farouche", "creuse"]
    holes = [
        {
            "pos": index,
            "secret": {"word": target["word"], "slug": target["slug"]},
            "start": {"word": target["start"], "slug": target["start"]},
            "start_rank": target["start_rank"],
        }
        for index, target in enumerate(targets, start=1)
    ]
    ranks = {}
    for index, target in enumerate(targets, start=1):
        ranks[target["slug"]] = {
            target["slug"]: {"word": target["word"], "rank": 0},
            f"voisin{index}": {"word": f"voisin{index}", "rank": 1},
            target["start"]: {"word": target["start"], "rank": 100},
            f"loin{index}": {"word": f"loin{index}", "rank": 10_000},
        }
    puzzle = {"lang": "fr", "words": words, "holes": holes, "ranks": ranks}
    content = _json_bytes(puzzle)
    puzzle_path = puzzle_dir / "one.json.gz"
    puzzle_path.write_bytes(gzip.compress(content, mtime=0))
    manifest = {
        "schema_version": 1,
        "manifest_kind": "playbook_distillation_corpus",
        "dataset_id": "strategy-fr-92",
        "lang": "fr",
        "counts": {"puzzles": 1, "targets": 3},
        "puzzles": [
            {
                "number": 1,
                "path": "puzzles/candidates/one.json.gz",
                "sha256": hashlib.sha256(content).hexdigest(),
                "sentence": " ".join(words),
                "targets": targets,
            }
        ],
    }
    manifest_path = dataset / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest_path, manifest


def test_committed_92_puzzle_corpus_has_a_frozen_packet_identity():
    corpus = pd.load_corpus(pd.CORPUS_MANIFEST)

    assert corpus["identity"] == {
        "dataset_id": "strategy-fr-92",
        "manifest_sha256": (
            "f5fcac1730fae7d401febace78b9a6594ee6245593f0c754ece2de834145eddd"
        ),
        "packet_schema_version": 1,
        "packet_sha256": (
            "af05d2c9f33f7333525f778803559ae05b0525007b81b165e5804e41c7f8ad4a"
        ),
        "packet_bytes": 390862,
        "puzzles": 92,
        "targets": 276,
        "representative_neighbors": 17796,
    }
    packet = json.loads(corpus["packet_json"])
    assert len(packet["puzzles"]) == 92
    assert packet["puzzles"][0]["sentence"] == (
        "le torrent farouche continuait de creuser la roche"
    )
    assert packet["puzzles"][0]["targets"][0]["starting_clue"] == "peer-to-peer"
    assert packet["puzzles"][0]["targets"][0]["starting_rank"] == 134


def test_manifest_metadata_is_bound_to_the_puzzle_before_any_call(
    tmp_path, monkeypatch
):
    manifest_path, manifest = _fixture_corpus(tmp_path, monkeypatch)
    manifest["puzzles"][0]["targets"][0]["word"] = "mensonge"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    with pytest.raises(pd.DistillationError, match="secret does not match"):
        pd.load_corpus(manifest_path)


def test_corpus_rejects_unmanifested_input_files(tmp_path, monkeypatch):
    manifest_path, _manifest = _fixture_corpus(tmp_path, monkeypatch)
    extra = manifest_path.parent / "puzzles" / "candidates" / "extra.json.gz"
    extra.write_bytes(gzip.compress(b"{}", mtime=0))

    with pytest.raises(pd.DistillationError, match="input graph differs"):
        pd.load_corpus(manifest_path)


def test_ultra_maps_to_each_provider_strongest_supported_transport():
    assert pd.ultra_provider_settings(MODELS[1], "subscription") == {
        "workflow_effort": "ultra",
        "provider_effort": "max",
        "reasoning_mode": "adaptive",
        "mapping": "Anthropic adaptive thinking with max effort",
    }
    assert pd.ultra_provider_settings(MODELS[2], "subscription") == {
        "workflow_effort": "ultra",
        "provider_effort": "ultra",
        "reasoning_mode": "standard",
        "mapping": "Codex plan literal ultra reasoning effort",
    }
    assert pd.ultra_provider_settings(MODELS[2], "api") == {
        "workflow_effort": "ultra",
        "provider_effort": "max",
        "reasoning_mode": "pro",
        "mapping": "Responses API max effort with Pro reasoning mode",
    }


def test_two_pass_resume_never_repeats_a_completed_stage_and_profile_is_final_only(
    tmp_path, monkeypatch
):
    manifest_path, _manifest = _fixture_corpus(tmp_path, monkeypatch)
    artifact = tmp_path / "sonnet.distill.json"
    profile = tmp_path / "sonnet.playbook.json"
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-only")
    calls = []

    class ScriptedReply:
        last_token_usage = {"input_tokens": 10, "output_tokens": 5}
        last_raw_token_usage = {
            "input_tokens": 10,
            "output_tokens": 5,
            "service_tier": "test",
        }

        def __call__(self, messages):
            calls.append(messages)
            return ["PRIVATE ANALYST REPORT", "FINAL OPERATIONAL PLAYBOOK"][
                len(calls) - 1
            ]

    reply = ScriptedReply()
    monkeypatch.setattr(pd, "provider_reply", lambda *_args, **_kwargs: reply)

    result = pd.main(
        [
            "--model",
            "SONNET",
            "--auth",
            "api",
            "--manifest",
            str(manifest_path),
            "--artifact",
            str(artifact),
            "--profile-out",
            str(profile),
        ]
    )

    assert result == 0
    assert len(calls) == 2
    audit = json.loads(artifact.read_text(encoding="utf-8"))
    assert audit["stages"]["analyst"]["response"] == "PRIVATE ANALYST REPORT"
    assert audit["stages"]["critic"]["response"] == "FINAL OPERATIONAL PLAYBOOK"
    for stage in audit["stages"].values():
        assert stage["token_usage_schema_version"] == 1
        assert stage["token_usage"] == {
            "input_tokens": 10,
            "cached_input_tokens": 0,
            "cache_write_input_tokens": 0,
            "output_tokens": 5,
            "reasoning_output_tokens": None,
            "total_tokens": 15,
        }
        assert stage["raw_provider_token_usage"] == {
            "input_tokens": 10,
            "output_tokens": 5,
            "service_tier": "test",
        }
    frozen = json.loads(profile.read_text(encoding="utf-8"))
    assert frozen["final_playbook"] == "FINAL OPERATIONAL PLAYBOOK"
    assert "PRIVATE ANALYST REPORT" not in json.dumps(frozen)

    class MustNotRun:
        def __call__(self, _messages):
            raise AssertionError("a completed paid stage was repeated")

    monkeypatch.setattr(pd, "provider_reply", lambda *_args, **_kwargs: MustNotRun())
    assert (
        pd.main(
            [
                "--model",
                "SONNET",
                "--auth",
                "api",
                "--manifest",
                str(manifest_path),
                "--artifact",
                str(artifact),
                "--profile-out",
                str(profile),
            ]
        )
        == 0
    )


def test_dry_run_performs_no_auth_check_write_or_provider_call(
    tmp_path, monkeypatch
):
    manifest_path, _manifest = _fixture_corpus(tmp_path, monkeypatch)
    artifact = tmp_path / "dry.distill.json"
    profile = tmp_path / "dry.playbook.json"
    monkeypatch.setattr(
        pd,
        "provider_reply",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("provider constructed during dry-run")
        ),
    )
    monkeypatch.setattr(
        pd,
        "validate_anthropic_subscription_auth",
        lambda: (_ for _ in ()).throw(
            AssertionError("auth checked during dry-run")
        ),
    )

    assert (
        pd.main(
            [
                "--model",
                "SONNET",
                "--manifest",
                str(manifest_path),
                "--artifact",
                str(artifact),
                "--profile-out",
                str(profile),
                "--dry-run",
            ]
        )
        == 0
    )
    assert not artifact.exists()
    assert not profile.exists()


def test_critic_prompt_has_no_old_size_cap_and_returns_only_final_playbook():
    prompt = pd.critic_prompt('{"puzzles":[]}', "draft")

    assert "no item or character cap" in prompt
    assert "return only the final playbook" in prompt
    assert "Only your response from this pass will be injected verbatim" in prompt
    assert "BEGIN_ANALYST_REPORT\ndraft\nEND_ANALYST_REPORT" in prompt
