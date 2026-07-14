"""Retrospective strategy-curriculum orchestrator (#84).

Per model: play each curriculum puzzle 3 independent times (same incoming
strategy, genuinely fresh provider contexts, no cross-run leakage), then one
fresh retrospective call that revises a compact reusable strategy (replace,
never append). After 15 puzzles, one synthesis call produces the final report
and frozen strategy; holdout evaluation then compares neutral / learned / v7
conditions without further learning.

Everything is checkpointed atomically and resumable; completed paid calls are
never repeated unless --force. Implementing/running these commands offline is
free — a paid curriculum run is a separate, deliberate curator action.
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
from typing import Any, Callable

SCRIPT_DIR = Path(__file__).resolve().parent
BENCHMARK_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

from llm_play import (  # noqa: E402
    DEFAULT_CAP,
    PROMPT_VERSION,
    PROVIDER_ENV,
    PuzzleReferee,
    RunResult,
    TryProgress,
    load_vocab,
    play_puzzle,
    provider_reply,
    select_model,
    validate_anthropic_subscription_auth,
    validate_openai_subscription_auth,
    _last_token_usage,
    _transport_name,
    _validate_provider_effort,
)
from curriculum_dataset import dataset_content_sha256  # noqa: E402
from curriculum_io import load_json, read_data_bytes, sha256_bytes  # noqa: E402
from slug import slug  # noqa: E402
import strategy_profiles as sp  # noqa: E402

CURRICULUM_PROMPT_VERSION = "2"
RUNS_PER_PUZZLE = 3
HOLDOUT_RUNS_PER_CONDITION = 3
CONDITIONS = ("neutral", "learned", "v7")
STRUCTURED_MAX_ATTEMPTS = 4
# Models estimate character counts imperfectly. A rejected strategy is repaired
# toward a margin below the actual validator cap instead of aiming at its edge.
STRUCTURED_STRATEGY_REPAIR_TARGET_CHARS = sp.STRATEGY_MAX_CHARS * 9 // 10

OUTPUT_ROOT = BENCHMARK_DIR / "output" / "curriculum"
# The exact hand-written v7 strategy, recovered from a recorded v7 transcript
# (never reconstructed or paraphrased). See datasets/v7-strategy.txt provenance
# header; load_v7_strategy() strips that header.
V7_STRATEGY_PATH = BENCHMARK_DIR / "datasets" / "v7-strategy.txt"

_WORD_RE = re.compile(r"[^\W\d_]+(?:-[^\W\d_]+)*", re.UNICODE)


class CurriculumReporter:
    """Flush progress without changing prompts, scoring, or checkpoint state."""

    def __init__(
        self,
        *,
        verbose: bool,
        artifact_path: Path,
        model_id: str,
        cap: int,
        total_plays: int,
        total_puzzles: int,
        total_retrospectives: int,
        completed_plays: int,
    ):
        self.verbose = verbose
        self.artifact_path = artifact_path
        self.total_plays = total_plays
        self.total_puzzles = total_puzzles
        self.total_retrospectives = total_retrospectives
        print(f"curriculum artifact: {artifact_path}", flush=True)
        print(
            f"curriculum progress: {completed_plays}/{total_plays} plays "
            f"checkpointed; model={model_id}; cap={cap}",
            flush=True,
        )

    def play_started(
        self,
        *,
        play_number: int,
        phase: str,
        puzzle_number: int,
        run_number: int,
    ) -> None:
        run_total = self._run_total(phase)
        print(
            f"[play {play_number}/{self.total_plays}] START {phase} "
            f"puzzle {puzzle_number}/{self.total_puzzles} "
            f"run {run_number}/{run_total}",
            flush=True,
        )

    def counted_try(
        self,
        progress: TryProgress,
        *,
        play_number: int,
        phase: str,
        puzzle_number: int,
        run_number: int,
    ) -> None:
        if not self.verbose:
            return
        run_total = self._run_total(phase)
        word = json.dumps(progress.word, ensure_ascii=False)
        print(
            f"[play {play_number}/{self.total_plays}] {phase} "
            f"puzzle {puzzle_number}/{self.total_puzzles} "
            f"run {run_number}/{run_total} try={progress.number} "
            f"word={word} progress={progress.progress:.2f}%",
            flush=True,
        )

    def play_completed(
        self,
        record: dict[str, Any],
        *,
        play_number: int,
        phase: str,
        puzzle_number: int,
        run_number: int,
    ) -> None:
        run_total = self._run_total(phase)
        if record["tries"] is not None:
            unit = "try" if record["tries"] == 1 else "tries"
            score = f"{record['tries']} {unit}"
        else:
            unit = "try" if record["counted_tries"] == 1 else "tries"
            score = f"DNF at {record['counted_tries']} counted {unit}"
        print(
            f"[play {play_number}/{self.total_plays}] DONE {phase} "
            f"puzzle {puzzle_number}/{self.total_puzzles} "
            f"run {run_number}/{run_total} — {score}, "
            f"{record['wall_duration']:.2f}s",
            flush=True,
        )

    def retrospective_started(
        self, *, retrospective_number: int, puzzle_number: int
    ) -> None:
        print(
            f"[strategy {retrospective_number}/{self.total_retrospectives}] "
            f"START retrospective after puzzle {puzzle_number}/{self.total_puzzles}",
            flush=True,
        )

    @staticmethod
    def structured_retry(
        *, prefix: str, next_attempt: int, error: str
    ) -> None:
        print(
            f"{prefix} RETRY structured reply "
            f"{next_attempt}/{STRUCTURED_MAX_ATTEMPTS} — {error}",
            flush=True,
        )

    def retrospective_completed(
        self,
        *,
        retrospective_number: int,
        puzzle_number: int,
        analysis: dict[str, Any],
        strategy: list[str],
    ) -> None:
        prefix = f"[strategy {retrospective_number}/{self.total_retrospectives}]"
        item_unit = "item" if len(strategy) == 1 else "items"
        print(
            f"{prefix} DONE retrospective after puzzle "
            f"{puzzle_number}/{self.total_puzzles} — "
            f"{len(strategy)} {item_unit}",
            flush=True,
        )
        if not self.verbose:
            return
        print(
            f"{prefix} retrospective analysis:\n"
            + json.dumps(analysis, ensure_ascii=False, indent=2),
            flush=True,
        )
        self._strategy(prefix, "revised strategy", strategy)

    def synthesis_started(self) -> None:
        print(
            f"[synthesis] START after {self.total_retrospectives} "
            "curriculum puzzles",
            flush=True,
        )

    def synthesis_completed(self, summary: str, strategy: list[str]) -> None:
        item_unit = "item" if len(strategy) == 1 else "items"
        print(
            f"[synthesis] DONE — {len(strategy)} final strategy {item_unit}",
            flush=True,
        )
        if not self.verbose:
            return
        print(f"[synthesis] comprehensive summary:\n{summary}", flush=True)
        self._strategy("[synthesis]", "final strategy", strategy)

    def complete(self, profile_path: Path) -> None:
        print(f"curriculum complete: {self.artifact_path}", flush=True)
        print(f"strategy profile: {profile_path}", flush=True)

    @staticmethod
    def _strategy(prefix: str, label: str, items: list[str]) -> None:
        print(f"{prefix} {label}:", flush=True)
        for number, item in enumerate(items, start=1):
            print(f"  {number}. {item}", flush=True)

    @staticmethod
    def _run_total(phase: str) -> int:
        return (
            HOLDOUT_RUNS_PER_CONDITION
            if phase.startswith("holdout/")
            else RUNS_PER_PUZZLE
        )


class CurriculumError(RuntimeError):
    pass


def resolve_path(path: Path) -> Path:
    """Accept absolute, caller-relative, repo-root-relative, or package-relative."""
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


# --- Run records and derived stall metrics --------------------------------------


def derive_run_metrics(
    puzzle: dict[str, Any], vocab: set[str], tried_words: tuple[str, ...]
) -> dict[str, Any]:
    """Replay the run through the real referee and derive the issue's metrics."""
    referee = PuzzleReferee(puzzle, vocab)
    max_streak = 0
    non_improving = 0
    first_sub100_try: int | None = None
    for word in tried_words:
        feedback = referee.submit(word)
        if feedback.kind != "counted":
            raise CurriculumError(
                f"recorded run contains a non-counting word {word!r}"
            )
        max_streak = max(max_streak, referee.stalled_tries)
        if referee.stalled_tries > 0:
            non_improving += 1
        if first_sub100_try is None and any(
            0 < hole.rank <= 100 for hole in referee.holes
        ):
            first_sub100_try = feedback.tries
    counted = referee.tries
    return {
        "max_no_improvement_streak": max_streak,
        "non_improving_guesses": non_improving,
        "guesses_after_rank100": (
            counted - first_sub100_try if first_sub100_try is not None else 0
        ),
        "solved": referee.solved,
    }


def run_record(result: RunResult, metrics: dict[str, Any]) -> dict[str, Any]:
    return {
        "tries": result.tries,
        "counted_tries": result.counted_tries,
        "turns": result.turns,
        "duration": result.duration,
        "tried_words": list(result.tried_words),
        "conversation": [dict(m) for m in result.conversation],
        "turn_token_usage": list(result.turn_token_usage),
        "metrics": metrics,
    }


# --- Retrospective and synthesis contracts ---------------------------------------

_ANALYSIS_KEYS = (
    "worked_well",
    "wasted_attempt_patterns",
    "missed_evidence",
    "strategy_adherence",
    "run_comparison",
)


def _puzzle_answer_lines(puzzle: dict[str, Any]) -> list[str]:
    lines = []
    for hole in puzzle["holes"]:
        lines.append(
            f"- answer: {hole['secret']['word']} (start clue was "
            f"{hole['start']['word']}, rank {hole['start_rank']})"
        )
    return lines


def retrospective_prompt(
    incoming: list[str] | None,
    puzzle: dict[str, Any],
    records: list[dict[str, Any]],
) -> str:
    lines = [
        "You are reviewing your own play of one hidden-word puzzle.",
        "",
        "RETROSPECTIVE RULES",
        (
            "You played the 3 independent runs below with the same incoming "
            "strategy. Diagnose what worked and what wasted guesses, then write "
            "a REVISED operational strategy for FUTURE, UNSEEN puzzles."
        ),
        (
            "Reply with a single JSON object and nothing else, shaped exactly as: "
            '{"analysis": {"worked_well": str, "wasted_attempt_patterns": str, '
            '"missed_evidence": str, "strategy_adherence": str, '
            '"run_comparison": str}, "revised_strategy": [str, ...]}'
        ),
        (
            f"revised_strategy: at most {sp.STRATEGY_MAX_ITEMS} items and "
            f"{sp.STRATEGY_MAX_CHARS} characters in total; general and reusable "
            "on unseen puzzles; it REPLACES the previous strategy. It must not "
            "quote the sentence and must not contain any target word, starting "
            "word, or guess from THIS puzzle."
        ),
        "",
        "INCOMING STRATEGY",
        sp.strategy_text(incoming) if incoming else "(none — first puzzle)",
        "",
        "CORRECT ANSWERS",
        *_puzzle_answer_lines(puzzle),
        "",
    ]
    for number, record in enumerate(records, start=1):
        metrics = record["metrics"]
        lines += [
            f"RUN {number}",
            (
                f"score: {record['tries'] if record['tries'] is not None else 'DNF'}"
                f" | max no-improvement streak: "
                f"{metrics['max_no_improvement_streak']}"
                f" | non-improving guesses: {metrics['non_improving_guesses']}"
                f" | guesses after first sub-100 rank: "
                f"{metrics['guesses_after_rank100']}"
            ),
            "transcript:",
        ]
        lines += [
            f"[{message['role']}] {message['content']}"
            for message in record["conversation"]
        ]
        lines.append("")
    return "\n".join(lines)


def parse_json_reply(reply: str) -> dict[str, Any]:
    text = reply.strip()
    start = text.find("{")
    if start < 0:
        raise ValueError("reply contains no JSON object")
    payload, _ = json.JSONDecoder().raw_decode(text[start:])
    if not isinstance(payload, dict):
        raise ValueError("reply JSON must be an object")
    return payload


def _banned_slugs(
    puzzle: dict[str, Any], records: list[dict[str, Any]]
) -> set[str]:
    banned = set()

    def add(word: str) -> None:
        folded = slug(word)
        if folded:
            banned.add(folded)
            banned.update(part for part in folded.split("-") if part)

    for hole in puzzle["holes"]:
        add(hole["secret"]["slug"])
        add(hole["start"]["slug"])
    for record in records:
        for word in record["tried_words"]:
            add(word)
    return banned


def _token_slug_forms(token: str) -> set[str]:
    folded = slug(token)
    if not folded:
        return set()
    return {folded, *(part for part in folded.split("-") if part)}


def _core_slug_sequence(text: str) -> list[str]:
    return [folded for token in _WORD_RE.findall(text) if (folded := slug(token))]


def _sentence_trigrams(puzzle: dict[str, Any]) -> set[tuple[str, str, str]]:
    sequence = _core_slug_sequence(" ".join(puzzle["words"]))
    return {
        tuple(sequence[index : index + 3])
        for index in range(max(0, len(sequence) - 2))
    }


def _quotes_sentence(item: str, puzzle: dict[str, Any]) -> bool:
    advice = _core_slug_sequence(item)
    advice_trigrams = {
        tuple(advice[index : index + 3])
        for index in range(max(0, len(advice) - 2))
    }
    return bool(_sentence_trigrams(puzzle) & advice_trigrams)


def validate_revised_strategy(
    items: Any, puzzle: dict[str, Any], records: list[dict[str, Any]]
) -> list[str]:
    """Bounded format + puzzle-leak rejection (targets, starts, guesses, quotes)."""
    revised = sp.validate_strategy_items(items)
    banned = _banned_slugs(puzzle, records)
    for item in revised:
        for token in _WORD_RE.findall(item):
            if _token_slug_forms(token) & banned:
                raise ValueError(
                    f"strategy item leaks puzzle word {token!r}; advice must be "
                    "general and reusable"
                )
        if _quotes_sentence(item, puzzle):
            raise ValueError("strategy item quotes the puzzle sentence")
    return revised


def validate_retrospective(
    payload: dict[str, Any],
    puzzle: dict[str, Any],
    records: list[dict[str, Any]],
) -> tuple[dict[str, Any], list[str]]:
    analysis = payload.get("analysis")
    if not isinstance(analysis, dict):
        raise ValueError('retrospective needs an "analysis" object')
    missing = [key for key in _ANALYSIS_KEYS if key not in analysis]
    if missing:
        raise ValueError(f"analysis is missing keys: {', '.join(missing)}")
    revised = validate_revised_strategy(
        payload.get("revised_strategy"), puzzle, records
    )
    return analysis, revised


def structured_call(
    prose_reply: Callable[[list[dict[str, str]]], str],
    prompt: str,
    validate: Callable[[dict[str, Any]], Any],
    *,
    on_retry: Callable[[int, str], None] | None = None,
) -> tuple[Any, list[dict[str, str]], dict[str, Any]]:
    """One fresh prose call with bounded validation repair attempts."""
    messages = [{"role": "user", "content": prompt}]
    started = time.monotonic()
    attempts: list[dict[str, Any]] = []
    for attempt in range(STRUCTURED_MAX_ATTEMPTS):
        attempt_started = time.monotonic()
        reply = prose_reply([m.copy() for m in messages])
        attempts.append(
            {
                "number": attempt + 1,
                "wall_duration": time.monotonic() - attempt_started,
                "token_usage": _last_token_usage(prose_reply),
            }
        )
        messages.append({"role": "assistant", "content": reply})
        try:
            telemetry = {
                "wall_duration": time.monotonic() - started,
                "attempts": attempts,
            }
            return validate(parse_json_reply(reply)), messages, telemetry
        except ValueError as exc:
            if attempt + 1 == STRUCTURED_MAX_ATTEMPTS:
                raise CurriculumError(
                    "structured reply is invalid after "
                    f"{STRUCTURED_MAX_ATTEMPTS} attempts: {exc}"
                ) from exc
            next_attempt = attempt + 2
            if on_retry is not None:
                on_retry(next_attempt, str(exc))
            repair_lines = [
                f"Your reply was rejected: {exc}.",
                (
                    "All schema, item-count, character-limit, and leak constraints "
                    "in the original request are hard validation requirements."
                ),
            ]
            length_match = re.fullmatch(
                r"strategy is (\d+) characters; the cap is (\d+)", str(exc)
            )
            if length_match:
                cap = int(length_match.group(2))
                target = min(STRUCTURED_STRATEGY_REPAIR_TARGET_CHARS, cap)
                repair_lines.append(
                    f"Rewrite the strategy to no more than {target} characters "
                    f"in total, leaving margin below the hard {cap}-character cap."
                )
            repair_lines.append(
                "Reply again with a single corrected JSON object and nothing else."
            )
            messages.append(
                {
                    "role": "user",
                    "content": " ".join(repair_lines),
                }
            )
    raise AssertionError("unreachable")


def synthesis_prompt(state: dict[str, Any]) -> str:
    lines = [
        "The curriculum is over. Synthesize what you learned across every puzzle.",
        "",
        (
            "Reply with a single JSON object and nothing else, shaped exactly as: "
            '{"comprehensive_summary": str, "final_strategy": [str, ...]}. '
            f"final_strategy uses the same bounded format (at most "
            f"{sp.STRATEGY_MAX_ITEMS} items, {sp.STRATEGY_MAX_CHARS} characters "
            "total), is general, and must not contain words from any specific "
            "puzzle."
        ),
        "",
    ]
    for puzzle_state in state["puzzles"]:
        scores = [
            record["tries"] if record["tries"] is not None else "DNF"
            for record in puzzle_state["runs"]
        ]
        lines += [
            f"PUZZLE {puzzle_state['number']} scores: {scores}",
            "retrospective analysis: "
            + json.dumps(
                puzzle_state["retrospective"]["analysis"], ensure_ascii=False
            ),
            "revised strategy after it: "
            + json.dumps(
                puzzle_state["retrospective"]["revised_strategy"],
                ensure_ascii=False,
            ),
            "",
        ]
    return "\n".join(lines)


def validate_synthesis(
    payload: dict[str, Any], curriculum_puzzles: list[dict[str, Any]]
) -> tuple[str, list[str]]:
    summary = payload.get("comprehensive_summary")
    if not isinstance(summary, str) or not summary.strip():
        raise ValueError('synthesis needs a non-empty "comprehensive_summary"')
    banned: set[str] = set()
    for puzzle in curriculum_puzzles:
        banned.update(_banned_slugs(puzzle, []))
    final = sp.validate_strategy_items(payload.get("final_strategy"))
    for item in final:
        for token in _WORD_RE.findall(item):
            if _token_slug_forms(token) & banned:
                raise ValueError(
                    f"final strategy leaks curriculum word {token!r}"
                )
        if any(_quotes_sentence(item, puzzle) for puzzle in curriculum_puzzles):
            raise ValueError("final strategy quotes a curriculum sentence")
    return summary.strip(), final


# --- Artifact state ---------------------------------------------------------------


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


def _completed_play_count(state: dict[str, Any]) -> int:
    curriculum = sum(len(puzzle.get("runs", [])) for puzzle in state["puzzles"])
    holdout = sum(
        len(entry.get("runs", []))
        for entries in state["holdout"].values()
        for entry in entries
    )
    return curriculum + holdout


# --- Orchestration -----------------------------------------------------------------


def run_curriculum(
    manifest_path: Path,
    *,
    model: str,
    effort: str,
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
) -> Path | None:
    manifest, dataset_sha, manifest_sha = load_manifest(manifest_path)
    dataset_dir = manifest_path.parent
    config = select_model(model)
    try:
        _validate_provider_effort(config["provider"], auth, effort)
    except ValueError as exc:
        raise CurriculumError(str(exc)) from exc
    transport = _transport_name(config, auth)
    api_key = None
    if auth == "api":
        api_key = os.environ.get(PROVIDER_ENV[config["provider"]])
        if not api_key and not dry_run:
            raise CurriculumError(
                f"{PROVIDER_ENV[config['provider']]} is required for API auth"
            )

    auth_verification: dict[str, Any] = {"mode": auth}
    if auth == "subscription":
        if dry_run:
            auth_verification["status"] = "skipped_dry_run"
        else:
            try:
                verified_session = (
                    validate_anthropic_subscription_auth()
                    if config["provider"] == "anthropic"
                    else validate_openai_subscription_auth()
                )
            except RuntimeError as exc:
                raise CurriculumError(str(exc)) from exc
            auth_verification.update(
                {"status": "verified", "provider_session": verified_session}
            )

    run_config = {
        "dataset_id": manifest["dataset_id"],
        "dataset_sha256": dataset_sha,
        "lang": manifest["lang"],
        "model_id": config["model_id"],
        "provider": config["provider"],
        "transport": transport,
        "effort": effort,
        "auth": auth,
        "auth_verification": auth_verification,
        "cap": cap,
        "prompt_version": PROMPT_VERSION,
        "curriculum_prompt_version": CURRICULUM_PROMPT_VERSION,
    }

    curriculum_records = [
        r for r in manifest["puzzles"] if r["split"] == "curriculum"
    ]
    holdout_records = [r for r in manifest["puzzles"] if r["split"] == "holdout"]
    frozen_v7 = v7_strategy if v7_strategy is not None else load_v7_strategy()

    if resume is not None:
        state = json.loads(resume.read_text(encoding="utf-8"))
        if state["config"] != run_config:
            raise CurriculumError(
                "resume artifact configuration does not match this invocation; "
                "refusing to mix configurations in one artifact"
            )
        artifact_path = resume
    else:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        artifact_path = (
            output_root
            / manifest["dataset_id"]
            / f"{config['model_id']}.{stamp}.json"
        )
        state = {
            "config": run_config,
            "manifest_sha256": manifest_sha,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "puzzles": [],
            "synthesis": None,
            "holdout": {condition: [] for condition in CONDITIONS},
        }

    if dry_run:
        pending_plays = (
            len(curriculum_records) * RUNS_PER_PUZZLE
            + len(holdout_records) * len(CONDITIONS) * HOLDOUT_RUNS_PER_CONDITION
        )
        print(
            json.dumps(
                {
                    "dry_run": True,
                    "config": run_config,
                    "curriculum_puzzles": len(curriculum_records),
                    "holdout_puzzles": len(holdout_records),
                    "planned_play_calls": pending_plays,
                    "planned_retrospectives": len(curriculum_records),
                    "planned_synthesis": 1,
                },
                indent=2,
            )
        )
        return None

    if resume is None:
        # Make the destination visible before the first paid turn. Individual runs
        # remain atomic: a partially played run is never recorded as complete.
        save_artifact(artifact_path, state)

    total_plays = (
        len(curriculum_records) * RUNS_PER_PUZZLE
        + len(holdout_records) * len(CONDITIONS) * HOLDOUT_RUNS_PER_CONDITION
    )
    reporter = CurriculumReporter(
        verbose=verbose,
        artifact_path=artifact_path,
        model_id=config["model_id"],
        cap=cap,
        total_plays=total_plays,
        total_puzzles=len(manifest["puzzles"]),
        total_retrospectives=len(curriculum_records),
        completed_plays=_completed_play_count(state),
    )

    vocab = vocab_loader(manifest["lang"])

    def fresh_word_player():
        return provider_factory(
            config, api_key, effort=effort, auth=auth, output="word"
        )

    def fresh_prose_caller():
        return provider_factory(
            config, api_key, effort=effort, auth=auth, output="prose"
        )

    def play_once(
        puzzle: dict[str, Any],
        strategy_items: list[str] | None,
        on_try: Callable[[TryProgress], None],
    ):
        started = time.monotonic()
        result = play_puzzle(
            puzzle,
            vocab,
            fresh_word_player(),
            cap=cap,
            on_try=on_try,
            strategy=sp.strategy_text(strategy_items) if strategy_items else None,
            rules_only=True,
        )
        metrics = derive_run_metrics(puzzle, vocab, result.tried_words)
        record = run_record(result, metrics)
        record["wall_duration"] = time.monotonic() - started
        return record

    # --- Curriculum: 3 fresh plays, then one fresh retrospective, per puzzle.
    incoming: list[str] | None = None
    for puzzle_index, record in enumerate(curriculum_records):
        if puzzle_index < len(state["puzzles"]):
            puzzle_state = state["puzzles"][puzzle_index]
        else:
            puzzle_state = {
                "number": record["number"],
                "path": record["path"],
                "incoming_strategy": incoming,
                "runs": [],
                "retrospective": None,
            }
            state["puzzles"].append(puzzle_state)
        puzzle = _load_puzzle(dataset_dir, record)

        while len(puzzle_state["runs"]) < RUNS_PER_PUZZLE:
            if puzzle_state["retrospective"] is not None and not force:
                raise CurriculumError(
                    "artifact has a retrospective before all runs; it is corrupt"
                )
            run_number = len(puzzle_state["runs"]) + 1
            play_number = puzzle_index * RUNS_PER_PUZZLE + run_number
            reporter.play_started(
                play_number=play_number,
                phase="curriculum",
                puzzle_number=record["number"],
                run_number=run_number,
            )
            completed_run = play_once(
                puzzle,
                puzzle_state["incoming_strategy"],
                lambda progress: reporter.counted_try(
                    progress,
                    play_number=play_number,
                    phase="curriculum",
                    puzzle_number=record["number"],
                    run_number=run_number,
                ),
            )
            puzzle_state["runs"].append(completed_run)
            save_artifact(artifact_path, state)
            reporter.play_completed(
                completed_run,
                play_number=play_number,
                phase="curriculum",
                puzzle_number=record["number"],
                run_number=run_number,
            )

        if puzzle_state["retrospective"] is None:
            reporter.retrospective_started(
                retrospective_number=puzzle_index + 1,
                puzzle_number=record["number"],
            )
            prompt = retrospective_prompt(
                puzzle_state["incoming_strategy"], puzzle, puzzle_state["runs"]
            )
            (analysis, revised), messages, telemetry = structured_call(
                fresh_prose_caller(),
                prompt,
                lambda payload: validate_retrospective(
                    payload, puzzle, puzzle_state["runs"]
                ),
                on_retry=lambda next_attempt, error: reporter.structured_retry(
                    prefix=(
                        f"[strategy {puzzle_index + 1}/"
                        f"{len(curriculum_records)}]"
                    ),
                    next_attempt=next_attempt,
                    error=error,
                ),
            )
            puzzle_state["retrospective"] = {
                "analysis": analysis,
                "revised_strategy": revised,
                "conversation": messages,
                "telemetry": telemetry,
            }
            save_artifact(artifact_path, state)
            reporter.retrospective_completed(
                retrospective_number=puzzle_index + 1,
                puzzle_number=record["number"],
                analysis=analysis,
                strategy=revised,
            )

        # The revised strategy REPLACES the previous one for the NEXT puzzle.
        incoming = puzzle_state["retrospective"]["revised_strategy"]

    # --- Final synthesis: one fresh call over every retrospective.
    if state["synthesis"] is None:
        reporter.synthesis_started()
        curriculum_puzzles = [
            _load_puzzle(dataset_dir, record) for record in curriculum_records
        ]
        (summary, final_strategy), messages, telemetry = structured_call(
            fresh_prose_caller(),
            synthesis_prompt(state),
            lambda payload: validate_synthesis(payload, curriculum_puzzles),
            on_retry=lambda next_attempt, error: reporter.structured_retry(
                prefix="[synthesis]",
                next_attempt=next_attempt,
                error=error,
            ),
        )
        state["synthesis"] = {
            "comprehensive_summary": summary,
            "final_strategy": final_strategy,
            "conversation": messages,
            "telemetry": telemetry,
        }
        save_artifact(artifact_path, state)
        reporter.synthesis_completed(summary, final_strategy)

    final_strategy = state["synthesis"]["final_strategy"]

    # --- Holdout: frozen strategies, three conditions, no retrospectives.
    condition_strategies: dict[str, list[str] | None] = {
        "neutral": None,
        "learned": final_strategy,
        "v7": [frozen_v7],
    }
    curriculum_play_count = len(curriculum_records) * RUNS_PER_PUZZLE
    for condition_index, condition in enumerate(CONDITIONS):
        completed = state["holdout"][condition]
        for holdout_index, record in enumerate(holdout_records):
            entry = next(
                (e for e in completed if e["number"] == record["number"]), None
            )
            if entry is None:
                entry = {"number": record["number"], "path": record["path"], "runs": []}
                completed.append(entry)
            puzzle = _load_puzzle(dataset_dir, record)
            while len(entry["runs"]) < HOLDOUT_RUNS_PER_CONDITION:
                run_number = len(entry["runs"]) + 1
                play_number = (
                    curriculum_play_count
                    + condition_index
                    * len(holdout_records)
                    * HOLDOUT_RUNS_PER_CONDITION
                    + holdout_index * HOLDOUT_RUNS_PER_CONDITION
                    + run_number
                )
                phase = f"holdout/{condition}"
                reporter.play_started(
                    play_number=play_number,
                    phase=phase,
                    puzzle_number=record["number"],
                    run_number=run_number,
                )
                completed_run = play_once(
                    puzzle,
                    condition_strategies[condition],
                    lambda progress: reporter.counted_try(
                        progress,
                        play_number=play_number,
                        phase=phase,
                        puzzle_number=record["number"],
                        run_number=run_number,
                    ),
                )
                entry["runs"].append(completed_run)
                save_artifact(artifact_path, state)
                reporter.play_completed(
                    completed_run,
                    play_number=play_number,
                    phase=phase,
                    puzzle_number=record["number"],
                    run_number=run_number,
                )

    # --- Compact reusable profile.
    profile = sp.build_profile(
        strategy_id=f"{manifest['dataset_id']}/{config['model_id']}",
        model_id=config["model_id"],
        provider=config["provider"],
        transport=transport,
        effort=effort,
        lang=manifest["lang"],
        dataset_id=manifest["dataset_id"],
        dataset_sha256=dataset_sha,
        prompt_version=PROMPT_VERSION,
        curriculum_prompt_version=CURRICULUM_PROMPT_VERSION,
        created_at=datetime.now(timezone.utc).isoformat(),
        final_strategy=final_strategy,
    )
    profile_path = artifact_path.with_suffix(".profile.json")
    sp.write_profile(profile_path, profile)
    state["profile_path"] = str(profile_path)
    save_artifact(artifact_path, state)
    reporter.complete(profile_path)
    return artifact_path


# --- Evaluation --------------------------------------------------------------------


def _median_tries(runs: list[dict[str, Any]]) -> int | None:
    """Median with DNF sorted last; a DNF median stays None, never a fake number."""
    ordered = sorted(
        (run["tries"] for run in runs),
        key=lambda tries: (tries is None, tries),
    )
    return ordered[len(ordered) // 2]


def _dnf_aware_median(values: list[int | None]) -> int | None:
    ordered = sorted(values, key=lambda tries: (tries is None, tries))
    return ordered[len(ordered) // 2] if ordered else None


def _merge_token_usage(
    total: dict[str, Any], usage: dict[str, Any] | None
) -> None:
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


def _cost_split(state: dict[str, Any]) -> dict[str, Any]:
    buckets = {
        phase: {"calls": 0, "wall_duration": 0.0, "token_usage": {}}
        for phase in ("play", "retrospective", "synthesis")
    }

    def add_play(record: dict[str, Any]) -> None:
        bucket = buckets["play"]
        bucket["calls"] += record.get("turns", 0)
        bucket["wall_duration"] += record.get(
            "wall_duration", record.get("duration", 0.0)
        )
        for usage in record.get("turn_token_usage", []):
            _merge_token_usage(bucket["token_usage"], usage)

    for puzzle_state in state.get("puzzles", []):
        for record in puzzle_state.get("runs", []):
            add_play(record)
        retrospective = puzzle_state.get("retrospective") or {}
        telemetry = retrospective.get("telemetry") or {}
        buckets["retrospective"]["wall_duration"] += telemetry.get(
            "wall_duration", 0.0
        )
        for attempt in telemetry.get("attempts", []):
            buckets["retrospective"]["calls"] += 1
            _merge_token_usage(
                buckets["retrospective"]["token_usage"],
                attempt.get("token_usage"),
            )
    for condition in state.get("holdout", {}).values():
        for entry in condition:
            for record in entry.get("runs", []):
                add_play(record)

    synthesis = state.get("synthesis") or {}
    telemetry = synthesis.get("telemetry") or {}
    buckets["synthesis"]["wall_duration"] = telemetry.get("wall_duration", 0.0)
    for attempt in telemetry.get("attempts", []):
        buckets["synthesis"]["calls"] += 1
        _merge_token_usage(
            buckets["synthesis"]["token_usage"], attempt.get("token_usage")
        )
    return buckets


def evaluate_artifact(state: dict[str, Any]) -> dict[str, Any]:
    trend = [
        {
            "number": puzzle_state["number"],
            "median_tries": _median_tries(puzzle_state["runs"]),
            "dnf": sum(1 for r in puzzle_state["runs"] if r["tries"] is None),
        }
        for puzzle_state in state["puzzles"]
    ]

    holdout: dict[str, Any] = {}
    for condition, entries in state["holdout"].items():
        per_puzzle = {
            entry["number"]: _median_tries(entry["runs"]) for entry in entries
        }
        medians = list(per_puzzle.values())
        numeric = [m for m in medians if m is not None]
        holdout[condition] = {
            "per_puzzle_median": per_puzzle,
            "median_of_medians": _dnf_aware_median(medians),
            "solved_only_median": statistics.median(numeric) if numeric else None,
            "dnf_puzzles": sum(median is None for median in medians),
            "dnf_runs": sum(
                1
                for entry in entries
                for run in entry["runs"]
                if run["tries"] is None
            ),
        }

    paired: dict[str, Any] = {}
    for condition in ("learned", "v7"):
        diffs = {}
        for number, neutral_median in holdout.get("neutral", {}).get(
            "per_puzzle_median", {}
        ).items():
            other = holdout.get(condition, {}).get("per_puzzle_median", {}).get(
                number
            )
            diffs[number] = (
                other - neutral_median
                if other is not None and neutral_median is not None
                else None
            )
        paired[f"{condition}_minus_neutral"] = diffs

    adherence = [
        puzzle_state["retrospective"]["analysis"].get("strategy_adherence")
        for puzzle_state in state["puzzles"]
        if puzzle_state.get("retrospective")
    ]

    return {
        "config": state["config"],
        "curriculum_trend": trend,
        "holdout": holdout,
        "paired_differences": paired,
        "strategy_adherence": adherence,
        "final_strategy": (state.get("synthesis") or {}).get("final_strategy"),
        "cost_split": _cost_split(state),
    }


# --- CLI ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    run_parser = sub.add_parser("run", help="run the curriculum for one model")
    run_parser.add_argument("manifest", type=Path)
    run_parser.add_argument("--model", required=True)
    run_parser.add_argument("--effort", default="none")
    run_parser.add_argument("--auth", choices=("api", "subscription"), default="api")
    run_parser.add_argument("--cap", type=int, default=DEFAULT_CAP)
    run_parser.add_argument("--resume", type=Path)
    run_parser.add_argument("--force", action="store_true")
    run_parser.add_argument("--dry-run", action="store_true")
    run_parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="print every counted try plus retrospective and strategy details",
    )

    eval_parser = sub.add_parser("evaluate", help="report on an artifact or profile")
    eval_parser.add_argument("artifact", type=Path)

    args = parser.parse_args(argv)

    if args.command == "run":
        run_curriculum(
            resolve_path(args.manifest),
            model=args.model,
            effort=args.effort,
            auth=args.auth,
            cap=args.cap,
            resume=resolve_path(args.resume) if args.resume else None,
            force=args.force,
            dry_run=args.dry_run,
            verbose=args.verbose,
        )
        return 0

    payload = json.loads(resolve_path(args.artifact).read_text(encoding="utf-8"))
    if "final_strategy" in payload and "puzzles" not in payload:
        sp.validate_profile(payload)
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    print(json.dumps(evaluate_artifact(payload), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
