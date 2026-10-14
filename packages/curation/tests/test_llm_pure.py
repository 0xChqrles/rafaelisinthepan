"""The pure parts of the LLM layer: JSON extraction and the answers' validation."""

import pytest

from llm import LLMError, parse_json, stands_alone
from rules import Token


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
    result = stands_alone(_Canned(answer), "Il marche dans ce lieu.", lang="fr")
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
        stands_alone(_Canned(answer), "Il marche dans ce lieu.", lang="fr")


def test_choose_excerpt_takes_two_integers_and_nothing_else():
    from llm import choose_excerpt
    window = {"before": ["B1."], "after": ["A1.", "A2."]}
    assert choose_excerpt(_Canned({"before": 1, "after": 2}), "Ligne.", window, lang="fr") == {"before": 1, "after": 2}
    assert choose_excerpt(_Canned({"before": 20, "after": -1}), "Ligne.", window, lang="fr") == {"before": 20, "after": -1}
    assert choose_excerpt(_Canned({"before": "2", "after": 1}), "Ligne.", window, lang="fr") is None
    assert choose_excerpt(_Canned({"before": True, "after": 1}), "Ligne.", window, lang="fr") is None
    assert choose_excerpt(_Canned({"after": 1}), "Ligne.", window, lang="fr") is None
    empty = _Canned({"before": 5, "after": 5})
    assert choose_excerpt(empty, "Ligne.", {"before": [], "after": []}, lang="fr") == {"before": 0, "after": 0}
    assert empty.calls == 0


# The would-say test: a chance in [0, 1] and the word kept instead, or nothing usable.
@pytest.mark.parametrize("answer, expected", [
    ({"would_say": 0.3, "instead": " faussaire "}, (0.3, "faussaire")),
    ({"would_say": 1, "instead": None}, (1, None)),
    ({"would_say": 0, "instead": "  "}, (0, None)),
    ({"would_say": True, "instead": "x"}, (None, "x")),
    ({"would_say": "0.3", "instead": "x"}, (None, "x")),
    ({"would_say": 1.5}, (None, None)),
    ({"would_say": -0.1}, (None, None)),
    ([0.3], (None, None)),
])
def test_would_say_keeps_a_chance_in_range_and_nothing_else(answer, expected):
    from llm import would_say
    tokens = [Token(0, "le", "le", "DET", "le", True), Token(1, "faussaire", "faussaire", "NOUN", "faussaire", False)]
    assert would_say(_Canned(answer), tokens, set(), 1, "faussaire", lang="fr") == expected


# --- #317: every question speaks the day's language ----------------------------------
import inspect

import llm
from rules import Token


class _Answer:
    def __init__(self, answer):
        self.answer = answer

    def json(self, _prompt):
        return self.answer


_DAY = {"marked": "The [cat].", "words": [{"word": "cat", "level": "medium"}], "path": []}


@pytest.mark.parametrize("answer, expected", [
    ({"order": [2, 1], "why": "w"}, {"order": [1, 0], "why": "w"}),
    ({"order": [], "why": "none"}, {"order": [], "why": "none"}),      # every line declined
    ({"order": [1, 1]}, None),                                         # a line twice
    ({"order": [3]}, None),                                            # no such line
    ({"order": [True]}, None),
    ({"why": "w"}, None),
])
def test_choose_among_takes_an_order_of_the_lines_shown_and_nothing_else(answer, expected):
    assert llm.choose_among(_Answer(answer), [_DAY, _DAY], lang="fr") == expected


@pytest.mark.parametrize("answer, expected", [
    ({"words": ["a", "b", "c"], "path": ["a: x", 3], "why": "w"}, {"words": ["a", "b", "c"], "path": ["a: x"], "why": "w"}),
    ({"words": None, "why": "flat"}, {"words": None, "why": "flat"}),  # the line declined
    ({"words": ["a", "b"]}, None),
    ({"why": "w"}, None),
])
def test_choose_words_takes_three_words_or_a_decline(answer, expected):
    assert llm.choose_words(_Answer(answer), {"sentence": "The cat.", "allowed": ["cat"]}, [], lang="fr") == expected


class _Capture:
    """A fake Claude that keeps every prompt it is asked."""

    def __init__(self):
        self.prompts = []

    def json(self, prompt):
        self.prompts.append(prompt)
        return {"picks": [], "ranked": [1, 0], "about": "x", "stands_alone": True, "why": "", "known": False,
                "line": None, "guesses": [], "expected": None, "choice": 1, "valid": True, "faulty": [],
                "starts": {}, "before": 0, "after": 0, "word": None}


def _tok(i, text, space=" "):
    return Token(i, text, text.lower(), "NOUN", text.lower(), False, space)


_TOKENS = [_tok(0, "the"), _tok(1, "cat", ""), _tok(2, ".")]
_HOLE = {"secret": "cat", "slug": "cat", "slot": "s", "notes": "n", "options": [{"word": "dog", "rank": 120}]}
QUESTIONS = {
    "pick_from_chunk": lambda c, lang: llm.pick_from_chunk(c, ["A line."], 6, lang=lang),
    "rank_sentences": lambda c, lang: llm.rank_sentences(c, [{"sentence": "A.", "why": "w"},
                                                             {"sentence": "B.", "why": "v"}], 20, lang=lang),
    "stands_alone": lambda c, lang: llm.stands_alone(c, "The cat.", lang=lang),
    "widely_known": lambda c, lang: llm.widely_known(c, "The cat.", "Author", "Work", lang=lang),
    "choose_words": lambda c, lang: llm.choose_words(c, {"sentence": "The cat.", "allowed": ["cat"]}, [], lang=lang),
    "choose_among": lambda c, lang: llm.choose_among(c, [{"marked": "The [cat].", "words": [{"word": "cat",
                                                                                          "level": "medium"}],
                                                          "path": ["cat: the subject"]}], lang=lang),
    "context_guesses": lambda c, lang: llm.context_guesses(c, _TOKENS, set(), 1, 6, lang=lang),
    "pick_form": lambda c, lang: llm.pick_form(c, "The cat.", "cat", ["n:s — nom, singulier"], lang=lang),
    "sentence_check": lambda c, lang: llm.sentence_check(c, "The dog.", ["dog"], lang=lang),
    "start_ideas": lambda c, lang: llm.start_ideas(c, "The dog.", [{"start": "dog", "secret": "cat"}], lang=lang),
    "pick_starts": lambda c, lang: llm.pick_starts(c, "The [cat].", [_HOLE], None, lang=lang),
    "choose_excerpt": lambda c, lang: llm.choose_excerpt(c, "The cat.", {"before": ["B."], "after": []}, lang=lang),
    "pick_start": lambda c, lang: llm.pick_start(c, "The [____].", "cat", _HOLE["options"], lang=lang,
                                                 others=[{"secret": "dog", "start": "wolf", "notes": "n"}]),
    "would_say": lambda c, lang: llm.would_say(c, _TOKENS, set(), 1, "cat", lang=lang),
    "replace_word": lambda c, lang: llm.replace_word(c, "The [cat].", [{"secret": "cat", "notes": "n"}], "cat",
                                                     ["dog"], None, refused="r", lang=lang),
    "drop_unsaid": lambda c, lang: llm.drop_unsaid(c, "The [cat].", [{"secret": "cat", "notes": "n"}], ["cat"],
                                                   ["dog"], None, lang=lang),
    "neighbours_complete": lambda c, lang: llm.neighbours_complete(c, "the ___ house", lang=lang),
    "drop_handed": lambda c, lang: llm.drop_handed(c, "The [cat].", [{"secret": "cat", "notes": "n"}], ["cat"],
                                                   ["dog"], None, lang=lang),
}


def test_every_question_takes_the_language():
    asked = {name for name, f in vars(llm).items()
             if inspect.isfunction(f) and list(inspect.signature(f).parameters)[:1] == ["claude"]}
    assert asked == set(QUESTIONS)          # a new question joins the list below
    for name in asked:
        assert inspect.signature(getattr(llm, name)).parameters["lang"].kind is inspect.Parameter.KEYWORD_ONLY


@pytest.mark.parametrize("name", list(QUESTIONS))
def test_every_question_is_asked_in_the_day_s_language(monkeypatch, name):
    # The skills are the same for both languages; the TEMPLATE is what must follow the day.
    for f in ("taste", "laws", "start_rules", "page_rules", "start_idea_rule"):
        monkeypatch.setattr(llm, f, lambda: "")
    monkeypatch.setattr(llm, "skill_section", lambda heading: "")
    en, fr = _Capture(), _Capture()
    QUESTIONS[name](en, "en")
    QUESTIONS[name](fr, "fr")
    assert en.prompts and fr.prompts
    assert all("English" in p and "French" not in p for p in en.prompts)
    assert all("French" in p and "English" not in p for p in fr.prompts)
    # English grammar has an article and no elision or gender, and English examples —
    # and the prompt keeps its own articles right
    for p in en.prompts:
        assert "elision" not in p and "gender" not in p and "affubl" not in p and "prénom" not in p
        assert "a English" not in p and "A English" not in p


_STARTS = [{"start": "berceau", "secret": "cercueil"}, {"start": "fracas", "secret": "rugissements"}]


_RIDDLE = "a riddle: its first idea there is not one its hidden word shares"


@pytest.mark.parametrize("answer, riddles, judged", [
    ({"starts": [{"start": "berceau", "idea": "a baby", "shared": False, "why": "a side meaning"},
                 {"start": "fracas", "idea": "noise", "shared": True}]},
     {"berceau": "a riddle: its first idea there, a baby, is not one its hidden word shares (a side meaning)"},
     {"berceau", "fracas"}),
    ({"starts": [{"start": "berceau", "shared": False}]}, {"berceau": _RIDDLE}, {"berceau"}),
    ({"starts": [{"start": "« Berceau »", "shared": False}]}, {"berceau": _RIDDLE}, {"berceau"}),   # echoed
    ({"starts": [{"start": "berceau", "shared": "false"}]}, {}, set()),    # only a real verdict counts
    ({"starts": [{"start": "lit", "shared": False}]}, {}, set()),          # not a start shown
    ({"starts": [{"start": "berceau"}]}, {}, set()),                       # no verdict: not judged
    ({"starts": [{"start": ["berceau"], "shared": False}]}, {}, set()),    # unreadable, never a crash
    ({"starts": [{"start": {"word": "berceau"}, "shared": False}]}, {}, set()),
    ({"starts": "berceau"}, {}, set()),
    ([], {}, set()),
])
def test_start_ideas_refuses_only_a_start_named_as_unshared(monkeypatch, answer, riddles, judged):
    monkeypatch.setattr(llm, "start_idea_rule", lambda: "")
    assert llm.start_ideas(_Answer(answer), "s", _STARTS, lang="fr") == (riddles, judged)


def test_the_start_idea_check_quotes_the_taste_rule(monkeypatch):
    monkeypatch.setattr(llm, "start_idea_rule", lambda: "RULE")
    claude = _Capture()
    llm.start_ideas(claude, "le tsar frappait le berceau", _STARTS, lang="fr")
    assert "RULE" in claude.prompts[0]
    assert "« berceau » stands where the hidden word « cercueil » is" in claude.prompts[0]


def test_the_taste_holds_the_one_idea_rule_the_check_quotes():
    rule = llm.start_idea_rule()
    assert rule.startswith("### One idea, the start's first one")
    assert "berceau" in rule and "## " not in rule.split("\n", 1)[1]   # its section alone
    # the user's own criterion, and no blanket ban they never made (« marriage » for
    # « divorce », the other end of a union, is a start they approved)
    assert "first one" in rule and "never the other end" not in rule


def test_would_say_names_every_english_speaking_country_and_leaves_the_french_question_as_calibrated():
    en, fr = _Capture(), _Capture()
    llm.would_say(en, _TOKENS, set(), 1, "cat", lang="en")
    llm.would_say(fr, _TOKENS, set(), 1, "cat", lang="fr")
    assert "every English-speaking country" in en.prompts[0]
    # the user's own words (« knickers »): a word only a small part of English speakers use
    assert "a small part of English speakers" in en.prompts[0] and "one country" not in en.prompts[0]
    assert "country" not in fr.prompts[0]
    assert "and never think of this one?\n\nReturn" in fr.prompts[0]


def test_holed_rebuilds_english_with_its_own_spacing_and_french_as_calibrated():
    en = [_tok(0, "I"), _tok(1, "do", ""), _tok(2, "n't"), _tok(3, "think"), _tok(4, "the"), _tok(5, "dog", ""),
          _tok(6, "'s"), _tok(7, "owner", ""), _tok(8, ".", "")]
    assert llm.holed(en, set(), 7, lang="en") == "I don't think the dog's [____]."
    assert llm.holed(en, {5}, 7, lang="en") == "I don't think the ____'s [____]."
    fr = [_tok(0, "l'"), _tok(1, "effet"), _tok(2, "du"), _tok(3, "chat"), _tok(4, ".")]
    assert llm.holed(fr, set(), 3, lang="fr") == "l'effet du [____]."
