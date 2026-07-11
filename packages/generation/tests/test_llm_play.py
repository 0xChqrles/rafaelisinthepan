"""Rules-parity contract for the offline LLM benchmark referee (#68).

The scripted model is deliberately network-free. These assertions describe the same
score/guess semantics as the browser: folded-vocab existence, folded dedupe, one counted
guess broadcast to every unsolved hole, strict improvements, and a counted-try DNF cap.
"""

from copy import deepcopy
import json
import os
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest

from llm_play import (
    ANTHROPIC_AUTH_MODES,
    DEEP_REASONING_MAX_TOKENS,
    DEFAULT_ANTHROPIC_AUTH,
    DEFAULT_EFFORT,
    EFFORT_LEVELS,
    MAX_CONSECUTIVE_UNPARSEABLE,
    MAX_NONCOUNTING_REPLIES,
    MODELS,
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
    validate_anthropic_subscription_auth,
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


def test_supported_model_roster_is_only_opus_sonnet_and_gpt_sol():
    assert MODELS == [
        {"provider": "anthropic", "model_id": "claude-opus-4-8", "label": "OPUS"},
        {"provider": "anthropic", "model_id": "claude-sonnet-5", "label": "SONNET"},
        {"provider": "openai", "model_id": "gpt-5.6-sol", "label": "GPT"},
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
    reply = provider_reply(
        MODELS[0], None, effort=effort, anthropic_auth="subscription"
    )

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


def test_openai_adapter_uses_responses_with_explicit_none_effort(monkeypatch):
    calls = []

    class FakeOpenAI:
        def __init__(self, *, api_key):
            assert api_key == "secret"
            self.responses = SimpleNamespace(create=self.create)

        def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(output_text="ocean", status="completed")

    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=FakeOpenAI))
    reply = provider_reply(MODELS[2], "secret", effort="none")

    assert reply([{"role": "user", "content": "board"}]) == "ocean"
    assert calls == [
        {
            "model": "gpt-5.6-sol",
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
def test_openai_adapter_applies_requested_reasoning_effort(
    monkeypatch, effort, max_tokens
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
    reply = provider_reply(MODELS[2], "secret", effort=effort)

    assert reply([{"role": "user", "content": "board"}]) == "ocean"
    assert calls == [
        {
            "model": "gpt-5.6-sol",
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


def test_effort_cli_defaults_to_none_and_accepts_every_shared_level():
    defaults = parse_args(["puzzle.json"])
    assert defaults.effort == DEFAULT_EFFORT
    assert defaults.anthropic_auth == DEFAULT_ANTHROPIC_AUTH
    for effort in EFFORT_LEVELS:
        assert parse_args(["puzzle.json", "--effort", effort]).effort == effort
    for auth in ANTHROPIC_AUTH_MODES:
        assert (
            parse_args(["puzzle.json", "--anthropic-auth", auth]).anthropic_auth == auth
        )


def test_in_place_output_writes_static_entries_and_preserves_file_mode(tmp_path):
    path = tmp_path / "puzzle.json"
    source = puzzle()
    source["source"] = {"work": "L'été"}
    path.write_text(json.dumps(source, ensure_ascii=False), encoding="utf-8")
    os.chmod(path, 0o640)
    entries = [
        {"model": "claude-opus-4-8", "label": "OPUS", "tries": 12},
        {"model": "claude-sonnet-5", "label": "SONNET", "tries": None},
        {"model": "gpt-5.6-sol", "label": "GPT", "tries": 18},
    ]

    write_benchmark(path, source, entries)

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["benchmark"] == entries
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
    result = play_puzzle(puzzle(), VOCAB, model)

    assert result.tries == 3
    assert result.counted_tries == 3
    assert result.turns == 5
    assert result.tried_words == ("sharéd", "forest", "ocean")
    user_feedback = [m["content"] for m in result.conversation if m["role"] == "user"]
    assert '"nonesuch" is not a word — this did not count.' in user_feedback[1]
    assert "Tries: 0" in user_feedback[1]
    assert '"shared" was already tried — this did not count.' in user_feedback[3]
    assert "Tries: 1" in user_feedback[3]


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

    assert main([str(path), "--models", "OPUS", "--runs", "2"]) == 0

    output = capsys.readouterr().out
    assert 'OPUS     run=1 tried=["forest", "ocean"]' in output
    assert 'OPUS     run=2 tried=["shared", "forest", "ocean"]' in output


def test_opening_board_keeps_hole_affixes_and_full_sentence_tokens():
    model = ScriptedModel(["forest", "ocean"])
    play_puzzle(puzzle(), VOCAB, model)

    opening = model.calls[0][0]["content"]
    assert "Board: the (tree(-50), meets lake(-40)" in opening
    assert "English" in opening


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
