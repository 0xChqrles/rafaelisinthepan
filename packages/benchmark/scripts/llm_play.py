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
]
DISPLAY_MODEL_COUNT = 3

# Bump whenever the opening rules or turn-feedback scaffold changes materially. Results
# are attributable to a model id plus this prompt version and the CLI's printed effort.
PROMPT_VERSION = "21"

DEFAULT_CAP = 300
DEFAULT_RUNS = 7
MAX_CONSECUTIVE_UNPARSEABLE = 5
MAX_NONCOUNTING_REPLIES = 5

# One cross-provider reasoning control. `none` preserves the original cheap one-word
# requests; the other levels enable provider-native reasoning with enough output room for
# hidden thinking plus the visible guess. OpenAI recommends starting with 25k tokens for
# reasoning workloads, while both providers recommend more headroom at xhigh/max.
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
ReasoningMode = Literal["standard", "pro"]

# A subscription run must never inherit a developer-platform credential or cloud
# provider override: Claude Code gives environment credentials precedence over the
# logged-in Claude.ai plan. Temporarily removing these also keeps the auth preflight and
# the Agent SDK subprocess on the same first-party subscription route.
SUBSCRIPTION_CONFLICT_ENV = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
)

# `CODEX_API_KEY` overrides saved CLI auth for one `codex exec` invocation. Strip it,
# every other OpenAI/Azure API route, and the parent Codex thread metadata so a plan run
# can only use the separately persisted ChatGPT login in CODEX_HOME.
OPENAI_SUBSCRIPTION_CONFLICT_ENV = (
    "OPENAI_API_KEY",
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
CODEX_TOOL_ITEM_TYPES = {
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "web_search",
}

PROVIDER_ENV = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
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


@dataclass(frozen=True)
class RunResult:
    # None is the persisted DNF value; counted_tries still records where the cap landed.
    tries: int | None
    counted_tries: int
    turns: int
    duration: float
    tried_words: tuple[str, ...]
    conversation: tuple[Message, ...]
    turn_token_usage: tuple[dict[str, Any], ...]


@dataclass(frozen=True)
class ModelSummary:
    config: ModelConfig
    results: tuple[RunResult, ...]
    median_run_index: int

    @property
    def median_run(self) -> RunResult:
        return self.results[self.median_run_index]

    @property
    def tries(self) -> int | None:
        return self.median_run.tries

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
        return {
            "model": self.config["model_id"],
            "label": self.config["label"],
            "tag": self.config["tag"],
            "tries": self.tries,
            "run": list(self.median_run.tried_words),
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
def _subscription_environment():
    """Hide pay-as-you-go credentials while Claude Code uses Claude.ai OAuth."""
    saved = {
        name: os.environ.pop(name)
        for name in SUBSCRIPTION_CONFLICT_ENV
        if name in os.environ
    }
    try:
        yield
    finally:
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


def _last_token_usage(model_reply: ModelReply) -> dict[str, Any] | None:
    return _json_token_usage(getattr(model_reply, "last_token_usage", None))


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
        # folded forms in the authoritative snapshot prevents a stateless transport
        # from paying repeatedly for the same rejected answer.
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
        "NOT SENTENCE TEXT:",
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
                "Your score is the total number of unique valid guesses; every "
                "counted guess is expensive."
            ),
            (
                f"The run has a limit of {cap} counted tries. Solving every word on "
                f"counted try {cap} succeeds; if any word remains unsolved after that "
                "try, the run is DNF. The first reply is the first guess, not a plan."
            ),
            "",
            "MANDATORY REPLY CONTRACT",
            *_reply_contract_lines(referee, language),
            "",
            "CLOZE AND EXACT ANSWERS",
            (
                "The CLOZE is a fixed real sentence. Each [WORD N] hides exactly one "
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
                "Embedding ranks measure distributional contextual relatedness, not "
                "guaranteed synonymy, grammar, or implication. Only rank 0 certifies "
                "the exact word."
            ),
            "",
            "AUTHORITATIVE STATE",
            (
                "Each turn includes rules, initial state and starting clues, then "
                "every prior PLAYER REPLY and exact REFEREE FEEDBACK in order. "
                "Snapshots never erase earlier rank/MISS evidence; the last feedback is "
                "current."
            ),
            (
                "Every model receives the identical record; hidden session "
                "memory supplies no evidence."
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
    # Prompt v21 has one strategy-neutral rules scaffold for every caller. The flag is
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
    # Prompt v21 never adds generic solving advice during play. Keep the keyword for
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
) -> RunResult:
    """Run one append-only model conversation through the real puzzle rules.

    `strategy` is optional model-authored playbook guidance injected into the opening
    as advice under the fixed rules. There is no
    pre-game planning turn: the first reply is the first guess.
    """
    if not _is_int(cap) or cap <= 0:
        raise ValueError("cap must be a positive integer")
    referee = PuzzleReferee(puzzle, vocab)
    if referee.solved:
        raise ValueError("puzzle starts solved; no benchmark can be played")

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
    turn_token_usage: list[dict[str, Any]] = []

    while True:
        raw_reply = model_reply([message.copy() for message in messages])
        usage = _last_token_usage(model_reply)
        if usage is not None:
            turn_token_usage.append(usage)
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
    supported = _supported_efforts(provider, auth)
    if effort not in supported:
        levels = "|".join(supported)
        provider_name = "OpenAI" if provider == "openai" else provider.title()
        auth_name = "API" if auth == "api" else "subscription"
        raise ValueError(
            f"{provider_name} {auth_name} benchmark does not allow reasoning effort "
            f"{effort!r}; use {levels}"
        )


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
        # Defensive compatibility for direct adapter callers. Production v21 game
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
    for turn_index, message_index in enumerate(range(1, len(messages), 2), start=1):
        record.extend(
            [
                f"PLAYER REPLY {turn_index}\n{messages[message_index]['content']}",
                (
                    f"REFEREE FEEDBACK {turn_index}\n"
                    f"{messages[message_index + 1]['content']}"
                ),
            ]
        )
    return stable, "\n\n".join(record)


def _stateless_word_prompt(messages: list[Message]) -> str:
    """Return one fresh prompt containing the complete chronological public record.

    Every real word-play transport sees this identical user prompt. All prior replies,
    exact referee outcomes, and the initial starting clues are explicit, so neither
    provider-specific session memory nor a lossy current-best snapshot becomes an
    experimental treatment.
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
) -> tuple[str, str, dict[str, Any] | None]:
    """Run one isolated Claude.ai-subscription turn and return text, session, usage."""
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
        cwd=cwd,
        resume=resume,
        max_turns=1,
        thinking=thinking,
        effort=sdk_effort,
        extra_args={"safe-mode": None, "disable-slash-commands": None},
    )
    result_message = None
    assistant_text = ""
    async for message in query(prompt=prompt, options=options):
        if AssistantMessage is not None and isinstance(message, AssistantMessage):
            assistant_text = _merge_agent_text_continuation(
                assistant_text,
                _text_content(message.content),
            )
        if isinstance(message, ResultMessage):
            result_message = message
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
        for candidate in (
            result_message.result,
            result_message.stop_reason,
            result_message.subtype,
        ):
            if isinstance(candidate, str) and candidate and candidate not in details:
                details.append(candidate)
        detail = "; ".join(details) or "unknown error"
        raise RuntimeError(f"{model_id} Agent SDK session failed: {detail}")
    if not result_message.session_id:
        raise RuntimeError(f"{model_id} Agent SDK session returned no session id")
    return (
        assistant_text or result_message.result or "",
        result_message.session_id,
        _json_token_usage(getattr(result_message, "usage", None)),
    )


class AnthropicSubscriptionReply:
    """Synchronous referee adapter over isolated Agent SDK turns."""

    def __init__(
        self,
        model_id: str,
        effort: ReasoningEffort,
        output: OutputMode = "word",
    ):
        self.model_id = model_id
        self.effort = effort
        self.output = output
        self.session_id: str | None = None
        self._message_count = 0
        self._workspace = tempfile.TemporaryDirectory(prefix="whippin-agent-sdk-")
        self.last_token_usage: dict[str, Any] | None = None

    def __call__(self, messages: list[Message]) -> str:
        if not messages or messages[-1].get("role") != "user":
            raise ValueError("Agent SDK reply requires a final user message")

        # `benchmark_model` reuses one adapter across median runs. A one-message
        # transcript always starts a fresh attempt.
        if len(messages) == 1:
            self.session_id = None
            self._message_count = 0
        elif self._message_count == 0:
            raise RuntimeError(
                "Agent SDK conversation cannot continue before its opening turn"
            )

        expected_count = 1 if self._message_count == 0 else self._message_count + 2
        if len(messages) != expected_count:
            raise RuntimeError(
                "Agent SDK conversation diverged from the append-only referee transcript"
            )

        # Word play uses a fresh provider turn containing the same fixed rules and
        # complete chronological public record as every other transport. Other output
        # modes retain their existing resumable-session behavior.
        prompt = messages[-1]["content"]
        resume = self.session_id
        if self.output == "word":
            prompt = _stateless_word_prompt(messages)
            resume = None

        with _subscription_environment():
            text, session_id, usage = asyncio.run(
                _agent_sdk_turn(
                    prompt,
                    model_id=self.model_id,
                    effort=self.effort,
                    cwd=self._workspace.name,
                    resume=resume,
                )
            )
        self.session_id = session_id if self.output != "word" else None
        self._message_count = len(messages)
        self.last_token_usage = usage
        return text

    def close(self) -> None:
        self._workspace.cleanup()


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
) -> tuple[str, dict[str, Any] | None]:
    final_message: str | None = None
    token_usage: dict[str, Any] | None = None
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
        if event_type == "turn.completed":
            token_usage = _json_token_usage(event.get("usage"))
            continue
        if not isinstance(event_type, str) or not event_type.startswith("item."):
            continue
        item = event.get("item")
        if not isinstance(item, dict):
            raise RuntimeError(f"{model_id} Codex CLI returned a malformed item event")
        item_type = item.get("type")
        if item_type in CODEX_TOOL_ITEM_TYPES:
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
    return final_message, token_usage


class OpenAISubscriptionReply:
    """Fresh, isolated Codex CLI turns backed by saved ChatGPT plan auth."""

    def __init__(
        self, model_id: str, effort: ReasoningEffort, output: OutputMode = "word"
    ):
        if effort not in CODEX_SUBSCRIPTION_EFFORTS:
            supported = "|".join(CODEX_SUBSCRIPTION_EFFORTS)
            raise ValueError(
                "OpenAI subscription auth does not support reasoning effort "
                f"{effort!r}; use {supported}"
            )
        cli = shutil.which("codex")
        if cli is None:
            raise RuntimeError("Codex CLI is not installed")
        self.cli = cli
        self.model_id = model_id
        self.effort = effort
        self.output = output
        self.timeout_seconds = (
            CODEX_PROSE_TIMEOUT_SECONDS
            if output == "prose"
            else CODEX_TURN_TIMEOUT_SECONDS
        )
        self._message_count = 0
        self._workspace = tempfile.TemporaryDirectory(prefix="whippin-codex-")
        self.last_token_usage: dict[str, Any] | None = None
        instructions = {
            "word": CODEX_BENCHMARK_INSTRUCTIONS,
            "decision": CODEX_DECISION_INSTRUCTIONS,
            "prose": CODEX_PROSE_INSTRUCTIONS,
        }[output]
        self._instructions_path = Path(self._workspace.name) / "instructions.md"
        self._instructions_path.write_text(instructions + "\n", encoding="utf-8")

    def _command(self) -> list[str]:
        config = [
            f"approval_policy={json.dumps('never')}",
            f"model_reasoning_effort={json.dumps(self.effort)}",
            f"model_instructions_file={json.dumps(str(self._instructions_path))}",
            "features.apps=false",
            "features.shell_tool=false",
            "features.multi_agent=false",
            f"web_search={json.dumps('disabled')}",
            f"history.persistence={json.dumps('none')}",
            "feedback.enabled=false",
            "analytics.enabled=false",
        ]
        command = [
            self.cli,
            "exec",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--skip-git-repo-check",
            "--strict-config",
            "--json",
            "--sandbox",
            "read-only",
            "--cd",
            self._workspace.name,
            "--model",
            self.model_id,
        ]
        for value in config:
            command.extend(("--config", value))
        command.append("-")
        return command

    def __call__(self, messages: list[Message]) -> str:
        if not messages or messages[-1].get("role") != "user":
            raise ValueError("Codex CLI reply requires a final user message")

        if len(messages) == 1:
            self._message_count = 0
        expected_count = 1 if self._message_count == 0 else self._message_count + 2
        if len(messages) != expected_count:
            raise RuntimeError(
                "Codex CLI conversation diverged from the append-only referee transcript"
            )

        try:
            completed = subprocess.run(
                self._command(),
                check=False,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
                cwd=self._workspace.name,
                env=_environment_without(OPENAI_SUBSCRIPTION_CONFLICT_ENV),
                input=_codex_snapshot_prompt(messages, self.output),
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
        result, usage = _codex_final_message(completed.stdout, self.model_id)
        self._message_count = len(messages)
        self.last_token_usage = usage
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
) -> ModelReply:
    """Build one provider adapter. Paid SDK imports stay lazy for offline tests.

    `output` fixes the adapter's response mode at construction: "word" for the
    ordinary benchmark, "decision" for structured controllers, and "prose" for
    long-form analysis. OpenAI API callers can additionally request documented Pro
    reasoning with max effort; other transports reject that wire-only option.
    """
    provider = config["provider"]
    model_id = config["model_id"]
    _validate_provider_effort(provider, auth, effort)
    _validate_reasoning_mode(provider, auth, effort, reasoning_mode)

    if provider == "anthropic":
        if auth == "subscription":
            return AnthropicSubscriptionReply(model_id, effort, output)
        if not api_key:
            raise ValueError("Anthropic API auth requires ANTHROPIC_API_KEY")
        import anthropic

        client = anthropic.Anthropic(api_key=api_key)

        def reply(messages: list[Message]) -> str:
            setattr(reply, "last_token_usage", None)
            budget = _output_token_budget(effort, output)
            request: dict[str, Any] = {
                "model": model_id,
                "max_tokens": budget,
            }
            stable_rules = ""
            if output == "word":
                stable_rules, volatile_state = _stateless_word_parts(messages)
            if stable_rules:
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
            setattr(
                reply,
                "last_token_usage",
                _json_token_usage(getattr(response, "usage", None)),
            )
            return _text_content(response.content)

        setattr(reply, "last_token_usage", None)
        return reply

    if provider == "openai":
        if auth == "subscription":
            return OpenAISubscriptionReply(model_id, effort, output)
        if not api_key:
            raise ValueError("OpenAI auth requires OPENAI_API_KEY")
        from openai import OpenAI

        client = OpenAI(api_key=api_key)

        def reply(messages: list[Message]) -> str:
            setattr(reply, "last_token_usage", None)
            reasoning: dict[str, str] = {"effort": effort}
            if reasoning_mode == "pro":
                reasoning["mode"] = "pro"
            response = client.responses.create(
                model=model_id,
                input=_provider_messages(messages, output),
                reasoning=reasoning,
                max_output_tokens=_output_token_budget(effort, output),
            )
            if getattr(response, "status", None) == "incomplete":
                details = getattr(response, "incomplete_details", None)
                reason = getattr(details, "reason", None) or "unknown reason"
                raise RuntimeError(
                    f"{model_id} returned an incomplete response: {reason}"
                )
            setattr(
                reply,
                "last_token_usage",
                _json_token_usage(getattr(response, "usage", None)),
            )
            return response.output_text

        setattr(reply, "last_token_usage", None)
        return reply

    raise ValueError(f"unsupported provider: {provider}")


def select_median_run(results: Sequence[RunResult]) -> int:
    """Return the actual median run's original index under the contract ordering."""
    if not results:
        raise ValueError("cannot select the median of zero runs")
    if len(results) % 2 == 0:
        raise ValueError("run count must be odd so the median is an actual run")
    ordered = sorted(
        enumerate(results),
        key=lambda item: (
            math.inf if item[1].tries is None else item[1].tries,
            item[1].turns,
            item[0],
        ),
    )
    return ordered[(len(results) - 1) // 2][0]


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
) -> ModelSummary:
    if not _is_int(runs) or runs <= 0:
        raise ValueError("runs must be a positive integer")
    if runs % 2 == 0:
        raise ValueError("runs must be odd so the median is an actual run")
    try:
        results: list[RunResult] = []
        for run_number in range(1, runs + 1):
            reporter = None
            if on_try is not None:

                def reporter(
                    update: TryProgress, current_run: int = run_number
                ) -> None:
                    on_try(current_run, update)

            results.append(
                play_puzzle(
                    puzzle,
                    vocab,
                    model_reply,
                    cap=cap,
                    on_try=reporter,
                    strategy=playbook,
                )
            )
    finally:
        close = getattr(model_reply, "close", None)
        if callable(close):
            close()
    return ModelSummary(
        config=config,
        results=tuple(results),
        median_run_index=select_median_run(results),
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
    if auth == "api":
        return "api"
    return "agent_sdk" if config["provider"] == "anthropic" else "codex_cli"


def _aggregate_token_usage(
    turn_token_usage: Sequence[Mapping[str, Any]],
) -> dict[str, int] | None:
    totals: dict[str, int] = {}
    for usage in turn_token_usage:
        for key, value in usage.items():
            if "token" in key.lower() and _is_int(value):
                totals[key] = totals.get(key, 0) + value
    return totals or None


def _lab_session(
    summary: ModelSummary,
    *,
    cap: int,
    effort: ReasoningEffort,
    auth: AuthMode,
    timestamp: str,
    playbook_sha256: str | None = None,
) -> dict[str, Any]:
    runs: list[dict[str, Any]] = []
    for index, result in enumerate(summary.results, start=1):
        run: dict[str, Any] = {
            "index": index,
            "selected": index - 1 == summary.median_run_index,
            "guesses": list(result.tried_words),
            "tries": result.tries,
            "counted_tries": result.counted_tries,
            "turns": result.turns,
            "duration": result.duration,
            "transcript": [message.copy() for message in result.conversation],
        }
        token_usage = _aggregate_token_usage(result.turn_token_usage)
        if token_usage is not None:
            run["token_usage"] = token_usage
            run["turn_token_usage"] = [
                dict(usage) for usage in result.turn_token_usage
            ]
        runs.append(run)

    config = summary.config
    session: dict[str, Any] = {
        "timestamp": timestamp,
        "prompt_version": PROMPT_VERSION,
        "cap": cap,
        "model_id": config["model_id"],
        "provider": config["provider"],
        "transport": _transport_name(config, auth),
        "effort": effort,
        "label": config["label"],
        "tag": config["tag"],
        "display": config["display"],
        "median_run": summary.median_run_index + 1,
        "benchmark_entry": summary.benchmark_entry(),
        "runs": runs,
    }
    if playbook_sha256 is not None:
        session["playbook_sha256"] = playbook_sha256
    return session


def write_lab_artifact(
    puzzle_path: Path,
    summary: ModelSummary,
    *,
    cap: int,
    effort: ReasoningEffort,
    auth: AuthMode,
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
            timestamp=recorded_at,
            playbook_sha256=playbook_sha256,
        )
    )
    _write_json_atomic(path, artifact, indent=2)
    return path, artifact


def display_benchmark_sessions(artifact: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Take the latest current-prompt lab session for each configured display model."""
    sessions = artifact.get("sessions")
    if not isinstance(sessions, list):
        raise ValueError("malformed benchmark artifact: sessions must be an array")
    latest: dict[str, dict[str, Any]] = {}
    display_configs = [config for config in _configured_models() if config["display"]]
    display_ids = {config["model_id"] for config in display_configs}
    for raw in reversed(sessions):
        if not isinstance(raw, dict) or raw.get("prompt_version") != PROMPT_VERSION:
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


def display_benchmark_entries(artifact: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [
        dict(session["benchmark_entry"])
        for session in display_benchmark_sessions(artifact)
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


def _odd_positive_int(value: str) -> int:
    parsed = _positive_int(value)
    if parsed % 2 == 0:
        raise argparse.ArgumentTypeError(
            "must be odd so the median is an actual run"
        )
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
        },
        description="Make one configured LLM play a Whippin puzzle offline and report its score.",
    )
    parser.add_argument("puzzle", type=Path, help="generated puzzle JSON")
    parser.add_argument(
        "--model",
        required=True,
        metavar="MODEL",
        help=("OPUS, SONNET, GPT-SOL, GPT-TERRA, GPT-LUNA, or an exact model id"),
    )
    parser.add_argument(
        "--cap", type=_positive_int, default=DEFAULT_CAP, help="counted-try DNF cap"
    )
    parser.add_argument(
        "--runs",
        type=_odd_positive_int,
        default=DEFAULT_RUNS,
        help=(
            "odd run count for the selected model; persist the actual median run "
            f"(default: {DEFAULT_RUNS})"
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
            f"Claude.ai/ChatGPT plan access (default: {DEFAULT_AUTH})"
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

    print(
        f"Whippin benchmark prompt={PROMPT_VERSION} effort={args.effort} "
        f"auth={args.auth} cap={args.cap} runs={args.runs} "
        f"playbook={playbook_sha256 or 'none'}",
        flush=True,
    )
    subscription_auth = args.auth == "subscription"
    api_key = None
    if not subscription_auth:
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
            print(
                f"{config['tag']:<8} {run_label}try={update.number} "
                f"word={word_json} progress={update.progress:.2f}%",
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
            ),
            cap=args.cap,
            runs=args.runs,
            on_try=print_try,
            playbook=playbook,
        )
    except Exception as exc:
        print(
            f"error: {config['tag']} ({config['model_id']}) failed: {exc}",
            file=sys.stderr,
        )
        return 1
    score = "DNF" if summary.tries is None else f"{summary.tries} tries"
    print(
        f"{config['tag']:<8} {score:>9}  median_run={summary.median_run_index + 1}  "
        f"turns={summary.turns}  duration={summary.duration:.1f}s  model={config['model_id']}"
    )
    for run_number, tried_words in enumerate(summary.run_tried_words, start=1):
        run_label = f"run={run_number} " if summary.runs > 1 else ""
        words_json = json.dumps(tried_words, ensure_ascii=False)
        print(f"{config['tag']:<8} {run_label}tried={words_json}")

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
                playbook_sha256=playbook_sha256,
            )
            print(f"Wrote lab artifact -> {artifact_path}")

            if config["display"]:
                display_sessions = display_benchmark_sessions(artifact)
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
