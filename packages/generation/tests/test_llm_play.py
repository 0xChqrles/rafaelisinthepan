"""Rules-parity contract for the offline LLM benchmark referee (#68).

The scripted model is deliberately network-free. These assertions describe the same
score/guess semantics as the browser: folded-vocab existence, folded dedupe, one counted
guess broadcast to every unsolved hole, strict improvements, and a counted-try DNF cap.
"""

from copy import deepcopy
import json
import os
from types import SimpleNamespace
import sys

import pytest

from llm_play import (
    MAX_CONSECUTIVE_UNPARSEABLE,
    MODELS,
    PROVIDER_ENV,
    PuzzleReferee,
    UnparseableReplyError,
    feedback_message,
    median_tries,
    play_puzzle,
    provider_reply,
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


def test_anthropic_adapter_disables_thinking_and_omits_rejected_sampling(monkeypatch):
    calls = []

    class FakeAnthropic:
        def __init__(self, *, api_key):
            assert api_key == "secret"
            self.messages = SimpleNamespace(create=self.create)

        def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(content=[SimpleNamespace(text="forest")])

    monkeypatch.setitem(
        sys.modules, "anthropic", SimpleNamespace(Anthropic=FakeAnthropic)
    )
    reply = provider_reply(MODELS[1], "secret")

    assert reply([{"role": "user", "content": "board"}]) == "forest"
    assert calls == [
        {
            "model": "claude-sonnet-5",
            "max_tokens": 32,
            "messages": [{"role": "user", "content": "board"}],
            "thinking": {"type": "disabled"},
        }
    ]
    assert not ({"temperature", "top_p", "top_k"} & calls[0].keys())


def test_openai_adapter_uses_responses_with_the_exact_sol_id(monkeypatch):
    calls = []

    class FakeOpenAI:
        def __init__(self, *, api_key):
            assert api_key == "secret"
            self.responses = SimpleNamespace(create=self.create)

        def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(output_text="ocean")

    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=FakeOpenAI))
    reply = provider_reply(MODELS[2], "secret")

    assert reply([{"role": "user", "content": "board"}]) == "ocean"
    assert calls == [
        {
            "model": "gpt-5.6-sol",
            "input": [{"role": "user", "content": "board"}],
            "max_output_tokens": 256,
        }
    ]


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


def test_final_score_matches_front_unique_try_semantics_for_same_sequence():
    # Invalid and folded duplicate submissions are visible turns but not tries; a MISS is
    # a vocabulary-valid unique try; the two secret guesses complete the round.
    sequence = ["???", "sharéd", "shared", "cold", "forest", "ocean"]
    result = play_puzzle(puzzle(), VOCAB, ScriptedModel(sequence))

    folded_unique_valid = {"shared", "cold", "forest", "ocean"}
    assert result.tries == len(folded_unique_valid) == 4
    assert result.turns == len(sequence)


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
