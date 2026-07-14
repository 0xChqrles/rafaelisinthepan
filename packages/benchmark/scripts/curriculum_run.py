"""Retrospective strategy-curriculum orchestrator (#84).

Per model: play each curriculum puzzle 3 independent times (same incoming
four-rule policy, genuinely fresh provider contexts, no cross-run leakage), then
one fresh retrospective call that revises that compact policy (replace, never
append). Every play turn is an auditable JSON decision checked before its guess
can reach the game referee. After 15 puzzles, one synthesis call produces the
final report and frozen policy; holdout evaluation then compares neutral /
learned / v7 conditions without further learning.

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
from dataclasses import dataclass
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
    TryProgress,
    load_vocab,
    parse_single_word,
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

CURRICULUM_PROMPT_VERSION = "3"
RUNS_PER_PUZZLE = 3
HOLDOUT_RUNS_PER_CONDITION = 3
CONDITIONS = ("neutral", "learned", "v7")
STRUCTURED_MAX_ATTEMPTS = 4
# Models estimate character counts imperfectly. A rejected policy is repaired
# toward a margin below the actual validator cap instead of aiming at its edge.
STRUCTURED_POLICY_REPAIR_TARGET_CHARS = sp.POLICY_MAX_ACTION_CHARS * 9 // 10
POLICY_MAX_ATTEMPTS_PER_TRY = 3
POLICY_DECISION_KEYS = ("guess", "rule", "mode", "target", "family")
POLICY_MODES = {
    "always": "explore",
    "stall": "pivot",
    "warm": "exploit",
    "invalid": "correct",
}

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
            f"checkpointed; model={model_id}; cap={cap}; "
            f"curriculum_prompt=v{CURRICULUM_PROMPT_VERSION}",
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

    def policy_attempt(
        self,
        attempt: dict[str, Any],
        *,
        play_number: int,
        phase: str,
        puzzle_number: int,
        run_number: int,
    ) -> None:
        if not self.verbose:
            return
        prefix = (
            f"[play {play_number}/{self.total_plays}] {phase} "
            f"puzzle {puzzle_number}/{self.total_puzzles} "
            f"run {run_number}/{self._run_total(phase)}"
        )
        decision = attempt.get("decision") or {}
        if attempt["accepted"]:
            print(
                f"{prefix} policy=accepted rule={decision['rule']} "
                f"mode={decision['mode']} target={decision['target']} "
                f"family={json.dumps(decision['family'], ensure_ascii=False)}",
                flush=True,
            )
        else:
            print(
                f"{prefix} policy=rejected expected={attempt['expected_rule']} "
                f"reason={json.dumps(attempt['error'], ensure_ascii=False)}",
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
        elif record.get("termination_reason") == "policy_failure":
            unit = "try" if record["counted_tries"] == 1 else "tries"
            score = (
                "POLICY FAILURE after "
                f"{record['counted_tries']} counted {unit}"
            )
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
        policy: dict[str, Any],
    ) -> None:
        prefix = f"[strategy {retrospective_number}/{self.total_retrospectives}]"
        print(
            f"{prefix} DONE retrospective after puzzle "
            f"{puzzle_number}/{self.total_puzzles} — "
            "4-rule policy",
            flush=True,
        )
        if not self.verbose:
            return
        print(
            f"{prefix} retrospective analysis:\n"
            + json.dumps(analysis, ensure_ascii=False, indent=2),
            flush=True,
        )
        self._policy(prefix, "revised policy", policy)

    def synthesis_started(self) -> None:
        print(
            f"[synthesis] START after {self.total_retrospectives} "
            "curriculum puzzles",
            flush=True,
        )

    def synthesis_completed(self, summary: str, policy: dict[str, Any]) -> None:
        print("[synthesis] DONE — final 4-rule policy", flush=True)
        if not self.verbose:
            return
        print(f"[synthesis] comprehensive summary:\n{summary}", flush=True)
        self._policy("[synthesis]", "final policy", policy)

    def complete(self, profile_path: Path) -> None:
        print(f"curriculum complete: {self.artifact_path}", flush=True)
        print(f"strategy profile: {profile_path}", flush=True)

    @staticmethod
    def _policy(prefix: str, label: str, policy: dict[str, Any]) -> None:
        print(
            f"{prefix} {label}:\n"
            + json.dumps(policy, ensure_ascii=False, indent=2),
            flush=True,
        )

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


# --- Prompt-v3 policy controller -------------------------------------------------


@dataclass(frozen=True)
class PolicyRunResult:
    tries: int | None
    counted_tries: int
    turns: int
    duration: float
    tried_words: tuple[str, ...]
    conversation: tuple[dict[str, str], ...]
    turn_token_usage: tuple[dict[str, Any], ...]
    termination_reason: str  # solved | cap | policy_failure
    policy_attempts: tuple[dict[str, Any], ...]


def v7_controller_policy() -> dict[str, Any]:
    """Controller thresholds explicitly stated by the frozen v7 guidance."""
    return sp.validate_policy(
        {
            "always": {
                "action": (
                    "Apply the frozen v7 guidance: combine sentence grammar with "
                    "rank evidence and choose the most useful untried word."
                )
            },
            "stall": {
                "after": 3,
                "action": (
                    "Leave the exhausted semantic family and pivot to a different "
                    "relation, opposite, or base form."
                ),
            },
            "warm": {
                "rank_at_most": 100,
                "max_followups": 3,
                "action": (
                    "Exploit the warmest evidence briefly, prioritizing the exact "
                    "grammatical form required by the sentence."
                ),
            },
            "invalid": {
                "action": (
                    "Repair the rejected decision with a valid, untried word while "
                    "preserving the intended target."
                )
            },
        }
    )


def _unsolved_holes(referee: PuzzleReferee) -> list[Any]:
    return [hole for hole in referee.holes if hole.rank != 0]


def _warm_holes(
    referee: PuzzleReferee, policy: dict[str, Any]
) -> list[Any]:
    threshold = policy["warm"]["rank_at_most"]
    if threshold == 0:
        return []
    return [
        hole for hole in _unsolved_holes(referee) if hole.rank <= threshold
    ]


def active_policy_rule(
    referee: PuzzleReferee,
    policy: dict[str, Any],
    *,
    correcting: bool = False,
    warm_followups: int = 0,
) -> str:
    """Select one rule from referee state plus the controller's warm budget."""
    policy = sp.validate_policy(policy)
    if correcting:
        return "invalid"
    warm = _warm_holes(referee, policy)
    stall_after = policy["stall"]["after"]
    if stall_after > 0 and referee.stalled_tries >= stall_after:
        return "stall"
    if warm and warm_followups >= policy["warm"]["max_followups"]:
        return "stall"
    if warm:
        return "warm"
    return "always"


def _policy_state_lines(referee: PuzzleReferee) -> list[str]:
    tried = ", ".join(sorted(referee.tried_words, key=slug)) or "none"
    if referee.tries == 0:
        trend = "NO-IMPROVEMENT STREAK: 0. No counted guesses yet."
    elif referee.stalled_tries == 0:
        trend = (
            "NO-IMPROVEMENT STREAK: 0. The latest counted guess improved at "
            "least one word."
        )
    else:
        unit = "guess" if referee.stalled_tries == 1 else "guesses"
        trend = (
            f"NO-IMPROVEMENT STREAK: {referee.stalled_tries}. The last "
            f"{referee.stalled_tries} counted {unit} improved no word."
        )
    return [
        "CURRENT STATE",
        f"CLOZE: {referee.cloze()}",
        "CURRENT BEST RANKED CLUE PER UNSOLVED WORD — SEMANTIC EVIDENCE, "
        "NOT SENTENCE TEXT:",
        *referee.best_clue_lines(),
        trend,
        f"EXCLUDED AS ALREADY TRIED (unordered; do not repeat): {tried}",
        f"TRIES: {referee.tries} (lower is better)",
    ]


def _active_rule_lines(
    referee: PuzzleReferee,
    policy: dict[str, Any],
    rule: str,
    *,
    last_family: str | None = None,
    warm_followups: int = 0,
) -> list[str]:
    targets = ", ".join(str(hole.number) for hole in _unsolved_holes(referee))
    lines = [
        "ACTIVE POLICY RULE — HARD REQUIREMENT",
        f"rule: {rule}",
        f"required mode: {POLICY_MODES[rule]}",
        f"action: {policy[rule]['action']}",
        f"allowed unsolved targets: {targets or 'none'}",
    ]
    warm_budget = policy["warm"]["max_followups"]
    if warm_budget > 0:
        lines.append(
            "accepted warm follow-ups in current burst: "
            f"{warm_followups}/{warm_budget}"
        )
    if rule == "warm":
        warm_targets = ", ".join(
            str(hole.number) for hole in _warm_holes(referee, policy)
        )
        lines.append(f"warm targets allowed for this rule: {warm_targets}")
    if rule == "stall":
        lines.append(
            "The family label must differ from the last accepted decision's family."
        )
        lines.append(f"last accepted family: {last_family or 'none'}")
    return lines


def _decision_contract_lines() -> list[str]:
    return [
        "DECISION OUTPUT CONTRACT",
        (
            "Return one JSON object and nothing else with exactly these fields: "
            '{"guess":str,"rule":str,"mode":str,"target":int,"family":str}.'
        ),
        (
            "guess must be exactly one valid untried game word. rule and mode must "
            "equal the active values. target must be an allowed unsolved WORD number. "
            "family is a short auditable semantic-family label."
        ),
        (
            "The controller validates this object before scoring the guess. A rejected "
            "decision does not count; repeated rejection terminates the run as a "
            "policy failure."
        ),
    ]


def policy_opening_message(
    referee: PuzzleReferee,
    policy: dict[str, Any],
    *,
    verbatim_guidance: str | None = None,
) -> str:
    policy = sp.validate_policy(policy)
    rule = active_policy_rule(referee, policy)
    lines = [
        "Play Whippin AI in French under curriculum policy v3.",
        "",
        "GOAL",
        (
            "Solve every hidden word in as few counted tries as possible. One valid "
            "untried guess is broadcast to every unsolved word."
        ),
        "",
        "FIXED GAME RULES",
        (
            "The CLOZE is a real sentence. Lower rank is closer, rank 0 solves, and "
            "MISS is outside the stored neighborhood."
        ),
        (
            "Ranks measure embedding relatedness, not grammatical fit or synonymy. "
            "Answers are exact inflected forms."
        ),
        (
            "Only vocabulary-valid unique guesses count. Solved words lock. The "
            "authoritative state below replaces obsolete intermediate state."
        ),
        "",
        "FOUR-RULE POLICY",
        sp.policy_text(policy),
    ]
    if verbatim_guidance:
        lines += [
            "",
            "FROZEN V7 GUIDANCE — VERBATIM CONTROL TEXT",
            verbatim_guidance,
        ]
    lines += [
        "",
        *_policy_state_lines(referee),
        "",
        *_active_rule_lines(referee, policy, rule),
        "",
        *_decision_contract_lines(),
    ]
    return "\n".join(lines)


def _policy_outcomes(feedback: Any, referee: PuzzleReferee) -> list[str]:
    lines = []
    for outcome in feedback.outcomes:
        current_rank = referee.holes[outcome.number - 1].rank
        if outcome.rank is None:
            lines.append(
                f"word {outcome.number}: MISS (current best remains rank "
                f"{current_rank})"
            )
        elif outcome.solved:
            lines.append(f"word {outcome.number}: 0 solved!")
        elif outcome.improved:
            lines.append(
                f"word {outcome.number}: {outcome.rank} closer; new best rank "
                f"{outcome.rank}"
            )
        else:
            lines.append(
                f"word {outcome.number}: rank {outcome.rank} did not improve "
                f"current best rank {current_rank}"
            )
    return lines


def policy_feedback_message(
    feedback: Any,
    referee: PuzzleReferee,
    policy: dict[str, Any],
    *,
    last_family: str,
    warm_followups: int,
) -> str:
    lines = [
        f'RESULT FOR "{feedback.guess}":',
        *_policy_outcomes(feedback, referee),
        "",
        *_policy_state_lines(referee),
    ]
    if feedback.solved:
        lines += ["", "RUN COMPLETE: solved."]
    else:
        rule = active_policy_rule(
            referee, policy, warm_followups=warm_followups
        )
        lines += [
            "",
            *_active_rule_lines(
                referee,
                policy,
                rule,
                last_family=last_family,
                warm_followups=warm_followups,
            ),
            "",
            *_decision_contract_lines(),
        ]
    return "\n".join(lines)


def policy_rejection_message(
    error: str,
    referee: PuzzleReferee,
    policy: dict[str, Any],
    *,
    required_rule: str,
    last_family: str | None,
    warm_followups: int,
) -> str:
    rule = active_policy_rule(referee, policy, correcting=True)
    lines = [
        f"POLICY REJECTION: {error}",
        "Nothing was scored and the game state did not change.",
        f"underlying {required_rule} action: {policy[required_rule]['action']}",
        "",
        *_policy_state_lines(referee),
        "",
        *_active_rule_lines(
            referee,
            policy,
            rule,
            warm_followups=warm_followups,
        ),
        (
            "The correction envelope is invalid/correct, but the decision must "
            f"still satisfy the underlying {required_rule} rule's target/family "
            "constraints."
        ),
        "",
        *_decision_contract_lines(),
    ]
    if required_rule == "warm":
        warm_targets = ", ".join(
            str(hole.number) for hole in _warm_holes(referee, policy)
        )
        lines.insert(3, f"underlying warm targets: {warm_targets}")
    if required_rule == "stall":
        lines.insert(3, f"last accepted family: {last_family or 'none'}")
    return "\n".join(lines)


def parse_policy_decision(reply: str) -> dict[str, Any]:
    try:
        payload = json.loads(reply.strip())
    except (json.JSONDecodeError, AttributeError) as exc:
        raise ValueError(
            "reply must be one JSON object with no surrounding text"
        ) from exc
    if not isinstance(payload, dict):
        raise ValueError("decision JSON must be an object")
    actual = set(payload)
    expected = set(POLICY_DECISION_KEYS)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        detail = []
        if missing:
            detail.append("missing " + ", ".join(missing))
        if extra:
            detail.append("unexpected " + ", ".join(extra))
        raise ValueError("decision has wrong fields (" + "; ".join(detail) + ")")
    return payload


def validate_policy_decision(
    payload: dict[str, Any],
    referee: PuzzleReferee,
    policy: dict[str, Any],
    *,
    expected_rule: str,
    tactical_rule: str | None = None,
    last_family: str | None,
) -> dict[str, Any]:
    rule = payload.get("rule")
    if rule != expected_rule:
        raise ValueError(f"rule must be {expected_rule!r}, got {rule!r}")
    mode = payload.get("mode")
    expected_mode = POLICY_MODES[expected_rule]
    if mode != expected_mode:
        raise ValueError(
            f"mode must be {expected_mode!r} for rule {expected_rule!r}"
        )

    tactical_rule = tactical_rule or expected_rule
    target = payload.get("target")
    unsolved = {hole.number for hole in _unsolved_holes(referee)}
    if (
        not isinstance(target, int)
        or isinstance(target, bool)
        or target not in unsolved
    ):
        raise ValueError(f"target must be one of the unsolved words {sorted(unsolved)}")
    if tactical_rule == "warm":
        warm = {hole.number for hole in _warm_holes(referee, policy)}
        if target not in warm:
            raise ValueError(f"warm rule target must be one of {sorted(warm)}")

    family = payload.get("family")
    if (
        not isinstance(family, str)
        or not family.strip()
        or len(family.strip()) > 40
        or "\n" in family
        or "\r" in family
    ):
        raise ValueError("family must be a non-empty label of at most 40 characters")
    family = family.strip()
    family_slug = slug(family)
    if not family_slug:
        raise ValueError("family must contain letters")
    if tactical_rule == "stall" and last_family == family_slug:
        raise ValueError("stall rule requires a different semantic family")

    guess = payload.get("guess")
    if not isinstance(guess, str):
        raise ValueError("guess must be a string")
    guess = guess.strip()
    if parse_single_word(guess) != guess:
        raise ValueError("guess must be exactly one word with no punctuation")
    folded = slug(guess)
    if folded not in referee.vocab:
        raise ValueError(f"guess {guess!r} is not in the game vocabulary")
    if folded in referee.tried:
        raise ValueError(f"guess {guess!r} was already tried")

    return {
        "guess": guess,
        "rule": rule,
        "mode": mode,
        "target": target,
        "family": family,
    }


def play_policy_puzzle(
    puzzle: dict[str, Any],
    vocab: set[str],
    model_reply: Callable[[list[dict[str, str]]], str],
    *,
    policy: dict[str, Any],
    cap: int,
    on_try: Callable[[TryProgress], None] | None = None,
    on_policy_attempt: Callable[[dict[str, Any]], None] | None = None,
    verbatim_guidance: str | None = None,
) -> PolicyRunResult:
    """Play with bounded, pre-score policy validation and auditable decisions."""
    if not isinstance(cap, int) or isinstance(cap, bool) or cap <= 0:
        raise ValueError("cap must be a positive integer")
    policy = sp.validate_policy(policy)
    referee = PuzzleReferee(puzzle, vocab)
    if referee.solved:
        raise ValueError("puzzle starts solved; no benchmark can be played")
    messages = [
        {
            "role": "user",
            "content": policy_opening_message(
                referee, policy, verbatim_guidance=verbatim_guidance
            ),
        }
    ]
    attempts: list[dict[str, Any]] = []
    usages: list[dict[str, Any]] = []
    turns = 0
    attempts_this_try = 0
    last_family: str | None = None
    correcting = False
    warm_followups = 0
    required_rule = active_policy_rule(
        referee, policy, warm_followups=warm_followups
    )
    started = time.monotonic()

    def finish(reason: str, tries: int | None) -> PolicyRunResult:
        return PolicyRunResult(
            tries=tries,
            counted_tries=referee.tries,
            turns=turns,
            duration=time.monotonic() - started,
            tried_words=tuple(referee.tried_words),
            conversation=tuple(message.copy() for message in messages),
            turn_token_usage=tuple(usages),
            termination_reason=reason,
            policy_attempts=tuple(dict(attempt) for attempt in attempts),
        )

    while True:
        expected_rule = "invalid" if correcting else required_rule
        attempt_started = time.monotonic()
        raw_reply = model_reply([message.copy() for message in messages])
        usage = _last_token_usage(model_reply)
        attempt_duration = time.monotonic() - attempt_started
        if usage is not None:
            usages.append(usage)
        turns += 1
        raw_reply = raw_reply if isinstance(raw_reply, str) else ""
        messages.append(
            {"role": "assistant", "content": raw_reply.strip() or "[empty response]"}
        )
        decision: dict[str, Any] | None = None
        try:
            decision = parse_policy_decision(raw_reply)
            decision = validate_policy_decision(
                decision,
                referee,
                policy,
                expected_rule=expected_rule,
                tactical_rule=required_rule,
                last_family=last_family,
            )
        except ValueError as exc:
            attempts_this_try += 1
            attempt = {
                "turn": turns,
                "expected_rule": expected_rule,
                "tactical_rule": required_rule,
                "accepted": False,
                "error": str(exc),
                "decision": decision,
                "wall_duration": attempt_duration,
                "token_usage": usage,
                "warm_followups_before": warm_followups,
                "warm_followups_after": warm_followups,
            }
            attempts.append(attempt)
            if on_policy_attempt is not None:
                on_policy_attempt(dict(attempt))
            if attempts_this_try >= POLICY_MAX_ATTEMPTS_PER_TRY:
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "RUN TERMINATED: policy decision validation failed "
                            f"{POLICY_MAX_ATTEMPTS_PER_TRY} times before a guess "
                            "could be scored."
                        ),
                    }
                )
                return finish("policy_failure", None)
            correcting = True
            messages.append(
                {
                    "role": "user",
                    "content": policy_rejection_message(
                        str(exc),
                        referee,
                        policy,
                        required_rule=required_rule,
                        last_family=last_family,
                        warm_followups=warm_followups,
                    ),
                }
            )
            continue

        attempt = {
            "turn": turns,
            "expected_rule": expected_rule,
            "tactical_rule": required_rule,
            "accepted": True,
            "error": None,
            "decision": decision,
            "wall_duration": attempt_duration,
            "token_usage": usage,
            "warm_followups_before": warm_followups,
        }
        attempts.append(attempt)
        if on_policy_attempt is not None:
            on_policy_attempt(dict(attempt))
        attempts_this_try = 0
        correcting = False
        last_family = slug(decision["family"])

        # Validity and deduplication were checked above; submit is now guaranteed
        # to count. The policy controller never mutates game scoring semantics.
        feedback = referee.submit(decision["guess"])
        if feedback.kind != "counted":
            raise CurriculumError(
                "policy controller admitted a non-counting guess; this is a bug"
            )
        if on_try is not None:
            on_try(
                TryProgress(
                    number=feedback.tries,
                    word=decision["guess"],
                    progress=referee.progress,
                )
            )
        if required_rule == "warm":
            warm_followups += 1
        else:
            warm_followups = 0
        if not _warm_holes(referee, policy):
            warm_followups = 0
        attempt["warm_followups_after"] = warm_followups
        messages.append(
            {
                "role": "user",
                "content": policy_feedback_message(
                    feedback,
                    referee,
                    policy,
                    last_family=last_family,
                    warm_followups=warm_followups,
                ),
            }
        )
        if feedback.solved:
            return finish("solved", feedback.tries)
        if feedback.tries >= cap:
            return finish("cap", None)
        required_rule = active_policy_rule(
            referee, policy, warm_followups=warm_followups
        )


# --- Run records and derived stall metrics --------------------------------------


def derive_run_metrics(
    puzzle: dict[str, Any], vocab: set[str], tried_words: tuple[str, ...]
) -> dict[str, Any]:
    """Replay the run through the real referee and derive the issue's metrics."""
    referee = PuzzleReferee(puzzle, vocab)
    max_streak = 0
    non_improving = 0
    first_sub100_try: int | None = None
    guess_trace: list[dict[str, Any]] = []
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


def run_record(result: PolicyRunResult, metrics: dict[str, Any]) -> dict[str, Any]:
    accepted = sum(
        1 for attempt in result.policy_attempts if attempt["accepted"]
    )
    rejected = len(result.policy_attempts) - accepted
    return {
        "tries": result.tries,
        "counted_tries": result.counted_tries,
        "turns": result.turns,
        "duration": result.duration,
        "tried_words": list(result.tried_words),
        "conversation": [dict(m) for m in result.conversation],
        "turn_token_usage": list(result.turn_token_usage),
        "termination_reason": result.termination_reason,
        "policy_attempts": list(result.policy_attempts),
        "policy_compliance": {
            "accepted_decisions": accepted,
            "rejected_decisions": rejected,
            "first_pass_decisions": sum(
                1
                for attempt in result.policy_attempts
                if attempt["accepted"] and attempt["expected_rule"] != "invalid"
            ),
            "policy_failure": result.termination_reason == "policy_failure",
        },
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


def _policy_format_constraints() -> str:
    """Describe every validate_policy bound once for both fresh prose prompts."""
    return (
        "Every action must be a non-empty single-line string of at most "
        f"{sp.POLICY_MAX_ACTION_ITEM_CHARS} characters; all four actions together "
        f"may contain at most {sp.POLICY_MAX_ACTION_CHARS} characters. "
        f"stall.after must be an integer from 0 to {sp.POLICY_MAX_STALL_AFTER} "
        "(0 disables its standalone threshold). warm.rank_at_most must be an "
        f"integer from 0 to {sp.POLICY_MAX_WARM_RANK}, and "
        f"warm.max_followups must be an integer from 0 to "
        f"{sp.POLICY_MAX_WARM_FOLLOWUPS}; the two warm values must either both be "
        "0 (disabled) or both be positive."
    )


def retrospective_prompt(
    incoming: dict[str, Any],
    puzzle: dict[str, Any],
    records: list[dict[str, Any]],
) -> str:
    lines = [
        "You are reviewing your own play of one hidden-word puzzle.",
        "",
        "RETROSPECTIVE RULES",
        (
            "You played the 3 independent runs below with the same incoming "
            "policy. Diagnose outcomes and the recorded policy compliance, then write "
            "a REVISED four-rule policy for FUTURE, UNSEEN puzzles."
        ),
        (
            "Reply with a single JSON object and nothing else, shaped exactly as: "
            '{"analysis": {"worked_well": str, "wasted_attempt_patterns": str, '
            '"missed_evidence": str, "strategy_adherence": str, '
            '"run_comparison": str}, "revised_policy": {"always": '
            '{"action": str}, "stall": {"after": int, "action": str}, '
            '"warm": {"rank_at_most": int, "max_followups": int, '
            '"action": str}, "invalid": {"action": str}}}'
        ),
        _policy_format_constraints(),
        (
            "Each of the five analysis fields must be a non-empty string. The policy "
            "must be general and "
            "reusable on unseen puzzles; it REPLACES the previous policy. It must not "
            "quote the sentence and must not contain any target word, starting "
            "word, or guess from THIS puzzle."
        ),
        (
            "The controller, not the player, selects the active rule. always maps to "
            "explore; stall to pivot; warm to exploit; invalid to correct. Make each "
            "action short and executable under that fixed mode. Exhausting the warm "
            "follow-up budget hands control to stall even when stall.after is 0."
        ),
        "",
        "INCOMING POLICY",
        json.dumps(incoming, ensure_ascii=False, separators=(",", ":")),
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
                f" | policy accepted/rejected: "
                f"{record['policy_compliance']['accepted_decisions']}/"
                f"{record['policy_compliance']['rejected_decisions']}"
                f" | termination: {record['termination_reason']}"
            ),
            "authoritative replay trace: "
            + json.dumps(metrics["guess_trace"], ensure_ascii=False),
            "policy decision audit: "
            + json.dumps(
                [
                    {
                        "accepted": attempt["accepted"],
                        "expected_rule": attempt["expected_rule"],
                        "tactical_rule": attempt.get("tactical_rule"),
                        "error": attempt.get("error"),
                        "decision": attempt.get("decision"),
                        "warm_followups_before": attempt.get(
                            "warm_followups_before"
                        ),
                        "warm_followups_after": attempt.get(
                            "warm_followups_after"
                        ),
                    }
                    for attempt in record["policy_attempts"]
                ],
                ensure_ascii=False,
            ),
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


def validate_revised_policy(
    value: Any, puzzle: dict[str, Any], records: list[dict[str, Any]]
) -> dict[str, Any]:
    """Four-rule format plus target/start/guess/sentence leak rejection."""
    revised = sp.validate_policy(value)
    banned = _banned_slugs(puzzle, records)
    for item in sp.policy_actions(revised):
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
) -> tuple[dict[str, Any], dict[str, Any]]:
    if set(payload) != {"analysis", "revised_policy"}:
        raise ValueError(
            "retrospective must contain exactly analysis and revised_policy"
        )
    analysis = payload.get("analysis")
    if not isinstance(analysis, dict):
        raise ValueError('retrospective needs an "analysis" object')
    if set(analysis) != set(_ANALYSIS_KEYS):
        raise ValueError(
            "analysis must contain exactly: " + ", ".join(_ANALYSIS_KEYS)
        )
    if not all(
        isinstance(analysis[key], str) and analysis[key].strip()
        for key in _ANALYSIS_KEYS
    ):
        raise ValueError("every analysis field must be a non-empty string")
    analysis = {key: analysis[key].strip() for key in _ANALYSIS_KEYS}
    revised = validate_revised_policy(
        payload.get("revised_policy"), puzzle, records
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
                    "All schema, character-limit, and leak constraints "
                    "in the original request are hard validation requirements."
                ),
            ]
            length_match = re.fullmatch(
                r"policy is (\d+) action characters; the cap is (\d+)", str(exc)
            )
            if length_match:
                cap = int(length_match.group(2))
                target = min(STRUCTURED_POLICY_REPAIR_TARGET_CHARS, cap)
                repair_lines.append(
                    f"Rewrite the four policy actions to no more than {target} "
                    "characters "
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
            '{"comprehensive_summary": str, "final_policy": {"always": '
            '{"action": str}, "stall": {"after": int, "action": str}, '
            '"warm": {"rank_at_most": int, "max_followups": int, '
            '"action": str}, "invalid": {"action": str}}}.'
        ),
        (
            "comprehensive_summary must be a non-empty string. "
            + _policy_format_constraints()
        ),
        (
            "final_policy must be general and must not contain words from any "
            "specific puzzle."
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
            "revised policy after it: "
            + json.dumps(
                puzzle_state["retrospective"]["revised_policy"],
                ensure_ascii=False,
            ),
            "",
        ]
    return "\n".join(lines)


def validate_synthesis(
    payload: dict[str, Any], curriculum_puzzles: list[dict[str, Any]]
) -> tuple[str, dict[str, Any]]:
    if set(payload) != {"comprehensive_summary", "final_policy"}:
        raise ValueError(
            "synthesis must contain exactly comprehensive_summary and final_policy"
        )
    summary = payload.get("comprehensive_summary")
    if not isinstance(summary, str) or not summary.strip():
        raise ValueError('synthesis needs a non-empty "comprehensive_summary"')
    banned: set[str] = set()
    for puzzle in curriculum_puzzles:
        banned.update(_banned_slugs(puzzle, []))
    final = sp.validate_policy(payload.get("final_policy"))
    for item in sp.policy_actions(final):
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
        "policy_profile_schema_version": sp.PROFILE_SCHEMA_VERSION,
        "policy_decision_fields": list(POLICY_DECISION_KEYS),
        "policy_max_attempts_per_try": POLICY_MAX_ATTEMPTS_PER_TRY,
    }

    curriculum_records = [
        r for r in manifest["puzzles"] if r["split"] == "curriculum"
    ]
    holdout_records = [r for r in manifest["puzzles"] if r["split"] == "holdout"]
    frozen_v7 = v7_strategy if v7_strategy is not None else load_v7_strategy()

    if resume is not None:
        state = json.loads(resume.read_text(encoding="utf-8"))
        prior_prompt_version = state.get("config", {}).get(
            "curriculum_prompt_version"
        )
        if prior_prompt_version != CURRICULUM_PROMPT_VERSION:
            raise CurriculumError(
                "resume artifact uses curriculum prompt version "
                f"{prior_prompt_version!r}; prompt-v2 runs are readable pilot "
                "artifacts but cannot be resumed into policy-enforced prompt-v3. "
                "Start a new v3 artifact."
            )
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

    def fresh_decision_player():
        return provider_factory(
            config, api_key, effort=effort, auth=auth, output="decision"
        )

    def fresh_prose_caller():
        return provider_factory(
            config, api_key, effort=effort, auth=auth, output="prose"
        )

    def play_once(
        puzzle: dict[str, Any],
        policy: dict[str, Any],
        on_try: Callable[[TryProgress], None],
        on_policy_attempt: Callable[[dict[str, Any]], None],
        *,
        verbatim_guidance: str | None = None,
    ):
        started = time.monotonic()
        result = play_policy_puzzle(
            puzzle,
            vocab,
            fresh_decision_player(),
            policy=policy,
            cap=cap,
            on_try=on_try,
            on_policy_attempt=on_policy_attempt,
            verbatim_guidance=verbatim_guidance,
        )
        metrics = derive_run_metrics(puzzle, vocab, result.tried_words)
        record = run_record(result, metrics)
        record["wall_duration"] = time.monotonic() - started
        return record

    # --- Curriculum: 3 fresh plays, then one fresh retrospective, per puzzle.
    incoming = sp.neutral_policy()
    for puzzle_index, record in enumerate(curriculum_records):
        if puzzle_index < len(state["puzzles"]):
            puzzle_state = state["puzzles"][puzzle_index]
        else:
            puzzle_state = {
                "number": record["number"],
                "path": record["path"],
                "incoming_policy": incoming,
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
                puzzle_state["incoming_policy"],
                lambda progress: reporter.counted_try(
                    progress,
                    play_number=play_number,
                    phase="curriculum",
                    puzzle_number=record["number"],
                    run_number=run_number,
                ),
                lambda attempt: reporter.policy_attempt(
                    attempt,
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
                puzzle_state["incoming_policy"], puzzle, puzzle_state["runs"]
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
                "revised_policy": revised,
                "conversation": messages,
                "telemetry": telemetry,
            }
            save_artifact(artifact_path, state)
            reporter.retrospective_completed(
                retrospective_number=puzzle_index + 1,
                puzzle_number=record["number"],
                analysis=analysis,
                policy=revised,
            )

        # The revised policy REPLACES the previous one for the NEXT puzzle.
        incoming = puzzle_state["retrospective"]["revised_policy"]

    # --- Final synthesis: one fresh call over every retrospective.
    if state["synthesis"] is None:
        reporter.synthesis_started()
        curriculum_puzzles = [
            _load_puzzle(dataset_dir, record) for record in curriculum_records
        ]
        (summary, final_policy), messages, telemetry = structured_call(
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
            "final_policy": final_policy,
            "conversation": messages,
            "telemetry": telemetry,
        }
        save_artifact(artifact_path, state)
        reporter.synthesis_completed(summary, final_policy)

    final_policy = state["synthesis"]["final_policy"]

    # --- Holdout: frozen policies, three conditions, no retrospectives.
    condition_policies: dict[str, dict[str, Any]] = {
        "neutral": sp.neutral_policy(),
        "learned": final_policy,
        "v7": v7_controller_policy(),
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
                    condition_policies[condition],
                    lambda progress: reporter.counted_try(
                        progress,
                        play_number=play_number,
                        phase=phase,
                        puzzle_number=record["number"],
                        run_number=run_number,
                    ),
                    lambda attempt: reporter.policy_attempt(
                        attempt,
                        play_number=play_number,
                        phase=phase,
                        puzzle_number=record["number"],
                        run_number=run_number,
                    ),
                    verbatim_guidance=(frozen_v7 if condition == "v7" else None),
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
        final_policy=final_policy,
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


def _policy_compliance_summary(runs: list[dict[str, Any]]) -> dict[str, Any]:
    accepted = sum(
        run.get("policy_compliance", {}).get("accepted_decisions", 0)
        for run in runs
    )
    rejected = sum(
        run.get("policy_compliance", {}).get("rejected_decisions", 0)
        for run in runs
    )
    first_pass = sum(
        run.get("policy_compliance", {}).get("first_pass_decisions", 0)
        for run in runs
    )
    total = accepted + rejected
    return {
        "accepted_decisions": accepted,
        "rejected_decisions": rejected,
        "first_pass_decisions": first_pass,
        "accepted_rate": accepted / total if total else None,
        "first_pass_rate": first_pass / accepted if accepted else None,
        "policy_failure_runs": sum(
            run.get("termination_reason") == "policy_failure" for run in runs
        ),
    }


def evaluate_artifact(state: dict[str, Any]) -> dict[str, Any]:
    trend = [
        {
            "number": puzzle_state["number"],
            "median_tries": _median_tries(puzzle_state["runs"]),
            "dnf": sum(1 for r in puzzle_state["runs"] if r["tries"] is None),
            "policy_compliance": _policy_compliance_summary(
                puzzle_state["runs"]
            ),
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
            "policy_compliance": _policy_compliance_summary(
                [run for entry in entries for run in entry["runs"]]
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
        "final_policy": (state.get("synthesis") or {}).get("final_policy"),
        "legacy_final_strategy": (state.get("synthesis") or {}).get(
            "final_strategy"
        ),
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
    if (
        ("final_policy" in payload or "final_strategy" in payload)
        and "puzzles" not in payload
    ):
        sp.validate_profile(payload)
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    print(json.dumps(evaluate_artifact(payload), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
