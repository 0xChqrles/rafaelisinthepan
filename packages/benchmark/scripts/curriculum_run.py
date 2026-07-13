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
    load_vocab,
    play_puzzle,
    provider_reply,
    select_model,
    _transport_name,
)
from slug import slug  # noqa: E402
import strategy_profiles as sp  # noqa: E402

CURRICULUM_PROMPT_VERSION = "1"
RUNS_PER_PUZZLE = 3
HOLDOUT_RUNS_PER_CONDITION = 3
CONDITIONS = ("neutral", "learned", "v7")

OUTPUT_ROOT = BENCHMARK_DIR / "output" / "curriculum"
# The exact hand-written v7 strategy, recovered from a recorded v7 transcript
# (never reconstructed or paraphrased). See datasets/v7-strategy.txt provenance
# header; load_v7_strategy() strips that header.
V7_STRATEGY_PATH = BENCHMARK_DIR / "datasets" / "v7-strategy.txt"

_WORD_RE = re.compile(r"[^\W\d_]+(?:-[^\W\d_]+)*", re.UNICODE)


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
    for hole in puzzle["holes"]:
        banned.add(hole["secret"]["slug"])
        banned.add(hole["start"]["slug"])
    for record in records:
        for word in record["tried_words"]:
            banned.add(slug(word))
    banned.discard("")
    return banned


def _sentence_quotes(puzzle: dict[str, Any]) -> list[str]:
    words = [w for w in puzzle["words"]]
    return [
        " ".join(words[i : i + 4]).lower()
        for i in range(max(0, len(words) - 3))
    ]


def validate_revised_strategy(
    items: Any, puzzle: dict[str, Any], records: list[dict[str, Any]]
) -> list[str]:
    """Bounded format + puzzle-leak rejection (targets, starts, guesses, quotes)."""
    revised = sp.validate_strategy_items(items)
    banned = _banned_slugs(puzzle, records)
    quotes = _sentence_quotes(puzzle)
    for item in revised:
        for token in _WORD_RE.findall(item):
            if slug(token) in banned:
                raise ValueError(
                    f"strategy item leaks puzzle word {token!r}; advice must be "
                    "general and reusable"
                )
        lowered = item.lower()
        for quote in quotes:
            if quote and quote in lowered:
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
) -> tuple[Any, list[dict[str, str]]]:
    """One fresh prose call; on malformed/leaking output, reprompt ONCE then fail."""
    messages = [{"role": "user", "content": prompt}]
    for attempt in range(2):
        reply = prose_reply([m.copy() for m in messages])
        messages.append({"role": "assistant", "content": reply})
        try:
            return validate(parse_json_reply(reply)), messages
        except ValueError as exc:
            if attempt == 1:
                raise CurriculumError(
                    f"structured reply is invalid after one reprompt: {exc}"
                ) from exc
            messages.append(
                {
                    "role": "user",
                    "content": (
                        f"Your reply was rejected: {exc}. Reply again with a "
                        "single corrected JSON object and nothing else."
                    ),
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
        for hole in puzzle["holes"]:
            banned.add(hole["secret"]["slug"])
            banned.add(hole["start"]["slug"])
    final = sp.validate_strategy_items(payload.get("final_strategy"))
    for item in final:
        for token in _WORD_RE.findall(item):
            if slug(token) in banned:
                raise ValueError(
                    f"final strategy leaks curriculum word {token!r}"
                )
    return summary.strip(), final


# --- Artifact state ---------------------------------------------------------------


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save_artifact(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    tmp.replace(path)


def load_manifest(manifest_path: Path) -> tuple[dict[str, Any], str]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    dataset_dir = manifest_path.parent
    for record in manifest["puzzles"]:
        actual = _sha256_file(dataset_dir / record["path"])
        if actual != record["sha256"]:
            raise CurriculumError(
                f"dataset puzzle {record['path']} does not match its manifest "
                "sha256; refusing to run on a modified dataset"
            )
    return manifest, _sha256_file(manifest_path)


def _load_puzzle(dataset_dir: Path, record: dict[str, Any]) -> dict[str, Any]:
    return json.loads(
        (dataset_dir / record["path"]).read_text(encoding="utf-8")
    )


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
    provider_factory: Callable[..., Any] = provider_reply,
    vocab_loader: Callable[[str], set[str]] = load_vocab,
    output_root: Path = OUTPUT_ROOT,
    v7_strategy: str | None = None,
) -> Path | None:
    manifest, manifest_sha = load_manifest(manifest_path)
    dataset_dir = manifest_path.parent
    config = select_model(model)
    transport = _transport_name(config, auth)
    api_key = None
    if auth == "api":
        api_key = os.environ.get(PROVIDER_ENV[config["provider"]])
        if not api_key and not dry_run:
            raise CurriculumError(
                f"{PROVIDER_ENV[config['provider']]} is required for API auth"
            )

    run_config = {
        "dataset_id": manifest["dataset_id"],
        "dataset_sha256": manifest_sha,
        "lang": manifest["lang"],
        "model_id": config["model_id"],
        "provider": config["provider"],
        "transport": transport,
        "effort": effort,
        "auth": auth,
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

    vocab = vocab_loader(manifest["lang"])

    def fresh_word_player():
        return provider_factory(
            config, api_key, effort=effort, auth=auth, output="word"
        )

    def fresh_prose_caller():
        return provider_factory(
            config, api_key, effort=effort, auth=auth, output="prose"
        )

    def play_once(puzzle: dict[str, Any], strategy_items: list[str] | None):
        started = time.monotonic()
        result = play_puzzle(
            puzzle,
            vocab,
            fresh_word_player(),
            cap=cap,
            strategy=sp.strategy_text(strategy_items) if strategy_items else None,
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
            puzzle_state["runs"].append(
                play_once(puzzle, puzzle_state["incoming_strategy"])
            )
            save_artifact(artifact_path, state)

        if puzzle_state["retrospective"] is None:
            prompt = retrospective_prompt(
                puzzle_state["incoming_strategy"], puzzle, puzzle_state["runs"]
            )
            (analysis, revised), messages = structured_call(
                fresh_prose_caller(),
                prompt,
                lambda payload: validate_retrospective(
                    payload, puzzle, puzzle_state["runs"]
                ),
            )
            puzzle_state["retrospective"] = {
                "analysis": analysis,
                "revised_strategy": revised,
                "conversation": messages,
            }
            save_artifact(artifact_path, state)

        # The revised strategy REPLACES the previous one for the NEXT puzzle.
        incoming = puzzle_state["retrospective"]["revised_strategy"]

    # --- Final synthesis: one fresh call over every retrospective.
    if state["synthesis"] is None:
        curriculum_puzzles = [
            _load_puzzle(dataset_dir, record) for record in curriculum_records
        ]
        (summary, final_strategy), messages = structured_call(
            fresh_prose_caller(),
            synthesis_prompt(state),
            lambda payload: validate_synthesis(payload, curriculum_puzzles),
        )
        state["synthesis"] = {
            "comprehensive_summary": summary,
            "final_strategy": final_strategy,
            "conversation": messages,
        }
        save_artifact(artifact_path, state)

    final_strategy = state["synthesis"]["final_strategy"]

    # --- Holdout: frozen strategies, three conditions, no retrospectives.
    condition_strategies: dict[str, list[str] | None] = {
        "neutral": None,
        "learned": final_strategy,
        "v7": [frozen_v7],
    }
    for condition in CONDITIONS:
        completed = state["holdout"][condition]
        for record in holdout_records:
            entry = next(
                (e for e in completed if e["number"] == record["number"]), None
            )
            if entry is None:
                entry = {"number": record["number"], "path": record["path"], "runs": []}
                completed.append(entry)
            puzzle = _load_puzzle(dataset_dir, record)
            while len(entry["runs"]) < HOLDOUT_RUNS_PER_CONDITION:
                entry["runs"].append(
                    play_once(puzzle, condition_strategies[condition])
                )
                save_artifact(artifact_path, state)

    # --- Compact reusable profile.
    profile = sp.build_profile(
        strategy_id=f"{manifest['dataset_id']}/{config['model_id']}",
        model_id=config["model_id"],
        provider=config["provider"],
        transport=transport,
        effort=effort,
        lang=manifest["lang"],
        dataset_id=manifest["dataset_id"],
        dataset_sha256=manifest_sha,
        prompt_version=PROMPT_VERSION,
        curriculum_prompt_version=CURRICULUM_PROMPT_VERSION,
        created_at=datetime.now(timezone.utc).isoformat(),
        final_strategy=final_strategy,
    )
    profile_path = artifact_path.with_suffix(".profile.json")
    sp.write_profile(profile_path, profile)
    state["profile_path"] = str(profile_path)
    save_artifact(artifact_path, state)
    return artifact_path


# --- Evaluation --------------------------------------------------------------------


def _median_tries(runs: list[dict[str, Any]]) -> int | None:
    """Median with DNF sorted last; a DNF median stays None, never a fake number."""
    ordered = sorted(
        (run["tries"] for run in runs),
        key=lambda tries: (tries is None, tries),
    )
    return ordered[len(ordered) // 2]


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
        numeric = [m for m in per_puzzle.values() if m is not None]
        holdout[condition] = {
            "per_puzzle_median": per_puzzle,
            "median_of_medians": (
                statistics.median(numeric) if numeric else None
            ),
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

    eval_parser = sub.add_parser("evaluate", help="report on an artifact or profile")
    eval_parser.add_argument("artifact", type=Path)

    args = parser.parse_args(argv)

    if args.command == "run":
        artifact_path = run_curriculum(
            resolve_path(args.manifest),
            model=args.model,
            effort=args.effort,
            auth=args.auth,
            cap=args.cap,
            resume=resolve_path(args.resume) if args.resume else None,
            force=args.force,
            dry_run=args.dry_run,
        )
        if artifact_path is not None:
            print(f"curriculum artifact: {artifact_path}")
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
