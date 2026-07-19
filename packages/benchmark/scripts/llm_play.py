#!/usr/bin/env python3
"""Offline LLM benchmark player for one generated Whippin puzzle (#68).

The referee in this module deliberately owns no second copy of the game rules: guesses
are folded by ``slug.slug()``, existence comes from the exact vocab JSON fetched by the
SPA, and each counted guess is broadcast across every unsolved puzzle rank map. Provider
SDKs are imported lazily so the pure referee can be tested with a scripted fake without
network access (or even the paid SDK dependencies installed).
"""

from __future__ import annotations

import argparse
import asyncio
from collections.abc import Callable, Iterable, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import importlib
import inspect
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any, Literal, TypedDict

SCRIPT_DIR = Path(__file__).resolve().parent
BENCHMARK_DIR = SCRIPT_DIR.parent
REPO_ROOT = BENCHMARK_DIR.parent.parent
GENERATION_DIR = REPO_ROOT / "packages" / "generation"
GENERATION_SCRIPTS_DIR = GENERATION_DIR / "scripts"
WEB_VOCAB_DIR = REPO_ROOT / "packages" / "web" / "public" / "vocab"
BENCHMARK_OUTPUT_DIR = BENCHMARK_DIR / "output"

# Reuse generation's stdlib-only implementation so the benchmark never grows a second
# copy of the slug/fold contract.
sys.path.insert(0, str(GENERATION_SCRIPTS_DIR))
from slug import slug  # noqa: E402


# Curator-editable benchmark roster. Exactly three `display` entries ship in the puzzle;
# the rest remain available for unpublished lab comparisons. Full labels are honest model
# family names for the solved screen, while tags are compact pixel-friendly strip forms.
MODELS = [
    {
        "provider": "anthropic",
        "model_id": "claude-opus-4-8",
        "label": "CLAUDE OPUS",
        "tag": "OPUS",
        "display": True,
    },
    {
        "provider": "anthropic",
        "model_id": "claude-sonnet-5",
        "label": "CLAUDE SONNET",
        "tag": "SONNET",
        "display": True,
    },
    {
        "provider": "openai",
        "model_id": "gpt-5.6-sol",
        "label": "GPT-5.6",
        "tag": "GPT",
        "display": True,
    },
    {
        "provider": "openai",
        "model_id": "gpt-5.6-terra",
        "label": "GPT-5.6 TERRA",
        "tag": "TERRA",
        "display": False,
    },
    {
        "provider": "openai",
        "model_id": "gpt-5.6-luna",
        "label": "GPT-5.6 LUNA",
        "tag": "LUNA",
        "display": False,
    },
    {
        "provider": "anthropic",
        "model_id": "claude-fable-5",
        "label": "CLAUDE FABLE",
        "tag": "FABLE",
        "display": False,
    },
    {
        "provider": "kimi",
        "model_id": "k3",
        "label": "KIMI K3",
        "tag": "KIMI",
        "display": False,
    },
]
DISPLAY_MODEL_COUNT = 3

# Bump whenever the opening rules or turn-feedback scaffold changes materially. Results
# are attributable to a model id plus this prompt version and the CLI's printed effort.
PROMPT_VERSION = "23"

DEFAULT_CAP = 300
DEFAULT_RUNS = 7
DEFAULT_KIMI_RUNS = 1
SessionMode = Literal["persistent", "stateless"]
SESSION_MODES: tuple[SessionMode, ...] = ("persistent", "stateless")
DEFAULT_SESSION: SessionMode = "persistent"
SelectionMode = Literal["median", "best"]
SELECTION_MODES: tuple[SelectionMode, ...] = ("median", "best")
DEFAULT_SELECTION: SelectionMode = "median"
MAX_CONSECUTIVE_UNPARSEABLE = 5
MAX_NONCOUNTING_REPLIES = 5
TOKEN_USAGE_SCHEMA_VERSION = 1

# One cross-provider reasoning control. `none` preserves the original cheap one-word
# requests; the other levels enable provider-native reasoning with enough output room for
# hidden thinking plus the visible guess. OpenAI recommends starting with 25k tokens for
# reasoning workloads, while providers recommend more headroom at xhigh/max.
ReasoningEffort = Literal[
    "none", "low", "medium", "high", "xhigh", "max", "ultra"
]
EFFORT_LEVELS: tuple[ReasoningEffort, ...] = (
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
)
ALL_REASONING_EFFORTS: tuple[ReasoningEffort, ...] = (*EFFORT_LEVELS, "ultra")
DEFAULT_EFFORT: ReasoningEffort = "none"
DIRECT_OUTPUT_MAX_TOKENS = 256
REASONING_MAX_TOKENS = 25_000
DEEP_REASONING_MAX_TOKENS = 64_000
# Output budgets for structured decisions and long-form analysis calls.
# The ordinary benchmark stays in one-word mode; every adapter mode is an explicit
# construction-time choice and is never inferred from message counts.
DECISION_OUTPUT_MAX_TOKENS = 512
PROSE_OUTPUT_MAX_TOKENS = 8_192
OutputMode = Literal["word", "decision", "prose"]
MedianPruneReason = Literal["upper_half", "dnf_majority"]
MEDIAN_PRUNE_REASONS: tuple[MedianPruneReason, ...] = (
    "upper_half",
    "dnf_majority",
)
RunTermination = Literal[
    "solved",
    "cap",
    "cannot_beat_best",
    "upper_half",
    "dnf_majority",
    "reply_error",
]

AuthMode = Literal["api", "subscription"]
AUTH_MODES: tuple[AuthMode, ...] = ("api", "subscription")
DEFAULT_AUTH: AuthMode = "api"
CODEX_SUBSCRIPTION_EFFORTS: tuple[ReasoningEffort, ...] = (
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
)
# GPT-5.6 documents max effort and an independent Pro reasoning mode. `ultra` is a
# Codex-plan control, not a Responses API wire value.
OPENAI_API_EFFORTS: tuple[ReasoningEffort, ...] = (
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
)
ANTHROPIC_EFFORTS: tuple[ReasoningEffort, ...] = (
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
)
KIMI_EFFORTS: tuple[ReasoningEffort, ...] = (
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
)
KIMI_EFFORT_MAP: dict[ReasoningEffort, ReasoningEffort] = {
    "low": "low",
    "medium": "high",
    "high": "high",
    "xhigh": "max",
    "max": "max",
    "ultra": "max",
}
ReasoningMode = Literal["standard", "pro"]

# A subscription run must never inherit a developer-platform credential or cloud
# provider override: Claude Code gives environment credentials precedence over the
# logged-in Claude.ai plan. Temporarily removing these also keeps the auth preflight and
# the Agent SDK subprocess on the same first-party subscription route.
SUBSCRIPTION_CONFLICT_ENV = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "KIMI_CODE_API_KEY",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
)

KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/"
# Kimi runs use the Claude Agent SDK transport, but they must inherit neither the
# user's Claude.ai credentials/config nor a parent model/endpoint override. The
# dedicated Kimi key is captured first, removed while the SDK builds its child
# environment, and injected into that child only under the Anthropic-compatible names.
KIMI_SUBPROCESS_CONFLICT_ENV = (
    *SUBSCRIPTION_CONFLICT_ENV,
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    "CLAUDE_CODE_SUBAGENT_MODEL",
)
KIMI_AGENT_SDK_REQUIRED_OPTIONS = frozenset(
    {
        "model",
        "system_prompt",
        "tools",
        "allowed_tools",
        "mcp_servers",
        "strict_mcp_config",
        "permission_mode",
        "setting_sources",
        "skills",
        "agents",
        "plugins",
        "settings",
        "fallback_model",
        "cwd",
        "env",
        "resume",
        "max_turns",
        "thinking",
        "effort",
        "extra_args",
    }
)

# `CODEX_API_KEY` overrides saved CLI auth for one `codex exec` invocation. Strip it,
# the dedicated Kimi key, every other OpenAI/Azure API route, and the parent Codex thread
# metadata so a plan run can only use the separately persisted ChatGPT login in CODEX_HOME.
OPENAI_SUBSCRIPTION_CONFLICT_ENV = (
    "OPENAI_API_KEY",
    "KIMI_CODE_API_KEY",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT_ID",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_AD_TOKEN",
    "CODEX_THREAD_ID",
    "CODEX_CI",
)

CODEX_TURN_TIMEOUT_SECONDS = 300
CODEX_PROSE_TIMEOUT_SECONDS = 1_800
CODEX_BENCHMARK_INSTRUCTIONS = (
    "You are an isolated word-game player. Treat the user's complete rules and "
    "complete chronological game record as your only task context. Never inspect "
    "files, use tools, search, or modify anything. Follow the visible-reply contract "
    "in the user prompt exactly; do not add any other text."
)
# Prose mode gives offline analysis/distillation calls full-text answers.
CODEX_PROSE_INSTRUCTIONS = (
    "You are an isolated game analyst. Treat the user's complete message as your only "
    "task context. Never inspect files, use tools, search, or modify anything. Answer "
    "the final user message fully, in the exact format it requests."
)
CODEX_DECISION_INSTRUCTIONS = (
    "You are an isolated word-game player under an auditable policy controller. "
    "Treat the user's complete game snapshot as your only task context. Never inspect "
    "files, use tools, search, or modify anything. Reply to the final user message "
    "with only the exact JSON decision object it requests."
)
# Fail-closed request-surface guard (#93 isolation contract): the only legitimate
# stream items are the model's private reasoning and its final visible message. Every
# other item type — a tool call, a plan update (`update_plan`), a user-input request
# (`request_user_input`), an image view (`view_image`), a plugin action, or any
# capability a future CLI adds — is rejected, so a persistent thread cannot silently
# accrue hidden state that leaks across guesses and contaminates the benchmark. An
# allowlist stays safe as the CLI grows new item types; a denylist would not.
CODEX_ALLOWED_ITEM_TYPES = {"agent_message", "reasoning"}

PROVIDER_ENV = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "kimi": "KIMI_CODE_API_KEY",
}

MODEL_LABEL_RE = re.compile(r"^[A-Z0-9][A-Z0-9 .-]*$")
MODEL_TAG_RE = re.compile(r"^[A-Z0-9][A-Z0-9 -]{0,5}$")

LANGUAGE_NAMES = {"en": "English", "fr": "French"}


class ModelConfig(TypedDict):
    provider: str
    model_id: str
    label: str
    tag: str
    display: bool


class TokenUsage(TypedDict):
    """Provider-neutral accounting for exactly one model request or an aggregate."""

    # Input includes cached reads and cache writes. The two cache fields are subsets,
    # matching OpenAI/Codex semantics while Anthropic/Kimi are converted at the edge.
    input_tokens: int
    cached_input_tokens: int
    cache_write_input_tokens: int
    # Output includes reasoning. A provider that does not expose the reasoning
    # breakdown reports null rather than falsely claiming zero reasoning tokens.
    output_tokens: int
    reasoning_output_tokens: int | None
    total_tokens: int


Message = dict[str, str]
ModelReply = Callable[[list[Message]], str]


@dataclass
class RuntimeHole:
    number: int
    pos: int
    secret_slug: str
    word: str
    rank: int
    start_rank: int
    prefix: str
    suffix: str
    rank_map: dict[str, Any]


@dataclass(frozen=True)
class HoleOutcome:
    number: int
    rank: int | None
    improved: bool
    solved: bool


@dataclass(frozen=True)
class GuessFeedback:
    kind: str  # invalid | duplicate | counted
    guess: str
    folded: str
    message: str
    outcomes: tuple[HoleOutcome, ...]
    tries: int
    solved: bool


@dataclass(frozen=True)
class TryProgress:
    number: int
    word: str
    progress: float
    token_usage: TokenUsage | None


@dataclass(frozen=True)
class RunResult:
    # None is never embedded for a cost-pruned run. `termination` distinguishes those
    # censored attempts from genuine cap DNFs.
    tries: int | None
    counted_tries: int
    turns: int
    duration: float
    tried_words: tuple[str, ...]
    conversation: tuple[Message, ...]
    turn_token_usage: tuple[TokenUsage, ...]
    termination: RunTermination
    # Raw payloads remain local audit evidence. In particular, persistent Codex CLI
    # payloads are cumulative thread snapshots, not per-turn values.
    raw_provider_token_usage: tuple[dict[str, Any], ...] = ()


MedianPrunePredicate = Callable[[int], MedianPruneReason | None]


@dataclass(frozen=True)
class ModelSummary:
    config: ModelConfig
    results: tuple[RunResult, ...]
    selection: SelectionMode
    selected_run_index: int

    @property
    def selected_run(self) -> RunResult:
        return self.results[self.selected_run_index]

    @property
    def tries(self) -> int | None:
        return self.selected_run.tries

    @property
    def turns(self) -> int:
        return sum(result.turns for result in self.results)

    @property
    def duration(self) -> float:
        return sum(result.duration for result in self.results)

    @property
    def runs(self) -> int:
        return len(self.results)

    @property
    def run_tried_words(self) -> tuple[tuple[str, ...], ...]:
        return tuple(result.tried_words for result in self.results)

    def benchmark_entry(self) -> dict[str, Any]:
        if self.selected_run.termination not in ("solved", "cap"):
            raise ValueError(
                "an incomplete or cost-pruned run cannot be embedded"
            )
        return {
            "model": self.config["model_id"],
            "label": self.config["label"],
            "tag": self.config["tag"],
            "tries": self.tries,
            "run": list(self.selected_run.tried_words),
        }


class IncompleteRunError(RuntimeError):
    """A bounded reply failure with the paid run prefix preserved for audit."""

    def __init__(self, message: str, partial_result: RunResult | None = None):
        super().__init__(message)
        self.partial_result = partial_result


class UnparseableReplyError(IncompleteRunError):
    """A model failed to produce any parseable word five turns in a row."""


class NoProgressReplyError(IncompleteRunError):
    """A model produced too many parsed replies without a counted try."""


TryReporter = Callable[[TryProgress], None]
ModelTryReporter = Callable[[int, TryProgress], None]


@contextmanager
def _temporary_environment_without(names: Iterable[str]):
    """Remove selected inherited variables and restore their exact prior state."""
    blocked = tuple(names)
    saved = {
        name: os.environ.pop(name)
        for name in blocked
        if name in os.environ
    }
    try:
        yield
    finally:
        for name in blocked:
            os.environ.pop(name, None)
        os.environ.update(saved)


def validate_anthropic_subscription_auth() -> str:
    """Refuse a subscription run unless Claude Code confirms paid Claude.ai auth."""
    cli = shutil.which("claude")
    if cli is None:
        raise RuntimeError(
            "Claude Code is not installed; install it, run `claude`, and log in "
            "with the paid Claude.ai account"
        )
    env = {
        name: value
        for name, value in os.environ.items()
        if name not in SUBSCRIPTION_CONFLICT_ENV
    }
    try:
        completed = subprocess.run(
            [cli, "auth", "status", "--json"],
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
            env=env,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(
            f"could not inspect Claude Code authentication: {exc}"
        ) from exc
    if completed.returncode != 0:
        raise RuntimeError(
            "Claude Code authentication could not be verified; run `claude` and log "
            "in with the paid Claude.ai account"
        )
    try:
        status = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            "Claude Code returned malformed authentication status"
        ) from exc
    subscription = status.get("subscriptionType")
    if (
        status.get("loggedIn") is not True
        or status.get("authMethod") != "claude.ai"
        or not isinstance(subscription, str)
        or not subscription
        or subscription.lower() == "free"
    ):
        raise RuntimeError(
            "Claude Code is not using a paid Claude.ai subscription; run `claude`, "
            "use `/login`, and select the subscription account"
        )
    return subscription


def _environment_without(names: Iterable[str]) -> dict[str, str]:
    blocked = set(names)
    return {name: value for name, value in os.environ.items() if name not in blocked}


def validate_openai_subscription_auth() -> str:
    """Refuse a plan run unless Codex CLI confirms saved ChatGPT authentication."""
    cli = shutil.which("codex")
    if cli is None:
        raise RuntimeError(
            "Codex CLI is not installed; install it, run `codex login`, and sign in "
            "with the ChatGPT account that owns the Codex plan"
        )
    try:
        completed = subprocess.run(
            [cli, "login", "status"],
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
            env=_environment_without(OPENAI_SUBSCRIPTION_CONFLICT_ENV),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(
            f"could not inspect Codex CLI authentication: {exc}"
        ) from exc
    status_lines = (completed.stdout + "\n" + completed.stderr).splitlines()
    if completed.returncode != 0 or not any(
        line.strip() == "Logged in using ChatGPT" for line in status_lines
    ):
        raise RuntimeError(
            "Codex CLI is not using ChatGPT subscription auth; run `codex logout`, "
            "then `codex login` and choose ChatGPT"
        )
    return "ChatGPT"


def _load_kimi_agent_sdk() -> Any:
    try:
        sdk = importlib.import_module("claude_agent_sdk")
    except (ImportError, ModuleNotFoundError) as exc:
        raise RuntimeError(
            "Kimi Code transport requires claude-agent-sdk; sync the benchmark "
            "workspace dependencies before retrying"
        ) from exc

    options_type = getattr(sdk, "ClaudeAgentOptions", None)
    query = getattr(sdk, "query", None)
    result_type = getattr(sdk, "ResultMessage", None)
    if options_type is None or not callable(query) or result_type is None:
        raise RuntimeError(
            "installed claude-agent-sdk does not expose the Agent SDK transport "
            "required for isolated Kimi Code runs"
        )
    try:
        parameters = inspect.signature(options_type).parameters
    except (TypeError, ValueError) as exc:
        raise RuntimeError(
            "could not verify claude-agent-sdk isolation capabilities for Kimi Code"
        ) from exc
    accepts_kwargs = any(
        parameter.kind is inspect.Parameter.VAR_KEYWORD
        for parameter in parameters.values()
    )
    missing = (
        set()
        if accepts_kwargs
        else KIMI_AGENT_SDK_REQUIRED_OPTIONS.difference(parameters)
    )
    if missing:
        names = ", ".join(sorted(missing))
        raise RuntimeError(
            "installed claude-agent-sdk is too old for an isolated Kimi Code "
            f"transport (missing options: {names})"
        )

    module_file = getattr(sdk, "__file__", None)
    bundled_cli = None
    if isinstance(module_file, str):
        bundled_dir = Path(module_file).resolve().parent / "_bundled"
        bundled_cli = next(
            (
                path
                for path in (bundled_dir / "claude", bundled_dir / "claude.exe")
                if path.is_file()
            ),
            None,
        )
    cli = str(bundled_cli) if bundled_cli is not None else shutil.which("claude")
    if cli is None:
        raise RuntimeError(
            "Kimi Code transport requires the Claude Code CLI bundled with "
            "claude-agent-sdk (or an installed compatible `claude` executable)"
        )
    try:
        completed = subprocess.run(
            [cli, "--help"],
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
            env=_environment_without(KIMI_SUBPROCESS_CONFLICT_ENV),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(
            f"could not verify the Claude Code CLI used by the Kimi transport: {exc}"
        ) from exc
    required_flags = {
        "--bare",
        "--disable-slash-commands",
        "--effort",
        "--no-session-persistence",
        "--setting-sources",
        "--strict-mcp-config",
        "--tools",
    }
    missing_flags = required_flags.difference(completed.stdout.split())
    if completed.returncode != 0 or missing_flags:
        suffix = (
            f" (missing flags: {', '.join(sorted(missing_flags))})"
            if missing_flags
            else ""
        )
        raise RuntimeError(
            "installed Claude Code CLI is unsupported for isolated Kimi Code runs"
            f"{suffix}"
        )
    return sdk


def validate_kimi_subscription_auth(api_key: str | None) -> str:
    """Validate Kimi's dedicated credential and zero-tool Agent SDK dependency."""
    if not isinstance(api_key, str) or not api_key.strip():
        raise RuntimeError(
            "Kimi K3 subscription auth requires KIMI_CODE_API_KEY from the "
            "Kimi Code Console"
        )
    _load_kimi_agent_sdk()
    return "Kimi Code"


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _as_record(value: object, description: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"malformed puzzle: {description} must be an object")
    return value


def _json_token_usage(value: object) -> dict[str, Any] | None:
    """Preserve provider token accounting as JSON without coupling to SDK classes."""
    if value is None:
        return None
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        value = model_dump(exclude_none=True)
    if not isinstance(value, Mapping):
        return None

    def normalize(item: object) -> Any:
        nested_dump = getattr(item, "model_dump", None)
        if callable(nested_dump):
            item = nested_dump(exclude_none=True)
        if isinstance(item, Mapping):
            return {
                str(key): normalize(nested)
                for key, nested in item.items()
                if nested is not None
            }
        if isinstance(item, Sequence) and not isinstance(item, (str, bytes)):
            return [normalize(nested) for nested in item]
        if item is None or isinstance(item, (str, int, float, bool)):
            return item
        return str(item)

    normalized = normalize(value)
    return normalized if isinstance(normalized, dict) and normalized else None


def _token_count(
    usage: Mapping[str, Any], key: str, *, default: int = 0
) -> int:
    value = usage.get(key)
    if value is None:
        return default
    if not _is_int(value) or value < 0:
        raise ValueError(
            f"malformed token usage: {key!r} must be a non-negative integer"
        )
    return value


def _nested_token_count(
    usage: Mapping[str, Any], parent: str, key: str
) -> int | None:
    details = usage.get(parent)
    if details is None:
        return None
    if not isinstance(details, Mapping):
        raise ValueError(
            f"malformed token usage: {parent!r} must be an object"
        )
    if details.get(key) is None:
        return None
    return _token_count(details, key)


def _canonical_token_usage(
    *,
    input_tokens: int,
    cached_input_tokens: int = 0,
    cache_write_input_tokens: int = 0,
    output_tokens: int,
    reasoning_output_tokens: int | None = None,
) -> TokenUsage:
    counts = {
        "input_tokens": input_tokens,
        "cached_input_tokens": cached_input_tokens,
        "cache_write_input_tokens": cache_write_input_tokens,
        "output_tokens": output_tokens,
    }
    for key, value in counts.items():
        if not _is_int(value) or value < 0:
            raise ValueError(
                f"malformed token usage: {key!r} must be a non-negative integer"
            )
    if reasoning_output_tokens is not None and (
        not _is_int(reasoning_output_tokens) or reasoning_output_tokens < 0
    ):
        raise ValueError(
            "malformed token usage: 'reasoning_output_tokens' must be null or "
            "a non-negative integer"
        )
    if cached_input_tokens > input_tokens:
        raise ValueError(
            "malformed token usage: cached input exceeds total input"
        )
    if cache_write_input_tokens > input_tokens:
        raise ValueError(
            "malformed token usage: cache-write input exceeds total input"
        )
    if (
        reasoning_output_tokens is not None
        and reasoning_output_tokens > output_tokens
    ):
        raise ValueError(
            "malformed token usage: reasoning output exceeds total output"
        )
    return {
        "input_tokens": input_tokens,
        "cached_input_tokens": cached_input_tokens,
        "cache_write_input_tokens": cache_write_input_tokens,
        "output_tokens": output_tokens,
        "reasoning_output_tokens": reasoning_output_tokens,
        "total_tokens": input_tokens + output_tokens,
    }


def _standard_token_usage(value: object) -> TokenUsage | None:
    """Validate/fill the fixed schema already emitted by a provider adapter."""
    usage = _json_token_usage(value)
    if usage is None or not any(
        key in usage for key in ("input_tokens", "output_tokens")
    ):
        return None
    reasoning = usage.get("reasoning_output_tokens")
    if reasoning is not None and (not _is_int(reasoning) or reasoning < 0):
        raise ValueError(
            "malformed token usage: 'reasoning_output_tokens' must be null or "
            "a non-negative integer"
        )
    return _canonical_token_usage(
        input_tokens=_token_count(usage, "input_tokens"),
        cached_input_tokens=_token_count(usage, "cached_input_tokens"),
        cache_write_input_tokens=_token_count(
            usage, "cache_write_input_tokens"
        ),
        output_tokens=_token_count(usage, "output_tokens"),
        reasoning_output_tokens=reasoning,
    )


def _normalize_anthropic_token_usage(value: object) -> TokenUsage | None:
    """Convert Anthropic/Agent-SDK cache categories into inclusive input totals."""
    usage = _json_token_usage(value)
    if usage is None or not any(
        key in usage
        for key in (
            "input_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
            "output_tokens",
        )
    ):
        return None
    fresh_input = _token_count(usage, "input_tokens")
    cached_input = _token_count(usage, "cache_read_input_tokens")
    cache_write_input = _token_count(
        usage, "cache_creation_input_tokens"
    )
    reasoning = _nested_token_count(
        usage, "output_tokens_details", "thinking_tokens"
    )
    return _canonical_token_usage(
        input_tokens=fresh_input + cached_input + cache_write_input,
        cached_input_tokens=cached_input,
        cache_write_input_tokens=cache_write_input,
        output_tokens=_token_count(usage, "output_tokens"),
        reasoning_output_tokens=reasoning,
    )


def _normalize_openai_token_usage(value: object) -> TokenUsage | None:
    """Convert Responses/Codex usage, whose input count already includes cache."""
    usage = _json_token_usage(value)
    if usage is None or not any(
        key in usage for key in ("input_tokens", "output_tokens")
    ):
        return None
    cached_input = (
        _token_count(usage, "cached_input_tokens")
        if usage.get("cached_input_tokens") is not None
        else _nested_token_count(
            usage, "input_tokens_details", "cached_tokens"
        )
        or 0
    )
    cache_write_input = (
        _token_count(usage, "cache_write_input_tokens")
        if usage.get("cache_write_input_tokens") is not None
        else _nested_token_count(
            usage, "input_tokens_details", "cache_write_tokens"
        )
        or 0
    )
    if usage.get("reasoning_output_tokens") is not None:
        reasoning: int | None = _token_count(
            usage, "reasoning_output_tokens"
        )
    else:
        reasoning = _nested_token_count(
            usage, "output_tokens_details", "reasoning_tokens"
        )
    return _canonical_token_usage(
        input_tokens=_token_count(usage, "input_tokens"),
        cached_input_tokens=cached_input,
        cache_write_input_tokens=cache_write_input,
        output_tokens=_token_count(usage, "output_tokens"),
        reasoning_output_tokens=reasoning,
    )


def _cumulative_token_usage_delta(
    current: TokenUsage, previous: TokenUsage | None
) -> TokenUsage:
    """Turn a persistent Codex cumulative snapshot into exactly one turn's usage."""
    if previous is None:
        return current

    def delta(key: str) -> int:
        current_value = current[key]
        previous_value = previous[key]
        if not _is_int(current_value) or not _is_int(previous_value):
            raise ValueError(
                f"malformed cumulative token usage counter: {key}"
            )
        difference = current_value - previous_value
        if difference < 0:
            raise RuntimeError(
                "Codex CLI cumulative token usage decreased within one saved "
                f"thread ({key}: {current_value} < {previous_value})"
            )
        return difference

    current_reasoning = current["reasoning_output_tokens"]
    previous_reasoning = previous["reasoning_output_tokens"]
    if current_reasoning is None or previous_reasoning is None:
        reasoning: int | None = None
    else:
        reasoning = current_reasoning - previous_reasoning
        if reasoning < 0:
            raise RuntimeError(
                "Codex CLI cumulative token usage decreased within one saved "
                "thread (reasoning_output_tokens)"
            )
    return _canonical_token_usage(
        input_tokens=delta("input_tokens"),
        cached_input_tokens=delta("cached_input_tokens"),
        cache_write_input_tokens=delta("cache_write_input_tokens"),
        output_tokens=delta("output_tokens"),
        reasoning_output_tokens=reasoning,
    )


def _last_token_usage(model_reply: ModelReply) -> TokenUsage | None:
    return _standard_token_usage(
        getattr(model_reply, "last_token_usage", None)
    )


def _last_raw_token_usage(model_reply: ModelReply) -> dict[str, Any] | None:
    return _json_token_usage(
        getattr(model_reply, "last_raw_token_usage", None)
    )


class PuzzleReferee:
    """Mutable replay of the browser's guess loop for one puzzle."""

    def __init__(self, puzzle: dict[str, Any], vocab: Iterable[str]):
        lang = puzzle.get("lang")
        words = puzzle.get("words")
        holes = puzzle.get("holes")
        ranks = puzzle.get("ranks")
        if not isinstance(lang, str):
            raise ValueError('malformed puzzle: missing string "lang"')
        if not isinstance(words, list) or not all(
            isinstance(word, str) for word in words
        ):
            raise ValueError('malformed puzzle: "words" must be an array of strings')
        if not isinstance(holes, list) or not holes:
            raise ValueError('malformed puzzle: "holes" must be a non-empty array')
        ranks_record = _as_record(ranks, '"ranks"')

        self.lang = lang
        self.words = list(words)
        # CLI loading already returns a set; reuse that immutable existence view across
        # every provider/run instead of copying hundreds of thousands of slugs each time.
        self.vocab = vocab if isinstance(vocab, set) else set(vocab)
        self.tried: set[str] = set()
        self.tried_words: list[str] = []
        # Parsed words outside the fixed vocabulary do not count, but keeping their
        # folded forms in the authoritative snapshot prevents any transport from paying
        # repeatedly for the same rejected answer.
        self.rejected_words: dict[str, str] = {}
        self.holes: list[RuntimeHole] = []
        # Consecutive counted tries that improved no hole's rank (MISS or warm-but-not-
        # closer). This is reported as evidence, not used to force a solving method.
        # Any improvement resets it; non-counting replies leave it untouched.
        self.stalled_tries = 0

        # The schema guarantees sentence order, but sorting here makes the feedback order
        # robust and explicit: hole numbers always read left-to-right like the front.
        ordered_holes = sorted(
            (_as_record(hole, 'each "holes" entry') for hole in holes),
            key=lambda hole: hole.get("pos", -1),
        )
        for index, hole in enumerate(ordered_holes, start=1):
            pos = hole.get("pos")
            start_rank = hole.get("start_rank")
            secret = _as_record(hole.get("secret"), 'hole "secret"')
            start = _as_record(hole.get("start"), 'hole "start"')
            secret_slug = secret.get("slug")
            start_word = start.get("word")
            if not _is_int(pos) or not 0 <= pos < len(self.words):
                raise ValueError('malformed puzzle: hole "pos" is out of range')
            if not _is_int(start_rank) or start_rank < 0:
                raise ValueError(
                    'malformed puzzle: hole "start_rank" must be a non-negative integer'
                )
            if not isinstance(secret_slug, str) or not secret_slug:
                raise ValueError(
                    'malformed puzzle: hole secret needs a non-empty "slug"'
                )
            if not isinstance(start_word, str) or not start_word:
                raise ValueError(
                    'malformed puzzle: hole start needs a non-empty "word"'
                )
            prefix = hole.get("prefix", "")
            suffix = hole.get("suffix", "")
            if not isinstance(prefix, str) or not isinstance(suffix, str):
                raise ValueError(
                    'malformed puzzle: hole "prefix"/"suffix" must be strings'
                )
            rank_map = _as_record(
                ranks_record.get(secret_slug),
                f'"ranks" entry for secret "{secret_slug}"',
            )
            self.holes.append(
                RuntimeHole(
                    number=index,
                    pos=pos,
                    secret_slug=secret_slug,
                    word=start_word,
                    rank=start_rank,
                    start_rank=start_rank,
                    prefix=prefix,
                    suffix=suffix,
                    rank_map=rank_map,
                )
            )

    @property
    def tries(self) -> int:
        return len(self.tried)

    @property
    def solved(self) -> bool:
        return all(hole.rank == 0 for hole in self.holes)

    @property
    def progress(self) -> float:
        if not self.holes:
            return 0.0
        total = 0.0
        for hole in self.holes:
            vocab_size = len(hole.rank_map)
            scale = math.log(vocab_size + 1)
            start_score = 1 - math.log(hole.start_rank + 1) / scale
            denominator = 1 - start_score
            if denominator <= 0:
                hole_progress = 1.0 if hole.rank <= 0 else 0.0
            else:
                score = 1 - math.log(hole.rank + 1) / scale
                hole_progress = (score - start_score) / denominator
                hole_progress = max(0.0, min(1.0, hole_progress))
            total += hole_progress
        return 100 * total / len(self.holes)

    def cloze(self) -> str:
        """Render fixed sentence context without presenting guesses as sentence text."""
        rendered = list(self.words)
        for hole in self.holes:
            content = hole.word if hole.rank == 0 else f"[WORD {hole.number}]"
            rendered[hole.pos] = f"{hole.prefix}{content}{hole.suffix}"
        return " ".join(rendered)

    def best_clue_lines(self) -> list[str]:
        """Show only the current best rank for each unsolved word.

        Earlier words remain available in an unordered exclusion set, while only the
        latest outcome is repeated. Keeping the trajectory out of a semantic list avoids
        turning the state itself into an invitation to autocomplete the same cluster.
        """
        lines: list[str] = []
        for hole in self.holes:
            if hole.rank == 0:
                continue
            lines.append(f"WORD {hole.number}: {hole.word} (rank {hole.rank})")
        return lines or ["All hidden words are solved."]

    def submit(self, guess: str) -> GuessFeedback:
        folded = slug(guess)
        if folded not in self.vocab:
            self.rejected_words.setdefault(folded, guess)
            return GuessFeedback(
                kind="invalid",
                guess=guess,
                folded=folded,
                message=(
                    f'"{guess}" is not in the fixed game vocabulary — this did not '
                    "count and produced no rank feedback. Its reply format was valid, "
                    "but vocabulary membership was not."
                ),
                outcomes=(),
                tries=self.tries,
                solved=self.solved,
            )
        if folded in self.tried:
            return GuessFeedback(
                kind="duplicate",
                guess=guess,
                folded=folded,
                message=(
                    f'"{guess}" has the same folded lookup form as an already tried '
                    "word — this did not count and produced no rank feedback."
                ),
                outcomes=(),
                tries=self.tries,
                solved=self.solved,
            )

        self.tried.add(folded)
        self.tried_words.append(guess)
        outcomes: list[HoleOutcome] = []
        for hole in self.holes:
            # Solved holes are locked: they receive no feedback and can never regress.
            if hole.rank == 0:
                continue
            raw_entry = hole.rank_map.get(folded)
            if raw_entry is None:
                outcomes.append(HoleOutcome(hole.number, None, False, False))
                continue
            entry = _as_record(raw_entry, f'rank candidate "{folded}"')
            rank = entry.get("rank")
            word = entry.get("word")
            if not _is_int(rank) or rank < 0 or not isinstance(word, str):
                raise ValueError(
                    f'malformed puzzle: rank candidate "{folded}" needs word + non-negative rank'
                )
            improved = rank < hole.rank
            if improved:
                hole.word = word
                hole.rank = rank
            outcomes.append(
                HoleOutcome(hole.number, rank, improved, improved and rank == 0)
            )

        recorded_outcomes = tuple(outcomes)
        improved = any(outcome.improved for outcome in recorded_outcomes)
        if improved:
            self.stalled_tries = 0
        else:
            self.stalled_tries += 1

        return GuessFeedback(
            kind="counted",
            guess=guess,
            folded=folded,
            message="",
            outcomes=recorded_outcomes,
            tries=self.tries,
            solved=self.solved,
        )


# The model-channel grammar is deliberately narrower and more explicit than free-form
# browser input. It mirrors the token shapes admitted by generation's language wordlists:
# language letters, optionally joined by ordinary internal ASCII hyphens. The prompt states
# this grammar verbatim so a conforming model reply cannot fail parsing. Leading/trailing
# transport whitespace is harmless; everything else must be the word itself.
_REPLY_CHAR_CLASSES = {
    # The browser folds accents before its existence lookup for both languages. Accept
    # the same Latin display forms here, then let the shared slug/vocab contract decide
    # membership. This preserves parity for inputs such as an accented spelling of an
    # otherwise ASCII English lookup key.
    "en": "a-zàâäéèêëîïôöùûüÿçœæ",
    "fr": "a-zàâäéèêëîïôöùûüÿçœæ",
}
_REPLY_PATTERNS = {
    lang: re.compile(rf"[{chars}]+(?:-[{chars}]+)*")
    for lang, chars in _REPLY_CHAR_CLASSES.items()
}
_GENERIC_REPLY_PATTERN = re.compile(
    r"[^\W\d_]+(?:-[^\W\d_]+)*", re.UNICODE
)


def parse_single_word(reply: str, *, lang: str | None = None) -> str | None:
    candidate = reply.strip()
    pattern = _REPLY_PATTERNS.get(lang, _GENERIC_REPLY_PATTERN)
    return candidate if candidate and pattern.fullmatch(candidate) else None


def _reply_contract_lines(referee: PuzzleReferee, language: str) -> list[str]:
    if referee.lang == "fr":
        alphabet = (
            "lowercase a-z and the French letters à â ä é è ê ë î ï ô ö ù û ü "
            "ÿ ç œ æ"
        )
        clitic_rule = (
            "Apostrophes are forbidden. A French clitic plus lexical word (the shape "
            "s’+verb or l’+word) is multiple pieces here. A visible clitic/apostrophe "
            "beside [WORD N] is fixed context; submit only the hidden lexical core."
        )
    else:
        alphabet = (
            "lowercase a-z and Latin display variants à â ä é è ê ë î ï ô ö ù û ü "
            "ÿ ç œ æ, which lookup folds to ASCII"
        )
        clitic_rule = (
            "Apostrophes are forbidden. Text beside [WORD N], including a "
            "clitic/apostrophe, is fixed context; submit only the hidden lexical core."
        )
    return [
        (
            "Reason privately as needed; your entire visible reply "
            f"must be exactly one bare {language} game-vocabulary word. Use "
            f"permitted letters ({alphabet}) with "
            "optional ordinary ASCII hyphens (-); they cannot lead, trail, double, or "
            "be another dash character."
        ),
        (
            "The visible reply must contain no uppercase, spaces, straight/curly "
            "apostrophes, punctuation, quotes, Markdown, digits, underscores, labels, "
            "prose, or explanations; a multiword expression is not one reply."
        ),
        clitic_rule,
        (
            "Its folded form must exist in the fixed vocabulary. Use an established "
            f"standalone {language} dictionary content word, not an invented, "
            "concatenated, clitic-attached, single-letter, or excluded function form. "
            "Folding lowercases, expands œ/æ, removes accents, and keeps hyphens; equal "
            "folds are duplicates. Use normal accents."
        ),
        (
            "Malformed, outside-vocabulary, and duplicate replies give no ranks and do "
            f"not count. {MAX_CONSECUTIVE_UNPARSEABLE} consecutive malformed replies "
            f"end the run; {MAX_NONCOUNTING_REPLIES} parsed non-counting replies without "
            "a counted guess also end it. Rejected vocabulary forms persist; do not "
            "repeat them."
        ),
    ]


def _reply_reminder(referee: PuzzleReferee) -> str:
    # An affirmative multi-step-deduction cue in recency position: adaptive-thinking
    # transports skip reasoning on prompts that merely permit it, so the reminder must
    # assert that choosing the next word requires deliberation before the reply.
    language = LANGUAGE_NAMES.get(referee.lang, referee.lang)
    return (
        "Finding the next word takes multi-step deduction over the CLOZE, ranked "
        "clues, and exclusion sets; think it through carefully, then reply with "
        f"exactly one bare {language} game-vocabulary word: permitted lowercase "
        "letters, optional internal ASCII hyphens; no apostrophe, space, "
        "punctuation, formatting, or explanation."
    )


def _state_snapshot_lines(referee: PuzzleReferee) -> list[str]:
    tried = ", ".join(sorted(referee.tried_words, key=slug)) or "none"
    rejected = (
        ", ".join(sorted(referee.rejected_words.values(), key=slug)) or "none"
    )
    if referee.tries == 0:
        trend = "NO-IMPROVEMENT STREAK: 0. No counted guesses yet."
    elif referee.stalled_tries == 0:
        trend = (
            "NO-IMPROVEMENT STREAK: 0. The latest counted guess improved at "
            "least one word."
        )
    else:
        guess_unit = "guess" if referee.stalled_tries == 1 else "guesses"
        trend = (
            f"NO-IMPROVEMENT STREAK: {referee.stalled_tries}. The last "
            f"{referee.stalled_tries} counted {guess_unit} improved no word; all "
            "current best ranks stayed unchanged."
        )
    return [
        "CURRENT STATE",
        f"CLOZE: {referee.cloze()}",
        "CURRENT BEST RANKED CLUE PER UNSOLVED WORD — SEMANTIC EVIDENCE, "
        "NOT SENTENCE TEXT; ITS SHOWN RANK IS ALREADY KNOWN:",
        *referee.best_clue_lines(),
        trend,
        f"EXCLUDED AS ALREADY TRIED (unordered; do not repeat): {tried}",
        "REJECTED OUTSIDE VOCABULARY (unordered; did not count; do not repeat): "
        f"{rejected}",
    ]


def _rules_opening(
    referee: PuzzleReferee,
    language: str,
    strategy_section: list[str],
    *,
    cap: int,
) -> str:
    return "\n".join(
        [
            f"WHIPPIN AI — {language.upper()} WORD GAME",
            "",
            "OBJECTIVE AND SCORE",
            (
                "Solve every hidden word in as few counted tries as possible. "
                "Score counts unique valid guesses; every counted guess is expensive."
            ),
            (
                f"The limit is {cap} counted tries. Counted try {cap} succeeds if it "
                "solves every word; otherwise the run is DNF. The first reply is the "
                "first guess, not a plan."
            ),
            "",
            "MANDATORY REPLY CONTRACT",
            *_reply_contract_lines(referee, language),
            "",
            "CLOZE AND EXACT ANSWERS",
            (
                "The CLOZE is a real sentence. Each [WORD N] hides exactly one "
                "lexical core. Visible words, clitics, apostrophes, and punctuation are "
                "fixed context, not reply text; solved cores appear in place."
            ),
            (
                "The answer is the sentence's exact inflected form, not merely a lemma. "
                "Singular/plural, masculine/feminine, agreement, person, tense, mood, "
                "and conjugation can change it; folding preserves distinguishing letters."
            ),
            (
                "Starting and later ranked clues are semantic evidence, never proposed "
                "sentence text or answer reveals. They need not match grammar, number, "
                "gender, or exact meaning; the starting clue is uncounted."
            ),
            "",
            "GUESS AND RANK RULES",
            (
                "Any unique vocabulary-valid reply is legal and counts once even if it "
                "fits no blank or improves nothing. It is tested against every unsolved "
                "word; solved words are locked. One guess can produce different outcomes "
                "and improve or solve several words."
            ),
            (
                "For each word, rank 0 is exact; lower positive ranks are closer; MISS "
                "is outside its stored neighborhood. A valid MISS still counts. Only a "
                "strictly lower rank changes the best; equal, higher, and MISS do not. "
                "Rank 0 solves and locks the word."
            ),
            (
                "A displayed clue's rank is already known. Re-submitting it cannot "
                "improve that same WORD at an equal rank. Do not re-test it unless you "
                "expect it to improve a different unsolved WORD."
            ),
            (
                "Embedding ranks measure distributional contextual relatedness, not "
                "guaranteed synonymy, grammar, or implication. Only rank 0 certifies "
                "the exact word."
            ),
            "",
            "AUTHORITATIVE STATE",
            (
                "Every turn uses identical public evidence: rules, initial clues, every "
                "prior PLAYER REPLY and exact REFEREE outcome, and latest state. "
                "Transports may retain the conversation or reconstruct its record; "
                "neither adds hidden evidence."
            ),
            (
                "Any strict improvement resets the streak; non-counting leaves it "
                "unchanged."
            ),
            *strategy_section,
            "",
            "COMPLETE CHRONOLOGICAL GAME RECORD",
            *_state_snapshot_lines(referee),
            "Tries: 0 (your score — lower is better)",
            _reply_reminder(referee),
        ]
    )


def opening_message(
    referee: PuzzleReferee,
    strategy: str | None = None,
    *,
    rules_only: bool = False,
    cap: int = DEFAULT_CAP,
) -> str:
    language = LANGUAGE_NAMES.get(referee.lang, referee.lang)
    strategy_section: list[str] = []
    if strategy:
        strategy_section = [
            "",
            "YOUR STRATEGY",
            (
                "Guidance you distilled from your own earlier games. It is advice, "
                "not rules: the fixed game rules above always take precedence."
            ),
            strategy,
        ]
    # Prompt v23 has one strategy-neutral rules scaffold for every caller. The flag is
    # retained for API compatibility with callers that request neutral rules; only
    # an explicitly supplied strategy can add solving guidance.
    _ = rules_only
    return _rules_opening(
        referee,
        language,
        strategy_section,
        cap=cap,
    )


def _outcome_text(outcome: HoleOutcome, referee: PuzzleReferee) -> str:
    current_rank = referee.holes[outcome.number - 1].rank
    if outcome.rank is None:
        return (
            f"word {outcome.number}: MISS "
            f"(current best remains rank {current_rank})"
        )
    if outcome.solved:
        return f"word {outcome.number}: 0 solved!"
    if outcome.improved:
        return f"word {outcome.number}: {outcome.rank} closer! New best rank {outcome.rank}."
    return (
        f"word {outcome.number}: rank {outcome.rank} did not improve current best "
        f"rank {current_rank}"
    )


def feedback_message(
    feedback: GuessFeedback,
    referee: PuzzleReferee,
    *,
    rules_only: bool = False,
) -> str:
    if feedback.kind == "counted":
        outcomes = "\n".join(
            _outcome_text(outcome, referee) for outcome in feedback.outcomes
        )
        lead = f'RESULT FOR "{feedback.guess}":\n{outcomes}'
    else:
        lead = feedback.message
    lines = [
        lead,
        *_state_snapshot_lines(referee),
        f"Tries: {feedback.tries} (your score — lower is better)",
    ]
    # Prompt v23 never adds generic solving advice during play. Keep the keyword for
    # caller compatibility; explicit learned/v7 guidance lives only in the opening.
    _ = rules_only
    lines.append(_reply_reminder(referee))
    return "\n".join(lines)


def _unparseable_reason(reply: str) -> str:
    candidate = reply.strip()
    if not candidate:
        return "The reply was empty."
    if any(mark in candidate for mark in ("'", "’", "ʼ")):
        return (
            "The reply contains an apostrophe, which separates a clitic/prefix from "
            "the lexical word and is never permitted in this interface. Submit only "
            "one standalone lexical core."
        )
    if any(character.isspace() for character in candidate):
        return (
            "The reply contains whitespace, so it is not one bare word. Remove every "
            "extra word, label, and explanation."
        )
    return (
        "The reply contains a character or word shape outside the stated grammar. "
        "Only permitted language letters and optional internal ASCII hyphens are allowed."
    )


def unparseable_message(
    referee: PuzzleReferee, reply: str, *, rules_only: bool = False
) -> str:
    rendered_reply = json.dumps(reply.strip(), ensure_ascii=False)
    lines = [
        f"INVALID REPLY FORMAT: {rendered_reply}",
        _unparseable_reason(reply),
        "This did not count, changed no state, and produced no rank feedback.",
        *_state_snapshot_lines(referee),
        f"Tries: {referee.tries} (your score — lower is better)",
    ]
    _ = rules_only
    lines.append(_reply_reminder(referee))
    return "\n".join(lines)


def play_puzzle(
    puzzle: dict[str, Any],
    vocab: Iterable[str],
    model_reply: ModelReply,
    *,
    cap: int = DEFAULT_CAP,
    on_try: TryReporter | None = None,
    strategy: str | None = None,
    rules_only: bool = False,
    best_score_to_beat: int | None = None,
    median_prune: MedianPrunePredicate | None = None,
) -> RunResult:
    """Run one append-only model conversation through the real puzzle rules.

    `strategy` is optional model-authored playbook guidance injected into the opening
    as advice under the fixed rules. There is no
    pre-game planning turn: the first reply is the first guess.
    """
    if not _is_int(cap) or cap <= 0:
        raise ValueError("cap must be a positive integer")
    if best_score_to_beat is not None and (
        not _is_int(best_score_to_beat) or best_score_to_beat <= 0
    ):
        raise ValueError("best score to beat must be a positive integer")
    if best_score_to_beat is not None and median_prune is not None:
        raise ValueError("best and median pruning cannot be combined")
    referee = PuzzleReferee(puzzle, vocab)
    if referee.solved:
        raise ValueError("puzzle starts solved; no benchmark can be played")

    def current_median_prune_reason(
        live_tries: int,
    ) -> MedianPruneReason | None:
        if median_prune is None:
            return None
        reason = median_prune(live_tries)
        if reason is not None and reason not in MEDIAN_PRUNE_REASONS:
            raise ValueError(f"unsupported median prune reason: {reason}")
        return reason

    initial_prune = current_median_prune_reason(0)
    if initial_prune is not None:
        return RunResult(
            tries=None,
            counted_tries=0,
            turns=0,
            duration=0.0,
            tried_words=(),
            conversation=(),
            turn_token_usage=(),
            termination=initial_prune,
        )

    messages: list[Message] = [
        {
            "role": "user",
            "content": opening_message(
                referee,
                strategy,
                rules_only=rules_only,
                cap=cap,
            ),
        }
    ]
    turns = 0
    consecutive_unparseable = 0
    noncounting_replies = 0
    started = time.monotonic()
    turn_token_usage: list[TokenUsage] = []
    raw_provider_token_usage: list[dict[str, Any]] = []

    while True:
        raw_reply = model_reply([message.copy() for message in messages])
        usage = _last_token_usage(model_reply)
        raw_usage = _last_raw_token_usage(model_reply)
        if usage is not None:
            turn_token_usage.append(usage)
        if raw_usage is not None:
            raw_provider_token_usage.append(raw_usage)
        turns += 1
        if not isinstance(raw_reply, str):
            raw_reply = ""
        assistant_content = raw_reply.strip() or "[empty response]"
        messages.append({"role": "assistant", "content": assistant_content})

        guess = parse_single_word(raw_reply, lang=referee.lang)
        if guess is None:
            consecutive_unparseable += 1
            if consecutive_unparseable >= MAX_CONSECUTIVE_UNPARSEABLE:
                raise UnparseableReplyError(
                    f"aborted after {MAX_CONSECUTIVE_UNPARSEABLE} consecutive unparseable replies",
                    RunResult(
                        tries=None,
                        counted_tries=referee.tries,
                        turns=turns,
                        duration=time.monotonic() - started,
                        tried_words=tuple(referee.tried_words),
                        conversation=tuple(message.copy() for message in messages),
                        turn_token_usage=tuple(turn_token_usage),
                        termination="reply_error",
                        raw_provider_token_usage=tuple(
                            raw_provider_token_usage
                        ),
                    ),
                )
            messages.append(
                {
                    "role": "user",
                    "content": unparseable_message(
                        referee,
                        raw_reply,
                        rules_only=rules_only,
                    ),
                }
            )
            continue

        consecutive_unparseable = 0
        feedback = referee.submit(guess)
        messages.append(
            {
                "role": "user",
                "content": feedback_message(
                    feedback, referee, rules_only=rules_only
                ),
            }
        )

        if feedback.kind == "counted":
            noncounting_replies = 0
            if on_try is not None:
                on_try(
                    TryProgress(
                        number=feedback.tries,
                        word=guess,
                        progress=referee.progress,
                        token_usage=usage,
                    )
                )
        else:
            # The counted-try cap cannot stop a model that keeps returning invalid or
            # repeated words. Bound those paid-but-scoreless replies independently; an
            # occasional correction remains free and does not change game semantics.
            noncounting_replies += 1
            if noncounting_replies >= MAX_NONCOUNTING_REPLIES:
                raise NoProgressReplyError(
                    f"aborted after {MAX_NONCOUNTING_REPLIES} parsed replies "
                    "without a counted try",
                    RunResult(
                        tries=None,
                        counted_tries=referee.tries,
                        turns=turns,
                        duration=time.monotonic() - started,
                        tried_words=tuple(referee.tried_words),
                        conversation=tuple(message.copy() for message in messages),
                        turn_token_usage=tuple(turn_token_usage),
                        termination="reply_error",
                        raw_provider_token_usage=tuple(
                            raw_provider_token_usage
                        ),
                    ),
                )

        # A solve on try N wins even when N equals the cap. The cap is a DNF only when
        # unsolved after that many counted, unique, vocabulary-valid guesses.
        if feedback.solved:
            return RunResult(
                tries=feedback.tries,
                counted_tries=feedback.tries,
                turns=turns,
                duration=time.monotonic() - started,
                tried_words=tuple(referee.tried_words),
                conversation=tuple(message.copy() for message in messages),
                turn_token_usage=tuple(turn_token_usage),
                termination="solved",
                raw_provider_token_usage=tuple(raw_provider_token_usage),
            )
        median_prune_reason_now = current_median_prune_reason(
            feedback.tries
        )
        if median_prune_reason_now is not None:
            return RunResult(
                tries=None,
                counted_tries=feedback.tries,
                turns=turns,
                duration=time.monotonic() - started,
                tried_words=tuple(referee.tried_words),
                conversation=tuple(message.copy() for message in messages),
                turn_token_usage=tuple(turn_token_usage),
                termination=median_prune_reason_now,
                raw_provider_token_usage=tuple(raw_provider_token_usage),
            )
        # In best mode a run that is still unsolved at the incumbent score cannot tie
        # or beat it: solving now was checked above, and another counted guess would be
        # strictly worse. Preserve the paid prefix as a censored lab run and stop.
        if (
            best_score_to_beat is not None
            and feedback.tries >= best_score_to_beat
        ):
            return RunResult(
                tries=None,
                counted_tries=feedback.tries,
                turns=turns,
                duration=time.monotonic() - started,
                tried_words=tuple(referee.tried_words),
                conversation=tuple(message.copy() for message in messages),
                turn_token_usage=tuple(turn_token_usage),
                termination="cannot_beat_best",
                raw_provider_token_usage=tuple(raw_provider_token_usage),
            )
        if feedback.tries >= cap:
            return RunResult(
                tries=None,
                counted_tries=feedback.tries,
                turns=turns,
                duration=time.monotonic() - started,
                tried_words=tuple(referee.tried_words),
                conversation=tuple(message.copy() for message in messages),
                turn_token_usage=tuple(turn_token_usage),
                termination="cap",
                raw_provider_token_usage=tuple(raw_provider_token_usage),
            )


def _text_content(content: object) -> str:
    """Normalize current SDK response content without coupling the referee to SDK types."""
    if isinstance(content, str):
        return content
    if not isinstance(content, Sequence):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, dict):
            text = block.get("text")
        else:
            text = getattr(block, "text", None)
        if isinstance(text, str):
            parts.append(text)
    return "\n".join(parts)


def _output_token_budget(effort: ReasoningEffort, output: OutputMode) -> int:
    """Explicit construction-time output mode — never inferred from message counts."""
    if effort == "none":
        # Thinking-off models can still emit visible explanation despite the one-word
        # contract. Leave enough room for a complete reply; strict parsing rejects prose.
        budget = DIRECT_OUTPUT_MAX_TOKENS
    elif effort in {"xhigh", "max", "ultra"}:
        budget = DEEP_REASONING_MAX_TOKENS
    else:
        budget = REASONING_MAX_TOKENS
    if output == "prose":
        return max(budget, PROSE_OUTPUT_MAX_TOKENS)
    if output == "decision":
        return max(budget, DECISION_OUTPUT_MAX_TOKENS)
    return budget


def _supported_efforts(provider: str, auth: AuthMode) -> tuple[ReasoningEffort, ...]:
    if provider == "kimi":
        return KIMI_EFFORTS if auth == "subscription" else ()
    if provider == "openai" and auth == "api":
        return OPENAI_API_EFFORTS
    if provider == "openai" and auth == "subscription":
        return CODEX_SUBSCRIPTION_EFFORTS
    return ANTHROPIC_EFFORTS


def _validate_provider_effort(
    provider: str, auth: AuthMode, effort: ReasoningEffort
) -> None:
    if effort not in ALL_REASONING_EFFORTS:
        raise ValueError(f"unsupported reasoning effort: {effort}")
    if auth not in AUTH_MODES:
        raise ValueError(f"unsupported auth mode: {auth}")
    if provider == "kimi" and auth != "subscription":
        raise ValueError(
            "Kimi K3 benchmark requires --auth subscription with "
            "KIMI_CODE_API_KEY"
        )
    if provider == "kimi" and effort == "none":
        raise ValueError(
            "Kimi K3 does not allow reasoning effort 'none' because disabling "
            "thinking routes the request to K2.6; use low|medium|high|xhigh|max"
        )
    supported = _supported_efforts(provider, auth)
    if effort not in supported:
        levels = "|".join(supported)
        provider_name = "OpenAI" if provider == "openai" else provider.title()
        auth_name = "API" if auth == "api" else "subscription"
        raise ValueError(
            f"{provider_name} {auth_name} benchmark does not allow reasoning effort "
            f"{effort!r}; use {levels}"
        )


def _effective_provider_effort(
    provider: str, effort: ReasoningEffort
) -> ReasoningEffort:
    if provider == "kimi":
        try:
            return KIMI_EFFORT_MAP[effort]
        except KeyError as exc:
            raise ValueError(
                "Kimi K3 keeps thinking enabled and does not allow reasoning "
                "effort 'none'; use low|medium|high|xhigh|max"
            ) from exc
    return effort


def _validate_reasoning_mode(
    provider: str,
    auth: AuthMode,
    effort: ReasoningEffort,
    reasoning_mode: ReasoningMode,
) -> None:
    if reasoning_mode not in {"standard", "pro"}:
        raise ValueError(f"unsupported reasoning mode: {reasoning_mode}")
    if reasoning_mode == "standard":
        return
    if provider != "openai" or auth != "api":
        raise ValueError("Pro reasoning mode is available only through the OpenAI API")
    if effort != "max":
        raise ValueError("Pro reasoning mode requires OpenAI API effort 'max'")


def _historical_feedback(content: str) -> str:
    """Keep an exact turn outcome without replaying its superseded snapshot."""
    outcome, marker, _snapshot = content.partition("\nCURRENT STATE\n")
    return outcome.rstrip() if marker else content


def _stateless_word_parts(messages: list[Message]) -> tuple[str, str]:
    """Split a fresh-turn prompt into fixed rules and its complete public record.

    The concatenation of the two parts is the exact prompt text; the prefix is
    byte-identical across every turn of a run so a prompt-cache breakpoint placed on
    it can actually be read back.
    """
    if not messages or messages[0].get("role") != "user":
        raise ValueError("word reply requires an opening user message")
    if messages[-1].get("role") != "user":
        raise ValueError("word reply requires a final user message")
    for index, message in enumerate(messages):
        expected_role = "user" if index % 2 == 0 else "assistant"
        if message.get("role") != expected_role:
            raise ValueError(
                "word reply requires an alternating user/assistant transcript"
            )
        if not isinstance(message.get("content"), str):
            raise ValueError("word reply message content must be text")

    opening = messages[0]["content"]
    record_marker = "\nCOMPLETE CHRONOLOGICAL GAME RECORD\n"
    opening_rules, marker, initial_state = opening.partition(record_marker)
    if marker:
        stable = (
            f"{opening_rules.rstrip()}\n\n"
            "COMPLETE CHRONOLOGICAL GAME RECORD\n"
        )
    else:
        # Defensive compatibility for direct adapter callers. Production v23 game
        # openings carry the complete-record marker; older fixtures may expose only
        # CURRENT STATE, and arbitrary one-message calls remain byte-preserving.
        opening_rules, state_marker, state_tail = opening.partition(
            "\nCURRENT STATE\n"
        )
        if state_marker:
            stable = f"{opening_rules.rstrip()}\n\n"
            initial_state = f"CURRENT STATE\n{state_tail}"
        elif len(messages) == 1:
            return "", opening
        else:
            stable = ""
            initial_state = opening

    record = [initial_state]
    turn_count = (len(messages) - 1) // 2
    for turn_index, message_index in enumerate(range(1, len(messages), 2), start=1):
        feedback = messages[message_index + 1]["content"]
        if turn_index < turn_count:
            feedback = _historical_feedback(feedback)
        record.extend(
            [
                f"PLAYER REPLY {turn_index}\n{messages[message_index]['content']}",
                f"REFEREE FEEDBACK {turn_index}\n{feedback}",
            ]
        )
    return stable, "\n\n".join(record)


def _stateless_word_prompt(messages: list[Message]) -> str:
    """Return one fresh prompt containing the complete chronological public record.

    Every transport sees this identical user prompt in the explicit stateless diagnostic.
    All prior replies, exact referee outcomes, initial clues, and the latest authoritative
    snapshot are explicit. Superseded snapshots are omitted because the exact ordered
    outcomes preserve their evidence.
    """
    stable, volatile = _stateless_word_parts(messages)
    return f"{stable}{volatile}"


def _provider_messages(
    messages: list[Message], output: OutputMode
) -> list[Message]:
    if output != "word":
        return messages
    return [{"role": "user", "content": _stateless_word_prompt(messages)}]


def _merge_agent_text_continuation(current: str, continuation: str) -> str:
    """Join Claude Code max-output recovery chunks without duplicating their seam.

    Claude Code can recover a logical turn that hit ``max_tokens`` by issuing another
    provider message. The continuation may repeat the final word fragment from the
    preceding message. The Agent SDK's final ``ResultMessage.result`` contains only the
    last recovery chunk, so callers must assemble the emitted assistant messages.
    """
    if not current:
        return continuation
    if not continuation:
        return current
    overlap_limit = min(len(current), len(continuation), 4_096)
    for overlap in range(overlap_limit, 2, -1):
        if current.endswith(continuation[:overlap]):
            return current + continuation[overlap:]
    return current + continuation


async def _agent_sdk_turn(
    prompt: str,
    *,
    model_id: str,
    effort: ReasoningEffort,
    cwd: str,
    resume: str | None,
    subprocess_env: Mapping[str, str] | None = None,
    extra_args: Mapping[str, str | None] | None = None,
) -> tuple[str, str, dict[str, Any] | None]:
    """Run one isolated Agent SDK turn and return text, session id, and usage."""
    import claude_agent_sdk

    ClaudeAgentOptions = claude_agent_sdk.ClaudeAgentOptions
    ResultMessage = claude_agent_sdk.ResultMessage
    AssistantMessage = getattr(claude_agent_sdk, "AssistantMessage", None)
    query = claude_agent_sdk.query

    thinking: dict[str, str]
    sdk_effort: str | None
    if effort == "none":
        thinking = {"type": "disabled"}
        sdk_effort = None
    else:
        thinking = {"type": "adaptive"}
        sdk_effort = effort

    cli_extra_args: dict[str, str | None] = {
        "safe-mode": None,
        "disable-slash-commands": None,
    }
    cli_extra_args.update(extra_args or {})
    options = ClaudeAgentOptions(
        model=model_id,
        # None is intentionally serialized by the SDK as an empty replacement system
        # prompt. Do not opt into the `claude_code` preset for this model benchmark.
        system_prompt=None,
        tools=[],
        allowed_tools=[],
        mcp_servers={},
        strict_mcp_config=True,
        permission_mode="dontAsk",
        setting_sources=[],
        skills=[],
        agents={},
        plugins=[],
        settings=None,
        fallback_model=None,
        cwd=cwd,
        env=dict(subprocess_env or {}),
        resume=resume,
        max_turns=1,
        thinking=thinking,
        effort=sdk_effort,
        extra_args=cli_extra_args,
    )
    result_message = None
    trailing_error: Exception | None = None
    assistant_text = ""
    try:
        async for message in query(prompt=prompt, options=options):
            if AssistantMessage is not None and isinstance(message, AssistantMessage):
                assistant_text = _merge_agent_text_continuation(
                    assistant_text,
                    _text_content(message.content),
                )
            if isinstance(message, ResultMessage):
                result_message = message
    except Exception as exc:
        if result_message is None or not result_message.is_error:
            raise
        trailing_error = exc
    if result_message is None:
        raise RuntimeError(f"{model_id} Agent SDK session returned no final result")
    if result_message.is_error:
        details: list[str] = []
        errors = getattr(result_message, "errors", None)
        if isinstance(errors, list):
            details.extend(error for error in errors if isinstance(error, str) and error)
        api_status = getattr(result_message, "api_error_status", None)
        if isinstance(api_status, int):
            details.append(f"provider HTTP status {api_status}")
        for candidate in (result_message.result, result_message.stop_reason):
            if (
                isinstance(candidate, str)
                and candidate
                and candidate != "Claude Code returned an error result: success"
                and candidate not in details
            ):
                details.append(candidate)
        subtype = result_message.subtype
        if (
            isinstance(subtype, str)
            and subtype
            and subtype != "success"
            and subtype not in details
        ):
            details.append(subtype)
        if not details and trailing_error is not None:
            trailing_detail = str(trailing_error)
            if trailing_detail != "Claude Code returned an error result: success":
                details.append(trailing_detail)
        detail = "; ".join(details) or "provider request failed without diagnostics"
        error = RuntimeError(f"{model_id} Agent SDK session failed: {detail}")
        if trailing_error is not None:
            raise error from trailing_error
        raise error
    if not result_message.session_id:
        raise RuntimeError(f"{model_id} Agent SDK session returned no session id")
    return (
        assistant_text or result_message.result or "",
        result_message.session_id,
        _json_token_usage(getattr(result_message, "usage", None)),
    )


class AnthropicSubscriptionReply:
    """Synchronous referee adapter over isolated Agent SDK sessions."""

    def __init__(
        self,
        model_id: str,
        effort: ReasoningEffort,
        output: OutputMode = "word",
        session: SessionMode = DEFAULT_SESSION,
        *,
        subprocess_env: Mapping[str, str] | None = None,
        conflict_env: Iterable[str] = SUBSCRIPTION_CONFLICT_ENV,
        workspace_prefix: str = "whippin-agent-sdk-",
        agent_extra_args: Mapping[str, str | None] | None = None,
    ):
        self.model_id = model_id
        self.effort = effort
        self.output = output
        if session not in SESSION_MODES:
            raise ValueError(f"unsupported session mode: {session}")
        self.session = session
        self._subprocess_env = dict(subprocess_env or {})
        self._conflict_env = tuple(conflict_env)
        self._agent_extra_args = dict(agent_extra_args or {})
        self.session_id: str | None = None
        self._message_count = 0
        self._workspace = tempfile.TemporaryDirectory(prefix=workspace_prefix)
        self.last_token_usage: TokenUsage | None = None
        self.last_raw_token_usage: dict[str, Any] | None = None

    def __call__(self, messages: list[Message]) -> str:
        self.last_token_usage = None
        self.last_raw_token_usage = None
        if not messages or messages[-1].get("role") != "user":
            raise ValueError("Agent SDK reply requires a final user message")

        persistent = self.output != "word" or self.session == "persistent"
        if persistent:
            # `benchmark_model` reuses one adapter across runs. A one-message
            # transcript always starts a fresh attempt.
            if len(messages) == 1:
                self.session_id = None
                self._message_count = 0
            elif self._message_count == 0:
                raise RuntimeError(
                    "Agent SDK conversation cannot continue before its opening turn"
                )
            expected_count = (
                1 if self._message_count == 0 else self._message_count + 2
            )
            if len(messages) != expected_count:
                raise RuntimeError(
                    "Agent SDK conversation diverged from the append-only referee "
                    "transcript"
                )
        else:
            self.session_id = None
            self._message_count = 0
        if persistent and len(messages) > 1 and self.session_id is None:
            raise RuntimeError(
                "Agent SDK conversation cannot resume before its opening turn"
            )

        # Product play sends only the newest referee message into the native session.
        # The explicit stateless diagnostic reconstructs the same complete public record
        # in a fresh provider turn. Non-word workflows keep their existing sessions.
        prompt = messages[-1]["content"]
        resume = self.session_id
        if not persistent:
            prompt = _stateless_word_prompt(messages)
            resume = None

        with _temporary_environment_without(self._conflict_env):
            text, session_id, usage = asyncio.run(
                _agent_sdk_turn(
                    prompt,
                    model_id=self.model_id,
                    effort=self.effort,
                    cwd=self._workspace.name,
                    resume=resume,
                    subprocess_env=self._subprocess_env,
                    extra_args=self._agent_extra_args,
                )
            )
        if resume is not None and session_id != resume:
            raise RuntimeError(
                f"{self.model_id} Agent SDK resumed the wrong session "
                f"({session_id!r} != {resume!r})"
            )
        self.session_id = session_id if persistent else None
        self._message_count = len(messages) if persistent else 0
        self.last_raw_token_usage = usage
        self.last_token_usage = _normalize_anthropic_token_usage(usage)
        return text

    def close(self) -> None:
        self._workspace.cleanup()


def _kimi_transport_error(
    exc: Exception, *, api_key: str | None = None
) -> RuntimeError:
    detail = str(exc) or exc.__class__.__name__
    if api_key:
        detail = detail.replace(api_key, "[redacted]")
    lowered = detail.lower()
    if "api.anthropic.com" in lowered or "claude.ai" in lowered:
        return RuntimeError(
            "Kimi routing safety check failed: the Agent SDK attempted a Claude.ai/"
            "Anthropic route instead of the pinned Kimi Code endpoint"
        )
    rate_limit_markers = (
        "provider http status 429",
        "rate limit",
        "usage limit",
        "quota",
        "engine is currently overloaded",
        "too many requests",
    )
    if re.search(r"\b429\b", lowered) or any(
        marker in lowered for marker in rate_limit_markers
    ):
        return RuntimeError(
            "Kimi Code rate limit, quota, or temporary overload stopped the K3 run; "
            f"check the Kimi Console reset time or retry later ({detail})"
        )
    entitlement_markers = (
        "provider http status 401",
        "provider http status 403",
        "provider http status 404",
        "unauthorized",
        "forbidden",
        "invalid api key",
        "entitlement",
        "model not found",
        "unknown model",
    )
    if re.search(r"\b(?:401|403|404)\b", lowered) or any(
        marker in lowered for marker in entitlement_markers
    ):
        return RuntimeError(
            "Kimi Code authentication or K3 plan/model entitlement failed at the "
            f"official endpoint {KIMI_CODE_BASE_URL}; verify KIMI_CODE_API_KEY and "
            f"Moderato-or-higher K3 access ({detail})"
        )
    dependency_markers = (
        "claude code not found",
        "cli not found",
        "failed to start claude code",
        "agent sdk transport requires",
    )
    if any(marker in lowered for marker in dependency_markers):
        return RuntimeError(
            "Kimi Code Agent SDK transport dependency failed; sync the benchmark "
            f"workspace and verify its bundled Claude Code CLI ({detail})"
        )
    return RuntimeError(
        f"Kimi K3 request through {KIMI_CODE_BASE_URL} failed: {detail}"
    )


class KimiSubscriptionReply(AnthropicSubscriptionReply):
    """K3 over Kimi Code's pinned Anthropic-compatible subscription endpoint."""

    def __init__(
        self,
        model_id: str,
        api_key: str,
        requested_effort: ReasoningEffort,
        output: OutputMode = "word",
        session: SessionMode = DEFAULT_SESSION,
    ):
        effective_effort = _effective_provider_effort("kimi", requested_effort)
        super().__init__(
            model_id,
            effective_effort,
            output,
            session,
            conflict_env=KIMI_SUBPROCESS_CONFLICT_ENV,
            workspace_prefix="whippin-kimi-agent-sdk-",
            agent_extra_args={
                "bare": None,
                **(
                    {"no-session-persistence": None}
                    if output == "word" and session == "stateless"
                    else {}
                ),
            },
        )
        config_dir = Path(self._workspace.name) / "claude-config"
        config_dir.mkdir()
        self.requested_effort = requested_effort
        self.effective_effort = effective_effort
        # ClaudeAgentOptions.env is merged into the spawned CLI only. The surrounding
        # conflict guard removes inherited routes first, so these are the child's sole
        # Anthropic-compatible credential/endpoint values and never replace os.environ.
        self._subprocess_env = {
            "ANTHROPIC_API_KEY": api_key,
            "ANTHROPIC_BASE_URL": KIMI_CODE_BASE_URL,
            "CLAUDE_CONFIG_DIR": str(config_dir),
        }

    def __call__(self, messages: list[Message]) -> str:
        try:
            return super().__call__(messages)
        except Exception as exc:
            raise _kimi_transport_error(
                exc, api_key=self._subprocess_env.get("ANTHROPIC_API_KEY")
            ) from exc

    def close(self) -> None:
        self._subprocess_env.clear()
        super().close()


def _codex_snapshot_prompt(
    messages: list[Message], output: OutputMode = "word"
) -> str:
    if output == "word":
        return _stateless_word_prompt(messages)
    if output == "prose" and len(messages) == 1:
        # One-shot analyst/critic prompts must be byte-identical across transports.
        # Wrapping a single message as both opening_rules and current_state would also
        # duplicate large evidence packets and can push them over the model context.
        return messages[0]["content"]

    opening = messages[0]["content"]
    opening_rules, marker, initial_state = opening.partition("\nCURRENT STATE\n")
    if marker:
        initial_state = f"CURRENT STATE\n{initial_state}"
    else:
        # Defensive fallback for callers outside play_puzzle; production openings
        # always carry the explicit state marker.
        opening_rules = opening
        initial_state = opening
    snapshot = {
        "opening_rules": opening_rules,
        "current_state": (
            messages[-1]["content"] if len(messages) > 1 else initial_state
        ),
    }
    encoded = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
    if output == "prose":
        lead = "Complete the task from the compact JSON snapshot below."
        response_rule = "Answer fully in the exact format requested."
    else:
        lead = "Play under the policy controller in the compact JSON snapshot below."
        response_rule = "Return only the exact JSON decision object requested."
    return "\n".join(
        [
            lead,
            "The opening rules and latest current state are authoritative; obsolete "
            "intermediate turns are intentionally omitted.",
            response_rule,
            encoded,
        ]
    )


def _codex_final_message(
    stdout: str, model_id: str
) -> tuple[str, dict[str, Any] | None, str | None]:
    final_message: str | None = None
    token_usage: dict[str, Any] | None = None
    thread_id: str | None = None
    for line_number, line in enumerate(stdout.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"{model_id} Codex CLI returned malformed JSONL on line {line_number}"
            ) from exc
        if not isinstance(event, dict):
            raise RuntimeError(f"{model_id} Codex CLI returned a malformed event")
        event_type = event.get("type")
        if event_type in {"error", "turn.failed"}:
            detail = event.get("message") or event.get("error") or "unknown error"
            raise RuntimeError(f"{model_id} Codex CLI turn failed: {detail}")
        if event_type == "thread.started":
            candidate = event.get("thread_id")
            if not isinstance(candidate, str) or not candidate:
                raise RuntimeError(
                    f"{model_id} Codex CLI returned a malformed thread id"
                )
            if thread_id is not None and candidate != thread_id:
                raise RuntimeError(
                    f"{model_id} Codex CLI returned conflicting thread ids"
                )
            thread_id = candidate
            continue
        if event_type == "turn.completed":
            token_usage = _json_token_usage(event.get("usage"))
            continue
        if not isinstance(event_type, str) or not event_type.startswith("item."):
            continue
        item = event.get("item")
        if not isinstance(item, dict):
            raise RuntimeError(f"{model_id} Codex CLI returned a malformed item event")
        item_type = item.get("type")
        if item_type not in CODEX_ALLOWED_ITEM_TYPES:
            raise RuntimeError(
                f"{model_id} Codex CLI attempted forbidden tool activity: {item_type}"
            )
        if event_type == "item.completed" and item_type == "agent_message":
            text = item.get("text")
            if not isinstance(text, str):
                raise RuntimeError(
                    f"{model_id} Codex CLI returned a malformed agent message"
                )
            final_message = text
    if final_message is None:
        raise RuntimeError(f"{model_id} Codex CLI returned no final agent message")
    return final_message, token_usage, thread_id


class OpenAISubscriptionReply:
    """Isolated Codex CLI sessions backed by saved ChatGPT plan auth."""

    def __init__(
        self,
        model_id: str,
        effort: ReasoningEffort,
        output: OutputMode = "word",
        session: SessionMode = DEFAULT_SESSION,
    ):
        if effort not in CODEX_SUBSCRIPTION_EFFORTS:
            supported = "|".join(CODEX_SUBSCRIPTION_EFFORTS)
            raise ValueError(
                "OpenAI subscription auth does not support reasoning effort "
                f"{effort!r}; use {supported}"
            )
        if session not in SESSION_MODES:
            raise ValueError(f"unsupported session mode: {session}")
        cli = shutil.which("codex")
        if cli is None:
            raise RuntimeError("Codex CLI is not installed")
        self.cli = cli
        self.model_id = model_id
        self.effort = effort
        self.output = output
        self.session = session
        self.session_id: str | None = None
        self.timeout_seconds = (
            CODEX_PROSE_TIMEOUT_SECONDS
            if output == "prose"
            else CODEX_TURN_TIMEOUT_SECONDS
        )
        self._message_count = 0
        self._workspace = tempfile.TemporaryDirectory(prefix="whippin-codex-")
        self.last_token_usage: TokenUsage | None = None
        self.last_raw_token_usage: dict[str, Any] | None = None
        self._cumulative_token_usage: TokenUsage | None = None
        instructions = {
            "word": CODEX_BENCHMARK_INSTRUCTIONS,
            "decision": CODEX_DECISION_INSTRUCTIONS,
            "prose": CODEX_PROSE_INSTRUCTIONS,
        }[output]
        self._instructions_path = Path(self._workspace.name) / "instructions.md"
        self._instructions_path.write_text(instructions + "\n", encoding="utf-8")

    def _command(self, resume: str | None = None) -> list[str]:
        persistent = self.output == "word" and self.session == "persistent"
        if resume is not None and not persistent:
            raise RuntimeError("a stateless Codex turn cannot resume a session")
        config = [
            f"approval_policy={json.dumps('never')}",
            f"model_reasoning_effort={json.dumps(self.effort)}",
            f"model_instructions_file={json.dumps(str(self._instructions_path))}",
            "features.apps=false",
            "features.shell_tool=false",
            "features.multi_agent=false",
            f"web_search={json.dumps('disabled')}",
            f"history.persistence={json.dumps('save-all' if persistent else 'none')}",
            "feedback.enabled=false",
            "analytics.enabled=false",
        ]
        command = [self.cli, "exec"]
        if resume is not None:
            command.append("resume")
        if not persistent:
            command.append("--ephemeral")
        command.extend(
            [
                "--ignore-user-config",
                "--ignore-rules",
                "--skip-git-repo-check",
                "--strict-config",
                "--json",
                "--model",
                self.model_id,
            ]
        )
        # A resumed thread retains its original cwd and sandbox; those flags are valid
        # only when creating the first turn.
        if resume is None:
            model_index = command.index("--model")
            command[model_index:model_index] = [
                "--sandbox",
                "read-only",
                "--cd",
                self._workspace.name,
            ]
        for value in config:
            command.extend(("--config", value))
        if resume is not None:
            command.append(resume)
        command.append("-")
        return command

    def __call__(self, messages: list[Message]) -> str:
        self.last_token_usage = None
        self.last_raw_token_usage = None
        if not messages or messages[-1].get("role") != "user":
            raise ValueError("Codex CLI reply requires a final user message")

        persistent = self.output == "word" and self.session == "persistent"
        if persistent:
            if len(messages) == 1:
                self.session_id = None
                self._message_count = 0
                self._cumulative_token_usage = None
            expected_count = (
                1 if self._message_count == 0 else self._message_count + 2
            )
            if len(messages) != expected_count:
                raise RuntimeError(
                    "Codex CLI conversation diverged from the append-only referee "
                    "transcript"
                )
        else:
            self.session_id = None
            self._message_count = 0
            self._cumulative_token_usage = None
        if persistent and len(messages) > 1 and self.session_id is None:
            raise RuntimeError(
                "Codex CLI conversation cannot resume before its opening turn"
            )
        resume = self.session_id if persistent else None
        prompt = (
            messages[-1]["content"]
            if persistent
            else _codex_snapshot_prompt(messages, self.output)
        )

        try:
            completed = subprocess.run(
                self._command(resume),
                check=False,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
                cwd=self._workspace.name,
                env=_environment_without(OPENAI_SUBSCRIPTION_CONFLICT_ENV),
                input=prompt,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RuntimeError(f"{self.model_id} Codex CLI turn failed: {exc}") from exc
        if completed.returncode != 0:
            detail = (
                completed.stderr.strip() or completed.stdout.strip() or "unknown error"
            )
            raise RuntimeError(
                f"{self.model_id} Codex CLI exited {completed.returncode}: "
                f"{detail[-1000:]}"
            )
        result, usage, thread_id = _codex_final_message(
            completed.stdout, self.model_id
        )
        if persistent:
            if thread_id is None:
                raise RuntimeError(
                    f"{self.model_id} Codex CLI session returned no thread id"
                )
            if resume is not None and thread_id != resume:
                raise RuntimeError(
                    f"{self.model_id} Codex CLI resumed the wrong thread "
                    f"({thread_id!r} != {resume!r})"
                )
            self.session_id = thread_id
        else:
            self.session_id = None
        self._message_count = len(messages) if persistent else 0
        self.last_raw_token_usage = usage
        normalized_usage = _normalize_openai_token_usage(usage)
        if normalized_usage is not None and persistent:
            current_cumulative = normalized_usage
            normalized_usage = _cumulative_token_usage_delta(
                current_cumulative, self._cumulative_token_usage
            )
            self._cumulative_token_usage = current_cumulative
        self.last_token_usage = normalized_usage
        return result

    def close(self) -> None:
        self._workspace.cleanup()


def provider_reply(
    config: ModelConfig,
    api_key: str | None,
    *,
    effort: ReasoningEffort = DEFAULT_EFFORT,
    auth: AuthMode = DEFAULT_AUTH,
    output: OutputMode = "word",
    reasoning_mode: ReasoningMode = "standard",
    session: SessionMode = DEFAULT_SESSION,
) -> ModelReply:
    """Build one provider adapter. Paid SDK imports stay lazy for offline tests.

    `output` fixes the adapter's response mode at construction: "word" for the
    ordinary benchmark, "decision" for structured controllers, and "prose" for
    long-form analysis. OpenAI API callers can additionally request documented Pro
    reasoning with max effort; other transports reject that wire-only option. Ordinary
    word play defaults to one provider-native persistent session per run; stateless mode
    remains an explicit complete-record diagnostic.
    """
    provider = config["provider"]
    model_id = config["model_id"]
    _validate_provider_effort(provider, auth, effort)
    _validate_reasoning_mode(provider, auth, effort, reasoning_mode)
    if session not in SESSION_MODES:
        raise ValueError(f"unsupported session mode: {session}")

    if provider == "kimi":
        if not api_key:
            raise ValueError(
                "Kimi K3 subscription auth requires KIMI_CODE_API_KEY"
            )
        return KimiSubscriptionReply(model_id, api_key, effort, output, session)

    if provider == "anthropic":
        if auth == "subscription":
            return AnthropicSubscriptionReply(model_id, effort, output, session)
        if not api_key:
            raise ValueError("Anthropic API auth requires ANTHROPIC_API_KEY")
        import anthropic

        client = anthropic.Anthropic(api_key=api_key)
        provider_history: list[dict[str, Any]] = []
        message_count = 0

        def reply(messages: list[Message]) -> str:
            nonlocal provider_history, message_count
            setattr(reply, "last_token_usage", None)
            setattr(reply, "last_raw_token_usage", None)
            if not messages or messages[-1].get("role") != "user":
                raise ValueError("Anthropic API reply requires a final user message")
            persistent = output == "word" and session == "persistent"
            if persistent:
                if len(messages) == 1:
                    provider_history = []
                    message_count = 0
                expected_count = 1 if message_count == 0 else message_count + 2
                if len(messages) != expected_count:
                    raise RuntimeError(
                        "Anthropic API conversation diverged from the append-only "
                        "referee transcript"
                    )
            budget = _output_token_budget(effort, output)
            request: dict[str, Any] = {
                "model": model_id,
                "max_tokens": budget,
            }
            stable_rules = ""
            if output == "word" and not persistent:
                stable_rules, volatile_state = _stateless_word_parts(messages)
            if persistent:
                request["messages"] = [
                    *provider_history,
                    {"role": "user", "content": messages[-1]["content"]},
                ]
                # Automatic moving cache breakpoints retain the append-only native
                # conversation, including signed hidden-thinking blocks.
                request["cache_control"] = {"type": "ephemeral"}
            elif stable_rules:
                # Word turns are one user message whose tail (the complete public
                # record) changes every turn. A breakpoint placed after the whole
                # message therefore never produces a cache read; pinning it on the
                # byte-identical rules prefix does. Prefixes below the model's
                # minimum cacheable size silently skip caching, which is still
                # cheaper than writing an unreadable full-prompt entry per turn.
                request["messages"] = [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": stable_rules,
                                "cache_control": {"type": "ephemeral"},
                            },
                            {"type": "text", "text": volatile_state},
                        ],
                    }
                ]
            else:
                request["messages"] = _provider_messages(messages, output)
                # Append-only prose/decision conversations still use Anthropic's
                # automatic moving cache breakpoint on the last cacheable block.
                request["cache_control"] = {"type": "ephemeral"}
            if effort == "none":
                # Preserve the original one-word mode: Sonnet 5 defaults to adaptive
                # thinking, so it must be disabled explicitly; Opus accepts the same form.
                request["thinking"] = {"type": "disabled"}
            else:
                # Opus 4.8 and Sonnet 5 support adaptive (not manual-budget) thinking.
                request["thinking"] = {"type": "adaptive"}
                request["output_config"] = {"effort": effort}

            response = client.messages.create(**request)
            if getattr(response, "stop_reason", None) == "max_tokens":
                raise RuntimeError(
                    f"{model_id} exhausted its {budget}-token output budget"
                )
            raw_usage = _json_token_usage(getattr(response, "usage", None))
            setattr(reply, "last_raw_token_usage", raw_usage)
            setattr(
                reply,
                "last_token_usage",
                _normalize_anthropic_token_usage(raw_usage),
            )
            if persistent:
                provider_history = [
                    *request["messages"],
                    {"role": "assistant", "content": list(response.content)},
                ]
            message_count = len(messages) if persistent else 0
            return _text_content(response.content)

        setattr(reply, "last_token_usage", None)
        setattr(reply, "last_raw_token_usage", None)
        return reply

    if provider == "openai":
        if auth == "subscription":
            return OpenAISubscriptionReply(model_id, effort, output, session)
        if not api_key:
            raise ValueError("OpenAI auth requires OPENAI_API_KEY")
        from openai import OpenAI

        client = OpenAI(api_key=api_key)
        previous_response_id: str | None = None
        message_count = 0

        def reply(messages: list[Message]) -> str:
            nonlocal previous_response_id, message_count
            setattr(reply, "last_token_usage", None)
            setattr(reply, "last_raw_token_usage", None)
            if not messages or messages[-1].get("role") != "user":
                raise ValueError("OpenAI API reply requires a final user message")
            persistent = output == "word" and session == "persistent"
            if persistent:
                if len(messages) == 1:
                    previous_response_id = None
                    message_count = 0
                expected_count = 1 if message_count == 0 else message_count + 2
                if len(messages) != expected_count:
                    raise RuntimeError(
                        "OpenAI API conversation diverged from the append-only referee "
                        "transcript"
                    )
            reasoning: dict[str, str] = {"effort": effort}
            if reasoning_mode == "pro":
                reasoning["mode"] = "pro"
            request: dict[str, Any] = {
                "model": model_id,
                "input": (
                    [{"role": "user", "content": messages[-1]["content"]}]
                    if persistent
                    else _provider_messages(messages, output)
                ),
                "reasoning": reasoning,
                "max_output_tokens": _output_token_budget(effort, output),
            }
            if persistent:
                request["store"] = True
                if previous_response_id is not None:
                    request["previous_response_id"] = previous_response_id
            response = client.responses.create(**request)
            if getattr(response, "status", None) == "incomplete":
                details = getattr(response, "incomplete_details", None)
                reason = getattr(details, "reason", None) or "unknown reason"
                raise RuntimeError(
                    f"{model_id} returned an incomplete response: {reason}"
                )
            raw_usage = _json_token_usage(getattr(response, "usage", None))
            setattr(reply, "last_raw_token_usage", raw_usage)
            setattr(
                reply,
                "last_token_usage",
                _normalize_openai_token_usage(raw_usage),
            )
            if persistent:
                response_id = getattr(response, "id", None)
                if not isinstance(response_id, str) or not response_id:
                    raise RuntimeError(
                        f"{model_id} Responses API session returned no response id"
                    )
                previous_response_id = response_id
            message_count = len(messages) if persistent else 0
            return response.output_text

        setattr(reply, "last_token_usage", None)
        setattr(reply, "last_raw_token_usage", None)
        return reply

    raise ValueError(f"unsupported provider: {provider}")


def median_prune_reason(
    finalized_results: Sequence[RunResult],
    live_tries: int,
    *,
    total_runs: int,
) -> MedianPruneReason | None:
    """Return a safe median-only stop reason for the current sequential run.

    A solved-score bound can stop only the live run, after its solve check. A cap-DNF
    majority fixes the median at DNF and lets every not-yet-started run stop at zero.
    Cost-pruned results never count as genuine cap DNFs.
    """
    if not _is_int(total_runs) or total_runs <= 0 or total_runs % 2 == 0:
        raise ValueError("total median runs must be a positive odd integer")
    if not _is_int(live_tries) or live_tries < 0:
        raise ValueError("live tries must be a non-negative integer")
    if len(finalized_results) > total_runs:
        raise ValueError("finalized runs cannot exceed total runs")
    if total_runs == 1 or len(finalized_results) == total_runs:
        return None

    median_count = (total_runs + 1) // 2
    dnf_count = sum(
        result.termination == "cap" for result in finalized_results
    )
    if dnf_count >= total_runs - median_count + 1:
        return "dnf_majority"

    solved_scores = sorted(
        result.tries
        for result in finalized_results
        if result.tries is not None
    )
    if (
        len(solved_scores) >= median_count
        and live_tries >= solved_scores[median_count - 1]
    ):
        return "upper_half"
    return None


def _selection_order(
    item: tuple[int, RunResult],
) -> tuple[float, int, int, int]:
    index, result = item
    return (
        math.inf if result.tries is None else result.tries,
        0 if result.termination in ("solved", "cap") else 1,
        result.turns,
        index,
    )


def select_median_run(results: Sequence[RunResult]) -> int:
    """Return the actual median run's original index under the contract ordering."""
    if not results:
        raise ValueError("cannot select the median of zero runs")
    if len(results) % 2 == 0:
        raise ValueError("run count must be odd so the median is an actual run")
    ordered = sorted(enumerate(results), key=_selection_order)
    return ordered[(len(results) - 1) // 2][0]


def select_best_run(results: Sequence[RunResult]) -> int:
    """Return the lowest success, or a stable full-cap DNF when none succeeded."""
    if not results:
        raise ValueError("cannot select the best of zero runs")
    return min(
        enumerate(results),
        key=lambda item: (
            math.inf if item[1].tries is None else item[1].tries,
            item[1].turns,
            item[0],
        ),
    )[0]


def benchmark_model(
    config: ModelConfig,
    puzzle: dict[str, Any],
    vocab: Iterable[str],
    model_reply: ModelReply,
    *,
    cap: int,
    runs: int,
    on_try: ModelTryReporter | None = None,
    playbook: str | None = None,
    selection: SelectionMode = DEFAULT_SELECTION,
) -> ModelSummary:
    if not _is_int(runs) or runs <= 0:
        raise ValueError("runs must be a positive integer")
    if selection not in SELECTION_MODES:
        raise ValueError(f"unsupported run selection mode: {selection}")
    if selection == "median" and runs % 2 == 0:
        raise ValueError("runs must be odd so the median is an actual run")
    try:
        results: list[RunResult] = []
        for run_number in range(1, runs + 1):
            incumbent_best = min(
                (
                    result.tries
                    for result in results
                    if result.tries is not None
                ),
                default=None,
            )
            reporter = None
            if on_try is not None:

                def reporter(
                    update: TryProgress, current_run: int = run_number
                ) -> None:
                    on_try(current_run, update)

            median_pruner: MedianPrunePredicate | None = None
            if selection == "median":
                finalized_results = tuple(results)

                def should_prune_median(
                    live_tries: int,
                ) -> MedianPruneReason | None:
                    return median_prune_reason(
                        finalized_results,
                        live_tries,
                        total_runs=runs,
                    )

                median_pruner = should_prune_median

            results.append(
                play_puzzle(
                    puzzle,
                    vocab,
                    model_reply,
                    cap=cap,
                    on_try=reporter,
                    strategy=playbook,
                    best_score_to_beat=(
                        incumbent_best
                        if selection == "best"
                        else None
                    ),
                    median_prune=median_pruner,
                )
            )
    finally:
        close = getattr(model_reply, "close", None)
        if callable(close):
            close()
    return ModelSummary(
        config=config,
        results=tuple(results),
        selection=selection,
        selected_run_index=(
            select_median_run(results)
            if selection == "median"
            else select_best_run(results)
        ),
    )


def assert_benchmark_entry_consistent(
    puzzle: dict[str, Any],
    vocab: Iterable[str],
    entry: Mapping[str, Any],
    *,
    cap: int,
) -> None:
    """Hard-fail before embed if the distilled run cannot reproduce its score/state."""
    run = entry.get("run")
    stored_tries = entry.get("tries")
    if not isinstance(run, list) or not all(isinstance(word, str) for word in run):
        raise ValueError("benchmark consistency: run must be an array of strings")
    if stored_tries is not None and (
        not _is_int(stored_tries) or stored_tries <= 0
    ):
        raise ValueError("benchmark consistency: tries must be positive or null")

    referee = PuzzleReferee(puzzle, vocab)
    for word in run:
        if referee.solved:
            raise ValueError(
                "benchmark consistency: run contains guesses after the puzzle was solved"
            )
        feedback = referee.submit(word)
        if feedback.kind != "counted":
            raise ValueError(
                "benchmark consistency: run contains an invalid or folded-duplicate guess"
            )

    if stored_tries is None:
        if referee.solved or referee.tries != cap:
            raise ValueError(
                "benchmark consistency: DNF run must remain unsolved at the counted-try cap"
            )
        return
    if not referee.solved or referee.tries != stored_tries:
        state = "solved" if referee.solved else "unsolved"
        raise ValueError(
            "benchmark consistency: replay score/state mismatch "
            f"(stored={stored_tries}, replayed={referee.tries}, {state})"
        )


def _configured_models() -> list[ModelConfig]:
    configs: list[ModelConfig] = []
    for raw in MODELS:
        provider = raw.get("provider")
        model_id = raw.get("model_id")
        label = raw.get("label")
        tag = raw.get("tag")
        display = raw.get("display")
        if provider not in PROVIDER_ENV:
            raise ValueError(f"unsupported provider in MODELS: {provider!r}")
        if not isinstance(model_id, str) or not model_id.strip():
            raise ValueError("every MODELS entry needs a non-empty model_id")
        if (
            not isinstance(label, str)
            or label != label.strip()
            or not MODEL_LABEL_RE.fullmatch(label)
        ):
            raise ValueError(
                "every MODELS label must be a non-empty uppercase display name"
            )
        if (
            not isinstance(tag, str)
            or tag != tag.strip()
            or not MODEL_TAG_RE.fullmatch(tag)
        ):
            raise ValueError(
                "every MODELS tag must be 1–6 uppercase pixel-friendly characters"
            )
        if not isinstance(display, bool):
            raise ValueError("every MODELS entry needs a boolean display flag")
        configs.append(
            {
                "provider": provider,
                "model_id": model_id,
                "label": label,
                "tag": tag,
                "display": display,
            }
        )
    if sum(config["display"] for config in configs) != DISPLAY_MODEL_COUNT:
        raise ValueError(
            f"MODELS must select exactly {DISPLAY_MODEL_COUNT} display entries"
        )
    if len({config["model_id"] for config in configs}) != len(configs):
        raise ValueError("MODELS model_id values must be unique")
    if len({config["tag"] for config in configs}) != len(configs):
        raise ValueError("MODELS tag values must be unique")
    return configs


def _friendly_model_selector(config: ModelConfig) -> str:
    if config["model_id"].startswith("gpt-5.6-"):
        variant = config["model_id"].removeprefix("gpt-5.6-")
        return f"GPT-{variant.upper()}"
    return config["tag"]


def _model_selector_guidance(configs: Sequence[ModelConfig]) -> str:
    aliases = ", ".join(_friendly_model_selector(config) for config in configs)
    model_ids = ", ".join(config["model_id"] for config in configs)
    return f"Valid values: {aliases}. Exact model IDs are also accepted: {model_ids}."


def select_model(requested: str) -> ModelConfig:
    configs = _configured_models()
    selector = requested.strip().lower()
    for config in configs:
        selection_keys = {
            config["model_id"].lower(),
            _friendly_model_selector(config).lower(),
        }
        if selector in selection_keys:
            return config
    raise ValueError(
        f"unknown model selector {requested!r}. {_model_selector_guidance(configs)}"
    )


def resolve_puzzle_path(path: Path) -> Path:
    """Accept absolute, caller-relative, repo-relative, or generation-relative paths."""
    if path.is_absolute():
        return path
    candidates = (Path.cwd() / path, REPO_ROOT / path, GENERATION_DIR / path)
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    return path


def load_puzzle(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"could not read puzzle {path}: {exc}") from exc
    return _as_record(data, "puzzle root")


def load_playbook_profile(
    path: Path, config: ModelConfig
) -> tuple[str, str]:
    """Load only a finalized model-specific playbook from a distillation profile."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"could not read playbook profile {path}: {exc}") from exc
    profile = _as_record(data, "playbook profile root")
    if (
        profile.get("schema_version") != 1
        or profile.get("kind") != "whippin_model_playbook"
    ):
        raise ValueError(f"malformed playbook profile {path}")
    if profile.get("model_id") != config["model_id"]:
        raise ValueError(
            "playbook profile model does not match the selected model "
            f"({profile.get('model_id')!r} != {config['model_id']!r})"
        )
    if profile.get("provider") != config["provider"]:
        raise ValueError("playbook profile provider does not match the selected model")
    if profile.get("gameplay_prompt_version") != PROMPT_VERSION:
        raise ValueError(
            "playbook profile was distilled for a different gameplay prompt version"
        )
    playbook = profile.get("final_playbook")
    recorded_sha = profile.get("final_playbook_sha256")
    if not isinstance(playbook, str) or not playbook.strip():
        raise ValueError("playbook profile has no finalized playbook")
    actual_sha = hashlib.sha256(playbook.encode("utf-8")).hexdigest()
    if recorded_sha != actual_sha:
        raise ValueError("playbook profile final playbook hash does not match")
    return playbook, actual_sha


def load_vocab(lang: str, vocab_dir: Path = WEB_VOCAB_DIR) -> set[str]:
    path = vocab_dir / f"{lang}.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"could not read vocabulary {path}: {exc}") from exc
    if not isinstance(data, list) or not all(isinstance(word, str) for word in data):
        raise ValueError(f"malformed vocabulary {path}: expected an array of strings")
    return set(data)


def _write_json_atomic(path: Path, data: object, *, indent: int | None = None) -> None:
    temp_path: str | None = None
    original_mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else None
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            delete=False,
        ) as handle:
            temp_path = handle.name
            json.dump(data, handle, ensure_ascii=False, indent=indent)
            if indent is not None:
                handle.write("\n")
        if original_mode is not None:
            os.chmod(temp_path, original_mode)
        os.replace(temp_path, path)
    finally:
        if temp_path and os.path.exists(temp_path):
            os.unlink(temp_path)


def _transport_name(config: ModelConfig, auth: AuthMode) -> str:
    if config["provider"] == "kimi":
        return "kimi_code_agent_sdk"
    if auth == "api":
        return "api"
    return "agent_sdk" if config["provider"] == "anthropic" else "codex_cli"


def _aggregate_token_usage(
    turn_token_usage: Sequence[Mapping[str, Any]],
) -> TokenUsage | None:
    normalized = [
        usage
        for raw_usage in turn_token_usage
        if (usage := _standard_token_usage(raw_usage)) is not None
    ]
    if not normalized:
        return None
    reasoning_values = [
        usage["reasoning_output_tokens"] for usage in normalized
    ]
    reasoning = (
        sum(value for value in reasoning_values if value is not None)
        if all(value is not None for value in reasoning_values)
        else None
    )
    return _canonical_token_usage(
        input_tokens=sum(usage["input_tokens"] for usage in normalized),
        cached_input_tokens=sum(
            usage["cached_input_tokens"] for usage in normalized
        ),
        cache_write_input_tokens=sum(
            usage["cache_write_input_tokens"] for usage in normalized
        ),
        output_tokens=sum(usage["output_tokens"] for usage in normalized),
        reasoning_output_tokens=reasoning,
    )


def _lab_session(
    summary: ModelSummary,
    *,
    cap: int,
    effort: ReasoningEffort,
    auth: AuthMode,
    session: SessionMode,
    timestamp: str,
    playbook_sha256: str | None = None,
) -> dict[str, Any]:
    runs: list[dict[str, Any]] = []
    for index, result in enumerate(summary.results, start=1):
        run: dict[str, Any] = {
            "index": index,
            "selected": index - 1 == summary.selected_run_index,
            "guesses": list(result.tried_words),
            "tries": result.tries,
            "counted_tries": result.counted_tries,
            "turns": result.turns,
            "duration": result.duration,
            "termination": result.termination,
            "transcript": [message.copy() for message in result.conversation],
        }
        canonical_turn_usage = [
            usage
            for raw_usage in result.turn_token_usage
            if (usage := _standard_token_usage(raw_usage)) is not None
        ]
        token_usage = _aggregate_token_usage(canonical_turn_usage)
        if token_usage is not None:
            run["token_usage"] = token_usage
            run["turn_token_usage"] = canonical_turn_usage
        if result.raw_provider_token_usage:
            run["raw_provider_token_usage"] = [
                dict(usage) for usage in result.raw_provider_token_usage
            ]
        runs.append(run)

    config = summary.config
    effective_effort = _effective_provider_effort(config["provider"], effort)
    record: dict[str, Any] = {
        "timestamp": timestamp,
        "prompt_version": PROMPT_VERSION,
        "cap": cap,
        "model_id": config["model_id"],
        "provider": config["provider"],
        "transport": _transport_name(config, auth),
        "auth": auth,
        "session": session,
        "token_usage_schema_version": TOKEN_USAGE_SCHEMA_VERSION,
        "effort": effort,
        "requested_effort": effort,
        "effective_provider_effort": effective_effort,
        "label": config["label"],
        "tag": config["tag"],
        "display": config["display"],
        "selection": summary.selection,
        "selected_run": summary.selected_run_index + 1,
        "duration": summary.duration,
        "benchmark_entry": summary.benchmark_entry(),
        "runs": runs,
    }
    total_usage = _aggregate_token_usage(
        [
            usage
            for result in summary.results
            for usage in result.turn_token_usage
        ]
    )
    if total_usage is not None:
        record["token_usage"] = total_usage
    record[f"{summary.selection}_run"] = summary.selected_run_index + 1
    if playbook_sha256 is not None:
        record["playbook_sha256"] = playbook_sha256
    return record


def write_lab_artifact(
    puzzle_path: Path,
    summary: ModelSummary,
    *,
    cap: int,
    effort: ReasoningEffort,
    auth: AuthMode,
    session: SessionMode = DEFAULT_SESSION,
    output_dir: Path | None = None,
    timestamp: str | None = None,
    playbook_sha256: str | None = None,
) -> tuple[Path, dict[str, Any]]:
    """Append one complete model session to the puzzle's unpublished lab record."""
    directory = BENCHMARK_OUTPUT_DIR if output_dir is None else output_dir
    path = directory / f"{puzzle_path.stem}.bench.json"
    if path.exists():
        try:
            artifact = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"could not read benchmark artifact {path}: {exc}") from exc
        artifact = _as_record(artifact, "benchmark artifact root")
        sessions = artifact.get("sessions")
        if artifact.get("schema_version") != 1 or not isinstance(sessions, list):
            raise ValueError(f"malformed benchmark artifact {path}")
    else:
        artifact = {
            "schema_version": 1,
            "puzzle": puzzle_path.name,
            "sessions": [],
        }
        sessions = artifact["sessions"]

    recorded_at = timestamp or datetime.now(timezone.utc).isoformat().replace(
        "+00:00", "Z"
    )
    sessions.append(
        _lab_session(
            summary,
            cap=cap,
            effort=effort,
            auth=auth,
            session=session,
            timestamp=recorded_at,
            playbook_sha256=playbook_sha256,
        )
    )
    _write_json_atomic(path, artifact, indent=2)
    return path, artifact


def display_benchmark_sessions(
    artifact: Mapping[str, Any],
    *,
    selection: SelectionMode = DEFAULT_SELECTION,
    session: SessionMode = DEFAULT_SESSION,
) -> list[dict[str, Any]]:
    """Take the latest same-selection/session current-prompt run per display model."""
    if selection not in SELECTION_MODES:
        raise ValueError(f"unsupported run selection mode: {selection}")
    if session not in SESSION_MODES:
        raise ValueError(f"unsupported session mode: {session}")
    sessions = artifact.get("sessions")
    if not isinstance(sessions, list):
        raise ValueError("malformed benchmark artifact: sessions must be an array")
    latest: dict[str, dict[str, Any]] = {}
    display_configs = [config for config in _configured_models() if config["display"]]
    display_ids = {config["model_id"] for config in display_configs}
    for raw in reversed(sessions):
        if not isinstance(raw, dict) or raw.get("prompt_version") != PROMPT_VERSION:
            continue
        # Sessions written before selection modes existed were all median sessions.
        session_selection = raw.get("selection", "median")
        if session_selection != selection or raw.get("session") != session:
            continue
        model_id = raw.get("model_id")
        entry = raw.get("benchmark_entry")
        if (
            model_id in display_ids
            and model_id not in latest
            and isinstance(entry, dict)
            and entry.get("model") == model_id
        ):
            latest[model_id] = raw
    return [
        latest[config["model_id"]]
        for config in display_configs
        if config["model_id"] in latest
    ]


def display_benchmark_entries(
    artifact: Mapping[str, Any],
    *,
    selection: SelectionMode = DEFAULT_SELECTION,
    session: SessionMode = DEFAULT_SESSION,
) -> list[dict[str, Any]]:
    return [
        dict(record["benchmark_entry"])
        for record in display_benchmark_sessions(
            artifact, selection=selection, session=session
        )
    ]


def validated_existing_benchmark_entries(
    puzzle: dict[str, Any], vocab: Iterable[str]
) -> list[dict[str, Any]] | None:
    """Return an existing schema-v2 trio only when every run still replays cleanly."""
    raw_entries = puzzle.get("benchmark")
    if not isinstance(raw_entries, list) or len(raw_entries) != DISPLAY_MODEL_COUNT:
        return None

    entries: list[dict[str, Any]] = []
    model_ids: set[str] = set()
    tags: set[str] = set()
    required = {"model", "label", "tag", "tries", "run"}
    for raw_entry in raw_entries:
        if not isinstance(raw_entry, dict) or not required.issubset(raw_entry):
            return None
        entry = dict(raw_entry)
        model_id = entry["model"]
        label = entry["label"]
        tag = entry["tag"]
        tries = entry["tries"]
        run = entry["run"]
        if (
            not isinstance(model_id, str)
            or not model_id
            or model_id != model_id.strip()
            or not isinstance(label, str)
            or label != label.strip()
            or not MODEL_LABEL_RE.fullmatch(label)
            or not isinstance(tag, str)
            or tag != tag.strip()
            or not MODEL_TAG_RE.fullmatch(tag)
            or (tries is not None and (not _is_int(tries) or tries <= 0))
            or not isinstance(run, list)
            or not run
            or not all(
                isinstance(word, str) and word and word == word.strip()
                for word in run
            )
            or (tries is not None and len(run) != tries)
        ):
            return None
        model_ids.add(model_id)
        tags.add(tag)
        try:
            # A DNF's complete run ends exactly at its original cap, so its length is
            # sufficient to reconstruct that cap even though the lean payload omits it.
            replay_cap = len(run) if tries is None else DEFAULT_CAP
            assert_benchmark_entry_consistent(
                puzzle, vocab, entry, cap=replay_cap
            )
        except ValueError:
            return None
        entries.append(entry)

    if len(model_ids) != DISPLAY_MODEL_COUNT or len(tags) != DISPLAY_MODEL_COUNT:
        return None
    return entries


def write_benchmark(
    path: Path,
    puzzle: dict[str, Any],
    entries: Sequence[Mapping[str, Any]] | None,
) -> None:
    """Write only a complete unique display trio; an incomplete refresh stays absent."""
    if entries is None:
        puzzle.pop("benchmark", None)
    else:
        if len(entries) != DISPLAY_MODEL_COUNT:
            raise ValueError(
                f"benchmark payload needs exactly {DISPLAY_MODEL_COUNT} entries"
            )
        copied = [dict(entry) for entry in entries]
        model_ids = {entry.get("model") for entry in copied}
        if len(model_ids) != DISPLAY_MODEL_COUNT or None in model_ids:
            raise ValueError("benchmark payload model entries must be unique")
        tags = {entry.get("tag") for entry in copied}
        if len(tags) != DISPLAY_MODEL_COUNT or None in tags:
            raise ValueError("benchmark payload tag entries must be unique")
        puzzle["benchmark"] = copied
    _write_json_atomic(path, puzzle)


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


class _BenchmarkArgumentParser(argparse.ArgumentParser):
    def __init__(
        self,
        *args: Any,
        argument_guidance: Mapping[str, str],
        **kwargs: Any,
    ):
        self.argument_guidance = argument_guidance
        super().__init__(*args, **kwargs)

    def error(self, message: str) -> None:
        if "expected one argument" in message:
            for argument, guidance in self.argument_guidance.items():
                if f"argument {argument}:" in message:
                    message = f"{message}. {guidance}"
                    break
        super().error(message)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    configs = _configured_models()
    parser = _BenchmarkArgumentParser(
        argument_guidance={
            "--model": _model_selector_guidance(configs),
            "--effort": f"Valid values: {', '.join(EFFORT_LEVELS)}.",
            "--auth": f"Valid values: {', '.join(AUTH_MODES)}.",
            "--session": f"Valid values: {', '.join(SESSION_MODES)}.",
            "--selection": f"Valid values: {', '.join(SELECTION_MODES)}.",
        },
        description="Make one configured LLM play a Whippin puzzle offline and report its score.",
    )
    parser.add_argument("puzzle", type=Path, help="generated puzzle JSON")
    parser.add_argument(
        "--model",
        required=True,
        metavar="MODEL",
        help=(
            "configured friendly selector or exact model id. "
            f"{_model_selector_guidance(configs)}"
        ),
    )
    parser.add_argument(
        "--cap", type=_positive_int, default=DEFAULT_CAP, help="counted-try DNF cap"
    )
    parser.add_argument(
        "--runs",
        type=_positive_int,
        default=None,
        help=(
            "run count for the selected model; median selection requires an odd count "
            f"(default: {DEFAULT_RUNS}; Kimi: {DEFAULT_KIMI_RUNS})"
        ),
    )
    parser.add_argument(
        "--selection",
        choices=SELECTION_MODES,
        default=DEFAULT_SELECTION,
        help=(
            "saved representative run: actual median, or lowest successful best; "
            "sequential median runs prune only provable upper-half tails or after a "
            "cap-DNF majority; best prunes later attempts once they cannot beat the incumbent "
            f"(default: {DEFAULT_SELECTION})"
        ),
    )
    parser.add_argument(
        "--effort",
        choices=EFFORT_LEVELS,
        default=DEFAULT_EFFORT,
        help=(
            "reasoning effort for the selected model "
            f"(default: {DEFAULT_EFFORT}; enabled levels use adaptive thinking)"
        ),
    )
    parser.add_argument(
        "--auth",
        choices=AUTH_MODES,
        default=DEFAULT_AUTH,
        help=(
            "transport for the selected model's provider: API-key billing or isolated "
            f"Claude.ai/ChatGPT/Kimi Code subscription access (default: {DEFAULT_AUTH})"
        ),
    )
    parser.add_argument(
        "--session",
        choices=SESSION_MODES,
        default=DEFAULT_SESSION,
        help=(
            "word-play history transport: one native provider session per run, or "
            "fresh complete-record turns for controlled diagnostics "
            f"(default: {DEFAULT_SESSION})"
        ),
    )
    parser.add_argument(
        "--playbook",
        type=Path,
        help=(
            "final whippin_model_playbook profile for the selected model; only its "
            "hash-verified final_playbook is injected"
        ),
    )
    parser.add_argument(
        "--in-place",
        action="store_true",
        help=(
            "append the full lab artifact and refresh the puzzle's optional "
            "display trio when complete"
        ),
    )
    args = parser.parse_args(argv)
    try:
        args.model_config = select_model(args.model)
    except ValueError as exc:
        parser.error(str(exc))
    if args.runs is None:
        args.runs = (
            DEFAULT_KIMI_RUNS
            if args.model_config["provider"] == "kimi"
            else DEFAULT_RUNS
        )
    if args.selection == "median" and args.runs % 2 == 0:
        parser.error("--runs must be odd so the median is an actual run")
    try:
        _validate_provider_effort(args.model_config["provider"], args.auth, args.effort)
    except ValueError as exc:
        parser.error(str(exc))
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    args.puzzle = resolve_puzzle_path(args.puzzle)
    try:
        puzzle = load_puzzle(args.puzzle)
        lang = puzzle.get("lang")
        if not isinstance(lang, str):
            raise ValueError('malformed puzzle: missing string "lang"')
        vocab = load_vocab(lang)
        # Construct once up front so malformed puzzle data fails before any paid call.
        PuzzleReferee(puzzle, vocab)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    config = args.model_config
    playbook: str | None = None
    playbook_sha256: str | None = None
    if args.playbook is not None:
        args.playbook = resolve_puzzle_path(args.playbook)
        try:
            playbook, playbook_sha256 = load_playbook_profile(args.playbook, config)
        except ValueError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
    api_key: str | None = None
    kimi_subscription_selected = config["provider"] == "kimi"
    if kimi_subscription_selected:
        api_key = os.environ.get(PROVIDER_ENV["kimi"])
        try:
            validate_kimi_subscription_auth(api_key)
        except RuntimeError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2

    anthropic_subscription_selected = (
        args.auth == "subscription" and config["provider"] == "anthropic"
    )
    if anthropic_subscription_selected:
        try:
            validate_anthropic_subscription_auth()
        except RuntimeError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2

    openai_subscription_selected = (
        args.auth == "subscription" and config["provider"] == "openai"
    )
    if openai_subscription_selected:
        try:
            validate_openai_subscription_auth()
        except RuntimeError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2

    effective_effort = _effective_provider_effort(config["provider"], args.effort)
    print(
        f"Whippin benchmark prompt={PROMPT_VERSION} provider={config['provider']} "
        f"model={config['model_id']} transport={_transport_name(config, args.auth)} "
        f"auth={args.auth} session={args.session} requested_effort={args.effort} "
        f"effective_provider_effort={effective_effort} cap={args.cap} runs={args.runs} "
        f"selection={args.selection} token_usage_schema={TOKEN_USAGE_SCHEMA_VERSION} "
        f"playbook={playbook_sha256 or 'none'}",
        flush=True,
    )
    if config["provider"] == "kimi":
        print(
            "KIMI cost notice: low effort still uses adaptive thinking; "
            f"this configuration schedules {args.runs} "
            f"run{'s' if args.runs != 1 else ''} with up to {args.cap} counted "
            f"guesses each in {args.session} mode. Every turn is a paid request, and "
            "malformed or non-counting replies can add requests.",
            flush=True,
        )
    if args.auth != "subscription":
        env_name = PROVIDER_ENV[config["provider"]]
        api_key = os.environ.get(env_name)
        if not api_key:
            print(
                f"warning: skipping {config['tag']} ({config['model_id']}); "
                f"{env_name} is not set",
                file=sys.stderr,
            )
            return 0
    try:

        def print_try(run_number: int, update: TryProgress) -> None:
            run_label = f"run={run_number} " if args.runs > 1 else ""
            word_json = json.dumps(update.word, ensure_ascii=False)
            usage = (
                " token_usage="
                + json.dumps(
                    update.token_usage,
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
                if update.token_usage is not None
                else ""
            )
            print(
                f"{config['tag']:<8} {run_label}try={update.number} "
                f"word={word_json} progress={update.progress:.2f}%{usage}",
                flush=True,
            )

        summary = benchmark_model(
            config,
            puzzle,
            vocab,
            provider_reply(
                config,
                api_key,
                effort=args.effort,
                auth=args.auth,
                session=args.session,
            ),
            cap=args.cap,
            runs=args.runs,
            on_try=print_try,
            playbook=playbook,
            selection=args.selection,
        )
    except Exception as exc:
        print(
            f"error: {config['tag']} ({config['model_id']}) failed: {exc}",
            file=sys.stderr,
        )
        return 1
    score = "DNF" if summary.tries is None else f"{summary.tries} tries"
    selected_label = f"{summary.selection}_run"
    total_usage = _aggregate_token_usage(
        [
            usage
            for result in summary.results
            for usage in result.turn_token_usage
        ]
    )
    usage_text = (
        json.dumps(total_usage, ensure_ascii=False, separators=(",", ":"))
        if total_usage is not None
        else "unreported"
    )
    print(
        f"{config['tag']:<8} {score:>9}  "
        f"{selected_label}={summary.selected_run_index + 1}  "
        f"turns={summary.turns}  duration={summary.duration:.1f}s  "
        f"token_usage={usage_text}  model={config['model_id']}"
    )
    for run_number, result in enumerate(summary.results, start=1):
        run_label = f"run={run_number} " if summary.runs > 1 else ""
        words_json = json.dumps(result.tried_words, ensure_ascii=False)
        prune_note = ""
        if result.termination == "upper_half":
            prune_note = (
                " termination=upper_half cost_pruned=true "
                f"stopped_at={result.counted_tries} score>{result.counted_tries}"
            )
        elif result.termination == "dnf_majority":
            prune_note = (
                " termination=dnf_majority cost_pruned=true median=DNF"
            )
        print(
            f"{config['tag']:<8} {run_label}tried={words_json}{prune_note}"
        )

    if args.in_place:
        try:
            entry = summary.benchmark_entry()
            # This assertion intentionally precedes BOTH output writes: a replay mismatch
            # must never reach the lean puzzle payload or the durable lab record.
            assert_benchmark_entry_consistent(puzzle, vocab, entry, cap=args.cap)
            existing_entries = validated_existing_benchmark_entries(puzzle, vocab)
            had_existing_benchmark = "benchmark" in puzzle
            artifact_path, artifact = write_lab_artifact(
                args.puzzle,
                summary,
                cap=args.cap,
                effort=args.effort,
                auth=args.auth,
                session=args.session,
                playbook_sha256=playbook_sha256,
            )
            print(f"Wrote lab artifact -> {artifact_path}")

            if config["display"]:
                display_sessions = display_benchmark_sessions(
                    artifact,
                    selection=args.selection,
                    session=args.session,
                )
                entries = [
                    dict(session["benchmark_entry"])
                    for session in display_sessions
                ]
                if len(entries) == DISPLAY_MODEL_COUNT:
                    # Recheck every accumulated model against the puzzle as it exists at
                    # embed time. The sentence/ranks may have changed between paid runs.
                    for session, display_entry in zip(
                        display_sessions, entries, strict=True
                    ):
                        session_cap = session.get("cap")
                        if not _is_int(session_cap) or session_cap <= 0:
                            raise ValueError(
                                "benchmark artifact session has an invalid cap"
                            )
                        assert_benchmark_entry_consistent(
                            puzzle, vocab, display_entry, cap=session_cap
                        )
                    write_benchmark(args.puzzle, puzzle, entries)
                    print(f"Wrote benchmark trio -> {args.puzzle}")
                else:
                    # Never replace a valid published trio with a partial refresh.
                    # A legacy/malformed field is still removed because the v2 client
                    # would reject it; an absent field can remain absent without a rewrite.
                    if existing_entries is not None:
                        print(
                            "Benchmark trio pending "
                            f"({len(entries)}/{DISPLAY_MODEL_COUNT}); "
                            f"kept existing benchmark -> {args.puzzle}"
                        )
                    elif had_existing_benchmark:
                        write_benchmark(args.puzzle, puzzle, None)
                        print(
                            "Benchmark trio pending "
                            f"({len(entries)}/{DISPLAY_MODEL_COUNT}); "
                            f'omitted legacy/malformed "benchmark" -> {args.puzzle}'
                        )
                    else:
                        print(
                            "Benchmark trio pending "
                            f"({len(entries)}/{DISPLAY_MODEL_COUNT}); "
                            f'"benchmark" remains absent -> {args.puzzle}'
                        )
            else:
                print("Lab-only model; puzzle benchmark unchanged")
        except Exception as exc:
            print(
                f"error: could not persist {config['tag']} benchmark: {exc}",
                file=sys.stderr,
            )
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
