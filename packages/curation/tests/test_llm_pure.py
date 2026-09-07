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
