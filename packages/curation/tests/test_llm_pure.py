"""The pure parts of the LLM layer: JSON extraction and the answers' validation."""

import pytest

from llm import LLMError, parse_json, stands_alone


def test_parse_json_reads_fenced_and_trailing_text():
    assert parse_json('Sure:\n```json\n{"word": "cygne"}\n```') == {"word": "cygne"}
    assert parse_json('{"a": [1, 2]} trailing words') == {"a": [1, 2]}
    assert parse_json("[1, 2]") == [1, 2]


# The page's cut (#270): two integer counts, or nothing — the clamp is sentences'.
class _Canned:
    def __init__(self, answer):
        self.answer, self.calls = answer, 0

    def json(self, prompt):
        self.calls += 1
        return self.answer


@pytest.mark.parametrize("ok", [True, False])
def test_stands_alone_preserves_the_boolean_verdict(ok):
    answer = {"stands_alone": ok, "about": " Une promenade. ",
              "why": "" if ok else " Le lieu dépend de la page précédente. "}
    result = stands_alone(_Canned(answer), "Il marche dans ce lieu.")
    assert result == {"ok": ok, "about": answer["about"].strip(), "why": answer["why"].strip()}


@pytest.mark.parametrize("answer", [
    None, [], {},
    {"stands_alone": "false", "about": "Une promenade.", "why": "Lieu inconnu."},
    {"stands_alone": 1, "about": "Une promenade.", "why": ""},
    {"stands_alone": True, "about": " ", "why": ""},
    {"stands_alone": False, "about": "", "why": " "},
    {"stands_alone": True, "about": ["Une promenade."], "why": ""},
    {"stands_alone": False, "about": "", "why": None},
])
def test_stands_alone_refuses_malformed_verdicts(answer):
    with pytest.raises(LLMError, match="standalone check"):
        stands_alone(_Canned(answer), "Il marche dans ce lieu.")


def test_choose_excerpt_takes_two_integers_and_nothing_else():
    from llm import choose_excerpt
    window = {"before": ["B1."], "after": ["A1.", "A2."]}
    assert choose_excerpt(_Canned({"before": 1, "after": 2}), "Ligne.", window) == {"before": 1, "after": 2}
    assert choose_excerpt(_Canned({"before": 20, "after": -1}), "Ligne.", window) == {"before": 20, "after": -1}
    assert choose_excerpt(_Canned({"before": "2", "after": 1}), "Ligne.", window) is None
    assert choose_excerpt(_Canned({"before": True, "after": 1}), "Ligne.", window) is None
    assert choose_excerpt(_Canned({"after": 1}), "Ligne.", window) is None
    empty = _Canned({"before": 5, "after": 5})
    assert choose_excerpt(empty, "Ligne.", {"before": [], "after": []}) == {"before": 0, "after": 0}
    assert empty.calls == 0
