#!/usr/bin/env python3
"""Two-pass model-specific playbook distillation over the 92-puzzle corpus (#88).

The raw analyst and critic replies are local audit material. Gameplay accepts only the
small finalized profile emitted after the critic pass, so an analyst draft can never be
injected accidentally. Provider calls are exactly two per model and are checkpointed
independently for safe resume.
"""

from __future__ import annotations

import argparse
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
from typing import Any

from llm_play import (
    AUTH_MODES,
    BENCHMARK_DIR,
    BENCHMARK_OUTPUT_DIR,
    PROVIDER_ENV,
    PROMPT_VERSION,
    ModelConfig,
    _write_json_atomic,
    provider_reply,
    select_model,
    validate_anthropic_subscription_auth,
    validate_openai_subscription_auth,
)


CORPUS_MANIFEST = (
    BENCHMARK_DIR / "datasets" / "strategy-fr-92" / "manifest.json"
)
OUTPUT_DIR = BENCHMARK_OUTPUT_DIR / "playbooks"
ARTIFACT_SCHEMA_VERSION = 1
PROFILE_SCHEMA_VERSION = 1
PACKET_SCHEMA_VERSION = 1
WORKFLOW_VERSION = "92-puzzle-two-pass-ultra-v1"
ANALYST_PROMPT_VERSION = "1"
CRITIC_PROMPT_VERSION = "1"
WORKFLOW_EFFORT = "ultra"

# Full 10k-neighbor maps occupy about 206 MiB uncompressed and cannot fit in either
# model context. Keep the most decision-relevant close neighborhood exactly, then retain
# deterministic landmarks through the cold boundary. Every puzzle, sentence, target,
# starting clue, start rank, and target metadata remains present.
EXACT_NEIGHBOR_MAX_RANK = 50
LANDMARK_RANKS = (
    60,
    75,
    100,
    125,
    150,
    200,
    300,
    500,
    750,
    1_000,
    1_500,
    2_500,
    5_000,
    7_500,
    10_000,
)
EXPECTED_PUZZLES = 92
EXPECTED_TARGETS = 276
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class DistillationError(ValueError):
    """The corpus, checkpoint, or final profile violates the workflow contract."""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_text(text: str) -> str:
    return _sha256_bytes(text.encode("utf-8"))


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(block)
    except OSError as exc:
        raise DistillationError(f"could not read {path}: {exc}") from exc
    return digest.hexdigest()


def _canonical_json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _record(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise DistillationError(f"{label} must be an object")
    return value


def _array(value: object, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise DistillationError(f"{label} must be an array")
    return value


def _string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise DistillationError(f"{label} must be a non-empty string")
    return value


def _integer(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise DistillationError(f"{label} must be an integer")
    return value


def _load_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DistillationError(f"could not read {label} {path}: {exc}") from exc
    return _record(value, label)


def _load_gzip_json(path: Path) -> tuple[dict[str, Any], str]:
    try:
        with gzip.open(path, "rb") as handle:
            content = handle.read()
        value = json.loads(content.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DistillationError(f"could not read puzzle {path}: {exc}") from exc
    return _record(value, f"puzzle {path}"), _sha256_bytes(content)


def _safe_corpus_path(dataset_dir: Path, raw_path: object) -> Path:
    relative = Path(_string(raw_path, "puzzle path"))
    if relative.is_absolute():
        raise DistillationError(f"puzzle path must be relative: {relative}")
    resolved = (dataset_dir / relative).resolve()
    try:
        resolved.relative_to(dataset_dir.resolve())
    except ValueError as exc:
        raise DistillationError(
            f"puzzle path escapes the dataset directory: {relative}"
        ) from exc
    return resolved


def _rank_entries(rank_map: object, label: str) -> list[tuple[int, str, str]]:
    mapping = _record(rank_map, label)
    entries: list[tuple[int, str, str]] = []
    for folded, raw_entry in mapping.items():
        if not isinstance(folded, str) or not folded:
            raise DistillationError(f"{label} has an invalid folded key")
        entry = _record(raw_entry, f"{label}[{folded!r}]")
        rank = _integer(entry.get("rank"), f"{label}[{folded!r}].rank")
        word = _string(entry.get("word"), f"{label}[{folded!r}].word")
        if rank < 0:
            raise DistillationError(f"{label}[{folded!r}] has a negative rank")
        entries.append((rank, folded, word))
    if not entries:
        raise DistillationError(f"{label} is empty")
    entries.sort(key=lambda item: (item[0], item[1], item[2]))
    return entries


def _sample_neighbors(entries: Sequence[tuple[int, str, str]]) -> list[list[object]]:
    positive = [entry for entry in entries if entry[0] > 0]
    selected: dict[tuple[int, str], tuple[int, str, str]] = {
        (rank, folded): (rank, folded, word)
        for rank, folded, word in positive
        if rank <= EXACT_NEIGHBOR_MAX_RANK
    }
    for landmark in LANDMARK_RANKS:
        if not positive:
            break
        nearest = min(
            positive,
            key=lambda entry: (
                abs(entry[0] - landmark),
                entry[0],
                entry[1],
                entry[2],
            ),
        )
        selected[(nearest[0], nearest[1])] = nearest
    return [
        [rank, word]
        for rank, _folded, word in sorted(
            selected.values(), key=lambda item: (item[0], item[1], item[2])
        )
    ]


def _validate_target(
    manifest_target: object,
    hole: object,
    ranks: dict[str, Any],
    *,
    puzzle_number: int,
    hole_number: int,
) -> dict[str, Any]:
    prefix = f"puzzle {puzzle_number} target {hole_number}"
    target = _record(manifest_target, f"{prefix} manifest record")
    puzzle_hole = _record(hole, f"{prefix} hole")
    secret = _record(puzzle_hole.get("secret"), f"{prefix} secret")
    start = _record(puzzle_hole.get("start"), f"{prefix} start")
    target_word = _string(target.get("word"), f"{prefix} word")
    target_slug = _string(target.get("slug"), f"{prefix} slug")
    start_word = _string(target.get("start"), f"{prefix} start word")
    start_rank = _integer(target.get("start_rank"), f"{prefix} start rank")
    if secret.get("word") != target_word or secret.get("slug") != target_slug:
        raise DistillationError(f"{prefix} secret does not match the manifest")
    if start.get("word") != start_word or puzzle_hole.get("start_rank") != start_rank:
        raise DistillationError(f"{prefix} starting clue does not match the manifest")
    rank_entries = _rank_entries(ranks.get(target_slug), f"{prefix} rank map")
    rank_zero = [entry for entry in rank_entries if entry[0] == 0]
    if len(rank_zero) != 1 or rank_zero[0][1] != target_slug:
        raise DistillationError(f"{prefix} rank map does not bind rank 0 to its secret")
    start_slug = _string(start.get("slug"), f"{prefix} start slug")
    start_entries = [entry for entry in rank_entries if entry[1] == start_slug]
    if len(start_entries) != 1 or start_entries[0][0] != start_rank:
        raise DistillationError(f"{prefix} start rank does not match its rank map")

    return {
        "hole": hole_number,
        "position": _integer(puzzle_hole.get("pos"), f"{prefix} position"),
        "answer": target_word,
        "answer_slug": target_slug,
        "part_of_speech": _string(target.get("pos"), f"{prefix} part of speech"),
        "gender": target.get("gender"),
        "frequency_rank": _integer(
            target.get("frequency_rank"), f"{prefix} frequency rank"
        ),
        "frequency_band": _string(
            target.get("frequency_band"), f"{prefix} frequency band"
        ),
        "semantic_class": _string(
            target.get("semantic_class"), f"{prefix} semantic class"
        ),
        "starting_clue": start_word,
        "starting_rank": start_rank,
        "representative_neighbors": _sample_neighbors(rank_entries),
    }


def load_corpus(manifest_path: Path) -> dict[str, Any]:
    manifest_path = manifest_path.resolve()
    manifest = _load_json(manifest_path, "corpus manifest")
    if (
        manifest.get("schema_version") != 1
        or manifest.get("manifest_kind") != "playbook_distillation_corpus"
        or manifest.get("dataset_id") != "strategy-fr-92"
        or manifest.get("lang") != "fr"
    ):
        raise DistillationError("unsupported playbook corpus manifest")
    counts = _record(manifest.get("counts"), "corpus counts")
    if (
        counts.get("puzzles") != EXPECTED_PUZZLES
        or counts.get("targets") != EXPECTED_TARGETS
    ):
        raise DistillationError(
            f"corpus must declare {EXPECTED_PUZZLES} puzzles and "
            f"{EXPECTED_TARGETS} targets"
        )
    records = _array(manifest.get("puzzles"), "corpus puzzles")
    if len(records) != EXPECTED_PUZZLES:
        raise DistillationError(
            f"corpus must contain exactly {EXPECTED_PUZZLES} puzzle records"
        )

    dataset_dir = manifest_path.parent
    seen_paths: set[Path] = set()
    packet_puzzles: list[dict[str, Any]] = []
    target_count = 0
    neighbor_count = 0
    for expected_number, raw_record in enumerate(records, start=1):
        record = _record(raw_record, f"puzzle record {expected_number}")
        number = _integer(record.get("number"), f"puzzle record {expected_number} number")
        if number != expected_number:
            raise DistillationError(
                "corpus puzzle numbers must be contiguous and manifest-ordered"
            )
        path = _safe_corpus_path(dataset_dir, record.get("path"))
        if path in seen_paths:
            raise DistillationError(f"duplicate corpus puzzle path: {path}")
        seen_paths.add(path)
        expected_sha = _string(record.get("sha256"), f"puzzle {number} sha256")
        if not SHA256_RE.fullmatch(expected_sha):
            raise DistillationError(f"puzzle {number} has an invalid sha256")
        puzzle, actual_sha = _load_gzip_json(path)
        if actual_sha != expected_sha:
            raise DistillationError(
                f"puzzle {number} content sha256 does not match the manifest"
            )
        if puzzle.get("lang") != "fr":
            raise DistillationError(f"puzzle {number} is not French")
        words = _array(puzzle.get("words"), f"puzzle {number} words")
        if not all(isinstance(word, str) for word in words):
            raise DistillationError(f"puzzle {number} words must all be strings")
        sentence = _string(record.get("sentence"), f"puzzle {number} sentence")
        if " ".join(words) != sentence:
            raise DistillationError(
                f"puzzle {number} sentence does not match its puzzle contents"
            )
        holes = _array(puzzle.get("holes"), f"puzzle {number} holes")
        targets = _array(record.get("targets"), f"puzzle {number} targets")
        if len(holes) != 3 or len(targets) != 3:
            raise DistillationError(f"puzzle {number} must contain exactly 3 targets")
        ranks = _record(puzzle.get("ranks"), f"puzzle {number} ranks")
        packet_targets = [
            _validate_target(
                target,
                hole,
                ranks,
                puzzle_number=number,
                hole_number=hole_number,
            )
            for hole_number, (target, hole) in enumerate(
                zip(targets, holes, strict=True), start=1
            )
        ]
        target_count += len(packet_targets)
        neighbor_count += sum(
            len(target["representative_neighbors"]) for target in packet_targets
        )
        packet_puzzles.append(
            {
                "puzzle": number,
                "sentence": sentence,
                "targets": packet_targets,
            }
        )

    actual_files = {
        path.resolve() for path in dataset_dir.rglob("*.json.gz") if path.is_file()
    }
    if actual_files != seen_paths:
        missing = len(seen_paths - actual_files)
        extra = len(actual_files - seen_paths)
        raise DistillationError(
            f"corpus input graph differs from the manifest (missing={missing}, extra={extra})"
        )
    if target_count != EXPECTED_TARGETS:
        raise DistillationError(
            f"corpus contains {target_count} targets, expected {EXPECTED_TARGETS}"
        )

    packet = {
        "schema_version": PACKET_SCHEMA_VERSION,
        "dataset_id": "strategy-fr-92",
        "language": "fr",
        "sampling": {
            "exact_neighbor_ranks": [1, EXACT_NEIGHBOR_MAX_RANK],
            "additional_rank_landmarks": list(LANDMARK_RANKS),
            "selection": (
                "all available positive ranks through the exact limit, then the "
                "deterministically nearest available entry to each landmark"
            ),
        },
        "puzzles": packet_puzzles,
    }
    packet_json = _canonical_json(packet)
    manifest_sha = _sha256_file(manifest_path)
    packet_sha = _sha256_text(packet_json)
    return {
        "manifest_path": manifest_path,
        "input_paths": {manifest_path, *seen_paths},
        "identity": {
            "dataset_id": "strategy-fr-92",
            "manifest_sha256": manifest_sha,
            "packet_schema_version": PACKET_SCHEMA_VERSION,
            "packet_sha256": packet_sha,
            "packet_bytes": len(packet_json.encode("utf-8")),
            "puzzles": EXPECTED_PUZZLES,
            "targets": EXPECTED_TARGETS,
            "representative_neighbors": neighbor_count,
        },
        "packet_json": packet_json,
    }


def _common_evidence(packet_json: str) -> str:
    return f"""WHIPPIN PLAYBOOK DISTILLATION — SHARED EVIDENCE

Whippin is a French sentence-reconstruction game with three hidden lexical cores.
The visible sentence context and one uncounted starting clue/rank per target are known.
Each unique vocabulary-valid guess is broadcast to every unsolved target. Rank 0 is
exact; lower positive ranks are closer; MISS is outside the stored neighborhood; only
strict improvement changes a clue. Answers require the sentence's exact inflected form.

The corpus below contains all 92 training puzzles and all 276 targets. Full rank maps
remain in the audited source files. To fit one context, representative_neighbors keeps
the complete close neighborhood through rank {EXACT_NEIGHBOR_MAX_RANK} plus deterministic
landmarks through rank 10,000. Starting clues/ranks and target metadata are always exact.

EVIDENCE_PACKET_JSON
{packet_json}
END_EVIDENCE_PACKET
"""


def analyst_prompt(packet_json: str) -> str:
    return (
        _common_evidence(packet_json)
        + f"""
ANALYST PASS v{ANALYST_PROMPT_VERSION}

Study the entire corpus deeply and derive the strongest reusable strategy you can for
future unseen Whippin puzzles played under the neutral prompt. Look for interactions
between fixed sentence context, exact morphology, embedding ranks, starting clues,
multi-target broadcasts, exploration, exploitation, elimination, and failure recovery.
Interrogate surprising cases and weak heuristics instead of merely summarizing rules.

Produce an unrestricted analyst report and draft playbook with whatever structure and
length genuinely improve future play. Include rationale, decision policies, tradeoffs,
failure modes, and concrete tests for when to abandon a line. This analyst reply is
audit-only and will never be injected into gameplay. Do not optimize for brevity or a
fixed item count.
"""
    )


def critic_prompt(packet_json: str, analyst_response: str) -> str:
    return (
        _common_evidence(packet_json)
        + f"""
CRITIC/REWRITE PASS v{CRITIC_PROMPT_VERSION}

Below is a first analyst's report. Independently check it against the complete evidence,
identify unsupported or brittle advice, repair omissions and contradictions, and rewrite
it into the best operational playbook for this same model on future unseen puzzles.

Only your response from this pass will be injected verbatim beneath a YOUR PLAYBOOK
heading after the fixed game rules. Therefore:
- return only the final playbook, with no critique, preface, grading, or process notes;
- make it directly actionable during turn-by-turn play;
- generalize instead of quoting or naming corpus sentences, puzzle IDs, target answers,
  or starting clues;
- never contradict the fixed game/reply rules;
- use whatever structure and length quality requires; there is no item or character cap.

BEGIN_ANALYST_REPORT
{analyst_response}
END_ANALYST_REPORT
"""
    )


def _model_file_stem(config: ModelConfig) -> str:
    return re.sub(r"[^a-z0-9]+", "-", config["model_id"].lower()).strip("-")


def ultra_provider_settings(
    config: ModelConfig, auth: str
) -> dict[str, str]:
    if config["provider"] == "anthropic":
        return {
            "workflow_effort": WORKFLOW_EFFORT,
            "provider_effort": "max",
            "reasoning_mode": "adaptive",
            "mapping": "Anthropic adaptive thinking with max effort",
        }
    if config["provider"] == "openai" and auth == "subscription":
        return {
            "workflow_effort": WORKFLOW_EFFORT,
            "provider_effort": "ultra",
            "reasoning_mode": "standard",
            "mapping": "Codex plan literal ultra reasoning effort",
        }
    if config["provider"] == "openai" and auth == "api":
        return {
            "workflow_effort": WORKFLOW_EFFORT,
            "provider_effort": "max",
            "reasoning_mode": "pro",
            "mapping": "Responses API max effort with Pro reasoning mode",
        }
    raise DistillationError(
        f"unsupported ultra transport: {config['provider']} via {auth}"
    )


def _new_artifact(
    config: ModelConfig,
    auth: str,
    provider_settings: Mapping[str, str],
    corpus_identity: Mapping[str, Any],
    analyst_prompt_sha256: str,
) -> dict[str, Any]:
    return {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "kind": "whippin_playbook_distillation_audit",
        "workflow_version": WORKFLOW_VERSION,
        "created_at": _utc_now(),
        "config": {
            "model_id": config["model_id"],
            "provider": config["provider"],
            "auth": auth,
            "gameplay_prompt_version": PROMPT_VERSION,
            "workflow_effort": WORKFLOW_EFFORT,
            "provider_effort": provider_settings["provider_effort"],
            "reasoning_mode": provider_settings["reasoning_mode"],
            "analyst_prompt_version": ANALYST_PROMPT_VERSION,
            "critic_prompt_version": CRITIC_PROMPT_VERSION,
        },
        "corpus": dict(corpus_identity),
        "stages": {
            "analyst": {
                "status": "pending",
                "attempts": 0,
                "prompt_sha256": analyst_prompt_sha256,
            },
            "critic": {"status": "pending", "attempts": 0},
        },
    }


def _validate_completed_stage(
    stage: object, label: str, expected_prompt_sha256: str
) -> str | None:
    record = _record(stage, f"{label} stage")
    status = record.get("status")
    if status not in {"pending", "running", "complete"}:
        raise DistillationError(f"{label} stage has an invalid status")
    attempts = record.get("attempts")
    if isinstance(attempts, bool) or not isinstance(attempts, int) or attempts < 0:
        raise DistillationError(f"{label} stage has an invalid attempt count")
    if record.get("prompt_sha256") not in {None, expected_prompt_sha256}:
        raise DistillationError(f"{label} prompt identity changed; refusing reuse")
    if status != "complete":
        return None
    response = _string(record.get("response"), f"{label} response")
    if record.get("response_sha256") != _sha256_text(response):
        raise DistillationError(f"{label} response hash does not match")
    if record.get("prompt_sha256") != expected_prompt_sha256:
        raise DistillationError(f"{label} completed under a different prompt")
    return response


def _load_or_create_artifact(
    path: Path,
    expected: dict[str, Any],
) -> dict[str, Any]:
    if not path.exists():
        _write_json_atomic(path, expected, indent=2)
        return expected
    artifact = _load_json(path, "distillation artifact")
    for key in ("schema_version", "kind", "workflow_version", "config", "corpus"):
        if artifact.get(key) != expected.get(key):
            raise DistillationError(
                f"existing artifact {path} has a different {key}; refusing paid reuse"
            )
    stages = _record(artifact.get("stages"), "distillation stages")
    if set(stages) != {"analyst", "critic"}:
        raise DistillationError("distillation artifact has an invalid stage graph")
    return artifact


def _stage_call(
    *,
    artifact: dict[str, Any],
    artifact_path: Path,
    stage_name: str,
    prompt: str,
    reply: Any,
) -> str:
    stage = _record(
        _record(artifact.get("stages"), "distillation stages").get(stage_name),
        f"{stage_name} stage",
    )
    prompt_sha = _sha256_text(prompt)
    completed = _validate_completed_stage(stage, stage_name, prompt_sha)
    if completed is not None:
        print(f"{stage_name}: already complete; reusing checkpoint", flush=True)
        return completed

    stage["status"] = "running"
    stage["attempts"] += 1
    stage["prompt_sha256"] = prompt_sha
    stage["started_at"] = _utc_now()
    stage.pop("last_error", None)
    _write_json_atomic(artifact_path, artifact, indent=2)
    print(
        f"{stage_name}: starting paid ultra pass (attempt {stage['attempts']})",
        flush=True,
    )
    started = time.monotonic()
    try:
        response = reply([{"role": "user", "content": prompt}])
        if not isinstance(response, str) or not response.strip():
            raise DistillationError(f"{stage_name} returned an empty response")
    except Exception as exc:
        stage["status"] = "pending"
        stage["last_error"] = str(exc)
        stage["duration_seconds"] = time.monotonic() - started
        _write_json_atomic(artifact_path, artifact, indent=2)
        raise

    stage["status"] = "complete"
    stage["response"] = response
    stage["response_sha256"] = _sha256_text(response)
    stage["duration_seconds"] = time.monotonic() - started
    stage["completed_at"] = _utc_now()
    usage = getattr(reply, "last_token_usage", None)
    if isinstance(usage, Mapping):
        stage["token_usage"] = dict(usage)
    _write_json_atomic(artifact_path, artifact, indent=2)
    print(
        f"{stage_name}: complete ({len(response.encode('utf-8'))} response bytes)",
        flush=True,
    )
    return response


def _build_profile(
    config: ModelConfig,
    artifact: Mapping[str, Any],
    corpus_identity: Mapping[str, Any],
    final_playbook: str,
) -> dict[str, Any]:
    stages = _record(artifact.get("stages"), "distillation stages")
    critic = _record(stages.get("critic"), "critic stage")
    return {
        "schema_version": PROFILE_SCHEMA_VERSION,
        "kind": "whippin_model_playbook",
        "model_id": config["model_id"],
        "provider": config["provider"],
        "gameplay_prompt_version": PROMPT_VERSION,
        "workflow_version": WORKFLOW_VERSION,
        "workflow_effort": WORKFLOW_EFFORT,
        "corpus": dict(corpus_identity),
        "generated_at": critic.get("completed_at"),
        "final_playbook": final_playbook,
        "final_playbook_sha256": _sha256_text(final_playbook),
    }


def _write_profile_idempotently(path: Path, profile: dict[str, Any]) -> None:
    if path.exists():
        existing = _load_json(path, "playbook profile")
        if existing != profile:
            raise DistillationError(
                f"refusing to overwrite a different playbook profile {path}"
            )
        return
    _write_json_atomic(path, profile, indent=2)


def _paths_do_not_collide(
    artifact_path: Path,
    profile_path: Path,
    input_paths: set[Path],
) -> None:
    artifact = artifact_path.resolve()
    profile = profile_path.resolve()
    if artifact == profile:
        raise DistillationError("artifact and profile outputs must be different paths")
    for output in (artifact, profile):
        if output in input_paths:
            raise DistillationError(f"output path collides with corpus input: {output}")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Distill one model's final playbook from all 92 puzzles using an "
            "ultra analyst pass followed by an ultra critic/rewrite pass."
        )
    )
    parser.add_argument("--model", required=True, metavar="MODEL")
    parser.add_argument(
        "--auth",
        choices=AUTH_MODES,
        default="subscription",
        help="provider API or authenticated Claude.ai/ChatGPT subscription",
    )
    parser.add_argument("--manifest", type=Path, default=CORPUS_MANIFEST)
    parser.add_argument("--artifact", type=Path)
    parser.add_argument("--profile-out", type=Path)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="validate and report exact work without auth checks, writes, or provider calls",
    )
    args = parser.parse_args(argv)
    try:
        args.model_config = select_model(args.model)
    except ValueError as exc:
        parser.error(str(exc))
    stem = _model_file_stem(args.model_config)
    args.artifact = (
        args.artifact
        if args.artifact is not None
        else OUTPUT_DIR / f"{stem}.distill.json"
    )
    args.profile_out = (
        args.profile_out
        if args.profile_out is not None
        else OUTPUT_DIR / f"{stem}.playbook.json"
    )
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    config: ModelConfig = args.model_config
    try:
        corpus = load_corpus(args.manifest)
        settings = ultra_provider_settings(config, args.auth)
        artifact_path = args.artifact.resolve()
        profile_path = args.profile_out.resolve()
        _paths_do_not_collide(
            artifact_path,
            profile_path,
            {path.resolve() for path in corpus["input_paths"]},
        )
        analyst = analyst_prompt(corpus["packet_json"])
        expected = _new_artifact(
            config,
            args.auth,
            settings,
            corpus["identity"],
            _sha256_text(analyst),
        )
    except DistillationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    report = {
        "model_id": config["model_id"],
        "provider": config["provider"],
        "auth": args.auth,
        **settings,
        "provider_calls": 2,
        "corpus": corpus["identity"],
        "artifact": str(artifact_path),
        "profile": str(profile_path),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    if args.dry_run:
        print("dry-run: no auth checks, writes, or provider calls", flush=True)
        return 0

    try:
        if config["provider"] == "anthropic" and args.auth == "subscription":
            validate_anthropic_subscription_auth()
        elif config["provider"] == "openai" and args.auth == "subscription":
            validate_openai_subscription_auth()

        api_key: str | None = None
        if args.auth == "api":
            env_name = PROVIDER_ENV[config["provider"]]
            api_key = os.environ.get(env_name)
            if not api_key:
                raise DistillationError(f"{env_name} is required for API auth")

        artifact = _load_or_create_artifact(artifact_path, expected)
        reply = provider_reply(
            config,
            api_key,
            effort=settings["provider_effort"],
            auth=args.auth,
            output="prose",
            reasoning_mode=(
                "pro" if settings["reasoning_mode"] == "pro" else "standard"
            ),
        )
        try:
            analyst_response = _stage_call(
                artifact=artifact,
                artifact_path=artifact_path,
                stage_name="analyst",
                prompt=analyst,
                reply=reply,
            )
            critic = critic_prompt(corpus["packet_json"], analyst_response)
            final_playbook = _stage_call(
                artifact=artifact,
                artifact_path=artifact_path,
                stage_name="critic",
                prompt=critic,
                reply=reply,
            )
        finally:
            close = getattr(reply, "close", None)
            if callable(close):
                close()

        profile = _build_profile(
            config,
            artifact,
            corpus["identity"],
            final_playbook,
        )
        _write_profile_idempotently(profile_path, profile)
    except Exception as exc:
        print(
            f"error: {config['tag']} ({config['model_id']}) distillation failed: {exc}",
            file=sys.stderr,
        )
        return 1

    print(f"final playbook -> {profile_path}", flush=True)
    print(f"audit artifact -> {artifact_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
