"""Rules-parity contract for the offline LLM benchmark referee (#68).

The scripted model is deliberately network-free. These assertions describe the same
score/guess semantics as the browser: folded-vocab existence, folded dedupe, one counted
guess broadcast to every unsolved hole, strict improvements, and a counted-try DNF cap.
"""

from copy import deepcopy
import json
import math
import os
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest

from llm_play import (
    AUTH_MODES,
    CODEX_BENCHMARK_INSTRUCTIONS,
    CODEX_SUBSCRIPTION_EFFORTS,
    CODEX_TURN_TIMEOUT_SECONDS,
    DEEP_REASONING_MAX_TOKENS,
    DEFAULT_AUTH,
    DEFAULT_EFFORT,
    EFFORT_LEVELS,
    MAX_CONSECUTIVE_UNPARSEABLE,
    MAX_NONCOUNTING_REPLIES,
    MODELS,
    OPENAI_SUBSCRIPTION_CONFLICT_ENV,
    PROMPT_VERSION,
    PROVIDER_ENV,
    REASONING_MAX_TOKENS,
    NoProgressReplyError,
    PuzzleReferee,
    UnparseableReplyError,
    feedback_message,
    main,
    median_tries,
    parse_args,
    play_puzzle,
    provider_reply,
    resolve_puzzle_path,
    select_model,
    validate_anthropic_subscription_auth,
    validate_openai_subscription_auth,
    write_benchmark,
)


def puzzle():
    return {
        "lang": "en",
        "words": ["the", "forest,", "meets", "ocean"],
        "holes": [
            {
                "pos": 1,
                "secret": {"word": "forest", "slug": "forest"},
                "start": {"word": "tree", "slug": "tree"},
                "start_rank": 50,
                "prefix": "(",
                "suffix": ",",
            },
            {
                "pos": 3,
                "secret": {"word": "ocean", "slug": "ocean"},
                "start": {"word": "lake", "slug": "lake"},
                "start_rank": 40,
            },
        ],
        "ranks": {
            "forest": {
                "shared": {"word": "shared", "rank": 10},
                "forest": {"word": "forest", "rank": 0},
            },
            "ocean": {
                "shared": {"word": "shared", "rank": 5},
                "ocean": {"word": "ocean", "rank": 0},
            },
        },
    }


VOCAB = {"shared", "forest", "ocean", "cold", "other"}


def test_supported_model_roster_has_claude_and_all_gpt_56_variants():
    assert MODELS == [
        {"provider": "anthropic", "model_id": "claude-opus-4-8", "label": "OPUS"},
        {"provider": "anthropic", "model_id": "claude-sonnet-5", "label": "SONNET"},
        {"provider": "openai", "model_id": "gpt-5.6-sol", "label": "SOL"},
        {"provider": "openai", "model_id": "gpt-5.6-terra", "label": "TERRA"},
        {"provider": "openai", "model_id": "gpt-5.6-luna", "label": "LUNA"},
    ]
    assert PROVIDER_ENV == {
        "anthropic": "ANTHROPIC_API_KEY",
        "openai": "OPENAI_API_KEY",
    }


@pytest.mark.parametrize("config", MODELS[:2], ids=lambda config: config["label"])
def test_anthropic_adapter_none_disables_thinking_caches_and_omits_sampling(
    monkeypatch, config
):
    calls = []

    class FakeAnthropic:
        def __init__(self, *, api_key):
            assert api_key == "secret"
            self.messages = SimpleNamespace(create=self.create)

        def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(
                content=[SimpleNamespace(text="forest")], stop_reason="end_turn"
            )

    monkeypatch.setitem(
        sys.modules, "anthropic", SimpleNamespace(Anthropic=FakeAnthropic)
    )
    reply = provider_reply(config, "secret", effort="none")

    assert reply([{"role": "user", "content": "board"}]) == "forest"
    assert calls == [
        {
            "model": config["model_id"],
            "max_tokens": 32,
            "messages": [{"role": "user", "content": "board"}],
            "cache_control": {"type": "ephemeral"},
            "thinking": {"type": "disabled"},
        }
    ]
    assert not ({"temperature", "top_p", "top_k"} & calls[0].keys())


@pytest.mark.parametrize("config", MODELS[:2], ids=lambda config: config["label"])
@pytest.mark.parametrize(
    ("effort", "max_tokens"),
    [
        ("low", REASONING_MAX_TOKENS),
        ("medium", REASONING_MAX_TOKENS),
        ("high", REASONING_MAX_TOKENS),
        ("xhigh", DEEP_REASONING_MAX_TOKENS),
        ("max", DEEP_REASONING_MAX_TOKENS),
    ],
)
def test_anthropic_adapter_enables_adaptive_thinking_at_requested_effort(
    monkeypatch, config, effort, max_tokens
):
    calls = []

    class FakeAnthropic:
        def __init__(self, *, api_key):
            assert api_key == "secret"
            self.messages = SimpleNamespace(create=self.create)

        def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(
                content=[SimpleNamespace(text="forest")], stop_reason="end_turn"
            )

    monkeypatch.setitem(
        sys.modules, "anthropic", SimpleNamespace(Anthropic=FakeAnthropic)
    )
    reply = provider_reply(config, "secret", effort=effort)

    assert reply([{"role": "user", "content": "board"}]) == "forest"
    assert calls == [
        {
            "model": config["model_id"],
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": "board"}],
            "cache_control": {"type": "ephemeral"},
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": effort},
        }
    ]


def test_anthropic_adapter_surfaces_reasoning_budget_exhaustion(monkeypatch):
    class FakeAnthropic:
        def __init__(self, *, api_key):
            self.messages = SimpleNamespace(create=self.create)

        def create(self, **_kwargs):
            return SimpleNamespace(content=[], stop_reason="max_tokens")

    monkeypatch.setitem(
        sys.modules, "anthropic", SimpleNamespace(Anthropic=FakeAnthropic)
    )
    reply = provider_reply(MODELS[0], "secret", effort="medium")

    with pytest.raises(RuntimeError, match=f"{REASONING_MAX_TOKENS}-token"):
        reply([{"role": "user", "content": "board"}])


@pytest.mark.parametrize("effort", EFFORT_LEVELS)
def test_anthropic_subscription_adapter_isolates_and_resumes_agent_sdk(
    monkeypatch, effort
):
    calls = []

    class FakeOptions:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    class FakeResultMessage:
        def __init__(self, *, result, session_id):
            self.result = result
            self.session_id = session_id
            self.is_error = False
            self.stop_reason = "end_turn"
            self.subtype = "success"

    async def fake_query(*, prompt, options):
        assert "ANTHROPIC_API_KEY" not in os.environ
        calls.append((prompt, options))
        session_id = options.resume or f"session-{len(calls)}"
        yield FakeResultMessage(result="forest", session_id=session_id)

    monkeypatch.setitem(
        sys.modules,
        "claude_agent_sdk",
        SimpleNamespace(
            ClaudeAgentOptions=FakeOptions,
            ResultMessage=FakeResultMessage,
            query=fake_query,
        ),
    )
    monkeypatch.setenv("ANTHROPIC_API_KEY", "must-not-be-used")
    reply = provider_reply(MODELS[0], None, effort=effort, auth="subscription")

    assert reply([{"role": "user", "content": "opening"}]) == "forest"
    assert (
        reply(
            [
                {"role": "user", "content": "opening"},
                {"role": "assistant", "content": "forest"},
                {"role": "user", "content": "feedback"},
            ]
        )
        == "forest"
    )
    # A new one-message transcript is a new median run, never a resumed attempt.
    assert reply([{"role": "user", "content": "opening again"}]) == "forest"
    assert os.environ["ANTHROPIC_API_KEY"] == "must-not-be-used"

    first_options = calls[0][1]
    assert [call[0] for call in calls] == ["opening", "feedback", "opening again"]
    assert [call[1].resume for call in calls] == [None, "session-1", None]
    assert first_options.model == "claude-opus-4-8"
    assert first_options.system_prompt is None
    assert first_options.tools == []
    assert first_options.allowed_tools == []
    assert first_options.mcp_servers == {}
    assert first_options.strict_mcp_config is True
    assert first_options.permission_mode == "dontAsk"
    assert first_options.setting_sources == []
    assert first_options.skills == []
    assert first_options.agents == {}
    assert first_options.plugins == []
    assert first_options.max_turns == 1
    assert first_options.extra_args == {
        "safe-mode": None,
        "disable-slash-commands": None,
    }
    if effort == "none":
        assert first_options.thinking == {"type": "disabled"}
        assert first_options.effort is None
    else:
        assert first_options.thinking == {"type": "adaptive"}
        assert first_options.effort == effort

    workspace = Path(first_options.cwd)
    assert workspace.is_dir()
    reply.close()
    assert not workspace.exists()


def test_subscription_auth_preflight_strips_api_credentials(monkeypatch):
    def fake_run(command, **kwargs):
        assert command == ["/usr/local/bin/claude", "auth", "status", "--json"]
        assert "ANTHROPIC_API_KEY" not in kwargs["env"]
        return SimpleNamespace(
            returncode=0,
            stdout=json.dumps(
                {
                    "loggedIn": True,
                    "authMethod": "claude.ai",
                    "subscriptionType": "pro",
                }
            ),
        )

    monkeypatch.setenv("ANTHROPIC_API_KEY", "must-not-be-used")
    monkeypatch.setattr(
        "llm_play.shutil.which", lambda _command: "/usr/local/bin/claude"
    )
    monkeypatch.setattr("llm_play.subprocess.run", fake_run)

    assert validate_anthropic_subscription_auth() == "pro"


@pytest.mark.parametrize(
    "status",
    [
        {"loggedIn": False},
        {
            "loggedIn": True,
            "authMethod": "console",
            "subscriptionType": "pro",
        },
        {
            "loggedIn": True,
            "authMethod": "claude.ai",
            "subscriptionType": "free",
        },
    ],
)
def test_subscription_auth_preflight_rejects_non_plan_sessions(monkeypatch, status):
    monkeypatch.setattr("llm_play.shutil.which", lambda _command: "/usr/bin/claude")
    monkeypatch.setattr(
        "llm_play.subprocess.run",
        lambda *_args, **_kwargs: SimpleNamespace(
            returncode=0, stdout=json.dumps(status)
        ),
    )

    with pytest.raises(RuntimeError, match="paid Claude.ai subscription"):
        validate_anthropic_subscription_auth()


@pytest.mark.parametrize("config", MODELS[2:], ids=lambda config: config["label"])
@pytest.mark.parametrize("effort", CODEX_SUBSCRIPTION_EFFORTS)
def test_openai_subscription_adapter_isolates_fresh_codex_exec(
    monkeypatch, config, effort
):
    calls = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        assert not (set(OPENAI_SUBSCRIPTION_CONFLICT_ENV) & kwargs["env"].keys())
        return SimpleNamespace(
            returncode=0,
            stdout="\n".join(
                [
                    json.dumps({"type": "thread.started", "thread_id": "fresh"}),
                    json.dumps({"type": "turn.started"}),
                    json.dumps(
                        {
                            "type": "item.completed",
                            "item": {"type": "agent_message", "text": "forest"},
                        }
                    ),
                    json.dumps({"type": "turn.completed"}),
                ]
            ),
            stderr="",
        )

    monkeypatch.setattr(
        "llm_play.shutil.which",
        lambda command: "/usr/local/bin/codex" if command == "codex" else None,
    )
    monkeypatch.setattr("llm_play.subprocess.run", fake_run)
    for name in OPENAI_SUBSCRIPTION_CONFLICT_ENV:
        monkeypatch.setenv(name, "must-not-be-used")

    reply = provider_reply(config, None, effort=effort, auth="subscription")
    opening = [{"role": "user", "content": "opening"}]
    continued = opening + [
        {"role": "assistant", "content": "forest"},
        {"role": "user", "content": "feedback"},
    ]

    assert reply(opening) == "forest"
    assert reply(continued) == "forest"
    assert reply([{"role": "user", "content": "opening again"}]) == "forest"

    assert len(calls) == 3
    command, kwargs = calls[0]
    assert command[:2] == ["/usr/local/bin/codex", "exec"]
    assert command[-1] == "-"
    assert command[command.index("--model") + 1] == config["model_id"]
    assert command[command.index("--sandbox") + 1] == "read-only"
    workspace = Path(command[command.index("--cd") + 1])
    assert workspace == Path(kwargs["cwd"])
    assert workspace.is_dir()
    for flag in (
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--strict-config",
        "--json",
    ):
        assert flag in command

    configs = [
        command[index + 1] for index, value in enumerate(command) if value == "--config"
    ]
    assert f'model_reasoning_effort="{effort}"' in configs
    assert 'approval_policy="never"' in configs
    assert "features.apps=false" in configs
    assert "features.shell_tool=false" in configs
    assert "features.multi_agent=false" in configs
    assert 'web_search="disabled"' in configs
    assert 'history.persistence="none"' in configs
    instructions_config = next(
        value for value in configs if value.startswith("model_instructions_file=")
    )
    instructions_path = Path(json.loads(instructions_config.split("=", 1)[1]))
    assert instructions_path.read_text(encoding="utf-8").strip() == (
        CODEX_BENCHMARK_INSTRUCTIONS
    )

    assert kwargs["check"] is False
    assert kwargs["capture_output"] is True
    assert kwargs["text"] is True
    assert kwargs["timeout"] == CODEX_TURN_TIMEOUT_SECONDS
    transcripts = [
        json.loads(call_kwargs["input"].splitlines()[-1])
        for _call_command, call_kwargs in calls
    ]
    assert transcripts == [
        opening,
        continued,
        [{"role": "user", "content": "opening again"}],
    ]

    reply.close()
    assert not workspace.exists()


@pytest.mark.parametrize("config", MODELS[2:], ids=lambda config: config["label"])
def test_openai_subscription_rejects_unsupported_none_effort(monkeypatch, config):
    monkeypatch.setattr("llm_play.shutil.which", lambda _command: "/usr/bin/codex")

    with pytest.raises(ValueError, match="does not support.*none.*low.*medium"):
        provider_reply(config, None, effort="none", auth="subscription")


def test_openai_subscription_rejects_codex_tool_activity(monkeypatch):
    monkeypatch.setattr("llm_play.shutil.which", lambda _command: "/usr/bin/codex")
    monkeypatch.setattr(
        "llm_play.subprocess.run",
        lambda *_args, **_kwargs: SimpleNamespace(
            returncode=0,
            stdout=json.dumps(
                {
                    "type": "item.started",
                    "item": {"type": "command_execution", "command": "pwd"},
                }
            ),
            stderr="",
        ),
    )
    reply = provider_reply(MODELS[2], None, effort="medium", auth="subscription")

    with pytest.raises(RuntimeError, match="forbidden tool activity"):
        reply([{"role": "user", "content": "opening"}])
    reply.close()


def test_openai_subscription_auth_preflight_strips_api_credentials(monkeypatch):
    def fake_run(command, **kwargs):
        assert command == ["/usr/local/bin/codex", "login", "status"]
        assert not (set(OPENAI_SUBSCRIPTION_CONFLICT_ENV) & kwargs["env"].keys())
        return SimpleNamespace(
            returncode=0,
            stdout="Logged in using ChatGPT\n",
            stderr="",
        )

    monkeypatch.setattr(
        "llm_play.shutil.which", lambda _command: "/usr/local/bin/codex"
    )
    monkeypatch.setattr("llm_play.subprocess.run", fake_run)
    for name in OPENAI_SUBSCRIPTION_CONFLICT_ENV:
        monkeypatch.setenv(name, "must-not-be-used")

    assert validate_openai_subscription_auth() == "ChatGPT"


def test_openai_subscription_auth_preflight_rejects_api_login(monkeypatch):
    monkeypatch.setattr("llm_play.shutil.which", lambda _command: "/usr/bin/codex")
    monkeypatch.setattr(
        "llm_play.subprocess.run",
        lambda *_args, **_kwargs: SimpleNamespace(
            returncode=0,
            stdout="Logged in using an API key\n",
            stderr="",
        ),
    )

    with pytest.raises(RuntimeError, match="not using ChatGPT subscription auth"):
        validate_openai_subscription_auth()


@pytest.mark.parametrize("config", MODELS[2:], ids=lambda config: config["label"])
def test_openai_adapter_uses_responses_with_explicit_none_effort(monkeypatch, config):
    calls = []

    class FakeOpenAI:
        def __init__(self, *, api_key):
            assert api_key == "secret"
            self.responses = SimpleNamespace(create=self.create)

        def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(output_text="ocean", status="completed")

    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=FakeOpenAI))
    reply = provider_reply(config, "secret", effort="none")

    assert reply([{"role": "user", "content": "board"}]) == "ocean"
    assert calls == [
        {
            "model": config["model_id"],
            "input": [{"role": "user", "content": "board"}],
            "reasoning": {"effort": "none"},
            "max_output_tokens": 256,
        }
    ]


@pytest.mark.parametrize(
    ("effort", "max_tokens"),
    [
        ("low", REASONING_MAX_TOKENS),
        ("medium", REASONING_MAX_TOKENS),
        ("high", REASONING_MAX_TOKENS),
        ("xhigh", DEEP_REASONING_MAX_TOKENS),
        ("max", DEEP_REASONING_MAX_TOKENS),
    ],
)
@pytest.mark.parametrize("config", MODELS[2:], ids=lambda config: config["label"])
def test_openai_adapter_applies_requested_reasoning_effort(
    monkeypatch, config, effort, max_tokens
):
    calls = []

    class FakeOpenAI:
        def __init__(self, *, api_key):
            assert api_key == "secret"
            self.responses = SimpleNamespace(create=self.create)

        def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(output_text="ocean", status="completed")

    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=FakeOpenAI))
    reply = provider_reply(config, "secret", effort=effort)

    assert reply([{"role": "user", "content": "board"}]) == "ocean"
    assert calls == [
        {
            "model": config["model_id"],
            "input": [{"role": "user", "content": "board"}],
            "reasoning": {"effort": effort},
            "max_output_tokens": max_tokens,
        }
    ]


def test_openai_adapter_surfaces_an_incomplete_reasoning_response(monkeypatch):
    class FakeOpenAI:
        def __init__(self, *, api_key):
            self.responses = SimpleNamespace(create=self.create)

        def create(self, **_kwargs):
            return SimpleNamespace(
                output_text="",
                status="incomplete",
                incomplete_details=SimpleNamespace(reason="max_output_tokens"),
            )

    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=FakeOpenAI))
    reply = provider_reply(MODELS[2], "secret", effort="medium")

    with pytest.raises(RuntimeError, match="incomplete.*max_output_tokens"):
        reply([{"role": "user", "content": "board"}])


def test_cli_defaults_to_api_and_accepts_shared_effort_and_auth_levels():
    defaults = parse_args(["puzzle.json", "--model", "OPUS"])
    assert defaults.effort == DEFAULT_EFFORT
    assert defaults.auth == DEFAULT_AUTH
    for effort in EFFORT_LEVELS:
        assert (
            parse_args(["puzzle.json", "--model", "OPUS", "--effort", effort]).effort
            == effort
        )
    for auth in AUTH_MODES:
        arguments = ["puzzle.json", "--model", "OPUS", "--auth", auth]
        if auth == "subscription":
            arguments.extend(("--effort", "medium"))
        assert parse_args(arguments).auth == auth


@pytest.mark.parametrize("legacy_flag", ["--anthropic-auth", "--openai-auth"])
def test_cli_rejects_removed_provider_specific_auth_flags(legacy_flag):
    with pytest.raises(SystemExit):
        parse_args(["puzzle.json", "--model", "OPUS", legacy_flag, "subscription"])


def test_cli_rejects_none_effort_before_an_openai_subscription_call():
    with pytest.raises(SystemExit):
        parse_args(["puzzle.json", "--model", "GPT-SOL", "--auth", "subscription"])
    assert (
        parse_args(["puzzle.json", "--model", "OPUS", "--auth", "subscription"]).effort
        == "none"
    )


@pytest.mark.parametrize(
    ("selector", "expected"),
    [
        ("OPUS", MODELS[0]),
        ("SONNET", MODELS[1]),
        ("GPT-SOL", MODELS[2]),
        ("GPT-TERRA", MODELS[3]),
        ("GPT-LUNA", MODELS[4]),
        *[(config["model_id"], config) for config in MODELS],
    ],
)
def test_singular_model_selectors(selector, expected):
    assert select_model(selector) == expected


@pytest.mark.parametrize(
    "selector", ["GPT", "gpt-5.6", "openai", "anthropic", "SOL", "TERRA", "LUNA"]
)
def test_model_selector_rejects_family_provider_and_short_gpt_aliases(selector):
    with pytest.raises(ValueError, match="unknown model selector"):
        select_model(selector)


def test_cli_requires_exactly_one_model_and_rejects_the_plural_flag():
    with pytest.raises(SystemExit):
        parse_args(["puzzle.json"])
    with pytest.raises(SystemExit):
        parse_args(["puzzle.json", "--models", "OPUS"])
    with pytest.raises(SystemExit):
        parse_args(["puzzle.json", "--model", "OPUS", "GPT-SOL"])
    with pytest.raises(SystemExit):
        parse_args(["puzzle.json", "--model", "OPUS,GPT-SOL"])
    with pytest.raises(SystemExit):
        parse_args(["puzzle.json", "--model", "GPT"])


def test_puzzle_path_accepts_repo_and_generation_relative_forms(monkeypatch, tmp_path):
    generation_dir = tmp_path / "packages" / "generation"
    puzzle_path = generation_dir / "output" / "word" / "fr" / "puzzle.json"
    puzzle_path.parent.mkdir(parents=True)
    puzzle_path.write_text("{}", encoding="utf-8")
    monkeypatch.setattr("llm_play.REPO_ROOT", tmp_path)
    monkeypatch.setattr("llm_play.GENERATION_DIR", generation_dir)

    monkeypatch.chdir(generation_dir)
    assert (
        resolve_puzzle_path(Path("packages/generation/output/word/fr/puzzle.json"))
        == puzzle_path
    )
    assert resolve_puzzle_path(Path("output/word/fr/puzzle.json")) == puzzle_path

    monkeypatch.chdir(tmp_path)
    assert resolve_puzzle_path(Path("output/word/fr/puzzle.json")) == puzzle_path


def test_in_place_output_upserts_one_model_and_preserves_other_results_and_file_mode(
    tmp_path,
):
    path = tmp_path / "puzzle.json"
    source = puzzle()
    source["source"] = {"work": "L'été"}
    source["benchmark"] = [
        {"model": "claude-opus-4-8", "label": "OPUS", "tries": 30},
        {"model": "gpt-5.6-terra", "label": "TERRA", "tries": 14},
    ]
    path.write_text(json.dumps(source, ensure_ascii=False), encoding="utf-8")
    os.chmod(path, 0o640)
    opus = {"model": "claude-opus-4-8", "label": "OPUS", "tries": 12}

    write_benchmark(path, source, opus)

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["benchmark"] == [
        opus,
        {"model": "gpt-5.6-terra", "label": "TERRA", "tries": 14},
    ]

    luna = {"model": "gpt-5.6-luna", "label": "LUNA", "tries": 20}
    write_benchmark(path, source, luna)

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["benchmark"] == [
        opus,
        {"model": "gpt-5.6-terra", "label": "TERRA", "tries": 14},
        luna,
    ]
    assert written["source"]["work"] == "L'été"
    assert os.stat(path).st_mode & 0o777 == 0o640


def test_multiple_runs_use_a_numeric_median_with_dnf_last():
    assert median_tries([10, 30, 20]) == 20
    assert median_tries([10, 21]) == 16
    assert median_tries([10, None]) is None


class ScriptedModel:
    def __init__(self, replies):
        self.replies = iter(replies)
        self.calls = []

    def __call__(self, messages):
        self.calls.append(deepcopy(messages))
        return next(self.replies)


def test_invalid_and_folded_duplicate_do_not_count_and_are_reprompted():
    # "sharéd" and "shared" fold to the same persisted try key, exactly like Game.
    model = ScriptedModel(["nonesuch", "sharéd", "shared", "forest", "ocean"])
    updates = []
    result = play_puzzle(puzzle(), VOCAB, model, on_try=updates.append)

    assert result.tries == 3
    assert result.counted_tries == 3
    assert result.turns == 5
    assert result.tried_words == ("sharéd", "forest", "ocean")
    user_feedback = [m["content"] for m in result.conversation if m["role"] == "user"]
    assert '"nonesuch" is not a word — this did not count.' in user_feedback[1]
    assert "Tries: 0" in user_feedback[1]
    assert '"shared" was already tried — this did not count.' in user_feedback[3]
    assert "Tries: 1" in user_feedback[3]
    assert [(update.number, update.word) for update in updates] == [
        (1, "sharéd"),
        (2, "forest"),
        (3, "ocean"),
    ]
    assert updates[-1].progress == pytest.approx(100)


def test_miss_and_warm_rank_feedback_match_each_secret_rank_map():
    referee = PuzzleReferee(puzzle(), VOCAB)

    warm = referee.submit("shared")
    assert [(outcome.number, outcome.rank) for outcome in warm.outcomes] == [
        (1, 10),
        (2, 5),
    ]
    assert "word 1: 10 closer!" in feedback_message(warm, referee)
    assert "word 2: 5 closer!" in feedback_message(warm, referee)

    miss = referee.submit("cold")
    assert [(outcome.number, outcome.rank) for outcome in miss.outcomes] == [
        (1, None),
        (2, None),
    ]
    assert feedback_message(miss, referee).count("MISS") == 2


def test_one_guess_advances_two_holes_but_counts_as_one_try():
    referee = PuzzleReferee(puzzle(), VOCAB)
    feedback = referee.submit("shared")

    assert feedback.tries == 1
    assert [hole.rank for hole in referee.holes] == [10, 5]
    assert all(outcome.improved for outcome in feedback.outcomes)


def test_referee_progress_matches_the_web_logarithmic_formula():
    referee = PuzzleReferee(puzzle(), VOCAB)
    assert referee.progress == pytest.approx(0)

    referee.submit("cold")
    assert referee.progress == pytest.approx(0)

    referee.submit("shared")

    def score(rank, size):
        return 1 - math.log(rank + 1) / math.log(size + 1)

    expected = 0
    for rank, start_rank, size in [(10, 50, 2), (5, 40, 2)]:
        start_score = score(start_rank, size)
        expected += (score(rank, size) - start_score) / (1 - start_score)
    assert referee.progress == pytest.approx(100 * expected / 2)

    referee.submit("forest")
    referee.submit("ocean")
    assert referee.progress == pytest.approx(100)


def test_solved_holes_are_locked_and_excluded_from_later_feedback():
    referee = PuzzleReferee(puzzle(), VOCAB)
    first = referee.submit("forest")
    assert [(outcome.number, outcome.rank) for outcome in first.outcomes] == [
        (1, 0),
        (2, None),
    ]

    second = referee.submit("shared")
    assert [(outcome.number, outcome.rank) for outcome in second.outcomes] == [(2, 5)]
    assert referee.holes[0].word == "forest"
    assert referee.holes[0].rank == 0


def test_cap_after_counted_tries_is_a_dnf():
    model = ScriptedModel(["cold", "other"])
    result = play_puzzle(puzzle(), VOCAB, model, cap=2)

    assert result.tries is None
    assert result.counted_tries == 2
    assert result.turns == 2
    assert result.tried_words == ("cold", "other")


def test_final_score_matches_front_unique_try_semantics_for_same_sequence():
    # Invalid and folded duplicate submissions are visible turns but not tries; a MISS is
    # a vocabulary-valid unique try; the two secret guesses complete the round.
    sequence = ["???", "sharéd", "shared", "cold", "forest", "ocean"]
    result = play_puzzle(puzzle(), VOCAB, ScriptedModel(sequence))

    folded_unique_valid = {"shared", "cold", "forest", "ocean"}
    assert result.tries == len(folded_unique_valid) == 4
    assert result.turns == len(sequence)
    assert result.tried_words == ("sharéd", "cold", "forest", "ocean")


def test_cli_prints_counted_words_in_order_for_each_run(monkeypatch, tmp_path, capsys):
    path = tmp_path / "puzzle.json"
    path.write_text(json.dumps(puzzle()), encoding="utf-8")
    model = ScriptedModel(
        [
            "forest",
            "ocean",
            "shared",
            "forest",
            "ocean",
        ]
    )
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr("llm_play.load_vocab", lambda _lang: VOCAB)
    monkeypatch.setattr("llm_play.provider_reply", lambda *_args, **_kwargs: model)

    assert main([str(path), "--model", "OPUS", "--runs", "2"]) == 0

    output = capsys.readouterr().out
    assert 'OPUS     run=1 try=1 word="forest" progress=50.00%' in output
    assert 'OPUS     run=1 try=2 word="ocean" progress=100.00%' in output
    assert 'OPUS     run=2 try=3 word="ocean" progress=100.00%' in output
    assert 'OPUS     run=1 tried=["forest", "ocean"]' in output
    assert 'OPUS     run=2 tried=["shared", "forest", "ocean"]' in output


def test_cli_openai_subscription_uses_plan_without_api_key(
    monkeypatch, tmp_path, capsys
):
    path = tmp_path / "puzzle.json"
    path.write_text(json.dumps(puzzle()), encoding="utf-8")
    model = ScriptedModel(["forest", "ocean"])
    preflights = []

    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setattr("llm_play.load_vocab", lambda _lang: VOCAB)
    monkeypatch.setattr(
        "llm_play.validate_openai_subscription_auth",
        lambda: preflights.append("ChatGPT") or "ChatGPT",
    )

    def fake_provider(config, api_key, **kwargs):
        assert config == MODELS[2]
        assert api_key is None
        assert kwargs["effort"] == "medium"
        assert kwargs["auth"] == "subscription"
        return model

    monkeypatch.setattr("llm_play.provider_reply", fake_provider)

    assert (
        main(
            [
                str(path),
                "--model",
                "GPT-SOL",
                "--effort",
                "medium",
                "--auth",
                "subscription",
            ]
        )
        == 0
    )

    output = capsys.readouterr()
    assert preflights == ["ChatGPT"]
    assert "auth=subscription" in output.out
    assert 'SOL      try=1 word="forest" progress=50.00%' in output.out
    assert "OPENAI_API_KEY is not set" not in output.err


def test_cli_anthropic_subscription_preflights_only_the_selected_provider(
    monkeypatch, tmp_path
):
    path = tmp_path / "puzzle.json"
    path.write_text(json.dumps(puzzle()), encoding="utf-8")
    preflights = []
    provider_calls = []

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setattr("llm_play.load_vocab", lambda _lang: VOCAB)
    monkeypatch.setattr(
        "llm_play.validate_anthropic_subscription_auth",
        lambda: preflights.append("anthropic") or "pro",
    )
    monkeypatch.setattr(
        "llm_play.validate_openai_subscription_auth",
        lambda: preflights.append("openai") or "ChatGPT",
    )

    def fake_provider(config, api_key, **kwargs):
        provider_calls.append((config["label"], api_key, kwargs["auth"]))
        return ScriptedModel(["forest", "ocean"])

    monkeypatch.setattr("llm_play.provider_reply", fake_provider)

    assert (
        main(
            [
                str(path),
                "--model",
                "OPUS",
                "--effort",
                "medium",
                "--auth",
                "subscription",
            ]
        )
        == 0
    )

    assert preflights == ["anthropic"]
    assert provider_calls == [("OPUS", None, "subscription")]


def test_opening_board_keeps_hole_affixes_and_full_sentence_tokens():
    model = ScriptedModel(["forest", "ocean"])
    play_puzzle(puzzle(), VOCAB, model)

    opening = model.calls[0][0]["content"]
    assert "Board: the (tree(-50), meets lake(-40)" in opening
    assert "English" in opening


def test_opening_prompt_prioritizes_context_correct_inflections():
    model = ScriptedModel(["forest", "ocean"])
    play_puzzle(puzzle(), VOCAB, model)

    opening = model.calls[0][0]["content"]
    assert PROMPT_VERSION == "4"
    assert "infer the hidden word's grammar from the fixed context" in opening
    assert "singular/plural" in opening
    assert "masculine/feminine" in opening
    assert "number, gender, agreement, or conjugation" in opening


def test_opening_prompt_encourages_nonanswer_probes_as_rank_hints():
    model = ScriptedModel(["forest", "ocean"])
    play_puzzle(puzzle(), VOCAB, model)

    opening = model.calls[0][0]["content"]
    assert "not only to check possible final answers" in opening
    assert "exploratory probe does not need to fit the sentence" in opening
    assert "provide intermediate hints" in opening
    assert "Balance direct candidates with probes" in opening
    assert "broader categories, contrasts, related objects or actions" in opening
    assert "compare ranks and follow lower ones" in opening


def test_opening_prompt_samples_and_reprioritizes_all_holes():
    model = ScriptedModel(["forest", "ocean"])
    play_puzzle(puzzle(), VOCAB, model)

    opening = model.calls[0][0]["content"]
    assert "Do not work strictly left-to-right" in opening
    assert "sample candidates or probes motivated by every unsolved position" in opening
    assert "surprisingly easy target" in opening
    assert "pursue whichever position or direction looks easiest" in opening
    assert "If it stalls, switch focus" in opening
    assert "After any solve, reread the board and reprioritize" in opening
    assert "revealed word gives new context for the rest" in opening


def test_unparseable_replies_reprompt_then_abort_after_five_consecutive_turns():
    model = ScriptedModel(["123", "...", "—", "42", "!!!"])

    with pytest.raises(UnparseableReplyError, match="5 consecutive"):
        play_puzzle(puzzle(), VOCAB, model)

    assert len(model.calls) == MAX_CONSECUTIVE_UNPARSEABLE
    assert "could not parse a word" in model.calls[1][-1]["content"]


@pytest.mark.parametrize(
    "replies",
    [
        ["nonesuch"] * MAX_NONCOUNTING_REPLIES,
        ["cold"] + ["cold"] * MAX_NONCOUNTING_REPLIES,
    ],
    ids=["invalid", "duplicate"],
)
def test_parsed_replies_without_a_counted_try_abort_the_paid_loop(replies):
    model = ScriptedModel(replies)

    with pytest.raises(NoProgressReplyError, match="without a counted try"):
        play_puzzle(puzzle(), VOCAB, model)

    expected_calls = MAX_NONCOUNTING_REPLIES + (1 if replies[0] == "cold" else 0)
    assert len(model.calls) == expected_calls
