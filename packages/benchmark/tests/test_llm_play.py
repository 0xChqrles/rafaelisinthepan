"""Rules-parity contract for the dedicated offline LLM benchmark package (#68).

The scripted model is deliberately network-free. These assertions describe the same
score/guess semantics as the browser: folded-vocab existence, folded dedupe, one counted
guess broadcast to every unsolved hole, strict improvements, and a counted-try DNF cap.
"""

from copy import deepcopy
import hashlib
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
    CODEX_DECISION_INSTRUCTIONS,
    CODEX_SUBSCRIPTION_EFFORTS,
    CODEX_TURN_TIMEOUT_SECONDS,
    DEEP_REASONING_MAX_TOKENS,
    DEFAULT_AUTH,
    DEFAULT_EFFORT,
    DEFAULT_RUNS,
    DECISION_OUTPUT_MAX_TOKENS,
    DIRECT_OUTPUT_MAX_TOKENS,
    DISPLAY_MODEL_COUNT,
    EFFORT_LEVELS,
    MAX_CONSECUTIVE_UNPARSEABLE,
    MAX_NONCOUNTING_REPLIES,
    MODELS,
    OPENAI_API_EFFORTS,
    OPENAI_SUBSCRIPTION_CONFLICT_ENV,
    PROMPT_VERSION,
    PROVIDER_ENV,
    PROSE_OUTPUT_MAX_TOKENS,
    REASONING_MAX_TOKENS,
    ModelSummary,
    NoProgressReplyError,
    PuzzleReferee,
    RunResult,
    UnparseableReplyError,
    assert_benchmark_entry_consistent,
    benchmark_model,
    display_benchmark_entries,
    feedback_message,
    load_playbook_profile,
    main,
    parse_args,
    parse_single_word,
    play_puzzle,
    provider_reply,
    resolve_puzzle_path,
    select_median_run,
    select_model,
    validate_anthropic_subscription_auth,
    validate_openai_subscription_auth,
    write_benchmark,
    write_lab_artifact,
    _stateless_word_prompt,
)


def test_playbook_profile_loader_accepts_only_hash_verified_final_for_selected_model(
    tmp_path,
):
    playbook = "Use the sentence and rank history together."
    path = tmp_path / "sonnet.playbook.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "kind": "whippin_model_playbook",
                "model_id": MODELS[1]["model_id"],
                "provider": MODELS[1]["provider"],
                "gameplay_prompt_version": PROMPT_VERSION,
                "final_playbook": playbook,
                "final_playbook_sha256": hashlib.sha256(
                    playbook.encode("utf-8")
                ).hexdigest(),
            }
        ),
        encoding="utf-8",
    )

    assert load_playbook_profile(path, MODELS[1]) == (
        playbook,
        hashlib.sha256(playbook.encode("utf-8")).hexdigest(),
    )
    with pytest.raises(ValueError, match="selected model"):
        load_playbook_profile(path, MODELS[0])

    data = json.loads(path.read_text(encoding="utf-8"))
    data["final_playbook"] += " tampered"
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match="hash does not match"):
        load_playbook_profile(path, MODELS[1])


@pytest.mark.parametrize(
    ("selector", "filename", "expected_sha256"),
    [
        (
            "GPT-SOL",
            "gpt-5.6-sol.playbook.json",
            "e2cc898fdacca01d9856bbf02afe6fd542d22cbebd6ab63c60ac2defa692bb55",
        ),
        (
            "SONNET",
            "claude-sonnet-5.playbook.json",
            "80b8802f0048e2837dbd7c8aa06fc9b62e401503246cbcba4438b38025cc6395",
        ),
    ],
)
def test_versioned_playbooks_are_exact_final_critic_profiles(
    selector, filename, expected_sha256
):
    path = Path(__file__).resolve().parents[1] / "playbooks" / filename
    data = json.loads(path.read_text(encoding="utf-8"))
    playbook, digest = load_playbook_profile(path, select_model(selector))

    assert digest == expected_sha256
    assert playbook == data["final_playbook"]
    assert "analyst" not in data
    assert "critic" not in data


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


def french_clitic_puzzle():
    return {
        "lang": "fr",
        "words": ["il", "s'endormait", "paisiblement"],
        "holes": [
            {
                "pos": 1,
                "secret": {"word": "endormait", "slug": "endormait"},
                "start": {"word": "reposait", "slug": "reposait"},
                "start_rank": 50,
                "prefix": "s'",
            }
        ],
        "ranks": {
            "endormait": {
                "endormait": {"word": "endormait", "rank": 0},
            }
        },
    }


VOCAB = {"shared", "forest", "ocean", "cold", "other"}

ANTHROPIC_MODELS = [config for config in MODELS if config["provider"] == "anthropic"]
OPENAI_MODELS = [config for config in MODELS if config["provider"] == "openai"]


def test_supported_model_roster_has_claude_and_all_gpt_56_variants():
    assert MODELS == [
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
    assert sum(config["display"] for config in MODELS) == DISPLAY_MODEL_COUNT == 3
    assert PROVIDER_ENV == {
        "anthropic": "ANTHROPIC_API_KEY",
        "openai": "OPENAI_API_KEY",
    }


@pytest.mark.parametrize("config", ANTHROPIC_MODELS, ids=lambda config: config["label"])
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
                content=[SimpleNamespace(text="forest")],
                stop_reason="end_turn",
                usage={"input_tokens": 11, "output_tokens": 1},
            )

    monkeypatch.setitem(
        sys.modules, "anthropic", SimpleNamespace(Anthropic=FakeAnthropic)
    )
    reply = provider_reply(config, "secret", effort="none")

    assert reply([{"role": "user", "content": "board"}]) == "forest"
    assert reply.last_token_usage == {"input_tokens": 11, "output_tokens": 1}
    assert calls == [
        {
            "model": config["model_id"],
            "max_tokens": DIRECT_OUTPUT_MAX_TOKENS,
            "messages": [{"role": "user", "content": "board"}],
            "cache_control": {"type": "ephemeral"},
            "thinking": {"type": "disabled"},
        }
    ]
    assert not ({"temperature", "top_p", "top_k"} & calls[0].keys())

    # Prose mode is a construction-time choice: same call shape, prose budget.
    prose_calls = calls.copy()
    prose = provider_reply(config, "secret", effort="none", output="prose")
    assert prose([{"role": "user", "content": "retrospective"}]) == "forest"
    assert calls[-1]["max_tokens"] == PROSE_OUTPUT_MAX_TOKENS
    assert len(calls) == len(prose_calls) + 1

    decision = provider_reply(config, "secret", effort="none", output="decision")
    assert decision([{"role": "user", "content": "policy turn"}]) == "forest"
    assert calls[-1]["max_tokens"] == DECISION_OUTPUT_MAX_TOKENS


@pytest.mark.parametrize("config", ANTHROPIC_MODELS, ids=lambda config: config["label"])
@pytest.mark.parametrize(
    ("effort", "max_tokens"),
    [
        ("low", REASONING_MAX_TOKENS),
        ("medium", REASONING_MAX_TOKENS),
        ("high", REASONING_MAX_TOKENS),
        ("xhigh", DEEP_REASONING_MAX_TOKENS),
        ("max", DEEP_REASONING_MAX_TOKENS),
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


def test_api_word_adapters_receive_the_same_stateless_authoritative_prompt(
    monkeypatch,
):
    anthropic_calls = []
    openai_calls = []

    class FakeAnthropic:
        def __init__(self, *, api_key):
            self.messages = SimpleNamespace(create=self.create)

        def create(self, **kwargs):
            anthropic_calls.append(kwargs)
            return SimpleNamespace(
                content=[SimpleNamespace(text="forest")], stop_reason="end_turn"
            )

    class FakeOpenAI:
        def __init__(self, *, api_key):
            self.responses = SimpleNamespace(create=self.create)

        def create(self, **kwargs):
            openai_calls.append(kwargs)
            return SimpleNamespace(output_text="forest", status="completed")

    monkeypatch.setitem(
        sys.modules, "anthropic", SimpleNamespace(Anthropic=FakeAnthropic)
    )
    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=FakeOpenAI))

    messages = [
        {
            "role": "user",
            "content": (
                "fixed rules\n\nCOMPLETE CHRONOLOGICAL GAME RECORD\n"
                "CURRENT STATE\ninitial state"
            ),
        },
        {"role": "assistant", "content": "first model reply"},
        {"role": "user", "content": "FIRST RESULT\nCURRENT STATE\nafter first"},
        {"role": "assistant", "content": "second model reply"},
        {"role": "user", "content": "SECOND RESULT\nCURRENT STATE\nlatest state"},
    ]
    expected = [
        {"role": "user", "content": _stateless_word_prompt(messages)}
    ]

    anthropic = provider_reply(MODELS[0], "secret", effort="none")
    openai = provider_reply(MODELS[2], "secret", effort="none")
    assert anthropic(messages) == openai(messages) == "forest"
    assert openai_calls[0]["input"] == expected
    # Anthropic splits the identical prompt into a cached fixed-rules block plus the
    # volatile state so the per-run prefix can produce cache reads; the visible text
    # is byte-identical to the OpenAI prompt.
    anthropic_messages = anthropic_calls[0]["messages"]
    assert "cache_control" not in anthropic_calls[0]
    assert len(anthropic_messages) == 1 and anthropic_messages[0]["role"] == "user"
    blocks = anthropic_messages[0]["content"]
    assert [block["type"] for block in blocks] == ["text", "text"]
    assert blocks[0]["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in blocks[1]
    assert blocks[0]["text"] + blocks[1]["text"] == expected[0]["content"]
    assert blocks[0]["text"] == (
        "fixed rules\n\nCOMPLETE CHRONOLOGICAL GAME RECORD\n"
    )
    assert expected[0]["content"] == (
        "fixed rules\n\nCOMPLETE CHRONOLOGICAL GAME RECORD\n"
        "CURRENT STATE\ninitial state\n\n"
        "PLAYER REPLY 1\nfirst model reply\n\n"
        "REFEREE FEEDBACK 1\nFIRST RESULT\nCURRENT STATE\nafter first\n\n"
        "PLAYER REPLY 2\nsecond model reply\n\n"
        "REFEREE FEEDBACK 2\nSECOND RESULT\nCURRENT STATE\nlatest state"
    )


def test_stateless_word_prompt_preserves_initial_clues_and_every_exact_result():
    model = ScriptedModel(["shared", "cold", "forest", "ocean"])

    play_puzzle(puzzle(), VOCAB, model)

    assert _stateless_word_prompt(model.calls[0]) == model.calls[0][0]["content"]
    # Before the third guess, the current-best snapshot has replaced both starting
    # clues with "shared". The provider prompt must nevertheless retain the initial
    # clues plus both guesses and their exact, ordered per-hole outcomes.
    prompt = _stateless_word_prompt(model.calls[2])
    assert "WORD 1: tree (rank 50)" in prompt
    assert "WORD 2: lake (rank 40)" in prompt
    assert "WORD 1: shared (rank 10)" in prompt
    assert "WORD 2: shared (rank 5)" in prompt
    ordered_markers = (
        "PLAYER REPLY 1\nshared",
        'REFEREE FEEDBACK 1\nRESULT FOR "shared":',
        "PLAYER REPLY 2\ncold",
        'REFEREE FEEDBACK 2\nRESULT FOR "cold":',
    )
    positions = [prompt.index(marker) for marker in ordered_markers]
    assert positions == sorted(positions)
    assert "word 1: 10 closer! New best rank 10." in prompt
    assert "word 2: MISS (current best remains rank 5)" in prompt


def test_codex_bootstrap_does_not_define_provider_specific_game_rules():
    assert "Follow the visible-reply contract in the user prompt exactly" in (
        CODEX_BENCHMARK_INSTRUCTIONS
    )
    for gameplay_rule in (
        "exactly one bare word",
        "lowercase letters",
        "ASCII hyphens",
        "apostrophes",
        "CURRENT STATE",
        "rank",
        "CLOZE",
    ):
        assert gameplay_rule not in CODEX_BENCHMARK_INSTRUCTIONS


@pytest.mark.parametrize(
    ("reply", "lang", "expected"),
    [
        ("chien", "fr", "chien"),
        ("Chien", "fr", None),
        (" forêt \n", "fr", "forêt"),
        ("arc-en-ciel", "fr", "arc-en-ciel"),
        ('**"forêt".**', "fr", None),
        ("s'endormir", "fr", None),
        ("s’endormir", "fr", None),
        ("arc–en–ciel", "fr", None),
        ("chien2", "fr", None),
        ("chien_chat", "fr", None),
        ("The answer is chien", "fr", None),
        ("chien chat", "fr", None),
        ("...", "fr", None),
        ("mañana", "fr", None),
        ("well-being", "en", "well-being"),
    ],
)
def test_reply_parser_enforces_the_advertised_language_word_shape(
    reply, lang, expected
):
    assert parse_single_word(reply, lang=lang) == expected


@pytest.mark.parametrize("effort", EFFORT_LEVELS)
def test_anthropic_subscription_word_adapter_uses_fresh_stateless_agent_sdk_turns(
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
            self.usage = {"input_tokens": 12, "output_tokens": 1}

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

    opening = [
        {
            "role": "user",
            "content": "opening rules\nCURRENT STATE\ninitial state",
        }
    ]
    continued = opening + [
        {"role": "assistant", "content": "forest"},
        {"role": "user", "content": "latest state"},
    ]

    assert reply(opening) == "forest"
    assert (
        reply(continued)
        == "forest"
    )
    # A new one-message transcript is a new median run, never a resumed attempt.
    assert reply([{"role": "user", "content": "opening again"}]) == "forest"
    assert os.environ["ANTHROPIC_API_KEY"] == "must-not-be-used"
    assert reply.last_token_usage == {"input_tokens": 12, "output_tokens": 1}

    first_options = calls[0][1]
    assert [call[0] for call in calls] == [
        _stateless_word_prompt(opening),
        _stateless_word_prompt(continued),
        "opening again",
    ]
    assert "CURRENT STATE\ninitial state" in calls[1][0]
    assert "PLAYER REPLY 1\nforest" in calls[1][0]
    assert "REFEREE FEEDBACK 1\nlatest state" in calls[1][0]
    assert [call[1].resume for call in calls] == [None, None, None]
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


def test_anthropic_persistent_word_adapter_resumes_only_within_one_run(monkeypatch):
    calls = []

    class FakeOptions:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    class FakeResultMessage:
        def __init__(self, *, session_id):
            self.result = "forest"
            self.session_id = session_id
            self.is_error = False
            self.stop_reason = "end_turn"
            self.subtype = "success"
            self.usage = {"input_tokens": 12, "output_tokens": 1}

    async def fake_query(*, prompt, options):
        calls.append((prompt, options))
        session_id = options.resume or f"session-{len(calls)}"
        yield FakeResultMessage(session_id=session_id)

    monkeypatch.setitem(
        sys.modules,
        "claude_agent_sdk",
        SimpleNamespace(
            ClaudeAgentOptions=FakeOptions,
            ResultMessage=FakeResultMessage,
            query=fake_query,
        ),
    )
    reply = provider_reply(
        MODELS[1],
        None,
        effort="medium",
        auth="subscription",
        word_session="persistent",
    )
    opening = [{"role": "user", "content": "historical v14 opening"}]
    continued = opening + [
        {"role": "assistant", "content": "my method"},
        {"role": "user", "content": "method noted"},
    ]

    assert reply(opening) == "forest"
    assert reply(continued) == "forest"
    # A one-message transcript is a new benchmark run and must not inherit the old
    # provider session even though the adapter object is reused across median runs.
    assert reply([{"role": "user", "content": "next run opening"}]) == "forest"

    assert [prompt for prompt, _options in calls] == [
        "historical v14 opening",
        "method noted",
        "next run opening",
    ]
    assert [options.resume for _prompt, options in calls] == [
        None,
        "session-1",
        None,
    ]
    assert reply.session_id == "session-3"
    reply.close()


def test_anthropic_subscription_assembles_max_output_recovery_chunks(monkeypatch):
    class FakeOptions:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    class FakeAssistantMessage:
        def __init__(self, text):
            self.content = [{"type": "text", "text": text}]

    class FakeResultMessage:
        result = "not as facts available during play.\n\n## 11. Continue"
        session_id = "recovered-session"
        is_error = False
        stop_reason = "end_turn"
        subtype = "success"
        usage = {"input_tokens": 10, "output_tokens": 132_844}

    async def fake_query(*, prompt, options):
        assert prompt == "analyze everything"
        assert options.effort == "max"
        yield FakeAssistantMessage("# Full report\nTreat metadata as priors, not")
        yield FakeAssistantMessage(
            "not as facts available during play.\n\n## 11. Continue"
        )
        # Claude Code exposes only the final continuation through ResultMessage.result.
        yield FakeResultMessage()

    monkeypatch.setitem(
        sys.modules,
        "claude_agent_sdk",
        SimpleNamespace(
            AssistantMessage=FakeAssistantMessage,
            ClaudeAgentOptions=FakeOptions,
            ResultMessage=FakeResultMessage,
            query=fake_query,
        ),
    )
    reply = provider_reply(
        MODELS[1], None, effort="max", auth="subscription", output="prose"
    )
    try:
        assert reply([{"role": "user", "content": "analyze everything"}]) == (
            "# Full report\nTreat metadata as priors, not as facts available during "
            "play.\n\n## 11. Continue"
        )
        assert reply.last_token_usage == {
            "input_tokens": 10,
            "output_tokens": 132_844,
        }
    finally:
        reply.close()


def test_anthropic_subscription_surfaces_provider_status_and_sdk_errors(monkeypatch):
    class FakeOptions:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    class FakeResultMessage:
        result = "Claude Code returned an error result: success"
        session_id = "failed-session"
        is_error = True
        stop_reason = None
        subtype = "success"
        usage = None
        errors = ["session limit; resets at 16:10"]
        api_error_status = 429

    async def fake_query(*, prompt, options):
        assert prompt == "analyze"
        assert options.effort == "max"
        yield FakeResultMessage()

    monkeypatch.setitem(
        sys.modules,
        "claude_agent_sdk",
        SimpleNamespace(
            ClaudeAgentOptions=FakeOptions,
            ResultMessage=FakeResultMessage,
            query=fake_query,
        ),
    )
    reply = provider_reply(
        MODELS[1], None, effort="max", auth="subscription", output="prose"
    )
    try:
        with pytest.raises(
            RuntimeError,
            match=r"session limit.*provider HTTP status 429",
        ):
            reply([{"role": "user", "content": "analyze"}])
    finally:
        reply.close()


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


@pytest.mark.parametrize("config", OPENAI_MODELS, ids=lambda config: config["label"])
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
                    json.dumps(
                        {
                            "type": "turn.completed",
                            "usage": {"input_tokens": 20, "output_tokens": 2},
                        }
                    ),
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
    opening = [
        {
            "role": "user",
            "content": "opening rules\nCURRENT STATE\ninitial state",
        }
    ]
    continued = opening + [
        {"role": "assistant", "content": "forest"},
        {"role": "user", "content": "feedback"},
    ]
    latest = continued + [
        {"role": "assistant", "content": "ocean"},
        {"role": "user", "content": "latest authoritative state"},
    ]

    assert reply(opening) == "forest"
    assert reply(continued) == "forest"
    assert reply(latest) == "forest"
    assert reply([{"role": "user", "content": "opening again"}]) == "forest"
    assert reply.last_token_usage == {"input_tokens": 20, "output_tokens": 2}

    assert len(calls) == 4
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
    assert [call_kwargs["input"] for _command, call_kwargs in calls] == [
        _stateless_word_prompt(opening),
        _stateless_word_prompt(continued),
        _stateless_word_prompt(latest),
        "opening again",
    ]
    # Fresh Codex turns get the same explicit full record as every other transport;
    # they do not need provider-side session memory to retain earlier evidence.
    assert "CURRENT STATE\ninitial state" in calls[2][1]["input"]
    assert "PLAYER REPLY 1\nforest" in calls[2][1]["input"]
    assert "REFEREE FEEDBACK 1\nfeedback" in calls[2][1]["input"]
    assert "PLAYER REPLY 2\nocean" in calls[2][1]["input"]
    assert (
        "REFEREE FEEDBACK 2\nlatest authoritative state"
        in calls[2][1]["input"]
    )

    reply.close()
    assert not workspace.exists()


def test_openai_persistent_word_adapter_resumes_only_within_one_run(monkeypatch):
    calls = []
    initial_threads = 0

    def fake_run(command, **kwargs):
        nonlocal initial_threads
        calls.append((command, kwargs))
        if command[2] == "resume":
            thread_id = command[-2]
        else:
            initial_threads += 1
            thread_id = f"thread-{initial_threads}"
        return SimpleNamespace(
            returncode=0,
            stdout="\n".join(
                [
                    json.dumps(
                        {"type": "thread.started", "thread_id": thread_id}
                    ),
                    json.dumps(
                        {
                            "type": "item.completed",
                            "item": {"type": "agent_message", "text": "forest"},
                        }
                    ),
                    json.dumps(
                        {
                            "type": "turn.completed",
                            "usage": {"input_tokens": 20, "output_tokens": 2},
                        }
                    ),
                ]
            ),
            stderr="",
        )

    monkeypatch.setattr("llm_play.shutil.which", lambda _command: "/usr/bin/codex")
    monkeypatch.setattr("llm_play.subprocess.run", fake_run)
    reply = provider_reply(
        MODELS[2],
        None,
        effort="medium",
        auth="subscription",
        word_session="persistent",
    )
    opening = [{"role": "user", "content": "historical v14 opening"}]
    continued = opening + [
        {"role": "assistant", "content": "my method"},
        {"role": "user", "content": "method noted"},
    ]

    assert reply(opening) == "forest"
    assert reply(continued) == "forest"
    assert reply([{"role": "user", "content": "next run opening"}]) == "forest"

    first_command, first_kwargs = calls[0]
    resumed_command, resumed_kwargs = calls[1]
    next_run_command, next_run_kwargs = calls[2]
    assert first_command[:2] == ["/usr/bin/codex", "exec"]
    assert first_command[2] != "resume"
    assert resumed_command[:3] == ["/usr/bin/codex", "exec", "resume"]
    assert resumed_command[-2:] == ["thread-1", "-"]
    assert next_run_command[:2] == ["/usr/bin/codex", "exec"]
    assert next_run_command[2] != "resume"
    for command in (first_command, resumed_command, next_run_command):
        assert "--ephemeral" not in command
        configs = [
            command[index + 1]
            for index, value in enumerate(command)
            if value == "--config"
        ]
        assert 'history.persistence="save-all"' in configs
    assert "--sandbox" in first_command
    assert "--cd" in first_command
    assert "--sandbox" not in resumed_command
    assert "--cd" not in resumed_command
    assert [
        first_kwargs["input"],
        resumed_kwargs["input"],
        next_run_kwargs["input"],
    ] == ["historical v14 opening", "method noted", "next run opening"]
    assert first_kwargs["cwd"] == resumed_kwargs["cwd"] == next_run_kwargs["cwd"]
    assert reply.session_id == "thread-2"

    workspace = Path(first_kwargs["cwd"])
    assert workspace.is_dir()
    reply.close()
    assert not workspace.exists()


def test_openai_persistent_word_adapter_rejects_a_changed_resume_thread(monkeypatch):
    calls = 0

    def fake_run(_command, **_kwargs):
        nonlocal calls
        calls += 1
        thread_id = "thread-1" if calls == 1 else "wrong-thread"
        return SimpleNamespace(
            returncode=0,
            stdout="\n".join(
                [
                    json.dumps(
                        {"type": "thread.started", "thread_id": thread_id}
                    ),
                    json.dumps(
                        {
                            "type": "item.completed",
                            "item": {"type": "agent_message", "text": "forest"},
                        }
                    ),
                ]
            ),
            stderr="",
        )

    monkeypatch.setattr("llm_play.shutil.which", lambda _command: "/usr/bin/codex")
    monkeypatch.setattr("llm_play.subprocess.run", fake_run)
    reply = provider_reply(
        MODELS[2],
        None,
        effort="medium",
        auth="subscription",
        word_session="persistent",
    )
    opening = [{"role": "user", "content": "opening"}]
    assert reply(opening) == "forest"
    with pytest.raises(RuntimeError, match="resumed the wrong thread"):
        reply(
            opening
            + [
                {"role": "assistant", "content": "method"},
                {"role": "user", "content": "method noted"},
            ]
        )
    reply.close()


def test_openai_subscription_prose_payload_has_no_one_word_directive(monkeypatch):
    calls = []

    def fake_run(_command, **kwargs):
        calls.append(kwargs)
        return SimpleNamespace(
            returncode=0,
            stdout="\n".join(
                [
                    json.dumps(
                        {
                            "type": "item.completed",
                            "item": {
                                "type": "agent_message",
                                "text": '{"analysis": "complete"}',
                            },
                        }
                    ),
                    json.dumps({"type": "turn.completed", "usage": {}}),
                ]
            ),
            stderr="",
        )

    monkeypatch.setattr("llm_play.shutil.which", lambda _command: "/usr/bin/codex")
    monkeypatch.setattr("llm_play.subprocess.run", fake_run)
    reply = provider_reply(
        MODELS[2], None, effort="medium", auth="subscription", output="prose"
    )

    assert reply([{"role": "user", "content": "Return a complete JSON report."}])
    payload = calls[0]["input"]
    assert "exactly one word" not in payload.lower()
    assert payload == "Return a complete JSON report."
    reply.close()


def test_openai_subscription_decision_mode_uses_json_instructions(monkeypatch):
    calls = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(
            returncode=0,
            stdout="\n".join(
                [
                    json.dumps(
                        {
                            "type": "item.completed",
                            "item": {
                                "type": "agent_message",
                                "text": '{"guess":"forêt"}',
                            },
                        }
                    ),
                    json.dumps({"type": "turn.completed", "usage": {}}),
                ]
            ),
            stderr="",
        )

    monkeypatch.setattr("llm_play.shutil.which", lambda _command: "/usr/bin/codex")
    monkeypatch.setattr("llm_play.subprocess.run", fake_run)
    reply = provider_reply(
        MODELS[2], None, effort="medium", auth="subscription", output="decision"
    )

    assert reply([{"role": "user", "content": "Return the policy decision."}])
    command, kwargs = calls[0]
    configs = [
        command[index + 1]
        for index, value in enumerate(command)
        if value == "--config"
    ]
    instructions_config = next(
        value for value in configs if value.startswith("model_instructions_file=")
    )
    instructions_path = Path(json.loads(instructions_config.split("=", 1)[1]))
    assert instructions_path.read_text(encoding="utf-8").strip() == (
        CODEX_DECISION_INSTRUCTIONS
    )
    assert "exactly one word" not in kwargs["input"].lower()
    assert "Return only the exact JSON decision object requested." in kwargs["input"]
    reply.close()


@pytest.mark.parametrize("config", OPENAI_MODELS, ids=lambda config: config["label"])
def test_openai_subscription_rejects_unsupported_none_effort(monkeypatch, config):
    monkeypatch.setattr("llm_play.shutil.which", lambda _command: "/usr/bin/codex")

    with pytest.raises(ValueError, match="does not allow.*none.*low.*medium"):
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


def test_persistent_word_session_is_subscription_word_only(monkeypatch):
    monkeypatch.setattr("llm_play.shutil.which", lambda _command: "/usr/bin/codex")

    with pytest.raises(ValueError, match="subscription auth"):
        provider_reply(
            MODELS[2],
            "secret",
            effort="medium",
            auth="api",
            word_session="persistent",
        )
    with pytest.raises(ValueError, match="word output"):
        provider_reply(
            MODELS[2],
            None,
            effort="medium",
            auth="subscription",
            output="prose",
            word_session="persistent",
        )


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


@pytest.mark.parametrize("config", OPENAI_MODELS, ids=lambda config: config["label"])
def test_openai_adapter_uses_responses_with_explicit_none_effort(monkeypatch, config):
    calls = []

    class FakeOpenAI:
        def __init__(self, *, api_key):
            assert api_key == "secret"
            self.responses = SimpleNamespace(create=self.create)

        def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(
                output_text="ocean",
                status="completed",
                usage={"input_tokens": 9, "output_tokens": 1, "total_tokens": 10},
            )

    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=FakeOpenAI))
    reply = provider_reply(config, "secret", effort="none")

    assert reply([{"role": "user", "content": "board"}]) == "ocean"
    assert reply.last_token_usage == {
        "input_tokens": 9,
        "output_tokens": 1,
        "total_tokens": 10,
    }
    assert calls == [
        {
            "model": config["model_id"],
            "input": [{"role": "user", "content": "board"}],
            "reasoning": {"effort": "none"},
            "max_output_tokens": 256,
        }
    ]

    prose = provider_reply(config, "secret", effort="none", output="prose")
    assert prose([{"role": "user", "content": "retrospective"}]) == "ocean"
    assert calls[-1]["max_output_tokens"] == PROSE_OUTPUT_MAX_TOKENS

    decision = provider_reply(config, "secret", effort="none", output="decision")
    assert decision([{"role": "user", "content": "policy turn"}]) == "ocean"
    assert calls[-1]["max_output_tokens"] == DECISION_OUTPUT_MAX_TOKENS


@pytest.mark.parametrize(
    ("effort", "max_tokens"),
    [
        ("low", REASONING_MAX_TOKENS),
        ("medium", REASONING_MAX_TOKENS),
        ("high", REASONING_MAX_TOKENS),
        ("xhigh", DEEP_REASONING_MAX_TOKENS),
    ],
)
@pytest.mark.parametrize("config", OPENAI_MODELS, ids=lambda config: config["label"])
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


def test_openai_api_ultra_mapping_uses_documented_max_effort_and_pro_mode(
    monkeypatch,
):
    calls = []

    class FakeOpenAI:
        def __init__(self, *, api_key):
            assert api_key == "secret"
            self.responses = SimpleNamespace(create=self.create)

        def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(output_text="playbook", status="completed")

    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=FakeOpenAI))
    assert OPENAI_API_EFFORTS == (
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    )
    reply = provider_reply(
        MODELS[2],
        "secret",
        effort="max",
        output="prose",
        reasoning_mode="pro",
    )

    assert reply([{"role": "user", "content": "distill"}]) == "playbook"
    assert calls[0]["reasoning"] == {"effort": "max", "mode": "pro"}
    assert calls[0]["max_output_tokens"] == DEEP_REASONING_MAX_TOKENS


def test_pro_mode_rejects_non_api_or_non_max_transports():
    with pytest.raises(ValueError, match="requires OpenAI API effort 'max'"):
        provider_reply(
            MODELS[2],
            "secret",
            effort="high",
            reasoning_mode="pro",
        )
    with pytest.raises(ValueError, match="only through the OpenAI API"):
        provider_reply(
            MODELS[1],
            "secret",
            effort="max",
            reasoning_mode="pro",
        )


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
    assert defaults.runs == DEFAULT_RUNS == 7
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


def test_cli_requires_an_odd_run_count_so_the_median_is_a_real_run(capsys):
    for runs in (0, 2, 8):
        with pytest.raises(SystemExit):
            parse_args(
                ["puzzle.json", "--model", "OPUS", "--runs", str(runs)]
            )
    error = capsys.readouterr().err
    assert "must be odd so the median is an actual run" in error


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


def test_regular_cli_accepts_openai_api_max_but_reserves_ultra_for_distillation():
    assert (
        parse_args(["puzzle.json", "--model", "GPT-SOL", "--effort", "max"]).effort
        == "max"
    )
    with pytest.raises(SystemExit):
        parse_args(["puzzle.json", "--model", "GPT-SOL", "--effort", "ultra"])


@pytest.mark.parametrize(
    ("selector", "expected"),
    [
        ("OPUS", MODELS[0]),
        ("SONNET", MODELS[1]),
        ("GPT-SOL", MODELS[2]),
        ("GPT-TERRA", MODELS[3]),
        ("GPT-LUNA", MODELS[4]),
        ("FABLE", MODELS[5]),
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


def test_cli_unknown_model_lists_every_valid_alias_and_exact_model_id(capsys):
    with pytest.raises(SystemExit):
        parse_args(["puzzle.json", "--model", "WRONG"])

    error = capsys.readouterr().err
    assert "unknown model selector 'WRONG'" in error
    assert "Valid values: OPUS, SONNET, GPT-SOL, GPT-TERRA, GPT-LUNA" in error
    for config in MODELS:
        assert config["model_id"] in error


def test_cli_model_flag_without_value_lists_every_valid_model(capsys):
    with pytest.raises(SystemExit):
        parse_args(["--model"])

    error = capsys.readouterr().err
    assert "argument --model: expected one argument" in error
    assert "Valid values: OPUS, SONNET, GPT-SOL, GPT-TERRA, GPT-LUNA" in error
    for config in MODELS:
        assert config["model_id"] in error


@pytest.mark.parametrize(
    ("argument", "values"),
    [
        ("--effort", EFFORT_LEVELS),
        ("--auth", AUTH_MODES),
    ],
)
def test_cli_choice_flag_without_value_lists_every_valid_value(
    argument, values, capsys
):
    with pytest.raises(SystemExit):
        parse_args([argument])

    error = capsys.readouterr().err
    assert f"argument {argument}: expected one argument" in error
    assert f"Valid values: {', '.join(values)}." in error


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


def test_in_place_output_writes_only_an_exact_trio_and_preserves_file_mode(tmp_path):
    path = tmp_path / "puzzle.json"
    source = puzzle()
    source["source"] = {"work": "L'été"}
    entries = [
        {
            "model": "claude-opus-4-8",
            "label": "CLAUDE OPUS",
            "tag": "OPUS",
            "tries": 12,
            "run": ["forest"],
        },
        {
            "model": "claude-sonnet-5",
            "label": "CLAUDE SONNET",
            "tag": "SONNET",
            "tries": 20,
            "run": ["forest"],
        },
        {
            "model": "gpt-5.6-sol",
            "label": "GPT-5.6",
            "tag": "GPT",
            "tries": None,
            "run": ["cold", "other"],
        },
    ]
    path.write_text(json.dumps(source, ensure_ascii=False), encoding="utf-8")
    os.chmod(path, 0o640)

    write_benchmark(path, source, entries)

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["benchmark"] == entries
    assert written["source"]["work"] == "L'été"
    assert os.stat(path).st_mode & 0o777 == 0o640

    with pytest.raises(ValueError, match="exactly 3"):
        write_benchmark(path, source, entries[:2])

    write_benchmark(path, source, None)
    assert "benchmark" not in json.loads(path.read_text(encoding="utf-8"))


def make_run(
    tries,
    *,
    turns,
    words=(),
    duration=1.0,
    token_usage=(),
):
    return RunResult(
        tries=tries,
        counted_tries=len(words),
        turns=turns,
        duration=duration,
        tried_words=tuple(words),
        conversation=({"role": "user", "content": "opening"},),
        turn_token_usage=tuple(token_usage),
    )


def test_median_selection_returns_an_actual_run_with_dnf_last_and_stable_ties():
    score_order = [
        make_run(10, turns=4),
        make_run(30, turns=5),
        make_run(20, turns=6),
    ]
    assert select_median_run(score_order) == 2

    dnf_last = [
        make_run(10, turns=4),
        make_run(None, turns=1),
        make_run(20, turns=6),
    ]
    assert select_median_run(dnf_last) == 2

    fewer_turns_breaks_score_ties = [
        make_run(10, turns=4),
        make_run(20, turns=8),
        make_run(20, turns=3),
    ]
    assert select_median_run(fewer_turns_breaks_score_ties) == 2

    earlier_index_breaks_full_ties = [
        make_run(10, turns=4),
        make_run(20, turns=3),
        make_run(20, turns=3),
    ]
    assert select_median_run(earlier_index_breaks_full_ties) == 1

    with pytest.raises(ValueError, match="odd"):
        select_median_run(score_order[:2])


class ScriptedModel:
    def __init__(self, replies):
        self.replies = iter(replies)
        self.calls = []

    def __call__(self, messages):
        self.calls.append(deepcopy(messages))
        return next(self.replies)


class UsageScriptedModel(ScriptedModel):
    def __init__(self, replies, usages):
        super().__init__(replies)
        self.usages = iter(usages)
        self.last_token_usage = None

    def __call__(self, messages):
        reply = super().__call__(messages)
        self.last_token_usage = next(self.usages)
        return reply


def test_run_result_collects_each_transport_reported_turn_usage():
    model = UsageScriptedModel(
        ["forest", "ocean"],
        [
            {"input_tokens": 10, "output_tokens": 1},
            {"input_tokens": 20, "output_tokens": 1},
        ],
    )

    result = play_puzzle(puzzle(), VOCAB, model)

    assert result.turn_token_usage == (
        {"input_tokens": 10, "output_tokens": 1},
        {"input_tokens": 20, "output_tokens": 1},
    )


def test_benchmark_model_persists_the_selected_median_runs_counted_display_forms():
    model = ScriptedModel(
        [
            "forest",
            "ocean",
            "shared",
            "forest",
            "ocean",
            "cold",
            "other",
            "forest",
            "ocean",
        ]
    )

    summary = benchmark_model(
        MODELS[0], puzzle(), VOCAB, model, cap=300, runs=3
    )

    assert summary.median_run_index == 1
    assert summary.tries == 3
    assert summary.benchmark_entry() == {
        "model": "claude-opus-4-8",
        "label": "CLAUDE OPUS",
        "tag": "OPUS",
        "tries": 3,
        "run": ["shared", "forest", "ocean"],
    }

    with pytest.raises(ValueError, match="odd"):
        benchmark_model(
            MODELS[0], puzzle(), VOCAB, ScriptedModel([]), cap=300, runs=2
        )


def test_embed_consistency_replays_score_and_solved_or_dnf_state():
    solved_entry = {
        "model": "claude-opus-4-8",
        "label": "CLAUDE OPUS",
        "tag": "OPUS",
        "tries": 2,
        "run": ["forest", "ocean"],
    }
    assert_benchmark_entry_consistent(puzzle(), VOCAB, solved_entry, cap=300)

    dnf_entry = {**solved_entry, "tries": None, "run": ["cold", "other"]}
    assert_benchmark_entry_consistent(puzzle(), VOCAB, dnf_entry, cap=2)

    with pytest.raises(ValueError, match="score/state mismatch"):
        assert_benchmark_entry_consistent(
            puzzle(), VOCAB, {**solved_entry, "tries": 3}, cap=300
        )
    with pytest.raises(ValueError, match="folded-duplicate"):
        assert_benchmark_entry_consistent(
            puzzle(), VOCAB, {**solved_entry, "run": ["sharéd", "shared"]}, cap=300
        )
    with pytest.raises(ValueError, match="DNF run"):
        assert_benchmark_entry_consistent(
            puzzle(), VOCAB, {**solved_entry, "tries": None}, cap=2
        )


def test_raw_lab_artifact_keeps_all_runs_transcripts_transport_and_token_usage(
    tmp_path,
):
    output_dir = tmp_path / "lab"
    puzzle_path = tmp_path / "forest_ocean.json"
    usage = (
        {
            "input_tokens": 10,
            "output_tokens": 1,
            "input_tokens_details": {"cached_tokens": 2},
        },
        {"input_tokens": 5, "output_tokens": 2},
    )
    first_summary = ModelSummary(
        config=MODELS[0],
        results=(
            make_run(2, turns=2, words=("forest", "ocean")),
            make_run(
                3,
                turns=3,
                words=("shared", "forest", "ocean"),
                duration=2.0,
                token_usage=usage,
            ),
            make_run(4, turns=4, words=("cold", "other", "forest", "ocean")),
        ),
        median_run_index=1,
    )

    artifact_path, artifact = write_lab_artifact(
        puzzle_path,
        first_summary,
        cap=300,
        effort="medium",
        auth="subscription",
        output_dir=output_dir,
        timestamp="2026-07-12T15:00:00Z",
    )

    assert artifact_path == output_dir / "forest_ocean.bench.json"
    session = artifact["sessions"][0]
    assert session["timestamp"] == "2026-07-12T15:00:00Z"
    assert session["prompt_version"] == PROMPT_VERSION
    assert session["cap"] == 300
    assert session["model_id"] == "claude-opus-4-8"
    assert session["provider"] == "anthropic"
    assert session["transport"] == "agent_sdk"
    assert session["effort"] == "medium"
    assert session["median_run"] == 2
    assert len(session["runs"]) == 3
    assert [run["selected"] for run in session["runs"]] == [False, True, False]
    selected = session["runs"][1]
    assert selected["guesses"] == ["shared", "forest", "ocean"]
    assert selected["tries"] == 3
    assert selected["turns"] == 3
    assert selected["duration"] == 2.0
    assert selected["transcript"] == [
        {"role": "user", "content": "opening"}
    ]
    assert selected["token_usage"] == {
        "input_tokens": 15,
        "output_tokens": 3,
    }
    assert selected["turn_token_usage"] == list(usage)
    assert session["benchmark_entry"]["run"] == ["shared", "forest", "ocean"]

    transports = [(MODELS[1], "api", "api"), (MODELS[2], "subscription", "codex_cli")]
    for index, (config, auth, expected_transport) in enumerate(transports, start=1):
        summary = ModelSummary(
            config=config,
            results=(make_run(2 + index, turns=2, words=("forest", "ocean")),),
            median_run_index=0,
        )
        _, artifact = write_lab_artifact(
            puzzle_path,
            summary,
            cap=300,
            effort="medium",
            auth=auth,
            output_dir=output_dir,
            timestamp=f"2026-07-12T15:0{index}:00Z",
        )
        assert artifact["sessions"][-1]["transport"] == expected_transport

    entries = display_benchmark_entries(artifact)
    assert [entry["model"] for entry in entries] == [
        "claude-opus-4-8",
        "claude-sonnet-5",
        "gpt-5.6-sol",
    ]
    assert [entry["tag"] for entry in entries] == ["OPUS", "SONNET", "GPT"]

    lab_only = ModelSummary(
        config=MODELS[3],
        results=(make_run(9, turns=9, words=("other",)),),
        median_run_index=0,
    )
    _, artifact = write_lab_artifact(
        puzzle_path,
        lab_only,
        cap=300,
        effort="none",
        auth="api",
        output_dir=output_dir,
        timestamp="2026-07-12T16:00:00Z",
    )
    assert artifact["sessions"][-1]["display"] is False
    assert len(display_benchmark_entries(artifact)) == DISPLAY_MODEL_COUNT


def test_in_place_cli_accumulates_lab_runs_then_embeds_only_the_complete_trio(
    monkeypatch, tmp_path
):
    puzzle_path = tmp_path / "puzzle.json"
    source = puzzle()
    source["benchmark"] = [
        {"model": "claude-opus-4-8", "label": "OPUS", "tries": 4}
    ]
    puzzle_path.write_text(json.dumps(source), encoding="utf-8")
    lab_dir = tmp_path / "lab"
    monkeypatch.setattr("llm_play.BENCHMARK_OUTPUT_DIR", lab_dir)
    monkeypatch.setattr("llm_play.load_vocab", lambda _lang: VOCAB)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(
        "llm_play.provider_reply",
        lambda *_args, **_kwargs: ScriptedModel(["forest", "ocean"]),
    )

    for selector in ("OPUS", "SONNET"):
        assert (
            main(
                [
                    str(puzzle_path),
                    "--model",
                    selector,
                    "--runs",
                    "1",
                    "--in-place",
                ]
            )
            == 0
        )
        assert "benchmark" not in json.loads(
            puzzle_path.read_text(encoding="utf-8")
        )

    assert (
        main(
            [
                str(puzzle_path),
                "--model",
                "GPT-SOL",
                "--runs",
                "1",
                "--in-place",
            ]
        )
        == 0
    )
    embedded = json.loads(puzzle_path.read_text(encoding="utf-8"))["benchmark"]
    assert [entry["model"] for entry in embedded] == [
        "claude-opus-4-8",
        "claude-sonnet-5",
        "gpt-5.6-sol",
    ]
    assert all(entry["tries"] == 2 for entry in embedded)
    assert all(entry["run"] == ["forest", "ocean"] for entry in embedded)

    before_lab_only = deepcopy(embedded)
    assert (
        main(
            [
                str(puzzle_path),
                "--model",
                "GPT-TERRA",
                "--runs",
                "1",
                "--in-place",
            ]
        )
        == 0
    )
    assert json.loads(puzzle_path.read_text(encoding="utf-8"))["benchmark"] == (
        before_lab_only
    )
    artifact = json.loads(
        (lab_dir / "puzzle.bench.json").read_text(encoding="utf-8")
    )
    assert len(artifact["sessions"]) == 4
    assert artifact["sessions"][-1]["model_id"] == "gpt-5.6-terra"


def test_prompt_bump_keeps_the_existing_trio_until_atomic_replacement(
    monkeypatch, tmp_path, capsys
):
    old_entries = [
        {
            "model": "claude-opus-4-8",
            "label": "CLAUDE OPUS",
            "tag": "OPUS",
            "tries": 4,
            "run": ["cold", "other", "forest", "ocean"],
        },
        {
            "model": "claude-sonnet-5",
            "label": "CLAUDE SONNET",
            "tag": "SONNET",
            "tries": 4,
            "run": ["shared", "cold", "forest", "ocean"],
        },
        {
            "model": "gpt-5.6-sol",
            "label": "GPT-5.6",
            "tag": "GPT",
            "tries": 3,
            "run": ["other", "forest", "ocean"],
        },
    ]
    source = puzzle()
    source["benchmark"] = deepcopy(old_entries)
    puzzle_path = tmp_path / "puzzle.json"
    puzzle_path.write_text(json.dumps(source), encoding="utf-8")

    lab_dir = tmp_path / "lab"
    lab_dir.mkdir()
    old_sessions = [
        {
            "prompt_version": "3",
            "model_id": entry["model"],
            "benchmark_entry": entry,
        }
        for entry in old_entries
    ]
    (lab_dir / "puzzle.bench.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "puzzle": "puzzle.json",
                "sessions": old_sessions,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr("llm_play.BENCHMARK_OUTPUT_DIR", lab_dir)
    monkeypatch.setattr("llm_play.load_vocab", lambda _lang: VOCAB)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(
        "llm_play.provider_reply",
        lambda *_args, **_kwargs: ScriptedModel(["forest", "ocean"]),
    )

    for selector in ("OPUS", "SONNET"):
        assert (
            main(
                [
                    str(puzzle_path),
                    "--model",
                    selector,
                    "--runs",
                    "1",
                    "--in-place",
                ]
            )
            == 0
        )
        assert json.loads(puzzle_path.read_text(encoding="utf-8"))[
            "benchmark"
        ] == old_entries

    assert "kept existing benchmark" in capsys.readouterr().out

    assert (
        main(
            [
                str(puzzle_path),
                "--model",
                "GPT-SOL",
                "--runs",
                "1",
                "--in-place",
            ]
        )
        == 0
    )
    replacement = json.loads(puzzle_path.read_text(encoding="utf-8"))["benchmark"]
    assert [entry["model"] for entry in replacement] == [
        "claude-opus-4-8",
        "claude-sonnet-5",
        "gpt-5.6-sol",
    ]
    assert all(entry["tries"] == 2 for entry in replacement)
    assert all(entry["run"] == ["forest", "ocean"] for entry in replacement)


def test_verbose_reply_is_reprompted_without_scoring_its_first_word():
    model = ScriptedModel(["The answer is forest", "forest", "ocean"])

    result = play_puzzle(puzzle(), VOCAB, model)

    assert result.tries == 2
    assert result.turns == 3
    assert result.tried_words == ("forest", "ocean")
    correction = model.calls[1][-1]["content"]
    assert "INVALID REPLY FORMAT" in correction
    assert "contains whitespace" in correction
    assert "no apostrophe, space, punctuation, formatting, or explanation" in correction


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
    assert '"nonesuch" is not in the fixed game vocabulary' in user_feedback[1]
    assert "reply format was valid" in user_feedback[1]
    assert "Tries: 0" in user_feedback[1]
    assert all(
        "REJECTED OUTSIDE VOCABULARY "
        "(unordered; did not count; do not repeat): nonesuch" in message
        for message in user_feedback[1:]
    )
    assert '"shared" has the same folded lookup form' in user_feedback[3]
    assert "Tries: 1" in user_feedback[3]
    assert [(update.number, update.word) for update in updates] == [
        (1, "sharéd"),
        (2, "forest"),
        (3, "ocean"),
    ]
    assert updates[-1].progress == pytest.approx(100)


def test_rejected_vocabulary_words_persist_by_folded_form_without_counting():
    referee = PuzzleReferee(puzzle(), VOCAB)

    first = referee.submit("inlassé")
    second = referee.submit("inlasse")
    counted = referee.submit("cold")

    assert first.kind == second.kind == "invalid"
    assert counted.kind == "counted"
    assert referee.tries == 1
    assert referee.rejected_words == {"inlasse": "inlassé"}
    message = feedback_message(counted, referee)
    assert (
        "REJECTED OUTSIDE VOCABULARY "
        "(unordered; did not count; do not repeat): inlassé" in message
    )


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
    miss_message = feedback_message(miss, referee)
    assert "word 1: MISS" in miss_message
    assert "word 2: MISS" in miss_message


def test_referee_reports_stagnation_as_evidence_without_forcing_a_tactic():
    stocked = puzzle()
    # Warm but farther than the current best: non-improving, like a MISS for the stall.
    stocked["ranks"]["forest"]["warm"] = {"word": "warm", "rank": 30}
    stocked["ranks"]["forest"]["better"] = {"word": "better", "rank": 7}
    stocked["ranks"]["ocean"]["better"] = {"word": "better", "rank": 4}
    vocab = VOCAB | {"warm", "better"}
    referee = PuzzleReferee(stocked, vocab)

    improving = referee.submit("shared")
    assert referee.stalled_tries == 0
    improved_message = feedback_message(improving, referee)
    assert "NO-IMPROVEMENT STREAK: 0" in improved_message

    first = referee.submit("warm")  # warm, rank 30 > best 10: not closer
    assert referee.stalled_tries == 1

    second = referee.submit("cold")  # MISS on both holes
    assert referee.stalled_tries == 2
    message = feedback_message(second, referee)
    assert "WORD 1: shared (rank 10)" in message
    assert "WORD 2: shared (rank 5)" in message
    assert 'RESULT FOR "cold":' in message
    assert "word 1: MISS (current best remains rank 10)" in message
    assert "word 2: MISS (current best remains rank 5)" in message
    assert "NO-IMPROVEMENT STREAK: 2" in message
    assert "The last 2 counted guesses improved no word" in message
    assert "all current best ranks stayed unchanged" in message
    assert "EXCLUDED AS ALREADY TRIED (unordered; do not repeat): cold, shared, warm" in message
    assert "Similarity among your own guesses is not evidence of progress" not in message
    assert "Decide for yourself how to adapt" not in message
    assert "RECENT COUNTED OUTCOMES" not in message
    assert "- shared:" not in message
    assert "- warm:" not in message
    for prescribed_reset in (
        "CONTEXT ONLY",
        "SEARCH RESET",
        "HARD RESET",
        "semantic probes are forbidden",
        "literally complete the CLOZE",
        "All semantic clues are withheld",
    ):
        assert prescribed_reset not in message

    # Non-counting replies preserve the evidence without changing the streak.
    duplicate = referee.submit("cold")
    assert duplicate.kind == "duplicate"
    assert referee.stalled_tries == 2
    duplicate_message = feedback_message(duplicate, referee)
    assert "NO-IMPROVEMENT STREAK: 2" in duplicate_message
    assert "cold, shared, warm" in duplicate_message

    better = referee.submit("better")
    assert all(outcome.improved for outcome in better.outcomes)
    assert not any(outcome.solved for outcome in better.outcomes)
    assert referee.stalled_tries == 0
    better_message = feedback_message(better, referee)
    assert "NO-IMPROVEMENT STREAK: 0" in better_message
    assert "WORD 1: better (rank 7)" in better_message
    assert "WORD 2: better (rank 4)" in better_message


def test_individual_snapshot_keeps_a_compact_unordered_exclusion_set():
    misses = ["zulu", "alpha", "middle"]
    referee = PuzzleReferee(puzzle(), VOCAB | set(misses))

    for word in misses:
        feedback = referee.submit(word)
    message = feedback_message(feedback, referee)

    assert f"NO-IMPROVEMENT STREAK: {len(misses)}" in message
    assert 'RESULT FOR "middle":' in message
    assert "EXCLUDED AS ALREADY TRIED (unordered; do not repeat): alpha, middle, zulu" in message
    assert "RECENT COUNTED OUTCOMES" not in message
    assert "- zulu:" not in message
    assert "- alpha:" not in message
    # Each snapshot stays compact. The canonical fresh-turn prompt separately retains
    # these exact feedback messages in chronological order for both providers.
    assert "WORD 1: tree (rank 50)" in message
    assert "WORD 1: tree(50)," not in message


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
            "cold",
            "forest",
            "ocean",
        ]
    )
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr("llm_play.load_vocab", lambda _lang: VOCAB)
    monkeypatch.setattr("llm_play.provider_reply", lambda *_args, **_kwargs: model)

    assert main([str(path), "--model", "OPUS", "--runs", "3"]) == 0

    output = capsys.readouterr().out
    assert 'OPUS     run=1 try=1 word="forest" progress=50.00%' in output
    assert 'OPUS     run=1 try=2 word="ocean" progress=100.00%' in output
    assert 'OPUS     run=2 try=3 word="ocean" progress=100.00%' in output
    assert 'OPUS     run=3 try=3 word="ocean" progress=100.00%' in output
    assert 'OPUS     run=1 tried=["forest", "ocean"]' in output
    assert 'OPUS     run=2 tried=["shared", "forest", "ocean"]' in output
    assert 'OPUS     run=3 tried=["cold", "forest", "ocean"]' in output


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
                "--runs",
                "1",
            ]
        )
        == 0
    )

    output = capsys.readouterr()
    assert preflights == ["ChatGPT"]
    assert "auth=subscription" in output.out
    assert 'GPT      try=1 word="forest" progress=50.00%' in output.out
    assert "OPENAI_API_KEY is not set" not in output.err


def test_v14_cli_binds_the_persistent_session_mode_before_paid_play(
    monkeypatch, tmp_path, capsys
):
    path = tmp_path / "puzzle.json"
    path.write_text(json.dumps(puzzle()), encoding="utf-8")
    method = "I will use sentence completions and abandon flat hypotheses."
    model = ScriptedModel([method, "forest", "ocean"])
    provider_kwargs = []

    monkeypatch.setattr("llm_play.load_vocab", lambda _lang: VOCAB)
    monkeypatch.setattr(
        "llm_play.validate_openai_subscription_auth", lambda: "ChatGPT"
    )

    def fake_provider(_config, _api_key, **kwargs):
        provider_kwargs.append(kwargs)
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
                "--runs",
                "1",
                "--v14-baseline",
            ]
        )
        == 0
    )

    assert provider_kwargs == [
        {
            "effort": "medium",
            "auth": "subscription",
            "word_session": "persistent",
        }
    ]
    assert "prompt=14-persistent" in capsys.readouterr().out


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
        provider_calls.append((config["tag"], api_key, kwargs["auth"]))
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
                "--runs",
                "1",
            ]
        )
        == 0
    )

    assert preflights == ["anthropic"]
    assert provider_calls == [("OPUS", None, "subscription")]


def test_opening_cloze_keeps_affixes_but_never_inserts_ranked_guesses():
    model = ScriptedModel(["forest", "ocean"])
    play_puzzle(puzzle(), VOCAB, model)

    opening = model.calls[0][0]["content"]
    assert "CLOZE: the ([WORD 1], meets [WORD 2]" in opening
    assert "SEMANTIC EVIDENCE, NOT SENTENCE TEXT" in opening
    assert "WORD 1: tree (rank 50)" in opening
    assert "WORD 2: lake (rank 40)" in opening
    assert "tree(-50)" not in opening
    assert "lake(-40)" not in opening
    assert "English" in opening


def test_feedback_cloze_reveals_solutions_but_not_improving_clues():
    referee = PuzzleReferee(puzzle(), VOCAB)

    warm = feedback_message(referee.submit("shared"), referee)
    assert "CLOZE: the ([WORD 1], meets [WORD 2]" in warm
    assert "WORD 1: shared (rank 10)" in warm
    assert "WORD 2: shared (rank 5)" in warm
    assert "the (shared" not in warm

    solved = feedback_message(referee.submit("forest"), referee)
    assert "CLOZE: the (forest, meets [WORD 2]" in solved
    assert "WORD 1:" not in solved


def test_opening_injects_learned_strategy_as_guidance_and_first_reply_is_a_guess():
    learned = "Probe two domains early. Abandon a direction after 3 flat guesses."

    bare = ScriptedModel(["forest", "ocean"])
    play_puzzle(puzzle(), VOCAB, bare)
    bare_opening = bare.calls[0][0]["content"]
    assert "YOUR STRATEGY" not in bare_opening
    assert "then reply with exactly one bare English game-vocabulary word" in bare_opening
    # No pre-game plan is requested anywhere (#84).
    assert "state the method you commit to" not in bare_opening
    assert "your method" not in bare_opening

    model = ScriptedModel(["forest", "ocean"])
    result = play_puzzle(puzzle(), VOCAB, model, strategy=learned)

    # The first reply is the first guess: it scores immediately.
    assert result.tries == 2
    assert result.turns == 2
    assert result.conversation[1] == {"role": "assistant", "content": "forest"}

    opening = model.calls[0][0]["content"]
    assert "YOUR STRATEGY" in opening
    assert learned in opening
    assert "advice, not rules" in opening
    assert "fixed game rules above always take precedence" in opening


def test_v14_baseline_restores_the_historical_method_turn_prompt_and_parser():
    method = (
        "I will complete every blank from the sentence first, compare those "
        "candidates with the ranks, and abandon a direction after flat feedback."
    )
    model = ScriptedModel([method, "**forest**", "ocean"])

    result = play_puzzle(puzzle(), VOCAB, model, v14_baseline=True)

    assert result.tries == 2
    assert result.turns == 3
    assert result.tried_words == ("forest", "ocean")
    assert result.conversation[1] == {"role": "assistant", "content": method}

    opening = model.calls[0][0]["content"]
    assert "YOUR METHOD" in opening
    assert "state the method you commit to" in opening
    assert "First reply: your method, in free text — no guess yet" in opening
    assert "every counted guess is expensive" in opening
    # These absences distinguish the recorded historical v14 surface from the prior
    # branch's v21/stateless hybrid.
    assert "REPLY CONTRACT AFTER THE METHOD TURN" not in opening
    assert "REJECTED OUTSIDE VOCABULARY" not in opening
    assert "complete public turn record" not in opening
    assert "Earlier outcomes are not replayed as a word sequence." in opening

    first_guess_feedback = model.calls[1][-1]["content"]
    assert first_guess_feedback.startswith("Method noted.")
    assert first_guess_feedback.endswith("Reply with exactly one word.")
    assert "REJECTED OUTSIDE VOCABULARY" not in first_guess_feedback

    second_guess_feedback = model.calls[2][-1]["content"]
    assert second_guess_feedback.startswith('RESULT FOR "forest":')
    assert second_guess_feedback.endswith("Reply with exactly one word.")
    # Historical v14 accepted harmless formatting around exactly one lexical word.
    assert result.conversation[3] == {
        "role": "assistant",
        "content": "**forest**",
    }


def test_v14_baseline_rejects_playbooks_output_writes_and_noncontrol_config():
    with pytest.raises(SystemExit):
        parse_args(
            [
                "puzzle.json",
                "--model",
                "SONNET",
                "--v14-baseline",
                "--playbook",
                "strategy.json",
            ]
        )
    with pytest.raises(SystemExit):
        parse_args(
            [
                "puzzle.json",
                "--model",
                "GPT-SOL",
                "--v14-baseline",
                "--in-place",
            ]
        )
    with pytest.raises(SystemExit):
        parse_args(
            [
                "puzzle.json",
                "--model",
                "SONNET",
                "--v14-baseline",
                "--effort",
                "medium",
            ]
        )
    with pytest.raises(SystemExit):
        parse_args(
            [
                "puzzle.json",
                "--model",
                "SONNET",
                "--v14-baseline",
                "--auth",
                "subscription",
                "--effort",
                "high",
            ]
        )
    accepted = parse_args(
        [
            "puzzle.json",
            "--model",
            "SONNET",
            "--v14-baseline",
            "--auth",
            "subscription",
            "--effort",
            "medium",
        ]
    )
    assert accepted.v14_baseline is True


def test_every_unconditioned_caller_gets_the_same_strategy_neutral_rules():
    ordinary = ScriptedModel(["forest", "ocean"])
    play_puzzle(puzzle(), VOCAB, ordinary)

    neutral_alias = ScriptedModel(["forest", "ocean"])
    play_puzzle(puzzle(), VOCAB, neutral_alias, rules_only=True)

    assert ordinary.calls[0][0]["content"] == neutral_alias.calls[0][0]["content"]
    opening = ordinary.calls[0][0]["content"]
    assert "YOUR STRATEGY" not in opening
    assert "YOUR METHOD" not in opening
    assert "Decide for yourself how to adapt" not in opening


def test_stateless_reply_contract_permits_private_thinking_but_binds_visible_output():
    model = ScriptedModel(["forest", "ocean"])
    play_puzzle(puzzle(), VOCAB, model)

    for messages in model.calls:
        prompt = _stateless_word_prompt(messages)
        assert "Reason privately as needed" in prompt
        assert "your entire visible reply must be exactly one bare English" in prompt
        assert "The visible reply must contain no uppercase" in prompt
        assert "labels, reasoning, or explanations" not in prompt
        # Every stateless turn ends with the affirmative deliberation cue so
        # adaptive-thinking transports treat the choice as multi-step reasoning.
        assert (
            "multi-step deduction over the CLOZE, ranked clues, and exclusion sets"
            in prompt
        )
        assert "Reply now" not in prompt


def test_opening_prompt_explains_rules_without_prescribing_a_solving_plan():
    model = ScriptedModel(["forest", "ocean"])
    play_puzzle(puzzle(), VOCAB, model, cap=75)

    opening = model.calls[0][0]["content"]
    assert PROMPT_VERSION == "21"
    for header in (
        "OBJECTIVE AND SCORE",
        "MANDATORY REPLY CONTRACT",
        "CLOZE AND EXACT ANSWERS",
        "GUESS AND RANK RULES",
        "AUTHORITATIVE STATE",
        "COMPLETE CHRONOLOGICAL GAME RECORD",
    ):
        assert header in opening
    assert len(opening.split()) <= 650
    assert "limit of 75 counted tries" in opening
    assert "counted try 75 succeeds" in opening
    assert "first reply is the first guess, not a plan" in opening
    assert "Singular/plural, masculine/feminine" in opening
    assert "person, tense, mood, and conjugation" in opening
    # No built-in solving policy or formerly prescribed tactic may enter the neutral
    # contract. Only an explicit treatment strategy gets a YOUR STRATEGY block.
    for prescribed_tactic in (
        "YOUR METHOD",
        "Choose your own solving method",
        "Decide for yourself how to adapt",
        "counted guess as a costly hypothesis",
        "improvement supports continuing a direction",
        "DECISION: First reread the CLOZE",
        "DECISION — CONTEXT ONLY",
        "Do not work strictly left-to-right",
        "sample candidates or probes motivated by every unsolved position",
        "semantic search is paused",
        "replies must literally complete the CLOZE",
        "Balance direct candidates with probes",
        "Prefer frequent words over rare or literary ones",
    ):
        assert prescribed_tactic not in opening


def test_french_prompt_makes_apostrophe_and_clitic_contract_explicit():
    model = ScriptedModel(["s’endormait", "endormait"])

    result = play_puzzle(
        french_clitic_puzzle(),
        {"endormait"},
        model,
        cap=75,
        rules_only=True,
    )

    assert result.tries == 1
    assert result.turns == 2
    opening = model.calls[0][0]["content"]
    assert "CLOZE: il s'[WORD 1] paisiblement" in opening
    assert "exactly one bare French game-vocabulary word" in opening
    assert "French letters à â ä é è ê ë î ï ô ö ù û ü ÿ ç œ æ" in opening
    assert "ordinary ASCII hyphen" in opening
    assert "spaces, straight/curly apostrophes" in opening
    assert "Apostrophes are forbidden" in opening
    assert "shape s’+verb or l’+word" in opening
    assert "submit only the hidden lexical core" in opening
    assert "folded form must exist in the fixed vocabulary" in opening
    assert "equal folds are duplicates" in opening
    assert "5 consecutive malformed replies end the run" in opening
    assert "5 parsed non-counting replies without a counted guess" in opening
    assert "Rejected vocabulary forms persist" in opening
    assert "YOUR STRATEGY" not in opening

    correction = model.calls[1][-1]["content"]
    assert 'INVALID REPLY FORMAT: "s’endormait"' in correction
    assert "contains an apostrophe" in correction
    assert "Submit only one standalone lexical core" in correction
    assert "This did not count, changed no state, and produced no rank feedback" in correction


def test_opening_prompt_explains_rank_evidence_without_smuggling_in_a_method():
    model = ScriptedModel(["forest", "ocean"])
    play_puzzle(puzzle(), VOCAB, model)

    opening = model.calls[0][0]["content"]
    assert "distributional contextual relatedness" in opening
    assert "not guaranteed synonymy, grammar, or implication" in opening
    assert "Only rank 0 certifies the exact word" in opening
    assert "tested against every unsolved word" in opening
    assert "solved words are locked" in opening
    assert "A valid MISS still counts" in opening
    assert "strictly lower rank" in opening
    assert "One guess can produce different outcomes" in opening
    assert "fits no blank" in opening
    assert "improve or solve several words" in opening
    assert "Starting and later ranked clues" in opening
    assert "starting clue is uncounted" in opening
    assert "strict improvement resets the streak" in opening
    assert "non-counting leaves it unchanged" in opening
    for strategy_like_text in (
        "probe",
        "hypothesis",
        "search order",
        "follow a warm",
        "switch direction",
        "semantic search",
    ):
        assert strategy_like_text not in opening.lower()


def test_feedback_uses_current_best_without_replaying_a_word_cluster():
    referee = PuzzleReferee(puzzle(), VOCAB)

    referee.submit("shared")
    message = feedback_message(referee.submit("cold"), referee)

    assert "WORD 1: shared (rank 10)" in message
    assert "WORD 2: shared (rank 5)" in message
    assert "WORD 1: shared(10), tree(50)" not in message
    assert "WORD 2: shared(5), lake(40)" not in message
    assert 'RESULT FOR "cold":' in message
    assert "- shared:" not in message
    assert "RECENT COUNTED OUTCOMES" not in message
    assert "NO-IMPROVEMENT STREAK: 1" in message
    assert "EXCLUDED AS ALREADY TRIED (unordered; do not repeat): cold, shared" in message


def test_prompt_states_the_minimize_tries_objective_everywhere():
    model = ScriptedModel(["cold", "forest", "ocean"])
    play_puzzle(puzzle(), VOCAB, model)

    opening = model.calls[0][0]["content"]
    # The objective is explicit: the try count IS the score and guesses cost.
    assert "as few counted tries as possible" in opening
    assert "Your score is the total number of unique valid guesses" in opening
    assert "every counted guess is expensive" in opening
    # Every turn restates the score framing next to the count, opening included.
    assert "Tries: 0 (your score — lower is better)" in opening
    feedback = model.calls[1][-1]["content"]
    assert "Tries: 1 (your score — lower is better)" in feedback
    for turn in model.calls:
        current = turn[-1]["content"]
        assert "then reply with exactly one bare English game-vocabulary word" in current
        assert "Decide for yourself how to adapt" not in current


def test_unparseable_replies_reprompt_then_abort_after_five_consecutive_turns():
    model = ScriptedModel(["123", "...", "—", "42", "!!!"])

    with pytest.raises(UnparseableReplyError, match="5 consecutive") as raised:
        play_puzzle(puzzle(), VOCAB, model)

    assert len(model.calls) == MAX_CONSECUTIVE_UNPARSEABLE
    assert "INVALID REPLY FORMAT" in model.calls[1][-1]["content"]
    assert "outside the stated grammar" in model.calls[1][-1]["content"]
    assert raised.value.partial_result.counted_tries == 0
    assert raised.value.partial_result.turns == MAX_CONSECUTIVE_UNPARSEABLE
    assert raised.value.partial_result.tries is None


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

    with pytest.raises(NoProgressReplyError, match="without a counted try") as raised:
        play_puzzle(puzzle(), VOCAB, model)

    expected_calls = MAX_NONCOUNTING_REPLIES + (1 if replies[0] == "cold" else 0)
    assert len(model.calls) == expected_calls
    assert raised.value.partial_result.tries is None
    assert raised.value.partial_result.counted_tries == (
        1 if replies[0] == "cold" else 0
    )
