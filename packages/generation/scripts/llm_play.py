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
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time
from typing import Any, TypedDict

from slug import slug


# Curator-editable benchmark roster. Keep labels short, uppercase, and pixel-friendly;
# these exact display forms are shipped in the puzzle JSON.
MODELS = [
    {"provider": "anthropic", "model_id": "claude-opus-4-8", "label": "OPUS"},
    {"provider": "anthropic", "model_id": "claude-sonnet-5", "label": "SONNET"},
    {"provider": "openai", "model_id": "gpt-5.6-sol", "label": "GPT"},
]

# Bump whenever the opening rules or turn-feedback scaffold changes materially. Results
# are then attributable to a model id plus this prompt version in CLI output/history.
PROMPT_VERSION = "1"

DEFAULT_CAP = 300
MAX_CONSECUTIVE_UNPARSEABLE = 5

SCRIPT_DIR = Path(__file__).resolve().parent
GENERATION_DIR = SCRIPT_DIR.parent
WEB_VOCAB_DIR = GENERATION_DIR.parent / "web" / "public" / "vocab"

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
class RunResult:
    # None is the persisted DNF value; counted_tries still records where the cap landed.
    tries: int | None
    counted_tries: int
    turns: int
    duration: float
    conversation: tuple[Message, ...]


@dataclass(frozen=True)
class ModelSummary:
    config: ModelConfig
    tries: int | None
    turns: int
    duration: float
    runs: int

    def benchmark_entry(self) -> dict[str, str | int | None]:
        return {
            "model": self.config["model_id"],
            "label": self.config["label"],
            "tries": self.tries,
        }


class UnparseableReplyError(RuntimeError):
    """A model failed to produce any parseable word five turns in a row."""


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


# First Unicode letter-run, optionally joined by internal ASCII dashes. Formatting around
# a word (quotes, Markdown, punctuation) is harmless; a reply with no lexical word is not.
_FIRST_WORD = re.compile(r"[^\W\d_]+(?:-[^\W\d_]+)*", re.UNICODE)


def parse_first_word(reply: str) -> str | None:
    match = _FIRST_WORD.search(reply)
    return match.group(0) if match else None


def opening_message(referee: PuzzleReferee) -> str:
    language = LANGUAGE_NAMES.get(referee.lang, referee.lang)
    return "\n".join(
        [
            f"Play Whippin AI in {language}. Reply with exactly one {language} word per turn.",
            "Each hidden word reports a closeness rank: lower is closer, 0 is found, and MISS is too far to rank.",
            "Invalid words and repeated words do not count. One guess is tested against every unsolved hidden word.",
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
    started = time.monotonic()

    while True:
        raw_reply = model_reply([message.copy() for message in messages])
        turns += 1
        if not isinstance(raw_reply, str):
            raw_reply = ""
        assistant_content = raw_reply.strip() or "[empty response]"
        messages.append({"role": "assistant", "content": assistant_content})

        guess = parse_first_word(raw_reply)
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

        # A solve on try N wins even when N equals the cap. The cap is a DNF only when
        # unsolved after that many counted, unique, vocabulary-valid guesses.
        if feedback.solved:
            return RunResult(
                tries=feedback.tries,
                counted_tries=feedback.tries,
                turns=turns,
                duration=time.monotonic() - started,
                conversation=tuple(message.copy() for message in messages),
            )
        if feedback.tries >= cap:
            return RunResult(
                tries=None,
                counted_tries=feedback.tries,
                turns=turns,
                duration=time.monotonic() - started,
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


def provider_reply(config: ModelConfig, api_key: str) -> ModelReply:
    """Build one official-SDK adapter. Imports stay lazy for offline contract tests."""
    provider = config["provider"]
    model_id = config["model_id"]

    if provider == "anthropic":
        import anthropic

        client = anthropic.Anthropic(api_key=api_key)

        def reply(messages: list[Message]) -> str:
            response = client.messages.create(
                model=model_id,
                max_tokens=32,
                messages=messages,
                # Opus 4.8 and Sonnet 5 reject non-default sampling params and manual
                # thinking budgets. Sonnet defaults to adaptive thinking, so disable it
                # explicitly to keep the deliberately tiny one-word output budget usable.
                thinking={"type": "disabled"},
            )
            return _text_content(response.content)

        return reply

    if provider == "openai":
        from openai import OpenAI

        client = OpenAI(api_key=api_key)

        def reply(messages: list[Message]) -> str:
            response = client.responses.create(
                model=model_id,
                input=messages,
                max_output_tokens=256,
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
) -> ModelSummary:
    if not _is_int(runs) or runs <= 0:
        raise ValueError("runs must be a positive integer")
    results = [play_puzzle(puzzle, vocab, model_reply, cap=cap) for _ in range(runs)]
    return ModelSummary(
        config=config,
        tries=median_tries([result.tries for result in results]),
        turns=sum(result.turns for result in results),
        duration=sum(result.duration for result in results),
        runs=runs,
    )


def select_models(requested: Sequence[str] | None) -> list[ModelConfig]:
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
    if not requested:
        return configs
    selectors = {
        part.strip().lower()
        for value in requested
        for part in value.split(",")
        if part.strip()
    }
    selected = [
        config
        for config in configs
        if selectors
        & {
            config["provider"].lower(),
            config["model_id"].lower(),
            config["label"].lower(),
        }
    ]
    matched = {
        selector
        for selector in selectors
        if any(
            selector
            in {
                config["provider"].lower(),
                config["model_id"].lower(),
                config["label"].lower(),
            }
            for config in configs
        )
    }
    unknown = sorted(selectors - matched)
    if unknown:
        raise ValueError("unknown model selector(s): " + ", ".join(unknown))
    return selected


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
    entries: list[dict[str, str | int | None]],
) -> None:
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
        description="Make configured LLMs play one Whippin puzzle offline and report their scores."
    )
    parser.add_argument("puzzle", type=Path, help="generated puzzle JSON")
    parser.add_argument(
        "--models",
        nargs="+",
        metavar="MODEL",
        help="provider, model id, or label (default: all configured models)",
    )
    parser.add_argument(
        "--cap", type=_positive_int, default=DEFAULT_CAP, help="counted-try DNF cap"
    )
    parser.add_argument(
        "--runs",
        type=_positive_int,
        default=1,
        help="runs per model; persist the median",
    )
    parser.add_argument(
        "--in-place",
        action="store_true",
        help='write successful results to the puzzle\'s optional "benchmark" field',
    )
    args = parser.parse_args(argv)
    try:
        args.model_configs = select_models(args.models)
    except ValueError as exc:
        parser.error(str(exc))
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
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

    print(
        f"Whippin benchmark prompt={PROMPT_VERSION} cap={args.cap} runs={args.runs}",
        flush=True,
    )
    summaries: list[ModelSummary] = []
    for config in args.model_configs:
        env_name = PROVIDER_ENV[config["provider"]]
        api_key = os.environ.get(env_name)
        if not api_key:
            print(
                f"warning: skipping {config['label']} ({config['model_id']}); {env_name} is not set",
                file=sys.stderr,
            )
            continue
        try:
            summary = benchmark_model(
                config,
                puzzle,
                vocab,
                provider_reply(config, api_key),
                cap=args.cap,
                runs=args.runs,
            )
        except (
            Exception
        ) as exc:  # provider/model failures must not stop the other models
            print(
                f"error: {config['label']} ({config['model_id']}) failed: {exc}",
                file=sys.stderr,
            )
            continue
        summaries.append(summary)
        score = "DNF" if summary.tries is None else f"{summary.tries} tries"
        print(
            f"{config['label']:<8} {score:>9}  "
            f"turns={summary.turns}  duration={summary.duration:.1f}s  model={config['model_id']}"
        )

    if args.in_place:
        if summaries:
            write_benchmark(
                args.puzzle,
                puzzle,
                [summary.benchmark_entry() for summary in summaries],
            )
            print(f"Wrote benchmark -> {args.puzzle}")
        else:
            print(
                "warning: no completed model results; puzzle left unchanged",
                file=sys.stderr,
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
