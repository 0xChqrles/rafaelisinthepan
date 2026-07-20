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
    DEFAULT_KIMI_RUNS,
    DEFAULT_RUNS,
    DEFAULT_SELECTION,
    DEFAULT_SESSION,
    DECISION_OUTPUT_MAX_TOKENS,
    DIRECT_OUTPUT_MAX_TOKENS,
    DISPLAY_MODEL_COUNT,
    EFFORT_LEVELS,
    KIMI_CODE_BASE_URL,
    KIMI_EFFORT_MAP,
    KIMI_SUBPROCESS_CONFLICT_ENV,
    MAX_CONSECUTIVE_UNPARSEABLE,
    MAX_NONCOUNTING_REPLIES,
    MODELS,
    OPENAI_API_EFFORTS,
    OPENAI_SUBSCRIPTION_CONFLICT_ENV,
    PROMPT_VERSION,
    PROVIDER_ENV,
    PROSE_OUTPUT_MAX_TOKENS,
    REASONING_MAX_TOKENS,
    SELECTION_MODES,
    SESSION_MODES,
    TOKEN_USAGE_SCHEMA_VERSION,
    ModelSummary,
    NoProgressReplyError,
    PuzzleReferee,
    RunResult,
    UnparseableReplyError,
    assert_benchmark_entry_consistent,
    benchmark_entry_replays,
    benchmark_model,
    feedback_message,
    load_playbook_profile,
    main,
    median_prune_reason,
    parse_args,
    parse_single_word,
    play_puzzle,
    provider_reply,
    resolve_puzzle_path,
    select_best_run,
    select_median_run,
    select_model,
    upsert_benchmark_entry,
    validate_anthropic_subscription_auth,
    validate_kimi_subscription_auth,
    validate_openai_subscription_auth,
    write_benchmark,
    write_lab_artifact,
    _effective_provider_effort,
    _aggregate_token_usage,
    _normalize_anthropic_token_usage,
    _normalize_openai_token_usage,
    _stateless_word_prompt,
)


def standardized_usage(
    input_tokens,
    output_tokens,
    *,
    cached_input_tokens=0,
    cache_write_input_tokens=0,
    reasoning_output_tokens=None,
):
    """Expected public v1 token shape; input/output are inclusive totals."""
    return {
        "input_tokens": input_tokens,
        "cached_input_tokens": cached_input_tokens,
        "cache_write_input_tokens": cache_write_input_tokens,
        "output_tokens": output_tokens,
        "reasoning_output_tokens": reasoning_output_tokens,
        "total_tokens": input_tokens + output_tokens,
    }


def test_provider_usage_normalizes_to_one_inclusive_cross_model_schema():
    expected = standardized_usage(
        200,
        30,
        cached_input_tokens=80,
        cache_write_input_tokens=20,
        reasoning_output_tokens=22,
    )

    assert _normalize_anthropic_token_usage(
        {
            "input_tokens": 100,
            "cache_read_input_tokens": 80,
            "cache_creation_input_tokens": 20,
            "output_tokens": 30,
            "output_tokens_details": {"thinking_tokens": 22},
            "service_tier": "standard",
        }
    ) == expected
    assert _normalize_openai_token_usage(
        {
            "input_tokens": 200,
            "input_tokens_details": {
                "cached_tokens": 80,
                "cache_write_tokens": 20,
            },
            "output_tokens": 30,
            "output_tokens_details": {"reasoning_tokens": 22},
            "total_tokens": 230,
        }
    ) == expected
    assert _normalize_openai_token_usage(
        {
            "input_tokens": 200,
            "cached_input_tokens": 80,
            "cache_write_input_tokens": 20,
            "output_tokens": 30,
            "reasoning_output_tokens": 22,
        }
    ) == expected


def test_standard_usage_aggregation_keeps_unknown_reasoning_explicit():
    assert _aggregate_token_usage(
        [
            standardized_usage(
                20,
                5,
                cached_input_tokens=8,
                cache_write_input_tokens=2,
            ),
            standardized_usage(
                30,
                7,
                cached_input_tokens=12,
                cache_write_input_tokens=3,
            ),
        ]
    ) == standardized_usage(
        50,
        12,
        cached_input_tokens=20,
        cache_write_input_tokens=5,
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
def test_versioned_v21_playbooks_remain_exact_frozen_critic_profiles(
    selector, filename, expected_sha256
):
    path = Path(__file__).resolve().parents[1] / "playbooks" / filename
    data = json.loads(path.read_text(encoding="utf-8"))
    playbook = data["final_playbook"]
    digest = hashlib.sha256(playbook.encode("utf-8")).hexdigest()

    assert data["gameplay_prompt_version"] == "21"
    assert digest == expected_sha256
    assert "analyst" not in data
    assert "critic" not in data
    with pytest.raises(ValueError, match="different gameplay prompt version"):
        load_playbook_profile(path, select_model(selector))


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


def repeated_secret_puzzle():
    return {
        "lang": "fr",
        "words": ["le", "chat,", "poursuit", "le", "chat", "dans", "le", "jardin."],
        "holes": [
            {
                "pos": 1,
                "secret": {"word": "chat", "slug": "chat"},
                "start": {"word": "animal", "slug": "animal"},
                "start_rank": 50,
                "suffix": ",",
            },
            {
                "pos": 4,
                "secret": {"word": "chat", "slug": "chat"},
                "start": {"word": "bête", "slug": "bete"},
                "start_rank": 50,
            },
            {
                "pos": 7,
                "secret": {"word": "jardin", "slug": "jardin"},
                "start": {"word": "parc", "slug": "parc"},
                "start_rank": 40,
                "suffix": ".",
            },
        ],
        "ranks": {
            "chat": {
                "animal": {"word": "animal", "rank": 30},
                "bete": {"word": "bête", "rank": 50},
                "chat": {"word": "chat", "rank": 0},
            },
            "jardin": {
                "parc": {"word": "parc", "rank": 40},
                "jardin": {"word": "jardin", "rank": 0},
            },
        },
    }


VOCAB = {"shared", "forest", "ocean", "cold", "other"}

ANTHROPIC_MODELS = [config for config in MODELS if config["provider"] == "anthropic"]
OPENAI_MODELS = [config for config in MODELS if config["provider"] == "openai"]
KIMI_MODELS = [config for config in MODELS if config["provider"] == "kimi"]


def test_supported_model_roster_marks_fable_kimi_gpt_as_the_display_trio():
    assert MODELS == [
        {
            "provider": "anthropic",
            "model_id": "claude-opus-4-8",
            "label": "CLAUDE OPUS",
            "tag": "OPUS",
            "display": False,
        },
        {
            "provider": "anthropic",
            "model_id": "claude-sonnet-5",
            "label": "CLAUDE SONNET",
            "tag": "SONNET",
            "display": False,
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
            "display": True,
        },
        {
            "provider": "kimi",
            "model_id": "k3",
            "label": "KIMI K3",
            "tag": "KIMI",
            "display": True,
        },
    ]
    # The front end shows exactly these three; every other roster model is recorded too
    # (`--in-place` embeds any model) but stays hidden by the client-side filter.
    assert {config["model_id"] for config in MODELS if config["display"]} == {
        "claude-fable-5",
        "k3",
        "gpt-5.6-sol",
    }
    assert sum(config["display"] for config in MODELS) == DISPLAY_MODEL_COUNT == 3
    assert KIMI_MODELS == [MODELS[6]]
    assert PROVIDER_ENV == {
        "anthropic": "ANTHROPIC_API_KEY",
        "openai": "OPENAI_API_KEY",
        "kimi": "KIMI_CODE_API_KEY",
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
    assert reply.last_token_usage == standardized_usage(11, 1)
    assert reply.last_raw_token_usage == {
        "input_tokens": 11,
        "output_tokens": 1,
    }
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

    anthropic = provider_reply(
        MODELS[0], "secret", effort="none", session="stateless"
    )
    openai = provider_reply(
        MODELS[2], "secret", effort="none", session="stateless"
    )
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
        "REFEREE FEEDBACK 1\nFIRST RESULT\n\n"
        "PLAYER REPLY 2\nsecond model reply\n\n"
        "REFEREE FEEDBACK 2\nSECOND RESULT\nCURRENT STATE\nlatest state"
    )
    assert expected[0]["content"].count("CURRENT STATE") == 2
    assert "after first" not in expected[0]["content"]


def test_anthropic_api_default_keeps_native_history_and_signed_thinking_blocks(
    monkeypatch,
):
    calls = []
    thinking = SimpleNamespace(
        type="thinking", thinking="private deduction", signature="signed"
    )
    first_text = SimpleNamespace(type="text", text="forest")
    second_text = SimpleNamespace(type="text", text="ocean")
    responses = iter(
        [
            SimpleNamespace(
                content=[thinking, first_text], stop_reason="end_turn"
            ),
            SimpleNamespace(content=[second_text], stop_reason="end_turn"),
            SimpleNamespace(content=[first_text], stop_reason="end_turn"),
        ]
    )

    class FakeAnthropic:
        def __init__(self, *, api_key):
            assert api_key == "secret"
            self.messages = SimpleNamespace(create=self.create)

        def create(self, **kwargs):
            calls.append(kwargs)
            return next(responses)

    monkeypatch.setitem(
        sys.modules, "anthropic", SimpleNamespace(Anthropic=FakeAnthropic)
    )
    reply = provider_reply(MODELS[0], "secret", effort="medium")
    opening = [{"role": "user", "content": "opening rules"}]
    continued = opening + [
        {"role": "assistant", "content": "forest"},
        {"role": "user", "content": "latest referee feedback"},
    ]

    assert reply(opening) == "forest"
    assert reply(continued) == "ocean"
    assert reply([{"role": "user", "content": "opening again"}]) == "forest"

    assert calls[0]["messages"] == opening
    assert calls[1]["messages"][0] == opening[0]
    assert calls[1]["messages"][1]["role"] == "assistant"
    assert calls[1]["messages"][1]["content"] == [thinking, first_text]
    assert calls[1]["messages"][2] == continued[-1]
    assert calls[2]["messages"] == [
        {"role": "user", "content": "opening again"}
    ]
    assert all(call["cache_control"] == {"type": "ephemeral"} for call in calls)


def test_stateless_word_prompt_preserves_initial_clues_and_every_exact_result():
    model = ScriptedModel(["shared", "cold", "forest", "ocean"])

    play_puzzle(puzzle(), VOCAB, model)

    assert _stateless_word_prompt(model.calls[0]) == model.calls[0][0]["content"]
    # Before the third guess, the current-best snapshot has replaced both starting
    # clues with "shared". The provider prompt must nevertheless retain the initial
    # clues plus both guesses and their exact, ordered per-hole outcomes. Superseded
    # full snapshots are omitted; only the initial and latest authoritative states remain.
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
    assert prompt.count("CURRENT STATE") == 2


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
def test_anthropic_subscription_word_adapter_resumes_one_native_session_per_run(
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
        assert "KIMI_CODE_API_KEY" not in os.environ
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
    monkeypatch.setenv("KIMI_CODE_API_KEY", "must-not-enter-claude")
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
    assert os.environ["KIMI_CODE_API_KEY"] == "must-not-enter-claude"
    assert reply.last_token_usage == standardized_usage(12, 1)

    first_options = calls[0][1]
    assert [call[0] for call in calls] == [
        opening[0]["content"],
        "latest state",
        "opening again",
    ]
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


def test_anthropic_subscription_stateless_mode_reconstructs_each_public_record(
    monkeypatch,
):
    calls = []

    async def fake_turn(prompt, **kwargs):
        calls.append((prompt, kwargs))
        return "forest", f"fresh-{len(calls)}", None

    monkeypatch.setattr(sys.modules["llm_play"], "_agent_sdk_turn", fake_turn)
    reply = provider_reply(
        MODELS[0],
        None,
        effort="medium",
        auth="subscription",
        session="stateless",
    )
    opening = [{"role": "user", "content": "opening\nCURRENT STATE\ninitial"}]
    continued = opening + [
        {"role": "assistant", "content": "forest"},
        {"role": "user", "content": "latest"},
    ]
    try:
        assert reply(opening) == "forest"
        assert reply(continued) == "forest"
    finally:
        reply.close()

    assert [call[0] for call in calls] == [
        _stateless_word_prompt(opening),
        _stateless_word_prompt(continued),
    ]
    assert [call[1]["resume"] for call in calls] == [None, None]


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
        assert reply.last_token_usage == standardized_usage(10, 132_844)
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
        raise Exception("Claude Code returned an error result: success")

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
        ) as raised:
            reply([{"role": "user", "content": "analyze"}])
        assert "error result: success" not in str(raised.value)
    finally:
        reply.close()


def test_agent_sdk_trailing_error_never_reports_success_without_diagnostics(monkeypatch):
    class FakeOptions:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    class FakeResultMessage:
        result = None
        session_id = "failed-session"
        is_error = True
        stop_reason = None
        subtype = "success"
        usage = None
        errors = None
        api_error_status = None

    async def fake_query(**_kwargs):
        yield FakeResultMessage()
        raise Exception("Claude Code returned an error result: success")

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
        MODELS[1], None, effort="medium", auth="subscription", output="prose"
    )
    try:
        with pytest.raises(
            RuntimeError, match="provider request failed without diagnostics"
        ) as raised:
            reply([{"role": "user", "content": "analyze"}])
        assert "error result: success" not in str(raised.value)
    finally:
        reply.close()


@pytest.mark.parametrize(
    ("requested", "effective"),
    [
        ("low", "low"),
        ("medium", "high"),
        ("high", "high"),
        ("xhigh", "max"),
        ("max", "max"),
        ("ultra", "max"),
    ],
)
def test_kimi_effort_mapping_is_explicit_and_never_disables_thinking(
    monkeypatch, requested, effective
):
    assert KIMI_EFFORT_MAP[requested] == effective
    assert _effective_provider_effort("kimi", requested) == effective

    calls = []

    async def fake_turn(prompt, **kwargs):
        calls.append((prompt, kwargs))
        return "forest", "kimi-session", None

    monkeypatch.setattr(
        sys.modules["llm_play"], "_agent_sdk_turn", fake_turn
    )
    reply = provider_reply(
        MODELS[6], "kimi-secret", effort=requested, auth="subscription"
    )
    try:
        assert reply([{"role": "user", "content": "board"}]) == "forest"
    finally:
        reply.close()
    assert calls[0][1]["effort"] == effective

    with pytest.raises(ValueError, match="does not allow.*none"):
        _effective_provider_effort("kimi", "none")


@pytest.mark.parametrize(
    ("requested_effort", "effective_effort"),
    [("low", "low"), ("medium", "high")],
)
def test_kimi_subscription_adapter_pins_endpoint_and_zero_tool_sdk_options(
    monkeypatch, requested_effort, effective_effort
):
    calls = []

    class FakeOptions:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    class FakeResultMessage:
        def __init__(self, result, session_id):
            self.result = result
            self.session_id = session_id
            self.is_error = False
            self.stop_reason = "end_turn"
            self.subtype = "success"
            self.usage = {"input_tokens": 21, "output_tokens": 3}

    async def fake_query(*, prompt, options):
        assert not (set(KIMI_SUBPROCESS_CONFLICT_ENV) & os.environ.keys())
        calls.append((prompt, options))
        yield FakeResultMessage("forest", options.resume or "kimi-session")

    monkeypatch.setitem(
        sys.modules,
        "claude_agent_sdk",
        SimpleNamespace(
            ClaudeAgentOptions=FakeOptions,
            ResultMessage=FakeResultMessage,
            query=fake_query,
        ),
    )
    inherited = {
        name: f"parent-{index}"
        for index, name in enumerate(KIMI_SUBPROCESS_CONFLICT_ENV)
    }
    for name, value in inherited.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://api.anthropic.com/")
    inherited["ANTHROPIC_BASE_URL"] = "https://api.anthropic.com/"

    reply = provider_reply(
        MODELS[6], "kimi-secret", effort=requested_effort, auth="subscription"
    )
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
    assert reply(continued) == "forest"
    assert reply.last_token_usage == standardized_usage(21, 3)
    assert {name: os.environ[name] for name in inherited} == inherited

    first_options = calls[0][1]
    assert [call[0] for call in calls] == [
        opening[0]["content"],
        "latest state",
    ]
    assert first_options.model == "k3"
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
    assert first_options.settings is None
    assert first_options.fallback_model is None
    assert first_options.max_turns == 1
    assert first_options.thinking == {"type": "adaptive"}
    assert first_options.effort == effective_effort
    assert [call[1].resume for call in calls] == [None, "kimi-session"]
    assert first_options.extra_args == {
        "safe-mode": None,
        "disable-slash-commands": None,
        "bare": None,
    }
    assert first_options.env["ANTHROPIC_API_KEY"] == "kimi-secret"
    assert first_options.env["ANTHROPIC_BASE_URL"] == KIMI_CODE_BASE_URL
    assert "KIMI_CODE_API_KEY" not in first_options.env
    config_dir = Path(first_options.env["CLAUDE_CONFIG_DIR"])
    workspace = Path(first_options.cwd)
    assert config_dir.parent == workspace
    assert config_dir.is_dir()
    assert workspace.is_dir()

    reply.close()
    assert not workspace.exists()


def test_kimi_subscription_stateless_mode_disables_provider_session_persistence(
    monkeypatch,
):
    calls = []

    async def fake_turn(prompt, **kwargs):
        calls.append((prompt, kwargs))
        return "forest", f"fresh-{len(calls)}", None

    monkeypatch.setattr(sys.modules["llm_play"], "_agent_sdk_turn", fake_turn)
    reply = provider_reply(
        MODELS[6],
        "kimi-secret",
        effort="low",
        auth="subscription",
        session="stateless",
    )
    opening = [{"role": "user", "content": "opening\nCURRENT STATE\ninitial"}]
    continued = opening + [
        {"role": "assistant", "content": "forest"},
        {"role": "user", "content": "latest"},
    ]
    try:
        assert reply(opening) == "forest"
        assert reply(continued) == "forest"
    finally:
        reply.close()

    assert [call[0] for call in calls] == [
        _stateless_word_prompt(opening),
        _stateless_word_prompt(continued),
    ]
    assert [call[1]["resume"] for call in calls] == [None, None]
    assert calls[0][1]["extra_args"]["no-session-persistence"] is None


def test_kimi_subscription_restores_environment_and_explains_entitlement_failure(
    monkeypatch,
):
    class FakeOptions:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    class FakeResultMessage:
        result = "K3 is not available on this plan"
        session_id = "failed-kimi"
        is_error = True
        stop_reason = None
        subtype = "error_during_execution"
        usage = None
        errors = ["model entitlement denied for kimi-secret"]
        api_error_status = 401

    async def fake_query(*, prompt, options):
        assert prompt == "board"
        assert options.env["ANTHROPIC_BASE_URL"] == KIMI_CODE_BASE_URL
        assert not (set(KIMI_SUBPROCESS_CONFLICT_ENV) & os.environ.keys())
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
    monkeypatch.setenv("KIMI_CODE_API_KEY", "parent-kimi-key")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "parent-anthropic-key")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://api.anthropic.com/")
    before = {
        name: os.environ.get(name) for name in KIMI_SUBPROCESS_CONFLICT_ENV
    }

    reply = provider_reply(
        MODELS[6], "kimi-secret", effort="high", auth="subscription"
    )
    try:
        with pytest.raises(
            RuntimeError,
            match=r"Kimi Code authentication or K3 plan/model entitlement.*Moderato",
        ) as raised:
            reply([{"role": "user", "content": "board"}])
        assert "kimi-secret" not in str(raised.value)
        assert "[redacted]" in str(raised.value)
    finally:
        reply.close()

    assert {
        name: os.environ.get(name) for name in KIMI_SUBPROCESS_CONFLICT_ENV
    } == before


def test_kimi_subscription_preserves_rate_limit_after_sdk_trailing_error(monkeypatch):
    class FakeOptions:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    class FakeResultMessage:
        result = None
        session_id = "rate-limited-kimi"
        is_error = True
        stop_reason = None
        subtype = "success"
        usage = None
        errors = ["The engine is currently overloaded, please try again later"]
        api_error_status = 429

    async def fake_query(*, prompt, options):
        assert prompt == "board"
        assert options.env["ANTHROPIC_BASE_URL"] == KIMI_CODE_BASE_URL
        yield FakeResultMessage()
        raise Exception("Claude Code returned an error result: success")

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
        MODELS[6], "kimi-secret", effort="medium", auth="subscription"
    )
    try:
        with pytest.raises(
            RuntimeError,
            match=r"rate limit, quota, or temporary overload.*provider HTTP status 429",
        ) as raised:
            reply([{"role": "user", "content": "board"}])
        assert "error result: success" not in str(raised.value)
    finally:
        reply.close()


def test_kimi_auth_preflight_requires_dedicated_key_and_supported_agent_sdk(
    monkeypatch,
):
    with pytest.raises(RuntimeError, match="KIMI_CODE_API_KEY"):
        validate_kimi_subscription_auth(None)

    def missing_module(_name):
        raise ModuleNotFoundError("claude_agent_sdk")

    monkeypatch.setattr("llm_play.importlib.import_module", missing_module)
    with pytest.raises(RuntimeError, match="requires claude-agent-sdk"):
        validate_kimi_subscription_auth("kimi-secret")


def test_kimi_auth_preflight_rejects_sdk_without_isolation_options(monkeypatch):
    class OldOptions:
        def __init__(self, model=None):
            self.model = model

    fake_sdk = SimpleNamespace(
        ClaudeAgentOptions=OldOptions,
        ResultMessage=object,
        query=lambda **_kwargs: None,
    )
    monkeypatch.setattr(
        "llm_play.importlib.import_module", lambda _name: fake_sdk
    )

    with pytest.raises(RuntimeError, match="too old.*missing options"):
        validate_kimi_subscription_auth("kimi-secret")


def test_kimi_auth_preflight_verifies_zero_tool_cli_capabilities_without_key_leak(
    monkeypatch,
):
    llm_play_module = sys.modules["llm_play"]

    class FakeOptions:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    fake_sdk = SimpleNamespace(
        ClaudeAgentOptions=FakeOptions,
        ResultMessage=object,
        query=lambda **_kwargs: None,
    )
    monkeypatch.setattr(
        llm_play_module.importlib, "import_module", lambda _name: fake_sdk
    )
    monkeypatch.setattr(
        llm_play_module.shutil, "which", lambda _name: "/usr/bin/claude"
    )
    monkeypatch.setenv("KIMI_CODE_API_KEY", "must-not-enter-cli-preflight")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://api.anthropic.com/")

    def fake_run(command, **kwargs):
        assert command == ["/usr/bin/claude", "--help"]
        assert not (set(KIMI_SUBPROCESS_CONFLICT_ENV) & kwargs["env"].keys())
        return SimpleNamespace(
            returncode=0,
            stdout=" ".join(
                [
                    "--bare",
                    "--disable-slash-commands",
                    "--effort",
                    "--no-session-persistence",
                    "--setting-sources",
                    "--strict-mcp-config",
                    "--tools",
                ]
            ),
        )

    monkeypatch.setattr(llm_play_module.subprocess, "run", fake_run)

    assert validate_kimi_subscription_auth("kimi-secret") == "Kimi Code"


def test_kimi_auth_preflight_rejects_cli_without_bare_isolation(monkeypatch):
    llm_play_module = sys.modules["llm_play"]

    class FakeOptions:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    fake_sdk = SimpleNamespace(
        ClaudeAgentOptions=FakeOptions,
        ResultMessage=object,
        query=lambda **_kwargs: None,
    )
    monkeypatch.setattr(
        llm_play_module.importlib, "import_module", lambda _name: fake_sdk
    )
    monkeypatch.setattr(
        llm_play_module.shutil, "which", lambda _name: "/usr/bin/claude"
    )
    monkeypatch.setattr(
        llm_play_module.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(
            returncode=0,
            stdout=(
                "--disable-slash-commands --effort --no-session-persistence "
                "--setting-sources --strict-mcp-config --tools"
            ),
        ),
    )

    with pytest.raises(RuntimeError, match=r"unsupported.*missing flags: --bare"):
        validate_kimi_subscription_auth("kimi-secret")


def test_subscription_auth_preflight_strips_api_credentials(monkeypatch):
    def fake_run(command, **kwargs):
        assert command == ["/usr/local/bin/claude", "auth", "status", "--json"]
        assert "ANTHROPIC_API_KEY" not in kwargs["env"]
        assert "KIMI_CODE_API_KEY" not in kwargs["env"]
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
    monkeypatch.setenv("KIMI_CODE_API_KEY", "must-not-enter-claude")
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

    reply = provider_reply(
        config,
        None,
        effort=effort,
        auth="subscription",
        session="stateless",
    )
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
    assert reply.last_token_usage == standardized_usage(20, 2)

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


def test_openai_subscription_default_resumes_one_saved_codex_thread_per_run(
    monkeypatch,
):
    calls = []
    cumulative_usage = [
        {
            "input_tokens": 100,
            "cached_input_tokens": 20,
            "cache_write_input_tokens": 5,
            "output_tokens": 10,
            "reasoning_output_tokens": 6,
        },
        {
            "input_tokens": 250,
            "cached_input_tokens": 100,
            "cache_write_input_tokens": 15,
            "output_tokens": 25,
            "reasoning_output_tokens": 15,
        },
        {
            "input_tokens": 90,
            "cached_input_tokens": 0,
            "cache_write_input_tokens": 0,
            "output_tokens": 8,
            "reasoning_output_tokens": 5,
        },
    ]

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        if "resume" in command:
            thread_id = command[-2]
        else:
            thread_id = f"thread-{len(calls)}"
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
                            "usage": cumulative_usage[len(calls) - 1],
                        }
                    ),
                ]
            ),
            stderr="",
        )

    monkeypatch.setattr("llm_play.shutil.which", lambda _command: "/usr/bin/codex")
    monkeypatch.setattr("llm_play.subprocess.run", fake_run)
    reply = provider_reply(
        MODELS[2], None, effort="medium", auth="subscription"
    )
    opening = [{"role": "user", "content": "opening rules"}]
    continued = opening + [
        {"role": "assistant", "content": "forest"},
        {"role": "user", "content": "latest referee feedback"},
    ]
    try:
        assert reply(opening) == "forest"
        first_usage = reply.last_token_usage
        assert reply(continued) == "forest"
        resumed_usage = reply.last_token_usage
        assert reply([{"role": "user", "content": "opening again"}]) == "forest"
        next_run_usage = reply.last_token_usage
        next_run_raw_usage = reply.last_raw_token_usage
    finally:
        reply.close()

    assert first_usage == standardized_usage(
        100,
        10,
        cached_input_tokens=20,
        cache_write_input_tokens=5,
        reasoning_output_tokens=6,
    )
    # Codex emits cumulative saved-thread totals; the benchmark exposes only this
    # turn's delta so the generic aggregator cannot triangularly double-count it.
    assert resumed_usage == standardized_usage(
        150,
        15,
        cached_input_tokens=80,
        cache_write_input_tokens=10,
        reasoning_output_tokens=9,
    )
    assert next_run_usage == standardized_usage(
        90,
        8,
        reasoning_output_tokens=5,
    )
    assert next_run_raw_usage == cumulative_usage[2]
    assert _aggregate_token_usage([first_usage, resumed_usage]) == (
        standardized_usage(
            250,
            25,
            cached_input_tokens=100,
            cache_write_input_tokens=15,
            reasoning_output_tokens=15,
        )
    )

    first_command, first_kwargs = calls[0]
    resumed_command, resumed_kwargs = calls[1]
    next_run_command, next_run_kwargs = calls[2]
    assert first_command[:2] == ["/usr/bin/codex", "exec"]
    assert "--ephemeral" not in first_command
    assert "--cd" in first_command and "--sandbox" in first_command
    assert 'history.persistence="save-all"' in first_command
    assert resumed_command[:3] == ["/usr/bin/codex", "exec", "resume"]
    assert resumed_command[-2] == "thread-1"
    assert "--cd" not in resumed_command and "--sandbox" not in resumed_command
    assert "--ephemeral" not in resumed_command
    assert next_run_command[:2] == ["/usr/bin/codex", "exec"]
    assert "resume" not in next_run_command
    assert [first_kwargs["input"], resumed_kwargs["input"], next_run_kwargs["input"]] == [
        "opening rules",
        "latest referee feedback",
        "opening again",
    ]


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


@pytest.mark.parametrize(
    "item_type",
    [
        # The classic tool items the denylist already covered.
        "command_execution",
        "file_change",
        "mcp_tool_call",
        "web_search",
        # The request-surface leaks the denylist silently let through (#93): plan
        # updates, user-input prompts, image views, plugins, and any future capability.
        "update_plan",
        "request_user_input",
        "view_image",
        "plugin_call",
        "some_future_capability",
    ],
)
def test_openai_subscription_rejects_every_non_reasoning_item(monkeypatch, item_type):
    monkeypatch.setattr("llm_play.shutil.which", lambda _command: "/usr/bin/codex")
    monkeypatch.setattr(
        "llm_play.subprocess.run",
        lambda *_args, **_kwargs: SimpleNamespace(
            returncode=0,
            stdout=json.dumps(
                {"type": "item.completed", "item": {"type": item_type}}
            ),
            stderr="",
        ),
    )
    reply = provider_reply(MODELS[2], None, effort="medium", auth="subscription")

    with pytest.raises(RuntimeError, match="forbidden tool activity"):
        reply([{"role": "user", "content": "opening"}])
    reply.close()


def test_openai_subscription_allows_private_reasoning_before_the_message(monkeypatch):
    # The allowlist must not over-tighten: a real reasoning-effort run streams private
    # `reasoning` items ahead of the final `agent_message`, and those must pass.
    monkeypatch.setattr("llm_play.shutil.which", lambda _command: "/usr/bin/codex")
    monkeypatch.setattr(
        "llm_play.subprocess.run",
        lambda *_args, **_kwargs: SimpleNamespace(
            returncode=0,
            stdout="\n".join(
                [
                    json.dumps({"type": "thread.started", "thread_id": "thread-1"}),
                    json.dumps(
                        {
                            "type": "item.completed",
                            "item": {"type": "reasoning", "text": "weigh the clues"},
                        }
                    ),
                    json.dumps(
                        {
                            "type": "item.completed",
                            "item": {"type": "agent_message", "text": "forest"},
                        }
                    ),
                    json.dumps({"type": "turn.completed", "usage": {}}),
                ]
            ),
            stderr="",
        ),
    )
    reply = provider_reply(MODELS[2], None, effort="medium", auth="subscription")

    assert reply([{"role": "user", "content": "opening"}]) == "forest"
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


def test_openai_api_default_chains_responses_and_resets_between_runs(monkeypatch):
    calls = []
    responses = iter(
        [
            SimpleNamespace(id="response-1", output_text="forest", status="completed"),
            SimpleNamespace(id="response-2", output_text="ocean", status="completed"),
            SimpleNamespace(id="response-3", output_text="forest", status="completed"),
        ]
    )

    class FakeOpenAI:
        def __init__(self, *, api_key):
            assert api_key == "secret"
            self.responses = SimpleNamespace(create=self.create)

        def create(self, **kwargs):
            calls.append(kwargs)
            return next(responses)

    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=FakeOpenAI))
    reply = provider_reply(MODELS[2], "secret", effort="medium")
    opening = [{"role": "user", "content": "opening rules"}]
    continued = opening + [
        {"role": "assistant", "content": "forest"},
        {"role": "user", "content": "latest referee feedback"},
    ]

    assert reply(opening) == "forest"
    assert reply(continued) == "ocean"
    assert reply([{"role": "user", "content": "opening again"}]) == "forest"

    assert [call["input"] for call in calls] == [
        [{"role": "user", "content": "opening rules"}],
        [{"role": "user", "content": "latest referee feedback"}],
        [{"role": "user", "content": "opening again"}],
    ]
    assert [call["store"] for call in calls] == [True, True, True]
    assert "previous_response_id" not in calls[0]
    assert calls[1]["previous_response_id"] == "response-1"
    assert "previous_response_id" not in calls[2]


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
    reply = provider_reply(
        config, "secret", effort="none", session="stateless"
    )

    assert reply([{"role": "user", "content": "board"}]) == "ocean"
    assert reply.last_token_usage == standardized_usage(9, 1)
    assert reply.last_raw_token_usage == {
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
    reply = provider_reply(
        config, "secret", effort=effort, session="stateless"
    )

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
    assert defaults.session == DEFAULT_SESSION == "persistent"
    assert defaults.runs == DEFAULT_RUNS == 5
    assert defaults.selection == DEFAULT_SELECTION == "median"
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
    for session in SESSION_MODES:
        assert (
            parse_args(
                ["puzzle.json", "--model", "OPUS", "--session", session]
            ).session
            == session
        )

    kimi = parse_args(
        [
            "puzzle.json",
            "--model",
            "KIMI",
            "--auth",
            "subscription",
            "--effort",
            "low",
        ]
    )
    assert kimi.runs == DEFAULT_KIMI_RUNS == 1


def test_cli_requires_odd_median_runs_but_best_accepts_any_positive_count(capsys):
    for runs in (0, 2, 8):
        with pytest.raises(SystemExit):
            parse_args(
                ["puzzle.json", "--model", "OPUS", "--runs", str(runs)]
            )
    error = capsys.readouterr().err
    assert "must be odd so the median is an actual run" in error

    for runs in (1, 2, 8):
        args = parse_args(
            [
                "puzzle.json",
                "--model",
                "OPUS",
                "--selection",
                "best",
                "--runs",
                str(runs),
            ]
        )
        assert args.selection == "best"
        assert args.runs == runs
    with pytest.raises(SystemExit):
        parse_args(
            [
                "puzzle.json",
                "--model",
                "OPUS",
                "--selection",
                "best",
                "--runs",
                "0",
            ]
        )
    assert SELECTION_MODES == ("median", "best")


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


def test_cli_requires_kimi_subscription_auth_and_rejects_none_before_a_request(
    capsys,
):
    for selector in ("KIMI", "k3"):
        args = parse_args(
            [
                "puzzle.json",
                "--model",
                selector,
                "--auth",
                "subscription",
                "--effort",
                "medium",
            ]
        )
        assert args.model_config == MODELS[6]
        assert args.effort == "medium"

    with pytest.raises(SystemExit):
        parse_args(
            ["puzzle.json", "--model", "KIMI", "--auth", "subscription"]
        )
    assert "disabling thinking routes the request to K2.6" in capsys.readouterr().err

    with pytest.raises(SystemExit):
        parse_args(
            ["puzzle.json", "--model", "KIMI", "--effort", "medium"]
        )
    assert "requires --auth subscription" in capsys.readouterr().err


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
        ("KIMI", MODELS[6]),
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
    assert (
        "Valid values: OPUS, SONNET, GPT-SOL, GPT-TERRA, GPT-LUNA, FABLE, KIMI"
        in error
    )
    for config in MODELS:
        assert config["model_id"] in error


def test_cli_model_flag_without_value_lists_every_valid_model(capsys):
    with pytest.raises(SystemExit):
        parse_args(["--model"])

    error = capsys.readouterr().err
    assert "argument --model: expected one argument" in error
    assert (
        "Valid values: OPUS, SONNET, GPT-SOL, GPT-TERRA, GPT-LUNA, FABLE, KIMI"
        in error
    )
    for config in MODELS:
        assert config["model_id"] in error


@pytest.mark.parametrize(
    ("argument", "values"),
    [
        ("--effort", EFFORT_LEVELS),
        ("--auth", AUTH_MODES),
        ("--session", SESSION_MODES),
        ("--selection", SELECTION_MODES),
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


def test_write_benchmark_embeds_a_variable_length_array_and_preserves_file_mode(tmp_path):
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
            "model": "gpt-5.6-sol",
            "label": "GPT-5.6",
            "tag": "GPT",
            "tries": None,
            "run": ["cold", "other"],
        },
    ]
    path.write_text(json.dumps(source, ensure_ascii=False), encoding="utf-8")
    os.chmod(path, 0o640)

    # Any number of tested models embed (the front end owns the display filter), not a
    # fixed trio; two here.
    write_benchmark(path, source, entries)
    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["benchmark"] == entries
    assert written["source"]["work"] == "L'été"
    assert os.stat(path).st_mode & 0o777 == 0o640

    # A single-model array is valid; an empty array is not.
    write_benchmark(path, source, entries[:1])
    assert json.loads(path.read_text(encoding="utf-8"))["benchmark"] == entries[:1]
    with pytest.raises(ValueError, match="at least one entry"):
        write_benchmark(path, source, [])

    # Duplicate model / tag entries are still rejected.
    with pytest.raises(ValueError, match="model entries must be unique"):
        write_benchmark(path, source, [entries[0], entries[0]])

    write_benchmark(path, source, None)
    assert "benchmark" not in json.loads(path.read_text(encoding="utf-8"))


def make_run(
    tries,
    *,
    turns,
    words=(),
    duration=1.0,
    token_usage=(),
    raw_token_usage=(),
    termination=None,
):
    return RunResult(
        tries=tries,
        counted_tries=len(words),
        turns=turns,
        duration=duration,
        tried_words=tuple(words),
        conversation=({"role": "user", "content": "opening"},),
        turn_token_usage=tuple(token_usage),
        termination=(
            termination
            if termination is not None
            else "solved" if tries is not None else "cap"
        ),
        raw_provider_token_usage=tuple(raw_token_usage),
    )


def test_median_prune_has_no_upper_bound_before_k_runs_solve():
    finalized = [
        make_run(4, turns=4),
        make_run(9, turns=9),
        make_run(None, turns=20, termination="cap"),
    ]

    assert (
        median_prune_reason(finalized, 300, total_runs=5) is None
    )


def test_median_prune_stops_at_the_kth_smallest_solved_score():
    finalized = [
        make_run(11, turns=11),
        make_run(5, turns=5),
        make_run(8, turns=8),
    ]

    assert median_prune_reason(finalized, 10, total_runs=5) is None
    assert (
        median_prune_reason(finalized, 11, total_runs=5)
        == "upper_half"
    )


def test_median_prune_bound_tightens_when_more_runs_solve():
    first_three_solves = [
        make_run(15, turns=15),
        make_run(4, turns=4),
        make_run(9, turns=9),
    ]
    with_later_solve = [*first_three_solves, make_run(6, turns=6)]

    assert (
        median_prune_reason(first_three_solves, 9, total_runs=5) is None
    )
    assert (
        median_prune_reason(with_later_solve, 9, total_runs=5)
        == "upper_half"
    )


def test_median_prune_short_circuits_only_after_a_cap_dnf_majority():
    two_dnfs = [
        make_run(None, turns=20, termination="cap"),
        make_run(None, turns=21, termination="cap"),
    ]
    three_dnfs = [
        *two_dnfs,
        make_run(None, turns=22, termination="cap"),
    ]

    assert median_prune_reason(two_dnfs, 0, total_runs=5) is None
    assert (
        median_prune_reason(three_dnfs, 0, total_runs=5)
        == "dnf_majority"
    )


def test_single_median_run_never_prunes():
    assert median_prune_reason([], 300, total_runs=1) is None
    assert (
        median_prune_reason(
            [make_run(None, turns=300, termination="cap")],
            300,
            total_runs=1,
        )
        is None
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


def test_upper_half_pruning_preserves_the_fully_run_median():
    fully_run = [
        make_run(6, turns=6),
        make_run(14, turns=14),
        make_run(9, turns=9),
        make_run(25, turns=25),
        make_run(18, turns=18),
    ]
    cost_pruned = [
        *fully_run[:3],
        make_run(None, turns=14, termination="upper_half"),
        make_run(None, turns=14, termination="upper_half"),
    ]

    assert select_median_run(fully_run) == 1
    assert select_median_run(cost_pruned) == 1


def test_best_selection_returns_the_lowest_success_with_stable_ties():
    score_order = [
        make_run(10, turns=4),
        make_run(None, turns=1),
        make_run(20, turns=6),
    ]
    assert select_best_run(score_order) == 0

    fewer_turns_breaks_score_ties = [
        make_run(10, turns=4),
        make_run(10, turns=3),
        make_run(20, turns=1),
    ]
    assert select_best_run(fewer_turns_breaks_score_ties) == 1

    earlier_index_breaks_full_ties = [
        make_run(10, turns=3),
        make_run(10, turns=3),
    ]
    assert select_best_run(earlier_index_breaks_full_ties) == 0

    all_dnf = [make_run(None, turns=5), make_run(None, turns=3)]
    assert select_best_run(all_dnf) == 1

    with pytest.raises(ValueError, match="zero"):
        select_best_run([])


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


def test_run_result_collects_each_normalized_turn_usage():
    model = UsageScriptedModel(
        ["forest", "ocean"],
        [
            {"input_tokens": 10, "output_tokens": 1},
            {"input_tokens": 20, "output_tokens": 1},
        ],
    )

    result = play_puzzle(puzzle(), VOCAB, model)

    assert result.turn_token_usage == (
        standardized_usage(10, 1),
        standardized_usage(20, 1),
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

    assert summary.selection == "median"
    assert summary.selected_run_index == 1
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


def test_median_mode_prunes_a_later_provable_upper_half_run(tmp_path):
    model = ScriptedModel(
        [
            # The first two sequential runs establish median upper bound 3.
            "forest",
            "ocean",
            "shared",
            "forest",
            "ocean",
            # The last run is still unsolved at 3 and makes no fourth call.
            "cold",
            "other",
            "forest",
        ]
    )

    summary = benchmark_model(
        MODELS[0], puzzle(), VOCAB, model, cap=300, runs=3
    )

    assert summary.selected_run_index == 1
    assert summary.tries == 3
    assert [result.counted_tries for result in summary.results] == [2, 3, 3]
    assert [result.termination for result in summary.results] == [
        "solved",
        "solved",
        "upper_half",
    ]
    assert summary.results[2].tries is None
    assert summary.results[2].tried_words == ("cold", "other", "forest")
    assert len(model.calls) == 8
    assert summary.benchmark_entry()["run"] == ["shared", "forest", "ocean"]

    _, artifact = write_lab_artifact(
        tmp_path / "forest_ocean.json",
        summary,
        cap=300,
        effort="medium",
        auth="api",
        output_dir=tmp_path / "lab",
    )
    pruned_run = artifact["sessions"][0]["runs"][2]
    assert pruned_run["tries"] is None
    assert pruned_run["counted_tries"] == 3
    assert pruned_run["termination"] == "upper_half"


def test_median_mode_preserves_a_bound_equal_to_cap_as_a_real_dnf():
    model = ScriptedModel(
        [
            # Three solves establish a median bound equal to cap=2.
            "forest",
            "ocean",
            "forest",
            "ocean",
            "forest",
            "ocean",
            # These runs receive no early pruning and must remain genuine cap DNFs.
            "cold",
            "other",
            "cold",
            "other",
        ]
    )

    summary = benchmark_model(
        MODELS[0], puzzle(), VOCAB, model, cap=2, runs=5
    )

    assert [result.counted_tries for result in summary.results] == [2, 2, 2, 2, 2]
    assert [result.termination for result in summary.results] == [
        "solved",
        "solved",
        "solved",
        "cap",
        "cap",
    ]
    assert len(model.calls) == 10


def test_median_mode_dnf_majority_skips_every_remaining_provider_call():
    model = ScriptedModel(["cold", "other", "cold", "other"])

    summary = benchmark_model(
        MODELS[0], puzzle(), VOCAB, model, cap=2, runs=3
    )

    assert summary.tries is None
    assert [result.counted_tries for result in summary.results] == [2, 2, 0]
    assert [result.termination for result in summary.results] == [
        "cap",
        "cap",
        "dnf_majority",
    ]
    assert summary.results[2].conversation == ()
    assert len(model.calls) == 4
    # The censored placeholder stays lab-only; the representative is a genuine,
    # complete cap DNF whose run can still be replayed and embedded.
    assert summary.selected_run.termination == "cap"
    assert summary.benchmark_entry()["run"] == ["cold", "other"]


@pytest.mark.parametrize("termination", ["cannot_beat_best", "upper_half", "dnf_majority"])
def test_cost_pruned_run_can_never_be_embedded(termination):
    summary = ModelSummary(
        config=MODELS[0],
        results=(
            make_run(
                None,
                turns=2,
                words=("cold", "other"),
                termination=termination,
            ),
        ),
        selection="median",
        selected_run_index=0,
    )

    with pytest.raises(ValueError, match="cost-pruned"):
        summary.benchmark_entry()


def test_best_mode_prunes_only_after_a_run_cannot_beat_the_incumbent():
    model = ScriptedModel(
        [
            # Run 1 establishes a best score of 3.
            "shared",
            "forest",
            "ocean",
            # Run 2 is unsolved at 3 and stops before consuming another reply.
            "cold",
            "other",
            "shared",
            # Run 3 improves the incumbent to 2.
            "forest",
            "ocean",
            # Run 4 is unsolved at 2 and stops there.
            "cold",
            "other",
        ]
    )

    summary = benchmark_model(
        MODELS[0],
        puzzle(),
        VOCAB,
        model,
        cap=300,
        runs=4,
        selection="best",
    )

    assert summary.selection == "best"
    assert summary.selected_run_index == 2
    assert summary.tries == 2
    assert [result.counted_tries for result in summary.results] == [3, 3, 2, 2]
    assert [result.termination for result in summary.results] == [
        "solved",
        "cannot_beat_best",
        "solved",
        "cannot_beat_best",
    ]
    assert len(model.calls) == 10
    assert summary.benchmark_entry()["run"] == ["forest", "ocean"]


def test_best_pruning_preserves_a_solve_on_the_incumbent_number():
    tied_model = ScriptedModel(["forest", "ocean"])
    tied = play_puzzle(
        puzzle(),
        VOCAB,
        tied_model,
        best_score_to_beat=2,
    )
    ordinary_model = ScriptedModel(["forest", "ocean"])
    play_puzzle(puzzle(), VOCAB, ordinary_model)
    pruned = play_puzzle(
        puzzle(),
        VOCAB,
        ScriptedModel(["cold", "other", "forest"]),
        best_score_to_beat=2,
    )

    assert tied.tries == 2
    assert tied.termination == "solved"
    # Selection is orchestration only: it does not change the model's game prompt.
    assert tied_model.calls[0] == ordinary_model.calls[0]
    assert pruned.tries is None
    assert pruned.counted_tries == 2
    assert pruned.tried_words == ("cold", "other")
    assert pruned.termination == "cannot_beat_best"


def test_best_mode_runs_to_the_real_cap_until_a_successful_incumbent_exists():
    model = ScriptedModel(["cold", "other", "cold", "other"])

    summary = benchmark_model(
        MODELS[0],
        puzzle(),
        VOCAB,
        model,
        cap=2,
        runs=2,
        selection="best",
    )

    assert summary.tries is None
    assert len(model.calls) == 4
    assert [result.counted_tries for result in summary.results] == [2, 2]
    assert [result.termination for result in summary.results] == ["cap", "cap"]


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
        standardized_usage(10, 1, cached_input_tokens=2),
        standardized_usage(5, 2),
    )
    raw_usage = (
        {
            "input_tokens": 8,
            "cache_read_input_tokens": 2,
            "cache_creation_input_tokens": 0,
            "output_tokens": 1,
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
                raw_token_usage=raw_usage,
            ),
            make_run(4, turns=4, words=("cold", "other", "forest", "ocean")),
        ),
        selection="median",
        selected_run_index=1,
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
    assert session["auth"] == "subscription"
    assert session["session"] == "persistent"
    assert session["token_usage_schema_version"] == TOKEN_USAGE_SCHEMA_VERSION
    assert session["effort"] == "medium"
    assert session["requested_effort"] == "medium"
    assert session["effective_provider_effort"] == "medium"
    assert session["selection"] == "median"
    assert session["selected_run"] == 2
    assert session["median_run"] == 2
    assert session["duration"] == 4.0
    assert session["token_usage"] == standardized_usage(
        15, 3, cached_input_tokens=2
    )
    assert len(session["runs"]) == 3
    assert [run["selected"] for run in session["runs"]] == [False, True, False]
    selected = session["runs"][1]
    assert selected["guesses"] == ["shared", "forest", "ocean"]
    assert selected["tries"] == 3
    assert selected["termination"] == "solved"
    assert selected["turns"] == 3
    assert selected["duration"] == 2.0
    assert selected["transcript"] == [
        {"role": "user", "content": "opening"}
    ]
    assert selected["token_usage"] == standardized_usage(
        15, 3, cached_input_tokens=2
    )
    assert selected["turn_token_usage"] == list(usage)
    assert selected["raw_provider_token_usage"] == list(raw_usage)
    assert session["benchmark_entry"]["run"] == ["shared", "forest", "ocean"]

    transports = [(MODELS[1], "api", "api"), (MODELS[2], "subscription", "codex_cli")]
    for index, (config, auth, expected_transport) in enumerate(transports, start=1):
        summary = ModelSummary(
            config=config,
            results=(make_run(2 + index, turns=2, words=("forest", "ocean")),),
            selection="median",
            selected_run_index=0,
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

    kimi_summary = ModelSummary(
        config=MODELS[6],
        results=(
            make_run(
                2,
                turns=2,
                words=("forest", "ocean"),
                duration=3.5,
                token_usage=({"input_tokens": 31, "output_tokens": 4},),
            ),
        ),
        selection="median",
        selected_run_index=0,
    )
    _, artifact = write_lab_artifact(
        puzzle_path,
        kimi_summary,
        cap=300,
        effort="medium",
        auth="subscription",
        output_dir=output_dir,
        timestamp="2026-07-18T14:00:00Z",
    )
    kimi_session = artifact["sessions"][-1]
    assert kimi_session["provider"] == "kimi"
    assert kimi_session["model_id"] == "k3"
    assert kimi_session["transport"] == "kimi_code_agent_sdk"
    assert kimi_session["auth"] == "subscription"
    assert kimi_session["requested_effort"] == "medium"
    assert kimi_session["effective_provider_effort"] == "high"
    assert kimi_session["prompt_version"] == PROMPT_VERSION
    assert kimi_session["cap"] == 300
    assert kimi_session["selection"] == "median"
    assert kimi_session["duration"] == 3.5
    assert kimi_session["token_usage"] == standardized_usage(31, 4)
    assert kimi_session["display"] is True

    lab_only = ModelSummary(
        config=MODELS[3],
        results=(make_run(9, turns=9, words=("other",)),),
        selection="median",
        selected_run_index=0,
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
    # The lab record annotates each session with its display flag (a lab-only model here);
    # the front end, not this artifact, decides what actually ships.
    assert artifact["sessions"][-1]["display"] is False
    assert artifact["sessions"][-1]["model_id"] == "gpt-5.6-terra"


def test_upsert_benchmark_entry_records_any_model_and_prunes_stale_entries():
    source = puzzle()
    # A previously embedded entry that still replays, plus one that is well-shaped but no
    # longer solves this puzzle (its run never reaches the secrets). The upsert keeps the
    # first and prunes the second rather than shipping a broken run.
    good = {
        "model": "claude-fable-5",
        "label": "CLAUDE FABLE",
        "tag": "FABLE",
        "tries": 2,
        "run": ["forest", "ocean"],
    }
    stale = {
        "model": "claude-sonnet-5",
        "label": "CLAUDE SONNET",
        "tag": "SONNET",
        "tries": 2,
        "run": ["cold", "other"],
    }
    source["benchmark"] = [good, stale]

    fresh = {
        "model": "gpt-5.6-sol",
        "label": "GPT-5.6",
        "tag": "GPT",
        "tries": 3,
        "run": ["shared", "forest", "ocean"],
    }
    entries, dropped = upsert_benchmark_entry(source, VOCAB, fresh)

    assert dropped == ["claude-sonnet-5"]
    # Roster order (gpt-sol=2 before fable=5) makes the on-disk array deterministic.
    assert [entry["model"] for entry in entries] == ["gpt-5.6-sol", "claude-fable-5"]
    assert good in entries and fresh in entries
    assert not benchmark_entry_replays(source, VOCAB, stale)

    # Re-running an already-recorded model replaces its entry instead of duplicating it.
    source["benchmark"] = entries
    replaced = {**fresh, "tries": 4, "run": ["cold", "shared", "forest", "ocean"]}
    entries2, dropped2 = upsert_benchmark_entry(source, VOCAB, replaced)
    assert dropped2 == []
    assert sum(entry["model"] == "gpt-5.6-sol" for entry in entries2) == 1
    assert next(e for e in entries2 if e["model"] == "gpt-5.6-sol")["tries"] == 4


def test_in_place_requires_median_persistent_and_the_default_run_count(capsys):
    ok = parse_args(["puzzle.json", "--model", "OPUS", "--in-place"])
    assert ok.in_place is True
    assert ok.runs == DEFAULT_RUNS == 5

    with pytest.raises(SystemExit):
        parse_args(
            ["puzzle.json", "--model", "OPUS", "--selection", "best",
             "--runs", "5", "--in-place"]
        )
    assert "--in-place requires --selection median" in capsys.readouterr().err

    with pytest.raises(SystemExit):
        parse_args(
            ["puzzle.json", "--model", "OPUS", "--session", "stateless", "--in-place"]
        )
    assert "--in-place requires --session persistent" in capsys.readouterr().err

    with pytest.raises(SystemExit):
        parse_args(["puzzle.json", "--model", "OPUS", "--runs", "3", "--in-place"])
    assert "--in-place requires exactly 5 runs" in capsys.readouterr().err


def test_in_place_cli_embeds_every_tested_model_and_prunes_stale_entries(
    monkeypatch, tmp_path, capsys
):
    # A legacy/malformed entry for a model we will NOT re-run first: the first upsert must
    # prune it (it can no longer replay) rather than ship it.
    puzzle_path = tmp_path / "puzzle.json"
    source = puzzle()
    source["benchmark"] = [{"model": "claude-opus-4-8", "label": "OPUS", "tries": 4}]
    puzzle_path.write_text(json.dumps(source), encoding="utf-8")
    lab_dir = tmp_path / "lab"
    monkeypatch.setattr("llm_play.BENCHMARK_OUTPUT_DIR", lab_dir)
    monkeypatch.setattr("llm_play.load_vocab", lambda _lang: VOCAB)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    # benchmark_model reuses one reply model across all runs of a call, so supply enough
    # scripted replies for the default 5 solving runs (forest, ocean each).
    monkeypatch.setattr(
        "llm_play.provider_reply",
        lambda *_args, **_kwargs: ScriptedModel(["forest", "ocean"] * 5),
    )

    def run(selector):
        # No --runs: exercises the default (5) that --in-place requires.
        assert main([str(puzzle_path), "--model", selector, "--in-place"]) == 0
        return json.loads(puzzle_path.read_text(encoding="utf-8"))["benchmark"]

    # SONNET is a lab-only model, yet it is recorded immediately; the malformed opus entry
    # that no longer replays is pruned in the same write.
    after_sonnet = run("SONNET")
    assert [entry["model"] for entry in after_sonnet] == ["claude-sonnet-5"]
    assert "Dropped stale benchmark entry (claude-opus-4-8)" in capsys.readouterr().out

    # Display and lab-only models accumulate side by side, roster-ordered.
    run("GPT-SOL")  # display
    run("FABLE")  # display
    embedded = run("GPT-TERRA")  # lab-only, still recorded
    assert [entry["model"] for entry in embedded] == [
        "claude-sonnet-5",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "claude-fable-5",
    ]
    assert all(entry["tries"] == 2 for entry in embedded)
    assert all(entry["run"] == ["forest", "ocean"] for entry in embedded)

    # Re-running an already-recorded model replaces its entry instead of duplicating it.
    re_embedded = run("GPT-SOL")
    assert [entry["model"] for entry in re_embedded] == [
        "claude-sonnet-5",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "claude-fable-5",
    ]

    artifact = json.loads((lab_dir / "puzzle.bench.json").read_text(encoding="utf-8"))
    assert len(artifact["sessions"]) == 5
    assert artifact["sessions"][-1]["model_id"] == "gpt-5.6-sol"


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


def test_referee_broadcasts_shared_secret_to_duplicate_occurrences():
    referee = PuzzleReferee(repeated_secret_puzzle(), {"animal", "chat", "jardin"})

    first = referee.submit("animal")
    assert [(outcome.number, outcome.rank) for outcome in first.outcomes] == [
        (1, 30),
        (2, 30),
        (3, None),
    ]
    assert referee.tries == 1
    assert [hole.rank for hole in referee.holes] == [30, 30, 40]

    solved = referee.submit("chat")
    assert [(outcome.number, outcome.rank, outcome.solved) for outcome in solved.outcomes] == [
        (1, 0, True),
        (2, 0, True),
        (3, None, False),
    ]
    assert referee.tries == 2
    assert [hole.rank for hole in referee.holes] == [0, 0, 40]

    final = referee.submit("jardin")
    assert final.solved is True
    assert referee.tries == 3
    assert referee.cloze() == "le chat, poursuit le chat dans le jardin."


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
    assert result.termination == "cap"


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
    assert "selection=median" in output
    assert "median_run=2" in output
    assert 'OPUS     run=1 try=1 word="forest" progress=50.00%' in output
    assert 'OPUS     run=1 try=2 word="ocean" progress=100.00%' in output
    assert 'OPUS     run=2 try=3 word="ocean" progress=100.00%' in output
    assert 'OPUS     run=3 try=3 word="ocean" progress=100.00%' in output
    assert 'OPUS     run=1 tried=["forest", "ocean"]' in output
    assert 'OPUS     run=2 tried=["shared", "forest", "ocean"]' in output
    assert 'OPUS     run=3 tried=["cold", "forest", "ocean"]' in output


def test_cli_labels_a_median_cost_prune_separately_from_a_real_dnf(
    monkeypatch, tmp_path, capsys
):
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
            "other",
            "forest",
        ]
    )
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr("llm_play.load_vocab", lambda _lang: VOCAB)
    monkeypatch.setattr("llm_play.provider_reply", lambda *_args, **_kwargs: model)

    assert main([str(path), "--model", "OPUS", "--runs", "3"]) == 0

    output = capsys.readouterr().out
    assert "3 tries  median_run=2" in output
    assert (
        'run=3 tried=["cold", "other", "forest"] '
        "termination=upper_half cost_pruned=true stopped_at=3 score>3"
        in output
    )
    assert len(model.calls) == 8


def test_cli_best_selection_prunes_a_dominated_run_and_reports_the_best(
    monkeypatch, tmp_path, capsys
):
    path = tmp_path / "puzzle.json"
    path.write_text(json.dumps(puzzle()), encoding="utf-8")
    model = ScriptedModel(["forest", "ocean", "cold", "other", "forest"])
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr("llm_play.load_vocab", lambda _lang: VOCAB)
    monkeypatch.setattr("llm_play.provider_reply", lambda *_args, **_kwargs: model)

    assert (
        main(
            [
                str(path),
                "--model",
                "OPUS",
                "--runs",
                "2",
                "--selection",
                "best",
            ]
        )
        == 0
    )

    output = capsys.readouterr().out
    assert "selection=best" in output
    assert "2 tries  best_run=1" in output
    assert 'OPUS     run=1 tried=["forest", "ocean"]' in output
    assert 'OPUS     run=2 tried=["cold", "other"]' in output
    assert len(model.calls) == 4


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
        assert kwargs["session"] == "stateless"
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
                "--session",
                "stateless",
                "--runs",
                "1",
            ]
        )
        == 0
    )

    output = capsys.readouterr()
    assert preflights == ["ChatGPT"]
    assert "auth=subscription" in output.out
    assert "session=stateless" in output.out
    assert 'GPT      try=1 word="forest" progress=50.00%' in output.out
    assert "OPENAI_API_KEY is not set" not in output.err


def test_cli_kimi_subscription_uses_dedicated_key_and_reports_effective_effort(
    monkeypatch, tmp_path, capsys
):
    path = tmp_path / "puzzle.json"
    path.write_text(json.dumps(puzzle()), encoding="utf-8")
    model = UsageScriptedModel(
        ["forest", "ocean"],
        [
            {"input_tokens": 12, "output_tokens": 2},
            {"input_tokens": 18, "output_tokens": 3},
        ],
    )
    preflights = []
    secret = "kimi-key-must-not-be-printed"

    monkeypatch.setenv("KIMI_CODE_API_KEY", secret)
    monkeypatch.setattr("llm_play.load_vocab", lambda _lang: VOCAB)
    monkeypatch.setattr(
        "llm_play.validate_kimi_subscription_auth",
        lambda api_key: preflights.append(api_key) or "Kimi Code",
    )

    def fake_provider(config, api_key, **kwargs):
        assert config == MODELS[6]
        assert api_key == secret
        assert kwargs["effort"] == "medium"
        assert kwargs["auth"] == "subscription"
        assert kwargs["session"] == "persistent"
        return model

    monkeypatch.setattr("llm_play.provider_reply", fake_provider)

    assert (
        main(
            [
                str(path),
                "--model",
                "KIMI",
                "--auth",
                "subscription",
                "--effort",
                "medium",
            ]
        )
        == 0
    )

    output = capsys.readouterr()
    assert preflights == [secret]
    assert "provider=kimi" in output.out
    assert "model=k3" in output.out
    assert "transport=kimi_code_agent_sdk" in output.out
    assert "auth=subscription" in output.out
    assert "session=persistent" in output.out
    assert f"token_usage_schema={TOKEN_USAGE_SCHEMA_VERSION}" in output.out
    assert "requested_effort=medium" in output.out
    assert "effective_provider_effort=high" in output.out
    assert "KIMI cost notice: low effort still uses adaptive thinking" in output.out
    assert (
        "schedules 1 run with up to 300 counted guesses each in persistent mode"
        in output.out
    )
    assert "malformed or non-counting replies can add requests" in output.out
    assert (
        'try=1 word="forest" progress=50.00% '
        'token_usage={"input_tokens":12,"cached_input_tokens":0,'
        '"cache_write_input_tokens":0,"output_tokens":2,'
        '"reasoning_output_tokens":null,"total_tokens":14}' in output.out
    )
    assert (
        'token_usage={"input_tokens":30,"cached_input_tokens":0,'
        '"cache_write_input_tokens":0,"output_tokens":5,'
        '"reasoning_output_tokens":null,"total_tokens":35}' in output.out
    )
    assert secret not in output.out
    assert secret not in output.err


def test_cli_kimi_missing_key_fails_preflight_without_building_a_provider(
    monkeypatch, tmp_path, capsys
):
    path = tmp_path / "puzzle.json"
    path.write_text(json.dumps(puzzle()), encoding="utf-8")
    monkeypatch.delenv("KIMI_CODE_API_KEY", raising=False)
    monkeypatch.setattr("llm_play.load_vocab", lambda _lang: VOCAB)

    provider_calls = []
    monkeypatch.setattr(
        "llm_play.provider_reply",
        lambda *_args, **_kwargs: provider_calls.append("called"),
    )

    assert (
        main(
            [
                str(path),
                "--model",
                "k3",
                "--auth",
                "subscription",
                "--effort",
                "medium",
                "--runs",
                "1",
            ]
        )
        == 2
    )
    assert provider_calls == []
    assert "KIMI_CODE_API_KEY" in capsys.readouterr().err


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
    assert PROMPT_VERSION == "23"
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
    assert "limit is 75 counted tries" in opening
    assert "Counted try 75 succeeds" in opening
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
    assert "ITS SHOWN RANK IS ALREADY KNOWN" in opening
    assert "cannot improve that same WORD" in opening
    assert "Do not re-test it" in opening
    assert "improve a different unsolved WORD" in opening
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
    assert "Score counts unique valid guesses" in opening
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
