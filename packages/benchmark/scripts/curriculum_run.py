"""Offline strategy distillation and frozen holdout evaluation (#84).

One model receives one deterministic packet built exclusively from a frozen
15-puzzle training view.  For #86 calibration-roster models that packet may add
only that same model's own training-split neutral runs; no other model or test
data is opened.  A max-effort prose stage distils compact operational guidance,
then a separate test view reuses the compatible frozen profile while neutral,
learned, and exact-v7 arms play fresh untouched test puzzles.

Every completed paid unit is checkpointed atomically.  Older prompt artifacts
remain readable by ``evaluate`` but cannot be resumed into this prompt-v6
experiment.  Running this module is the only operation that
can make provider calls; importing it, building a packet, dry-running, and
evaluating artifacts are offline.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

SCRIPT_DIR = Path(__file__).resolve().parent
BENCHMARK_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

from llm_play import (  # noqa: E402
    DEFAULT_CAP,
    PROMPT_VERSION,
    PROVIDER_ENV,
    NoProgressReplyError,
    PuzzleReferee,
    RunResult,
    TryProgress,
    UnparseableReplyError,
    _last_token_usage,
    _transport_name,
    _validate_provider_effort,
    load_vocab,
    play_puzzle,
    provider_reply,
    select_model,
    validate_anthropic_subscription_auth,
    validate_openai_subscription_auth,
)
from curriculum_dataset import dataset_content_sha256  # noqa: E402
from curriculum_io import load_json, read_data_bytes, sha256_bytes  # noqa: E402
from slug import slug  # noqa: E402
from strategy_evidence import (  # noqa: E402
    PACKET_SCHEMA_VERSION,
    EvidencePacket,
    build_evidence_packet,
    write_evidence_packet,
)
import strategy_profiles as sp  # noqa: E402


CURRICULUM_PROMPT_VERSION = "6"
DISTILLATION_PROMPT_VERSION = "2"
REQUIRED_STRATEGY_EFFORT = "max"
CALIBRATED_PLAY_EFFORT = "medium"
HOLDOUT_RUNS_PER_CONDITION = 3
CONDITIONS = ("neutral", "learned", "v7")
STRUCTURED_MAX_ATTEMPTS = 3

OUTPUT_ROOT = BENCHMARK_DIR / "output" / "curriculum"
V7_STRATEGY_PATH = BENCHMARK_DIR / "datasets" / "v7-strategy.txt"

_WORD_RE = re.compile(r"[^\W\d_]+(?:-[^\W\d_]+)*", re.UNICODE)


class CurriculumError(RuntimeError):
    """A reproducibility, validation, or orchestration invariant failed."""


class CurriculumReporter:
    """Flush useful progress without changing prompts or checkpoint state."""

    def __init__(
        self,
        *,
        verbose: bool,
        artifact_path: Path,
        model_id: str,
        cap: int,
        completed_plays: int,
        total_plays: int,
    ) -> None:
        self.verbose = verbose
        self.total_plays = total_plays
        print(f"curriculum artifact: {artifact_path}", flush=True)
        print(
            f"curriculum progress: {completed_plays}/{total_plays} holdout plays "
            f"checkpointed; model={model_id}; cap={cap}; "
            f"curriculum_prompt=v{CURRICULUM_PROMPT_VERSION}",
            flush=True,
        )

    def distillation_started(self, attempt: int) -> None:
        print(
            f"[strategy] START max-effort distillation attempt "
            f"{attempt}/{STRUCTURED_MAX_ATTEMPTS}",
            flush=True,
        )

    def distillation_rejected(self, attempt: int, error: str) -> None:
        print(
            f"[strategy] REJECTED attempt {attempt}/{STRUCTURED_MAX_ATTEMPTS} — "
            f"{error}",
            flush=True,
        )

    def distillation_completed(self, strategy: list[str]) -> None:
        print(
            f"[strategy] DONE — frozen {len(strategy)} operational "
            f"item{'s' if len(strategy) != 1 else ''}",
            flush=True,
        )
        if self.verbose:
            print(sp.strategy_text(strategy), flush=True)

    def play_started(
        self,
        *,
        play_number: int,
        condition: str,
        puzzle_index: int,
        puzzle_count: int,
        run_number: int,
        puzzle_number: int,
    ) -> None:
        print(
            f"[play {play_number}/{self.total_plays}] START holdout/{condition} "
            f"puzzle {puzzle_index}/{puzzle_count} (dataset #{puzzle_number}) "
            f"run {run_number}/{HOLDOUT_RUNS_PER_CONDITION}",
            flush=True,
        )

    def counted_try(
        self,
        progress: TryProgress,
        *,
        play_number: int,
        condition: str,
        puzzle_index: int,
        puzzle_count: int,
        run_number: int,
    ) -> None:
        if not self.verbose:
            return
        print(
            f"[play {play_number}/{self.total_plays}] holdout/{condition} "
            f"puzzle {puzzle_index}/{puzzle_count} "
            f"run {run_number}/{HOLDOUT_RUNS_PER_CONDITION} "
            f"try={progress.number} "
            f"word={json.dumps(progress.word, ensure_ascii=False)} "
            f"progress={progress.progress:.2f}%",
            flush=True,
        )

    def play_completed(
        self,
        record: dict[str, Any],
        *,
        play_number: int,
        condition: str,
        puzzle_index: int,
        puzzle_count: int,
        run_number: int,
    ) -> None:
        if record["tries"] is None:
            score = (
                f"DNF ({record['termination_reason']}) at "
                f"{record['counted_tries']} counted tries"
            )
        else:
            unit = "try" if record["tries"] == 1 else "tries"
            score = f"{record['tries']} {unit}"
        print(
            f"[play {play_number}/{self.total_plays}] DONE holdout/{condition} "
            f"puzzle {puzzle_index}/{puzzle_count} "
            f"run {run_number}/{HOLDOUT_RUNS_PER_CONDITION} — {score}, "
            f"{record['wall_duration']:.2f}s",
            flush=True,
        )

    @staticmethod
    def complete(profile_path: Path) -> None:
        print(f"curriculum complete; frozen profile: {profile_path}", flush=True)


def resolve_path(path: Path) -> Path:
    """Accept absolute, caller-relative, repo-root, or package-relative paths."""
    if path.is_absolute():
        return path
    repo_root = BENCHMARK_DIR.parent.parent
    for candidate in (Path.cwd() / path, repo_root / path, BENCHMARK_DIR / path):
        if candidate.is_file():
            return candidate.resolve()
    return path


def load_v7_strategy(path: Path = V7_STRATEGY_PATH) -> str:
    if not path.is_file():
        raise CurriculumError(
            f"frozen v7 strategy missing at {path}; it must be recovered from a "
            "recorded v7 transcript, never paraphrased"
        )
    lines = [
        line
        for line in path.read_text(encoding="utf-8").splitlines()
        if not line.startswith("#")
    ]
    text = "\n".join(lines).strip()
    if not text:
        raise CurriculumError(f"frozen v7 strategy at {path} is empty")
    return text


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def save_artifact(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    tmp.replace(path)


def load_manifest(manifest_path: Path) -> tuple[dict[str, Any], str, str]:
    """Validate the immutable dataset and return content and file identities."""
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    dataset_dir = manifest_path.parent
    for record in manifest["puzzles"]:
        actual = sha256_bytes(read_data_bytes(dataset_dir / record["path"]))
        if actual != record["sha256"]:
            raise CurriculumError(
                f"dataset puzzle {record['path']} does not match its manifest "
                "sha256; refusing to run on a modified dataset"
            )
    generator_record = manifest["generator_output"]
    generator_actual = _sha256_file(dataset_dir / generator_record["path"])
    if generator_actual != generator_record["sha256"]:
        raise CurriculumError(
            "dataset generator output does not match its manifest sha256; "
            "refusing to run on modified provenance"
        )
    content_sha = dataset_content_sha256(manifest)
    if content_sha != manifest.get("dataset_content_sha256"):
        raise CurriculumError(
            "dataset content identity does not match its manifest; refusing to run"
        )
    return manifest, content_sha, _sha256_file(manifest_path)


def _load_puzzle(dataset_dir: Path, record: dict[str, Any]) -> dict[str, Any]:
    return load_json(dataset_dir / record["path"])


# --- Deterministic distillation prompt and strategy validation -----------------


def distillation_prompt(packet: EvidencePacket, *, play_effort: str) -> str:
    """Return the exact deterministic prompt whose hash is pinned in artifacts."""
    packet_text = packet.canonical_bytes.decode("utf-8")
    target_count = packet.document["content"]["target_count"]
    calibration_guidance = (
        "The packet also contains only this model's own neutral calibration runs "
        "on these training puzzles. Use their counted guesses, rejections, rank "
        "trajectories, and failures as behavioral evidence; no other model or test "
        "run is present."
        if packet.document["schema_version"] == PACKET_SCHEMA_VERSION
        else "The packet contains static labeled curriculum evidence only."
    )
    return "\n".join(
        [
            f"WHIPPIN STRATEGY DISTILLATION PROMPT v{DISTILLATION_PROMPT_VERSION}",
            "",
            "You are designing a general strategy for your own lower-effort playing self.",
            f"That player will run with reasoning effort {play_effort!r} and must reply "
            "with exactly one French word on every turn.",
            "",
            "GAME AND RUNTIME CONTRACT",
            "- The goal is to solve every CLOZE blank in the fewest counted guesses.",
            "- One valid, untried guess is tested against every unsolved target.",
            "- Rank 0 solves a target; lower positive ranks are closer; MISS is outside "
            "the stored neighborhood.",
            "- During play you see the fixed CLOZE, solved locks, each unsolved target's "
            "current best displayed clue and rank, feedback for the latest guess, the "
            "no-improvement streak, and the unordered set of tried words.",
            "- You do not see answers, full rank maps, past hidden states, semantic-family "
            "labels, or this packet during holdout play.",
            "- Exact inflection matters. Invalid and repeated words do not count, but they "
            "waste a provider turn.",
            "- Embedding rank measures contextual relatedness, not synonymy, grammar, or "
            "transitive similarity between guesses.",
            "",
            "TRAINING TASK",
            f"Analyze all {target_count} labeled curriculum targets and infer a compact "
            "method that the same model can reliably execute from runtime-visible evidence "
            "alone.",
            calibration_guidance,
            "The answers and rank evidence below are privileged training data. Do not copy "
            "any answer, start, retained evidence word, sentence quotation, puzzle-specific "
            "clue, memorized hint, or semantic-family name into the strategy.",
            "Write the operational strategy in English to reduce accidental copying from "
            "the French evidence. The analysis may discuss training examples because it is "
            "stored for audit and never injected into play.",
            "Before returning, slug-check every strategy token (including hyphen segments) "
            "against every answer, start, and retained evidence slug in the packet. Rewrite "
            "any collision; even an accidental shared article or cognate is rejected.",
            "",
            "OUTPUT CONTRACT",
            "Return one JSON object and nothing else:",
            '{"analysis":"unrestricted non-empty training analysis","strategy":'
            '["compact operational item","..."]}',
            f"strategy must contain 1-{sp.STRATEGY_MAX_ITEMS} non-empty single-line "
            f"strings and at most {sp.STRATEGY_MAX_CHARS} characters total.",
            "Every strategy item must be general, executable using only the runtime "
            "contract above, and must not encode puzzle-specific material.",
            "",
            "EVIDENCE_PACKET_CANONICAL_JSON_BEGIN",
            packet_text,
            "EVIDENCE_PACKET_CANONICAL_JSON_END",
        ]
    )


def _parse_json_reply(reply: str) -> dict[str, Any]:
    if not isinstance(reply, str):
        raise ValueError("reply must be a string containing exactly one JSON object")
    text = reply.strip()
    if text.startswith("```") and text.endswith("```"):
        lines = text.splitlines()
        if len(lines) >= 3 and lines[0].strip().lower() in {"```", "```json"}:
            text = "\n".join(lines[1:-1]).strip()
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"reply must be exactly one valid JSON object: {exc.msg}") from exc
    if not isinstance(payload, dict):
        raise ValueError("reply JSON must be an object")
    return payload


def _token_slug_forms(token: str) -> set[str]:
    folded = slug(token)
    if not folded:
        return set()
    return {folded, *(part for part in folded.split("-") if part)}


def _core_slug_sequence(text: str) -> list[str]:
    return [folded for token in _WORD_RE.findall(text) if (folded := slug(token))]


def _trigrams(words: Iterable[str]) -> set[tuple[str, str, str]]:
    sequence = list(words)
    return {
        tuple(sequence[index : index + 3])
        for index in range(max(0, len(sequence) - 2))
    }


def _leak_corpus(packet: EvidencePacket) -> tuple[
    set[str], set[tuple[str, str, str]], set[tuple[str, str, str]]
]:
    """Collect all individual privileged words and copied three-word runs."""
    banned_words: set[str] = set()
    sentence_runs: set[tuple[str, str, str]] = set()
    evidence_runs: set[tuple[str, str, str]] = set()

    def ban(value: str) -> None:
        banned_words.update(_token_slug_forms(value))

    for puzzle in packet.document["content"]["puzzles"]:
        sentence_runs.update(_trigrams(_core_slug_sequence(puzzle["sentence"])))
        for target in puzzle["targets"]:
            ban(target["answer_slug"])
            ban(target["start"]["slug"])
            evidence = target["rank_evidence"]
            groups = [evidence["exact_rank_1_through_250"]] + [
                band["entries"] for band in evidence["sampled_bands"]
            ]
            for entries in groups:
                sequence = []
                for entry in entries:
                    ban(entry["slug"])
                    sequence.append(entry["slug"])
                evidence_runs.update(_trigrams(sequence))
    calibration = packet.document["content"].get("model_calibration_evidence", {})
    for puzzle in calibration.get("puzzles", []):
        for run in puzzle.get("runs", []):
            for word in run.get("tried_words", []):
                if isinstance(word, str):
                    ban(word)
    return banned_words, sentence_runs, evidence_runs


def validate_distillation(
    payload: dict[str, Any], packet: EvidencePacket
) -> tuple[str, list[str]]:
    if set(payload) != {"analysis", "strategy"}:
        raise ValueError("reply must contain exactly analysis and strategy")
    analysis = payload.get("analysis")
    if not isinstance(analysis, str) or not analysis.strip():
        raise ValueError("analysis must be a non-empty string")
    strategy = sp.validate_strategy_items(payload.get("strategy"))
    banned_words, sentence_runs, evidence_runs = _leak_corpus(packet)
    for item in strategy:
        for token in _WORD_RE.findall(item):
            overlap = _token_slug_forms(token) & banned_words
            if overlap:
                leaked = sorted(overlap)[0]
                raise ValueError(
                    f"strategy token {token!r} copies privileged evidence word "
                    f"{leaked!r}"
                )
        item_runs = _trigrams(_core_slug_sequence(item))
        if item_runs & sentence_runs:
            raise ValueError("strategy quotes a curriculum sentence sequence")
        if item_runs & evidence_runs:
            raise ValueError("strategy copies a retained rank-evidence sequence")
    return analysis.strip(), strategy


def _attempt_prompt(base_prompt: str, prior_attempts: list[dict[str, Any]]) -> str:
    """Make each bounded repair standalone so resumed subscription calls are fresh."""
    errors = [
        attempt.get("validation_error") or attempt.get("provider_error")
        for attempt in prior_attempts
        if attempt.get("validation_error") or attempt.get("provider_error")
    ]
    if not errors:
        return base_prompt
    lines = [
        base_prompt,
        "",
        "REPAIR REQUIREMENTS FROM EARLIER REJECTED ATTEMPTS",
        *[f"- {error}" for error in errors],
        "Produce a fully replacement JSON object satisfying every original constraint.",
    ]
    return "\n".join(lines)


def _close_provider(caller: Any) -> None:
    close = getattr(caller, "close", None)
    if callable(close):
        close()


def _distil_strategy(
    *,
    state: dict[str, Any],
    artifact_path: Path,
    packet: EvidencePacket,
    prompt: str,
    config: dict[str, Any],
    api_key: str | None,
    auth: str,
    provider_factory: Callable[..., Any],
    reporter: CurriculumReporter,
) -> tuple[str, list[str]]:
    stage = state["distillation"]
    if stage.get("status") == "complete":
        try:
            return validate_distillation(
                {
                    "analysis": stage.get("analysis"),
                    "strategy": stage.get("strategy"),
                },
                packet,
            )
        except ValueError as exc:
            raise CurriculumError(
                f"checkpointed strategy no longer validates: {exc}"
            ) from exc
    attempts = stage.setdefault("attempts", [])
    if len(attempts) >= STRUCTURED_MAX_ATTEMPTS:
        stage["status"] = "failed"
        save_artifact(artifact_path, state)
        raise CurriculumError(
            f"strategy distillation exhausted {STRUCTURED_MAX_ATTEMPTS} attempts; "
            "start a new artifact after correcting the prompt/provider issue"
        )

    while len(attempts) < STRUCTURED_MAX_ATTEMPTS:
        number = len(attempts) + 1
        reporter.distillation_started(number)
        request = _attempt_prompt(prompt, attempts)
        caller = provider_factory(
            config,
            api_key,
            effort=REQUIRED_STRATEGY_EFFORT,
            auth=auth,
            output="prose",
        )
        started = time.monotonic()
        response: str | None = None
        provider_error: str | None = None
        try:
            response = caller([{"role": "user", "content": request}])
        except Exception as exc:  # provider failures consume a bounded attempt
            provider_error = f"{type(exc).__name__}: {exc}"
        duration = time.monotonic() - started
        usage = _last_token_usage(caller)
        _close_provider(caller)
        attempt_record: dict[str, Any] = {
            "number": number,
            "request_sha256": hashlib.sha256(request.encode("utf-8")).hexdigest(),
            "response": response,
            "provider_error": provider_error,
            "validation_error": None,
            "token_usage": usage,
            "wall_duration": duration,
        }
        if provider_error is None:
            try:
                analysis, strategy = validate_distillation(
                    _parse_json_reply(response or ""), packet
                )
            except ValueError as exc:
                attempt_record["validation_error"] = str(exc)
            else:
                attempts.append(attempt_record)
                stage.update(
                    {
                        "status": "complete",
                        "analysis": analysis,
                        "strategy": strategy,
                        "completed_at": datetime.now(timezone.utc).isoformat(),
                        "wall_duration": sum(
                            attempt["wall_duration"] for attempt in attempts
                        ),
                    }
                )
                save_artifact(artifact_path, state)
                reporter.distillation_completed(strategy)
                return analysis, strategy

        attempts.append(attempt_record)
        stage["status"] = (
            "failed"
            if len(attempts) >= STRUCTURED_MAX_ATTEMPTS
            else "pending"
        )
        save_artifact(artifact_path, state)
        error = provider_error or attempt_record["validation_error"] or "unknown error"
        reporter.distillation_rejected(number, error)

    raise CurriculumError(
        f"strategy distillation is invalid after {STRUCTURED_MAX_ATTEMPTS} "
        f"attempts: {attempts[-1].get('validation_error') or attempts[-1].get('provider_error')}"
    )


# --- Ordinary one-word run records and replay metrics ---------------------------


def derive_run_metrics(
    puzzle: dict[str, Any], vocab: set[str], tried_words: tuple[str, ...]
) -> dict[str, Any]:
    """Replay a run through the real referee and derive the issue's metrics."""
    referee = PuzzleReferee(puzzle, vocab)
    max_streak = 0
    non_improving = 0
    first_sub100_try: int | None = None
    guess_trace: list[dict[str, Any]] = []
    for word in tried_words:
        feedback = referee.submit(word)
        if feedback.kind != "counted":
            raise CurriculumError(f"recorded run contains non-counting word {word!r}")
        max_streak = max(max_streak, referee.stalled_tries)
        if referee.stalled_tries > 0:
            non_improving += 1
        if first_sub100_try is None and any(
            0 < hole.rank <= 100 for hole in referee.holes
        ):
            first_sub100_try = feedback.tries
        guess_trace.append(
            {
                "try": feedback.tries,
                "guess": word,
                "outcomes": [
                    {
                        "word": outcome.number,
                        "rank": outcome.rank,
                        "improved": outcome.improved,
                        "solved": outcome.solved,
                    }
                    for outcome in feedback.outcomes
                ],
                "current_best_ranks": {
                    str(hole.number): hole.rank for hole in referee.holes
                },
                "no_improvement_streak": referee.stalled_tries,
            }
        )
    counted = referee.tries
    return {
        "max_no_improvement_streak": max_streak,
        "non_improving_guesses": non_improving,
        "guesses_after_rank100": (
            counted - first_sub100_try if first_sub100_try is not None else 0
        ),
        "solved": referee.solved,
        "guess_trace": guess_trace,
    }


def _run_record(
    result: RunResult,
    metrics: dict[str, Any],
    *,
    termination_reason: str,
    wall_duration: float,
) -> dict[str, Any]:
    return {
        "tries": result.tries,
        "counted_tries": result.counted_tries,
        "turns": result.turns,
        "duration": result.duration,
        "wall_duration": wall_duration,
        "tried_words": list(result.tried_words),
        "conversation": [dict(message) for message in result.conversation],
        "turn_token_usage": list(result.turn_token_usage),
        "termination_reason": termination_reason,
        "metrics": metrics,
    }


def _partial_result(exc: Exception) -> RunResult | None:
    value = getattr(exc, "partial_result", None)
    return value if isinstance(value, RunResult) else None


def _play_once(
    *,
    puzzle: dict[str, Any],
    vocab: set[str],
    strategy: str | None,
    config: dict[str, Any],
    api_key: str | None,
    play_effort: str,
    auth: str,
    cap: int,
    provider_factory: Callable[..., Any],
    on_try: Callable[[TryProgress], None],
) -> dict[str, Any]:
    player = provider_factory(
        config,
        api_key,
        effort=play_effort,
        auth=auth,
        output="word",
    )
    started = time.monotonic()
    termination_reason: str
    try:
        try:
            result = play_puzzle(
                puzzle,
                vocab,
                player,
                cap=cap,
                on_try=on_try,
                strategy=strategy,
                rules_only=True,
            )
        except UnparseableReplyError as exc:
            result = _partial_result(exc)
            if result is None:
                raise
            termination_reason = "unparseable_replies"
        except NoProgressReplyError as exc:
            result = _partial_result(exc)
            if result is None:
                raise
            termination_reason = "no_progress_replies"
        else:
            termination_reason = "solved" if result.tries is not None else "cap"
    finally:
        _close_provider(player)
    wall_duration = time.monotonic() - started
    metrics = derive_run_metrics(puzzle, vocab, result.tried_words)
    return _run_record(
        result,
        metrics,
        termination_reason=termination_reason,
        wall_duration=wall_duration,
    )


# --- Orchestration --------------------------------------------------------------


def _completed_play_count(state: dict[str, Any]) -> int:
    return sum(
        len(entry.get("runs", []))
        for entries in state.get("holdout", {}).values()
        for entry in entries
    )


def _strategy_sha256(items: Any) -> str:
    rendered = sp.strategy_text(items)
    return hashlib.sha256(rendered.encode("utf-8")).hexdigest()


def _validate_holdout_identity(
    state: dict[str, Any], records: list[dict[str, Any]]
) -> None:
    holdout = state.get("holdout")
    if not isinstance(holdout, dict) or set(holdout) != set(CONDITIONS):
        raise CurriculumError("artifact holdout arms do not match prompt-v6 conditions")
    expected = {record["number"]: record for record in records}
    for condition in CONDITIONS:
        entries = holdout[condition]
        if not isinstance(entries, list):
            raise CurriculumError(f"holdout/{condition} must be a list")
        numbers = [entry.get("number") for entry in entries]
        if len(numbers) != len(set(numbers)):
            raise CurriculumError(f"holdout/{condition} contains duplicate puzzles")
        if any(number not in expected for number in numbers):
            raise CurriculumError(f"holdout/{condition} contains an unknown puzzle")
        for entry in entries:
            record = expected[entry["number"]]
            if entry.get("path") != record["path"] or entry.get("sha256") != record["sha256"]:
                raise CurriculumError(
                    f"holdout/{condition} puzzle {entry['number']} identity changed"
                )
            runs = entry.get("runs")
            if not isinstance(runs, list) or len(runs) > HOLDOUT_RUNS_PER_CONDITION:
                raise CurriculumError(
                    f"holdout/{condition} puzzle {entry['number']} has an invalid run count"
                )


def _validate_distillation_state(state: dict[str, Any]) -> None:
    stage = state.get("distillation")
    if not isinstance(stage, dict) or stage.get("status") not in {
        "pending",
        "complete",
        "failed",
    }:
        raise CurriculumError("artifact has an invalid distillation stage")
    attempts = stage.get("attempts")
    if not isinstance(attempts, list) or len(attempts) > STRUCTURED_MAX_ATTEMPTS:
        raise CurriculumError("artifact has an invalid distillation attempt count")
    if [attempt.get("number") for attempt in attempts] != list(
        range(1, len(attempts) + 1)
    ):
        raise CurriculumError("artifact distillation attempt numbers are not contiguous")
    frozen_profile_source = stage.get("source") == "frozen_profile"
    if frozen_profile_source and (stage["status"] != "complete" or attempts):
        raise CurriculumError(
            "artifact frozen-profile strategy must be complete without distillation attempts"
        )
    if stage["status"] == "complete" and not attempts and not frozen_profile_source:
        raise CurriculumError("artifact marks distillation complete without an attempt")
    if stage["status"] == "failed" and len(attempts) != STRUCTURED_MAX_ATTEMPTS:
        raise CurriculumError("artifact marks distillation failed before exhausting attempts")
    completed_plays = _completed_play_count(state)
    if completed_plays or frozen_profile_source:
        if stage["status"] != "complete":
            raise CurriculumError("artifact contains holdout play before strategy freeze")
        try:
            expected_sha = _strategy_sha256(stage.get("strategy"))
        except ValueError as exc:
            raise CurriculumError(
                f"artifact holdout strategy is invalid: {exc}"
            ) from exc
        if stage.get("frozen_strategy_sha256") != expected_sha:
            raise CurriculumError(
                "artifact contains holdout play without its matching frozen strategy hash"
            )


def _build_distilled_profile_from_state(state: dict[str, Any]) -> dict[str, Any]:
    """Build the reusable profile pinned by a frozen prompt-v5/v6 distillation."""
    config = state.get("config")
    if not isinstance(config, dict):
        raise CurriculumError("cannot export profile: artifact config is missing")
    if config.get("artifact_schema_version") not in {5, 6}:
        raise CurriculumError(
            "cannot export profile: only prompt-v5/v6 artifacts are supported"
        )
    if config.get("profile_schema_version") != sp.PROFILE_SCHEMA_VERSION:
        raise CurriculumError(
            "cannot export profile: artifact profile schema is incompatible"
        )
    if config.get("strategy_source", "distillation") != "distillation":
        raise CurriculumError(
            "cannot export profile: artifact already reuses a frozen profile"
        )

    _validate_distillation_state(state)
    stage = state["distillation"]
    if stage.get("status") != "complete":
        raise CurriculumError("cannot export profile before distillation completes")
    try:
        expected_strategy_sha = _strategy_sha256(stage.get("strategy"))
    except ValueError as exc:
        raise CurriculumError(f"cannot export profile: {exc}") from exc
    if stage.get("frozen_strategy_sha256") != expected_strategy_sha:
        raise CurriculumError(
            "cannot export profile before the distilled strategy is frozen"
        )

    evidence = state.get("evidence_packet")
    if not isinstance(evidence, dict):
        raise CurriculumError(
            "cannot export profile: artifact evidence identity is missing"
        )
    if (
        evidence.get("schema_version")
        != config.get("evidence_packet_schema_version")
        or evidence.get("sha256") != config.get("evidence_packet_sha256")
    ):
        raise CurriculumError(
            "cannot export profile: artifact evidence identity does not match config"
        )

    try:
        return sp.build_profile(
            strategy_id=(
                f"{config['dataset_id']}/{config['model_id']}/"
                f"{config['evidence_packet_sha256'][:12]}"
            ),
            model_id=config["model_id"],
            provider=config["provider"],
            transport=config["transport"],
            auth=config["auth"],
            strategy_effort=config["strategy_effort"],
            play_effort=config["play_effort"],
            lang=config["lang"],
            dataset_id=config["dataset_id"],
            dataset_sha256=config["dataset_sha256"],
            evidence_packet_schema_version=config[
                "evidence_packet_schema_version"
            ],
            evidence_packet_sha256=config["evidence_packet_sha256"],
            distillation_prompt_sha256=config["distillation_prompt_sha256"],
            prompt_version=config["prompt_version"],
            curriculum_prompt_version=config["curriculum_prompt_version"],
            created_at=stage["completed_at"],
            final_strategy=stage["strategy"],
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise CurriculumError(f"cannot export profile: {exc}") from exc


def _write_profile_idempotently(path: Path, profile: dict[str, Any]) -> None:
    if path.exists():
        try:
            existing = sp.load_profile(path)
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            raise CurriculumError(
                f"refusing to overwrite invalid existing profile {path}: {exc}"
            ) from exc
        if existing != profile:
            raise CurriculumError(
                f"refusing to overwrite different existing profile {path}"
            )
        return
    sp.write_profile(path, profile)


def export_profile(artifact_path: Path) -> Path:
    """Export a frozen strategy profile offline without changing the artifact."""
    artifact_path = artifact_path.resolve()
    try:
        state = json.loads(artifact_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CurriculumError(f"cannot read artifact {artifact_path}: {exc}") from exc
    if not isinstance(state, dict):
        raise CurriculumError("cannot export profile: artifact must be an object")
    profile = _build_distilled_profile_from_state(state)
    profile_path = artifact_path.with_suffix(".profile.json")
    _write_profile_idempotently(profile_path, profile)
    return profile_path


def _validate_completed_runs(
    state: dict[str, Any], records: list[dict[str, Any]], dataset_dir: Path, vocab: set[str]
) -> None:
    by_number = {record["number"]: record for record in records}
    for condition in CONDITIONS:
        for entry in state["holdout"][condition]:
            puzzle = _load_puzzle(dataset_dir, by_number[entry["number"]])
            for run in entry["runs"]:
                words = tuple(run.get("tried_words", []))
                if run.get("counted_tries") != len(words):
                    raise CurriculumError(
                        f"holdout/{condition} puzzle {entry['number']} has a "
                        "count/word mismatch"
                    )
                metrics = derive_run_metrics(puzzle, vocab, words)
                if run.get("metrics") != metrics:
                    raise CurriculumError(
                        f"holdout/{condition} puzzle {entry['number']} replay metrics changed"
                    )
                expected_tries = len(words) if metrics["solved"] else None
                if run.get("tries") != expected_tries:
                    raise CurriculumError(
                        f"holdout/{condition} puzzle {entry['number']} score does not replay"
                    )


def _evidence_metadata(packet: EvidencePacket, path: Path) -> dict[str, Any]:
    content = packet.document["content"]
    return {
        "schema_version": packet.document["schema_version"],
        "path": str(path),
        "sha256": packet.sha256,
        "content_sha256": packet.content_sha256,
        "byte_count": len(packet.canonical_bytes),
        "content_byte_count": packet.content_byte_count,
        "curriculum_puzzle_count": content["curriculum_puzzle_count"],
        "target_count": content["target_count"],
        "ordered_curriculum_puzzle_sha256s": content[
            "ordered_curriculum_puzzle_sha256s"
        ],
        "sampling": content["sampling"],
    }


def _profile_only_evidence_metadata(
    profile: dict[str, Any], manifest: dict[str, Any]
) -> dict[str, Any]:
    """Pin training evidence identity without opening it from the test view."""
    training = manifest["strategy_evidence"]
    return {
        "schema_version": profile["evidence_packet_schema_version"],
        "sha256": profile["evidence_packet_sha256"],
        "source": "frozen_profile_only",
        "training_dataset_id": training["dataset_id"],
        "training_dataset_sha256": training["dataset_content_sha256"],
        "training_manifest_file_sha256": training[
            "training_manifest_file_sha256"
        ],
        "training_selection_sha256": training["training_selection_sha256"],
    }


def _ensure_evidence_sidecar(
    path: Path, packet: EvidencePacket, *, force: bool, new_artifact: bool
) -> None:
    if new_artifact:
        write_evidence_packet(path, packet)
        return
    if path.is_file() and read_data_bytes(path) == packet.canonical_bytes:
        return
    if force:
        write_evidence_packet(path, packet)
        return
    problem = "missing" if not path.is_file() else "does not match its pinned bytes"
    raise CurriculumError(
        f"resume evidence packet {path} is {problem}; use --force only to "
        "recreate this deterministic sidecar without repeating paid work"
    )


def _verify_run_config(state: dict[str, Any], expected: dict[str, Any]) -> None:
    prior = state.get("config", {})
    prior_prompt = prior.get("curriculum_prompt_version")
    if prior_prompt != CURRICULUM_PROMPT_VERSION:
        raise CurriculumError(
            "resume artifact uses curriculum prompt version "
            f"{prior_prompt!r}; older artifacts remain readable but cannot resume "
            "as model-isolated prompt-v6. Start a new artifact."
        )
    if prior != expected:
        differing = sorted(
            key
            for key in set(prior) | set(expected)
            if prior.get(key) != expected.get(key)
        )
        raise CurriculumError(
            "resume artifact configuration does not match this invocation "
            f"({', '.join(differing)}); refusing to mix experiment identities"
        )


def _auth_preflight(
    *, config: dict[str, Any], auth: str, dry_run: bool
) -> tuple[str | None, dict[str, Any]]:
    if dry_run:
        return None, {"mode": auth, "status": "skipped_dry_run"}
    api_key: str | None = None
    if auth == "api":
        env_name = PROVIDER_ENV[config["provider"]]
        api_key = os.environ.get(env_name)
        if not api_key:
            raise CurriculumError(f"{env_name} is required for API auth")
        return api_key, {"mode": auth, "status": "verified_key_present"}
    try:
        provider_session = (
            validate_anthropic_subscription_auth()
            if config["provider"] == "anthropic"
            else validate_openai_subscription_auth()
        )
    except RuntimeError as exc:
        raise CurriculumError(str(exc)) from exc
    return None, {
        "mode": auth,
        "status": "verified",
        "provider_session": provider_session,
    }


def run_curriculum(
    manifest_path: Path,
    *,
    model: str,
    strategy_effort: str,
    play_effort: str,
    auth: str,
    cap: int = DEFAULT_CAP,
    resume: Path | None = None,
    force: bool = False,
    dry_run: bool = False,
    verbose: bool = False,
    provider_factory: Callable[..., Any] = provider_reply,
    vocab_loader: Callable[[str], set[str]] = load_vocab,
    output_root: Path = OUTPUT_ROOT,
    v7_strategy: str | None = None,
    frozen_profile: Path | None = None,
) -> Path | None:
    if strategy_effort != REQUIRED_STRATEGY_EFFORT:
        raise CurriculumError(
            f"--strategy-effort must be {REQUIRED_STRATEGY_EFFORT!r}; "
            "strategy synthesis is intentionally a max-effort stage"
        )
    if not isinstance(cap, int) or isinstance(cap, bool) or cap <= 0:
        raise CurriculumError("--cap must be a positive integer")

    manifest, dataset_sha, manifest_sha = load_manifest(manifest_path)
    if (
        "calibration" in manifest or "strategy_evidence" in manifest
    ) and play_effort != CALIBRATED_PLAY_EFFORT:
        raise CurriculumError(
            "calibrated datasets require --play-effort "
            f"{CALIBRATED_PLAY_EFFORT!r}; calibration and final evaluation "
            "must use the same reasoning effort"
        )
    dataset_dir = manifest_path.parent
    config = select_model(model)
    try:
        _validate_provider_effort(config["provider"], auth, strategy_effort)
        _validate_provider_effort(config["provider"], auth, play_effort)
    except ValueError as exc:
        raise CurriculumError(str(exc)) from exc
    transport = _transport_name(config, auth)

    curriculum_records = [
        record for record in manifest["puzzles"] if record["split"] == "curriculum"
    ]
    holdout_records = [
        record for record in manifest["puzzles"] if record["split"] == "holdout"
    ]
    manifest_kind = manifest.get("manifest_kind")
    is_training_view = manifest_kind == "calibration_training_split"
    is_test_view = manifest_kind == "calibration_test_split"
    frozen_evaluation = is_test_view or (
        "strategy_evidence" in manifest and not is_training_view
    )
    packet: EvidencePacket | None = None
    prompt: str | None = None
    prompt_sha: str | None = None
    if not is_test_view:
        packet = build_evidence_packet(
            manifest,
            dataset_dir,
            model_id=config["model_id"],
        )
        prompt = distillation_prompt(packet, play_effort=play_effort)
        prompt_sha = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
    profile: dict[str, Any] | None = None
    profile_path: Path | None = None
    profile_sha: str | None = None
    if frozen_profile is not None:
        profile_path = resolve_path(frozen_profile).resolve()
        profile = sp.load_profile(profile_path)
        try:
            sp.assert_profile_compatible(
                profile,
                model_id=config["model_id"],
                transport=transport,
                auth=auth,
                strategy_effort=strategy_effort,
                play_effort=play_effort,
            )
        except ValueError as exc:
            raise CurriculumError(str(exc)) from exc
        if is_test_view:
            training_identity = manifest.get("strategy_evidence", {})
            expected_profile_identity = {
                "provider": config["provider"],
                "lang": manifest["lang"],
                "dataset_id": training_identity.get("dataset_id"),
                "dataset_sha256": training_identity.get(
                    "dataset_content_sha256"
                ),
                "evidence_packet_schema_version": training_identity.get(
                    "schema_version"
                ),
                "prompt_version": PROMPT_VERSION,
                "curriculum_prompt_version": CURRICULUM_PROMPT_VERSION,
            }
        else:
            assert packet is not None and prompt_sha is not None
            packet_identity = packet.document["content"]
            expected_profile_identity = {
                "provider": config["provider"],
                "lang": manifest["lang"],
                "dataset_id": packet_identity["dataset_id"],
                "dataset_sha256": packet_identity["dataset_content_sha256"],
                "evidence_packet_schema_version": packet.document[
                    "schema_version"
                ],
                "evidence_packet_sha256": packet.sha256,
                "distillation_prompt_sha256": prompt_sha,
                "prompt_version": PROMPT_VERSION,
                "curriculum_prompt_version": CURRICULUM_PROMPT_VERSION,
            }
        differing = [
            field
            for field, expected_value in expected_profile_identity.items()
            if profile.get(field) != expected_value
        ]
        if differing:
            raise CurriculumError(
                "frozen profile does not match the pinned curriculum evidence "
                f"({', '.join(differing)})"
            )
        profile_sha = _sha256_file(profile_path)
    elif frozen_evaluation:
        raise CurriculumError(
            "calibrated test datasets require --profile with a frozen strategy; "
            "re-distillation is forbidden"
        )
    frozen_v7 = v7_strategy if v7_strategy is not None else load_v7_strategy()
    v7_sha = hashlib.sha256(frozen_v7.encode("utf-8")).hexdigest()

    evidence_schema_version = (
        profile["evidence_packet_schema_version"]
        if is_test_view and profile is not None
        else packet.document["schema_version"] if packet is not None else None
    )
    evidence_sha256 = (
        profile["evidence_packet_sha256"]
        if is_test_view and profile is not None
        else packet.sha256 if packet is not None else None
    )
    distillation_prompt_sha256 = (
        profile["distillation_prompt_sha256"]
        if is_test_view and profile is not None
        else prompt_sha
    )
    run_config = {
        "artifact_schema_version": 6,
        "dataset_id": manifest["dataset_id"],
        "dataset_sha256": dataset_sha,
        "lang": manifest["lang"],
        "model_id": config["model_id"],
        "provider": config["provider"],
        "transport": transport,
        "auth": auth,
        "strategy_effort": strategy_effort,
        "play_effort": play_effort,
        "cap": cap,
        "prompt_version": PROMPT_VERSION,
        "curriculum_prompt_version": CURRICULUM_PROMPT_VERSION,
        "distillation_prompt_version": DISTILLATION_PROMPT_VERSION,
        "distillation_prompt_sha256": distillation_prompt_sha256,
        "profile_schema_version": sp.PROFILE_SCHEMA_VERSION,
        "evidence_packet_schema_version": evidence_schema_version,
        "evidence_packet_sha256": evidence_sha256,
        "holdout_runs_per_condition": HOLDOUT_RUNS_PER_CONDITION,
        "conditions": list(CONDITIONS),
        "v7_strategy_sha256": v7_sha,
    }
    if profile is not None:
        run_config.update(
            {
                "strategy_source": "frozen_profile",
                "frozen_profile_sha256": profile_sha,
                "frozen_profile_strategy_id": profile["strategy_id"],
            }
        )

    new_artifact = resume is None
    evidence_path: Path | None = None
    evidence_metadata: dict[str, Any]
    if resume is not None:
        artifact_path = resume
        state = json.loads(artifact_path.read_text(encoding="utf-8"))
        _verify_run_config(state, run_config)
        if state.get("manifest_sha256") != manifest_sha:
            raise CurriculumError(
                "resume manifest file hash differs from the artifact's pinned hash"
            )
        if is_test_view:
            assert profile is not None
            evidence_metadata = _profile_only_evidence_metadata(profile, manifest)
        else:
            assert packet is not None
            evidence_path = Path(state.get("evidence_packet", {}).get("path", ""))
            expected_evidence_path = artifact_path.with_name(
                f"{artifact_path.stem}.evidence.json.gz"
            )
            if evidence_path != expected_evidence_path:
                raise CurriculumError(
                    "resume artifact points at an unexpected evidence path"
                )
            evidence_metadata = _evidence_metadata(packet, evidence_path)
        if state.get("evidence_packet") != evidence_metadata:
            raise CurriculumError(
                "resume evidence metadata does not match the deterministic packet"
            )
    else:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        artifact_path = (
            output_root
            / manifest["dataset_id"]
            / f"{config['model_id']}.{stamp}.json"
        )
        if is_test_view:
            assert profile is not None
            evidence_metadata = _profile_only_evidence_metadata(profile, manifest)
        else:
            assert packet is not None
            evidence_path = artifact_path.with_name(
                f"{artifact_path.stem}.evidence.json.gz"
            )
            evidence_metadata = _evidence_metadata(packet, evidence_path)
        distillation = (
            {
                "status": "complete",
                "source": "frozen_profile",
                "attempts": [],
                "strategy": list(profile["final_strategy"]),
                "completed_at": profile["created_at"],
                "frozen_strategy_sha256": _strategy_sha256(
                    profile["final_strategy"]
                ),
            }
            if profile is not None
            else {"status": "pending", "attempts": []}
        )
        state = {
            "config": run_config,
            "manifest_sha256": manifest_sha,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "evidence_packet": evidence_metadata,
            "auth_verifications": [],
            "distillation": distillation,
            "holdout": {condition: [] for condition in CONDITIONS},
        }
        if profile is not None:
            state["profile"] = {
                "path": str(profile_path),
                "sha256": profile_sha,
                "strategy_id": profile["strategy_id"],
                "source": "frozen",
            }

    if profile is not None:
        expected_profile_record = {
            "path": str(profile_path),
            "sha256": profile_sha,
            "strategy_id": profile["strategy_id"],
            "source": "frozen",
        }
        if state.get("profile") != expected_profile_record:
            raise CurriculumError(
                "artifact frozen-profile reference does not match this invocation"
            )
        stage = state.get("distillation", {})
        if (
            stage.get("strategy") != profile["final_strategy"]
            or stage.get("completed_at") != profile["created_at"]
        ):
            raise CurriculumError(
                "artifact frozen strategy does not match the pinned profile"
            )

    _validate_holdout_identity(state, holdout_records)
    _validate_distillation_state(state)

    total_plays = (
        len(holdout_records) * len(CONDITIONS) * HOLDOUT_RUNS_PER_CONDITION
    )
    completed_plays = _completed_play_count(state)
    if dry_run:
        if (
            not new_artifact
            and not is_test_view
            and (
                evidence_path is None
                or packet is None
                or not evidence_path.is_file()
                or read_data_bytes(evidence_path) != packet.canonical_bytes
            )
        ):
            raise CurriculumError(
                "resume dry-run found a missing or mismatched evidence sidecar"
            )
        print(
            json.dumps(
                {
                    "dry_run": True,
                    "config": run_config,
                    "evidence_packet": evidence_metadata,
                    "curriculum_puzzles": len(curriculum_records),
                    "curriculum_targets": (
                        packet.document["content"]["target_count"]
                        if packet is not None
                        else 0
                    ),
                    "curriculum_play_calls": 0,
                    "planned_distillation_stage": (
                        0
                        if state.get("distillation", {}).get("status") == "complete"
                        else 1
                    ),
                    "maximum_distillation_attempts": STRUCTURED_MAX_ATTEMPTS,
                    "holdout_puzzles": len(holdout_records),
                    "planned_holdout_runs": total_plays,
                    "pending_holdout_runs": total_plays - completed_plays,
                    "call_plan": {
                        "distillation": {
                            "pending": state.get("distillation", {}).get("status")
                            != "complete",
                            "effort": strategy_effort,
                            "maximum_attempts": STRUCTURED_MAX_ATTEMPTS,
                            "fresh_context_per_attempt": True,
                            "source": run_config.get(
                                "strategy_source", "distillation"
                            ),
                        },
                        "holdout": [
                            {
                                "condition": condition,
                                "puzzle_numbers": [
                                    record["number"] for record in holdout_records
                                ],
                                "runs_per_puzzle": HOLDOUT_RUNS_PER_CONDITION,
                                "play_effort": play_effort,
                                "fresh_context_per_run": True,
                            }
                            for condition in CONDITIONS
                        ],
                    },
                    "retrospectives": 0,
                    "synthesis_calls": 0,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return None

    if not is_test_view:
        assert evidence_path is not None and packet is not None
        _ensure_evidence_sidecar(
            evidence_path, packet, force=force, new_artifact=new_artifact
        )

    api_key, verification = _auth_preflight(
        config=config, auth=auth, dry_run=False
    )
    verification["verified_at"] = datetime.now(timezone.utc).isoformat()
    state.setdefault("auth_verifications", []).append(verification)
    # The destination and exact packet are visible before the first paid request.
    save_artifact(artifact_path, state)

    reporter = CurriculumReporter(
        verbose=verbose,
        artifact_path=artifact_path,
        model_id=config["model_id"],
        cap=cap,
        completed_plays=completed_plays,
        total_plays=total_plays,
    )
    if profile is None:
        assert packet is not None and prompt is not None
        _analysis, strategy_items = _distil_strategy(
            state=state,
            artifact_path=artifact_path,
            packet=packet,
            prompt=prompt,
            config=config,
            api_key=api_key,
            auth=auth,
            provider_factory=provider_factory,
            reporter=reporter,
        )
    else:
        strategy_items = list(profile["final_strategy"])
    learned_strategy = sp.strategy_text(strategy_items)
    frozen_strategy_sha = _strategy_sha256(strategy_items)
    prior_strategy_sha = state["distillation"].get("frozen_strategy_sha256")
    if prior_strategy_sha is not None and prior_strategy_sha != frozen_strategy_sha:
        raise CurriculumError("checkpointed frozen strategy hash does not replay")
    state["distillation"]["frozen_strategy_sha256"] = frozen_strategy_sha
    if profile is None:
        profile = _build_distilled_profile_from_state(state)
        profile_path = artifact_path.with_suffix(".profile.json")
        _write_profile_idempotently(profile_path, profile)
        expected_profile_record = {
            "path": str(profile_path),
            "sha256": _sha256_file(profile_path),
            "strategy_id": profile["strategy_id"],
            "source": "distilled",
        }
        prior_profile_record = state.get("profile")
        if (
            prior_profile_record is not None
            and prior_profile_record != expected_profile_record
        ):
            raise CurriculumError(
                "checkpointed distilled-profile reference does not replay"
            )
        state["profile"] = expected_profile_record
    save_artifact(artifact_path, state)

    vocab = vocab_loader(manifest["lang"])
    _validate_completed_runs(state, holdout_records, dataset_dir, vocab)
    guidance = {
        "neutral": None,
        "learned": learned_strategy,
        "v7": frozen_v7,
    }
    for condition_index, condition in enumerate(CONDITIONS):
        entries = state["holdout"][condition]
        for puzzle_index, record in enumerate(holdout_records, start=1):
            entry = next(
                (item for item in entries if item["number"] == record["number"]),
                None,
            )
            if entry is None:
                entry = {
                    "number": record["number"],
                    "path": record["path"],
                    "sha256": record["sha256"],
                    "runs": [],
                }
                entries.append(entry)
                save_artifact(artifact_path, state)
            puzzle = _load_puzzle(dataset_dir, record)
            while len(entry["runs"]) < HOLDOUT_RUNS_PER_CONDITION:
                run_number = len(entry["runs"]) + 1
                play_number = (
                    condition_index
                    * len(holdout_records)
                    * HOLDOUT_RUNS_PER_CONDITION
                    + (puzzle_index - 1) * HOLDOUT_RUNS_PER_CONDITION
                    + run_number
                )
                reporter.play_started(
                    play_number=play_number,
                    condition=condition,
                    puzzle_index=puzzle_index,
                    puzzle_count=len(holdout_records),
                    run_number=run_number,
                    puzzle_number=record["number"],
                )
                completed = _play_once(
                    puzzle=puzzle,
                    vocab=vocab,
                    strategy=guidance[condition],
                    config=config,
                    api_key=api_key,
                    play_effort=play_effort,
                    auth=auth,
                    cap=cap,
                    provider_factory=provider_factory,
                    on_try=lambda progress, pn=play_number, c=condition,
                    pi=puzzle_index, rn=run_number: reporter.counted_try(
                        progress,
                        play_number=pn,
                        condition=c,
                        puzzle_index=pi,
                        puzzle_count=len(holdout_records),
                        run_number=rn,
                    ),
                )
                entry["runs"].append(completed)
                save_artifact(artifact_path, state)
                reporter.play_completed(
                    completed,
                    play_number=play_number,
                    condition=condition,
                    puzzle_index=puzzle_index,
                    puzzle_count=len(holdout_records),
                    run_number=run_number,
                )

    assert profile_path is not None
    state["evaluation"] = evaluate_artifact(state)
    state["completed_at"] = datetime.now(timezone.utc).isoformat()
    save_artifact(artifact_path, state)
    reporter.complete(profile_path)
    return artifact_path


# --- DNF-aware evaluation and legacy read compatibility -------------------------


def _median_tries(runs: list[dict[str, Any]]) -> int | None:
    """Median with DNF sorted last; a DNF middle value remains ``None``."""
    ordered = sorted(
        (run.get("tries") for run in runs),
        key=lambda tries: (tries is None, tries if tries is not None else 0),
    )
    return ordered[len(ordered) // 2] if ordered else None


def _dnf_aware_median(values: list[int | None]) -> int | None:
    ordered = sorted(
        values,
        key=lambda tries: (tries is None, tries if tries is not None else 0),
    )
    return ordered[len(ordered) // 2] if ordered else None


def _merge_token_usage(total: dict[str, Any], usage: dict[str, Any] | None) -> None:
    if not usage:
        return
    for key, value in usage.items():
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            total[key] = total.get(key, 0) + value
        elif isinstance(value, dict):
            nested = total.setdefault(key, {})
            if isinstance(nested, dict):
                _merge_token_usage(nested, value)


def _empty_cost_bucket() -> dict[str, Any]:
    return {"calls": 0, "wall_duration": 0.0, "token_usage": {}}


def _add_run_cost(bucket: dict[str, Any], run: dict[str, Any]) -> None:
    bucket["calls"] += run.get("turns", 0)
    bucket["wall_duration"] += run.get("wall_duration", run.get("duration", 0.0))
    for usage in run.get("turn_token_usage", []):
        _merge_token_usage(bucket["token_usage"], usage)


def _cost_split_v5(state: dict[str, Any]) -> dict[str, Any]:
    buckets = {"distillation": _empty_cost_bucket()}
    buckets.update(
        {f"holdout_{condition}": _empty_cost_bucket() for condition in CONDITIONS}
    )
    for attempt in state.get("distillation", {}).get("attempts", []):
        buckets["distillation"]["calls"] += 1
        buckets["distillation"]["wall_duration"] += attempt.get(
            "wall_duration", 0.0
        )
        _merge_token_usage(
            buckets["distillation"]["token_usage"], attempt.get("token_usage")
        )
    for condition in CONDITIONS:
        bucket = buckets[f"holdout_{condition}"]
        for entry in state.get("holdout", {}).get(condition, []):
            for run in entry.get("runs", []):
                _add_run_cost(bucket, run)
    return buckets


def _condition_summary(entries: list[dict[str, Any]]) -> dict[str, Any]:
    per_puzzle = {
        str(entry["number"]): _median_tries(entry.get("runs", []))
        for entry in entries
    }
    medians = list(per_puzzle.values())
    solved_medians = [value for value in medians if value is not None]
    runs = [run for entry in entries for run in entry.get("runs", [])]
    counted = sum(run.get("counted_tries", 0) for run in runs)
    non_improving = sum(
        run.get("metrics", {}).get("non_improving_guesses", 0) for run in runs
    )
    return {
        "per_puzzle_median": per_puzzle,
        "median_of_medians": _dnf_aware_median(medians),
        "solved_only_median": (
            statistics.median(solved_medians) if solved_medians else None
        ),
        "dnf_puzzles": sum(value is None for value in medians),
        "dnf_runs": sum(run.get("tries") is None for run in runs),
        "solved_runs": sum(run.get("tries") is not None for run in runs),
        "solve_rate": (
            sum(run.get("tries") is not None for run in runs) / len(runs)
            if runs
            else None
        ),
        "maximum_no_improvement_streak": max(
            (
                run.get("metrics", {}).get("max_no_improvement_streak", 0)
                for run in runs
            ),
            default=0,
        ),
        "non_improving_counted_guesses": non_improving,
        "non_improving_rate": non_improving / counted if counted else None,
        "guesses_after_rank100": sum(
            run.get("metrics", {}).get("guesses_after_rank100", 0) for run in runs
        ),
    }


def _paired_comparison(
    neutral: dict[str, Any], other: dict[str, Any]
) -> dict[str, Any]:
    puzzle_results: dict[str, Any] = {}
    numeric_deltas: list[int] = []
    for number, neutral_value in neutral.get("per_puzzle_median", {}).items():
        other_value = other.get("per_puzzle_median", {}).get(number)
        if neutral_value is None and other_value is None:
            outcome = "tied_dnf"
            delta = None
        elif neutral_value is None:
            outcome = "improved_from_dnf"
            delta = None
        elif other_value is None:
            outcome = "worsened_to_dnf"
            delta = None
        else:
            delta = other_value - neutral_value
            numeric_deltas.append(delta)
            outcome = "improved" if delta < 0 else "worsened" if delta > 0 else "tied"
        puzzle_results[number] = {
            "neutral": neutral_value,
            "condition": other_value,
            "difference": delta,
            "outcome": outcome,
        }
    ordered_pairs = sorted(
        puzzle_results.values(),
        key=lambda result: (
            0
            if result["outcome"] == "improved_from_dnf"
            else 2
            if result["outcome"] == "worsened_to_dnf"
            else 1,
            result["difference"] or 0,
        ),
    )
    paired_middle = ordered_pairs[len(ordered_pairs) // 2] if ordered_pairs else None
    return {
        "per_puzzle": puzzle_results,
        "paired_dnf_aware_median": (
            {
                "difference": paired_middle["difference"],
                "outcome": paired_middle["outcome"],
            }
            if paired_middle is not None
            else None
        ),
        "numeric_difference_median": (
            statistics.median(numeric_deltas) if numeric_deltas else None
        ),
        "improved_puzzles": sum(
            result["outcome"] in {"improved", "improved_from_dnf"}
            for result in puzzle_results.values()
        ),
        "worsened_puzzles": sum(
            result["outcome"] in {"worsened", "worsened_to_dnf"}
            for result in puzzle_results.values()
        ),
    }


def _compare_dnf_values(other: int | None, neutral: int | None) -> str:
    if other is None and neutral is None:
        return "tied_dnf"
    if neutral is None:
        return "improved_from_dnf"
    if other is None:
        return "worsened_to_dnf"
    return "improved" if other < neutral else "worsened" if other > neutral else "tied"


def _policy_compliance_summary(runs: list[dict[str, Any]]) -> dict[str, Any]:
    accepted = sum(
        run.get("policy_compliance", {}).get("accepted_decisions", 0)
        for run in runs
    )
    rejected = sum(
        run.get("policy_compliance", {}).get("rejected_decisions", 0)
        for run in runs
    )
    total = accepted + rejected
    return {
        "accepted_decisions": accepted,
        "rejected_decisions": rejected,
        "accepted_rate": accepted / total if total else None,
        "policy_failure_runs": sum(
            run.get("termination_reason") == "policy_failure" for run in runs
        ),
    }


def _legacy_cost_split(state: dict[str, Any]) -> dict[str, Any]:
    buckets = {
        name: _empty_cost_bucket()
        for name in ("play", "retrospective", "synthesis")
    }
    for puzzle in state.get("puzzles", []):
        for run in puzzle.get("runs", []):
            _add_run_cost(buckets["play"], run)
        telemetry = (puzzle.get("retrospective") or {}).get("telemetry") or {}
        buckets["retrospective"]["wall_duration"] += telemetry.get(
            "wall_duration", 0.0
        )
        for attempt in telemetry.get("attempts", []):
            buckets["retrospective"]["calls"] += 1
            _merge_token_usage(
                buckets["retrospective"]["token_usage"],
                attempt.get("token_usage"),
            )
    for entries in state.get("holdout", {}).values():
        for entry in entries:
            for run in entry.get("runs", []):
                _add_run_cost(buckets["play"], run)
    telemetry = (state.get("synthesis") or {}).get("telemetry") or {}
    buckets["synthesis"]["wall_duration"] += telemetry.get("wall_duration", 0.0)
    for attempt in telemetry.get("attempts", []):
        buckets["synthesis"]["calls"] += 1
        _merge_token_usage(
            buckets["synthesis"]["token_usage"], attempt.get("token_usage")
        )
    return buckets


def _evaluate_legacy_artifact(state: dict[str, Any]) -> dict[str, Any]:
    trend = [
        {
            "number": puzzle["number"],
            "median_tries": _median_tries(puzzle.get("runs", [])),
            "dnf": sum(run.get("tries") is None for run in puzzle.get("runs", [])),
            "policy_compliance": _policy_compliance_summary(
                puzzle.get("runs", [])
            ),
        }
        for puzzle in state.get("puzzles", [])
    ]
    holdout = {
        condition: {
            **_condition_summary(entries),
            "policy_compliance": _policy_compliance_summary(
                [run for entry in entries for run in entry.get("runs", [])]
            ),
        }
        for condition, entries in state.get("holdout", {}).items()
    }
    return {
        "legacy": True,
        "config": state.get("config"),
        "curriculum_trend": trend,
        "holdout": holdout,
        "final_policy": (state.get("synthesis") or {}).get("final_policy"),
        "legacy_final_strategy": (state.get("synthesis") or {}).get(
            "final_strategy"
        ),
        "cost_split": _legacy_cost_split(state),
    }


def evaluate_artifact(state: dict[str, Any]) -> dict[str, Any]:
    """Evaluate prompt-v6 artifacts and retain read-only legacy support."""
    if state.get("config", {}).get("curriculum_prompt_version") != CURRICULUM_PROMPT_VERSION:
        return _evaluate_legacy_artifact(state)
    holdout = {
        condition: _condition_summary(
            state.get("holdout", {}).get(condition, [])
        )
        for condition in CONDITIONS
    }
    learned_paired = _paired_comparison(holdout["neutral"], holdout["learned"])
    v7_paired = _paired_comparison(holdout["neutral"], holdout["v7"])
    learned_unpaired_aggregate = _compare_dnf_values(
        holdout["learned"]["median_of_medians"],
        holdout["neutral"]["median_of_medians"],
    )
    learned_paired_outcome = (
        learned_paired.get("paired_dnf_aware_median") or {}
    ).get("outcome")
    no_extra_dnf = (
        holdout["learned"]["dnf_puzzles"] <= holdout["neutral"]["dnf_puzzles"]
    )
    return {
        "config": state["config"],
        "holdout": holdout,
        "paired_differences": {
            "learned_minus_neutral": learned_paired,
            "v7_minus_neutral": v7_paired,
        },
        "decision_rule": {
            "learned_paired_dnf_aware_comparison": learned_paired_outcome,
            "learned_unpaired_median_of_medians_comparison": learned_unpaired_aggregate,
            "learned_has_no_additional_dnf_puzzles": no_extra_dnf,
            "distillation_success": learned_paired_outcome
            in {"improved", "improved_from_dnf"}
            and no_extra_dnf,
        },
        "final_strategy": (state.get("distillation") or {}).get("strategy"),
        "cost_split": _cost_split_v5(state),
    }


# --- CLI ------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    run_parser = sub.add_parser(
        "run", help="distil or reuse one strategy and run frozen holdout arms"
    )
    run_parser.add_argument("manifest", type=Path)
    run_parser.add_argument("--model", required=True)
    run_parser.add_argument(
        "--strategy-effort",
        required=True,
        choices=(REQUIRED_STRATEGY_EFFORT,),
        help="required max-effort strategy synthesis stage",
    )
    run_parser.add_argument(
        "--play-effort",
        required=True,
        help="reasoning effort shared by neutral, learned, and v7 holdout arms",
    )
    run_parser.add_argument("--auth", choices=("api", "subscription"), default="api")
    run_parser.add_argument("--cap", type=int, default=DEFAULT_CAP)
    run_parser.add_argument("--resume", type=Path)
    run_parser.add_argument(
        "--profile",
        type=Path,
        help="reuse a compatible frozen profile and make zero distillation calls",
    )
    run_parser.add_argument(
        "--force",
        action="store_true",
        help="recreate a missing/corrupt deterministic packet sidecar; never replay paid successes",
    )
    run_parser.add_argument("--dry-run", action="store_true")
    run_parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="print every counted holdout try and the frozen strategy",
    )

    eval_parser = sub.add_parser("evaluate", help="report on an artifact or profile")
    eval_parser.add_argument("artifact", type=Path)

    export_parser = sub.add_parser(
        "export-profile",
        help="export a frozen profile from a distilled artifact without provider calls",
    )
    export_parser.add_argument("artifact", type=Path)

    args = parser.parse_args(argv)
    if args.command == "run":
        run_curriculum(
            resolve_path(args.manifest),
            model=args.model,
            strategy_effort=args.strategy_effort,
            play_effort=args.play_effort,
            auth=args.auth,
            cap=args.cap,
            resume=resolve_path(args.resume) if args.resume else None,
            frozen_profile=resolve_path(args.profile) if args.profile else None,
            force=args.force,
            dry_run=args.dry_run,
            verbose=args.verbose,
        )
        return 0

    if args.command == "export-profile":
        profile_path = export_profile(resolve_path(args.artifact))
        print(f"frozen profile: {profile_path}")
        return 0

    payload = json.loads(resolve_path(args.artifact).read_text(encoding="utf-8"))
    if "schema_version" in payload and "puzzles" not in payload and "holdout" not in payload:
        sp.validate_profile(payload)
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    print(json.dumps(evaluate_artifact(payload), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
