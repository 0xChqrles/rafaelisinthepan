"""The pure parts of the LLM layer: JSON extraction and the author comparison."""

from llm import completion_matches, parse_json, same_author, split_for_completion


def test_same_author_compares_name_parts_in_any_order():
    assert same_author("Fernando Pessoa (as Bernardo Soares)", "Pessoa Fernando")
    assert same_author("Houellebecq", "Michel Houellebecq")
    assert not same_author("Marguerite Duras", "Delphine de Vigan")
    assert not same_author("Jean de La Fontaine", "Pierre de Marivaux")  # particles never match
    assert not same_author("", "Pessoa Fernando")


def test_parse_json_reads_fenced_and_trailing_text():
    assert parse_json('Sure:\n```json\n{"word": "cygne"}\n```') == {"word": "cygne"}
    assert parse_json('{"a": [1, 2]} trailing words') == {"a": [1, 2]}
    assert parse_json("[1, 2]") == [1, 2]


def test_completion_matches_a_verbatim_line_not_a_paraphrase():
    head, tail = split_for_completion("Aujourd’hui, maman est morte. Ou peut-être hier, je ne sais pas.")
    assert head == "Aujourd’hui, maman est morte. Ou"
    assert completion_matches(tail, "peut-être hier, je ne sais pas.")
    assert completion_matches(tail, "peut-etre hier je ne sais pas")  # punctuation and accents fold
    assert not completion_matches(tail, "")
    assert not completion_matches(tail, "la veille, je crois, ou avant.")


# The page's cut (#270): two integer counts, or nothing — the clamp is sentences'.
class _Canned:
    def __init__(self, answer):
        self.answer, self.calls = answer, 0

    def json(self, prompt):
        self.calls += 1
        return self.answer


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
