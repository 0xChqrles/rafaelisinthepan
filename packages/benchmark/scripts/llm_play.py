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
from collections.abc import Callable, Iterable, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
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

# Reuse generation's stdlib-only implementation so the benchmark never grows a second
# copy of the slug/fold contract.
sys.path.insert(0, str(GENERATION_SCRIPTS_DIR))
from slug import slug  # noqa: E402


# Curator-editable benchmark roster. Keep labels short, uppercase, and pixel-friendly;
# these exact display forms are shipped in the puzzle JSON.
MODELS = [
    {"provider": "anthropic", "model_id": "claude-opus-4-8", "label": "OPUS"},
    {"provider": "anthropic", "model_id": "claude-sonnet-5", "label": "SONNET"},
    {"provider": "openai", "model_id": "gpt-5.6-sol", "label": "SOL"},
    {"provider": "openai", "model_id": "gpt-5.6-terra", "label": "TERRA"},
    {"provider": "openai", "model_id": "gpt-5.6-luna", "label": "LUNA"},
]

# Bump whenever the opening rules or turn-feedback scaffold changes materially. Results
# are attributable to a model id plus this prompt version and the CLI's printed effort.
PROMPT_VERSION = "4"

DEFAULT_CAP = 300
MAX_CONSECUTIVE_UNPARSEABLE = 5
MAX_NONCOUNTING_REPLIES = 5

# One cross-provider reasoning control. `none` preserves the original cheap one-word
# requests; the other levels enable provider-native reasoning with enough output room for
# hidden thinking plus the visible guess. OpenAI recommends starting with 25k tokens for
# reasoning workloads, while both providers recommend more headroom at xhigh/max.
ReasoningEffort = Literal["none", "low", "medium", "high", "xhigh", "max"]
EFFORT_LEVELS: tuple[ReasoningEffort, ...] = (
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
)
DEFAULT_EFFORT: ReasoningEffort = "none"
DIRECT_OUTPUT_MAX_TOKENS = 256
REASONING_MAX_TOKENS = 25_000
DEEP_REASONING_MAX_TOKENS = 64_000

AuthMode = Literal["api", "subscription"]
AUTH_MODES: tuple[AuthMode, ...] = ("api", "subscription")
DEFAULT_AUTH: AuthMode = "api"
CODEX_SUBSCRIPTION_EFFORTS: tuple[ReasoningEffort, ...] = (
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
)
# The current GPT-5.6 reasoning guide documents these API levels. The Responses
# schema is broader, but model support is explicitly model-dependent; reject `max`
# before a paid call until the GPT-5.6 model pages document it.
OPENAI_API_EFFORTS: tuple[ReasoningEffort, ...] = (
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
)

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
CODEX_BENCHMARK_INSTRUCTIONS = (
    "You are an isolated word-game player. Treat the user's complete game transcript "
    "as your only task context. Never inspect files, use tools, search, or modify "
    "anything. Reply to the final user message with exactly one word and no punctuation "
    "or explanation."
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

MODEL_LABEL_RE = re.compile(r"^[A-Z0-9][A-Z0-9 -]{0,7}$")

LANGUAGE_NAMES = {"en": "English", "fr": "French"}


class ModelConfig(TypedDict):
    provider: str
    model_id: str
    label: str


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


@dataclass(frozen=True)
class ModelSummary:
    config: ModelConfig
    tries: int | None
    turns: int
    duration: float
    runs: int
    run_tried_words: tuple[tuple[str, ...], ...]

    def benchmark_entry(self) -> dict[str, str | int | None]:
        return {
            "model": self.config["model_id"],
            "label": self.config["label"],
            "tries": self.tries,
        }


class UnparseableReplyError(RuntimeError):
    """A model failed to produce any parseable word five turns in a row."""


class NoProgressReplyError(RuntimeError):
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
        self.holes: list[RuntimeHole] = []

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

    def board(self) -> str:
        rendered = list(self.words)
        for hole in self.holes:
            rendered[hole.pos] = f"{hole.prefix}{hole.word}(-{hole.rank}){hole.suffix}"
        return " ".join(rendered)

    def submit(self, guess: str) -> GuessFeedback:
        folded = slug(guess)
        if folded not in self.vocab:
            return GuessFeedback(
                kind="invalid",
                guess=guess,
                folded=folded,
                message=f'"{guess}" is not a word — this did not count.',
                outcomes=(),
                tries=self.tries,
                solved=self.solved,
            )
        if folded in self.tried:
            return GuessFeedback(
                kind="duplicate",
                guess=guess,
                folded=folded,
                message=f'"{guess}" was already tried — this did not count.',
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

        return GuessFeedback(
            kind="counted",
            guess=guess,
            folded=folded,
            message="",
            outcomes=tuple(outcomes),
            tries=self.tries,
            solved=self.solved,
        )


# Unicode letter-runs optionally joined by internal ASCII dashes. Formatting around one
# word (quotes, Markdown, punctuation) is harmless, but prose must not silently score its
# first token as a guess.
_LEXICAL_WORD = re.compile(r"[^\W\d_]+(?:-[^\W\d_]+)*", re.UNICODE)


def parse_single_word(reply: str) -> str | None:
    matches = _LEXICAL_WORD.findall(reply)
    return matches[0] if len(matches) == 1 else None


def opening_message(referee: PuzzleReferee) -> str:
    language = LANGUAGE_NAMES.get(referee.lang, referee.lang)
    return "\n".join(
        [
            f"Play Whippin AI in {language}. Reply with exactly one {language} word per turn.",
            "Each hidden word reports a closeness rank: lower is closer, 0 is found, and MISS is too far to rank.",
            "Invalid words and repeated words do not count. One guess is tested against every unsolved hidden word.",
            (
                "The board is a sentence: treat each word(-rank) as a replaceable "
                "clue and infer the hidden word's grammar from the fixed context."
            ),
            (
                "Guesses are exact inflected forms, not lemmas: singular/plural and "
                "masculine/feminine forms are distinct guesses."
            ),
            (
                "Do not work strictly left-to-right or exhaust one hidden word "
                "before considering the others. Before committing many tries to one, "
                "sample candidates or probes motivated by every unsolved position; "
                "this may expose a surprisingly easy target."
            ),
            (
                "Compare rank signals and pursue whichever position or direction "
                "looks easiest, regardless of order. If it stalls, switch focus. "
                "After any solve, reread the board and reprioritize: the revealed "
                "word gives new context for the rest."
            ),
            (
                "Use ranks to search, not only to check possible final answers. A "
                "valid exploratory probe does not need to fit the sentence: its ranks "
                "can reveal semantic directions and provide intermediate hints."
            ),
            (
                "Balance direct candidates with probes. To triangulate when needed, "
                "test broader categories, contrasts, related objects or actions, and "
                "neighbors of the warmest clues; compare ranks and follow lower ones."
            ),
            (
                "Once a candidate looks promising, promptly try the form required by "
                "the sentence's number, gender, agreement, or conjugation before "
                "listing more direct synonyms."
            ),
            f"Board: {referee.board()}",
            "Tries: 0",
        ]
    )


def _outcome_text(outcome: HoleOutcome) -> str:
    if outcome.rank is None:
        return f"word {outcome.number}: MISS"
    if outcome.solved:
        return f"word {outcome.number}: 0 solved!"
    if outcome.improved:
        return f"word {outcome.number}: {outcome.rank} closer!"
    return f"word {outcome.number}: {outcome.rank} (not closer)"


def feedback_message(feedback: GuessFeedback, referee: PuzzleReferee) -> str:
    if feedback.kind == "counted":
        lead = "\n".join(_outcome_text(outcome) for outcome in feedback.outcomes)
    else:
        lead = feedback.message
    return "\n".join(
        [
            lead,
            f"Board: {referee.board()}",
            f"Tries: {feedback.tries}",
            "Reply with exactly one word.",
        ]
    )


def unparseable_message(referee: PuzzleReferee) -> str:
    return "\n".join(
        [
            "I could not parse a word — this did not count. Reply with exactly one word.",
            f"Board: {referee.board()}",
            f"Tries: {referee.tries}",
        ]
    )


def play_puzzle(
    puzzle: dict[str, Any],
    vocab: Iterable[str],
    model_reply: ModelReply,
    *,
    cap: int = DEFAULT_CAP,
    on_try: TryReporter | None = None,
) -> RunResult:
    """Run one append-only model conversation through the real puzzle rules."""
    if not _is_int(cap) or cap <= 0:
        raise ValueError("cap must be a positive integer")
    referee = PuzzleReferee(puzzle, vocab)
    if referee.solved:
        raise ValueError("puzzle starts solved; no benchmark can be played")

    messages: list[Message] = [{"role": "user", "content": opening_message(referee)}]
    turns = 0
    consecutive_unparseable = 0
    noncounting_replies = 0
    started = time.monotonic()

    while True:
        raw_reply = model_reply([message.copy() for message in messages])
        turns += 1
        if not isinstance(raw_reply, str):
            raw_reply = ""
        assistant_content = raw_reply.strip() or "[empty response]"
        messages.append({"role": "assistant", "content": assistant_content})

        guess = parse_single_word(raw_reply)
        if guess is None:
            consecutive_unparseable += 1
            if consecutive_unparseable >= MAX_CONSECUTIVE_UNPARSEABLE:
                raise UnparseableReplyError(
                    f"aborted after {MAX_CONSECUTIVE_UNPARSEABLE} consecutive unparseable replies"
                )
            messages.append({"role": "user", "content": unparseable_message(referee)})
            continue

        consecutive_unparseable = 0
        feedback = referee.submit(guess)
        messages.append(
            {"role": "user", "content": feedback_message(feedback, referee)}
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
                    "without a counted try"
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
            )
        if feedback.tries >= cap:
            return RunResult(
                tries=None,
                counted_tries=feedback.tries,
                turns=turns,
                duration=time.monotonic() - started,
                tried_words=tuple(referee.tried_words),
                conversation=tuple(message.copy() for message in messages),
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


def _output_token_budget(effort: ReasoningEffort) -> int:
    if effort == "none":
        # Thinking-off models can still emit visible explanation despite the one-word
        # contract. Leave enough room for a complete reply; strict parsing rejects prose.
        return DIRECT_OUTPUT_MAX_TOKENS
    if effort in {"xhigh", "max"}:
        return DEEP_REASONING_MAX_TOKENS
    return REASONING_MAX_TOKENS


def _supported_efforts(provider: str, auth: AuthMode) -> tuple[ReasoningEffort, ...]:
    if provider == "openai" and auth == "api":
        return OPENAI_API_EFFORTS
    if provider == "openai" and auth == "subscription":
        return CODEX_SUBSCRIPTION_EFFORTS
    return EFFORT_LEVELS


def _validate_provider_effort(
    provider: str, auth: AuthMode, effort: ReasoningEffort
) -> None:
    if effort not in EFFORT_LEVELS:
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


async def _agent_sdk_turn(
    prompt: str,
    *,
    model_id: str,
    effort: ReasoningEffort,
    cwd: str,
    resume: str | None,
) -> tuple[str, str]:
    """Run one isolated Claude.ai-subscription turn and return text + session id."""
    from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

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
    async for message in query(prompt=prompt, options=options):
        if isinstance(message, ResultMessage):
            result_message = message
    if result_message is None:
        raise RuntimeError(f"{model_id} Agent SDK session returned no final result")
    if result_message.is_error:
        detail = (
            result_message.result
            or result_message.stop_reason
            or result_message.subtype
            or "unknown error"
        )
        raise RuntimeError(f"{model_id} Agent SDK session failed: {detail}")
    if not result_message.session_id:
        raise RuntimeError(f"{model_id} Agent SDK session returned no session id")
    return result_message.result or "", result_message.session_id


class AnthropicSubscriptionReply:
    """Synchronous referee adapter over isolated, resumable Agent SDK turns."""

    def __init__(self, model_id: str, effort: ReasoningEffort):
        self.model_id = model_id
        self.effort = effort
        self.session_id: str | None = None
        self._message_count = 0
        self._workspace = tempfile.TemporaryDirectory(prefix="whippin-agent-sdk-")

    def __call__(self, messages: list[Message]) -> str:
        if not messages or messages[-1].get("role") != "user":
            raise ValueError("Agent SDK reply requires a final user message")

        # `benchmark_model` reuses one adapter across median runs. The referee always
        # starts a new run with the one-message opening transcript, so reset the remote
        # session rather than leaking a prior attempt into the next score.
        if len(messages) == 1:
            self.session_id = None
            self._message_count = 0
        elif self.session_id is None:
            raise RuntimeError(
                "Agent SDK conversation cannot resume before its opening turn"
            )

        expected_count = 1 if self._message_count == 0 else self._message_count + 2
        if len(messages) != expected_count:
            raise RuntimeError(
                "Agent SDK conversation diverged from the append-only referee transcript"
            )

        with _subscription_environment():
            text, session_id = asyncio.run(
                _agent_sdk_turn(
                    messages[-1]["content"],
                    model_id=self.model_id,
                    effort=self.effort,
                    cwd=self._workspace.name,
                    resume=self.session_id,
                )
            )
        self.session_id = session_id
        self._message_count = len(messages)
        return text

    def close(self) -> None:
        self._workspace.cleanup()


def _codex_transcript_prompt(messages: list[Message]) -> str:
    transcript = json.dumps(messages, ensure_ascii=False, separators=(",", ":"))
    return "\n".join(
        [
            "Continue the word-game conversation encoded as JSON below.",
            "It is the complete append-only transcript; answer its final user message.",
            "Return exactly one word and nothing else.",
            transcript,
        ]
    )


def _codex_final_message(stdout: str, model_id: str) -> str:
    final_message: str | None = None
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
    return final_message


class OpenAISubscriptionReply:
    """Fresh, isolated Codex CLI turns backed by saved ChatGPT plan auth."""

    def __init__(self, model_id: str, effort: ReasoningEffort):
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
        self._message_count = 0
        self._workspace = tempfile.TemporaryDirectory(prefix="whippin-codex-")
        self._instructions_path = Path(self._workspace.name) / "instructions.md"
        self._instructions_path.write_text(
            CODEX_BENCHMARK_INSTRUCTIONS + "\n", encoding="utf-8"
        )

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
                timeout=CODEX_TURN_TIMEOUT_SECONDS,
                cwd=self._workspace.name,
                env=_environment_without(OPENAI_SUBSCRIPTION_CONFLICT_ENV),
                input=_codex_transcript_prompt(messages),
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
        result = _codex_final_message(completed.stdout, self.model_id)
        self._message_count = len(messages)
        return result

    def close(self) -> None:
        self._workspace.cleanup()


def provider_reply(
    config: ModelConfig,
    api_key: str | None,
    *,
    effort: ReasoningEffort = DEFAULT_EFFORT,
    auth: AuthMode = DEFAULT_AUTH,
) -> ModelReply:
    """Build one provider adapter. Paid SDK imports stay lazy for offline tests."""
    provider = config["provider"]
    model_id = config["model_id"]
    _validate_provider_effort(provider, auth, effort)

    if provider == "anthropic":
        if auth == "subscription":
            return AnthropicSubscriptionReply(model_id, effort)
        if not api_key:
            raise ValueError("Anthropic API auth requires ANTHROPIC_API_KEY")
        import anthropic

        client = anthropic.Anthropic(api_key=api_key)

        def reply(messages: list[Message]) -> str:
            request: dict[str, Any] = {
                "model": model_id,
                "max_tokens": _output_token_budget(effort),
                "messages": messages,
                # Append-only play histories only receive Anthropic's automatic moving
                # cache breakpoint when prompt caching is explicitly enabled.
                "cache_control": {"type": "ephemeral"},
            }
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
                    f"{model_id} exhausted its {_output_token_budget(effort)}-token output budget"
                )
            return _text_content(response.content)

        return reply

    if provider == "openai":
        if auth == "subscription":
            return OpenAISubscriptionReply(model_id, effort)
        if not api_key:
            raise ValueError("OpenAI auth requires OPENAI_API_KEY")
        from openai import OpenAI

        client = OpenAI(api_key=api_key)

        def reply(messages: list[Message]) -> str:
            response = client.responses.create(
                model=model_id,
                input=messages,
                reasoning={"effort": effort},
                max_output_tokens=_output_token_budget(effort),
            )
            if getattr(response, "status", None) == "incomplete":
                details = getattr(response, "incomplete_details", None)
                reason = getattr(details, "reason", None) or "unknown reason"
                raise RuntimeError(
                    f"{model_id} returned an incomplete response: {reason}"
                )
            return response.output_text

        return reply

    raise ValueError(f"unsupported provider: {provider}")


def median_tries(scores: Sequence[int | None]) -> int | None:
    """Numeric median with DNF treated as +infinity, rounded up to a schema integer."""
    if not scores:
        raise ValueError("cannot take the median of zero runs")
    ordered = sorted(math.inf if score is None else score for score in scores)
    midpoint = len(ordered) // 2
    if len(ordered) % 2:
        value = ordered[midpoint]
    else:
        value = (ordered[midpoint - 1] + ordered[midpoint]) / 2
    if math.isinf(value):
        return None
    return math.floor(value + 0.5)


def benchmark_model(
    config: ModelConfig,
    puzzle: dict[str, Any],
    vocab: Iterable[str],
    model_reply: ModelReply,
    *,
    cap: int,
    runs: int,
    on_try: ModelTryReporter | None = None,
) -> ModelSummary:
    if not _is_int(runs) or runs <= 0:
        raise ValueError("runs must be a positive integer")
    try:
        results = []
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
                )
            )
    finally:
        close = getattr(model_reply, "close", None)
        if callable(close):
            close()
    return ModelSummary(
        config=config,
        tries=median_tries([result.tries for result in results]),
        turns=sum(result.turns for result in results),
        duration=sum(result.duration for result in results),
        runs=runs,
        run_tried_words=tuple(result.tried_words for result in results),
    )


def select_model(requested: str) -> ModelConfig:
    def selection_keys(config: ModelConfig) -> set[str]:
        keys = {config["model_id"].lower()}
        if config["model_id"].startswith("gpt-5.6-"):
            variant = config["model_id"].removeprefix("gpt-5.6-")
            keys.add(f"gpt-{variant}")
        else:
            keys.add(config["label"].lower())
        return keys

    configs: list[ModelConfig] = []
    for raw in MODELS:
        provider = raw.get("provider")
        model_id = raw.get("model_id")
        label = raw.get("label")
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
                "every MODELS label must be 1–8 uppercase pixel-friendly characters"
            )
        configs.append({"provider": provider, "model_id": model_id, "label": label})
    selector = requested.strip().lower()
    for config in configs:
        if selector in selection_keys(config):
            return config
    raise ValueError(f"unknown model selector: {requested}")


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


def load_vocab(lang: str, vocab_dir: Path = WEB_VOCAB_DIR) -> set[str]:
    path = vocab_dir / f"{lang}.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"could not read vocabulary {path}: {exc}") from exc
    if not isinstance(data, list) or not all(isinstance(word, str) for word in data):
        raise ValueError(f"malformed vocabulary {path}: expected an array of strings")
    return set(data)


def write_benchmark(
    path: Path,
    puzzle: dict[str, Any],
    entry: dict[str, str | int | None],
) -> None:
    existing = puzzle.get("benchmark")
    entries = list(existing) if isinstance(existing, list) else []
    for index, current in enumerate(entries):
        if isinstance(current, dict) and current.get("model") == entry["model"]:
            entries[index] = entry
            break
    else:
        entries.append(entry)
    puzzle["benchmark"] = entries
    temp_path: str | None = None
    original_mode = stat.S_IMODE(path.stat().st_mode)
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            delete=False,
        ) as handle:
            temp_path = handle.name
            json.dump(puzzle, handle, ensure_ascii=False)
        os.chmod(temp_path, original_mode)
        os.replace(temp_path, path)
    finally:
        if temp_path and os.path.exists(temp_path):
            os.unlink(temp_path)


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Make one configured LLM play a Whippin puzzle offline and report its score."
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
        type=_positive_int,
        default=1,
        help="runs for the selected model; persist the median",
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
        "--in-place",
        action="store_true",
        help='write successful results to the puzzle\'s optional "benchmark" field',
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
        f"auth={args.auth} cap={args.cap} runs={args.runs}",
        flush=True,
    )
    subscription_auth = args.auth == "subscription"
    api_key = None
    if not subscription_auth:
        env_name = PROVIDER_ENV[config["provider"]]
        api_key = os.environ.get(env_name)
        if not api_key:
            print(
                f"warning: skipping {config['label']} ({config['model_id']}); "
                f"{env_name} is not set",
                file=sys.stderr,
            )
            return 0
    try:

        def print_try(run_number: int, update: TryProgress) -> None:
            run_label = f"run={run_number} " if args.runs > 1 else ""
            word_json = json.dumps(update.word, ensure_ascii=False)
            print(
                f"{config['label']:<8} {run_label}try={update.number} "
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
        )
    except Exception as exc:
        print(
            f"error: {config['label']} ({config['model_id']}) failed: {exc}",
            file=sys.stderr,
        )
        return 1
    score = "DNF" if summary.tries is None else f"{summary.tries} tries"
    print(
        f"{config['label']:<8} {score:>9}  "
        f"turns={summary.turns}  duration={summary.duration:.1f}s  model={config['model_id']}"
    )
    for run_number, tried_words in enumerate(summary.run_tried_words, start=1):
        run_label = f"run={run_number} " if summary.runs > 1 else ""
        words_json = json.dumps(tried_words, ensure_ascii=False)
        print(f"{config['label']:<8} {run_label}tried={words_json}")

    if args.in_place:
        write_benchmark(args.puzzle, puzzle, summary.benchmark_entry())
        print(f"Wrote benchmark -> {args.puzzle}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
