"""The pure parts of the LLM layer: JSON extraction and the answers' validation."""

import pytest

from llm import KINDS, LLMError, parse_json, read_line
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


# The read (`read_line`): the model's verdicts, each kept as answered; code applies them.
_READ = {"about": " A breeder's years for pigeons. ", "stands_alone": True, "why": "",
         "needs_book": [" Horiki ", ""], "kind": 2, "anchor": " pigeons ", "path": " bred animals, made petty ",
         "path_words": ["éleveur", " pratique "], "wide": True,
         "ladder": {"slot": "bred animals", "family": " creatures people keep ", "first": ""},
         "mirror": False, "joke_hidden": True, "sibling": " poules "}


def test_read_line_keeps_each_verdict_as_answered():
    assert read_line(_Canned(_READ), "Peu de personnes.", ["pigeons"], [], lang="fr") == {
        "about": "A breeder's years for pigeons.", "stands_alone": True, "why": "", "needs_book": ["Horiki"],
        "kind": 2, "anchor": "pigeons", "path": "bred animals, made petty", "path_words": ["éleveur", "pratique"],
        "wide": True, "ladder": {"slot": "bred animals", "family": "creatures people keep", "first": None},
        "mirror": False, "joke_hidden": True, "sibling": "poules"}
    flipped = read_line(_Canned({**_READ, "kind": None, "wide": False, "ladder": None, "mirror": True,
                                 "joke_hidden": False, "sibling": None}), "s", ["pigeons"], [], lang="fr")
    assert (flipped["kind"], flipped["wide"], flipped["ladder"], flipped["mirror"], flipped["joke_hidden"],
            flipped["sibling"]) == (None, False, None, True, False, None)


def test_a_line_that_does_not_stand_alone_or_names_no_main_word_leaves_the_rest_unanswered():
    alone = read_line(_Canned({"about": "", "stands_alone": False, "why": " Le lieu dépend de la page. "}),
                      "Il marche dans ce lieu.", [], [], lang="fr")
    assert (alone["stands_alone"], alone["why"], alone["anchor"], alone["mirror"]) == \
        (False, "Le lieu dépend de la page.", None, None)
    none = read_line(_Canned({"about": "x", "stands_alone": True, "why": "", "kind": None, "anchor": None}),
                     "s", [], [], lang="fr")
    assert (none["anchor"], none["kind"], none["needs_book"], none["joke_hidden"]) == (None, None, [], None)


@pytest.mark.parametrize("kind", [0, 8, -1])
def test_a_kind_outside_the_seven_is_an_unusable_reading(kind):
    assert read_line(_Canned({**_READ, "kind": kind}), "s", ["pigeons"], [], lang="fr") is None


@pytest.mark.parametrize("answer", [
    None, [], {},
    {"stands_alone": "false", "about": "Une promenade.", "why": "Lieu inconnu."},
    {"stands_alone": 1, "about": "Une promenade.", "why": ""},
    {"stands_alone": True, "about": " ", "why": ""},
    {"stands_alone": False, "about": "", "why": " "},
    {"stands_alone": True, "about": ["Une promenade."], "why": ""},
    {"stands_alone": False, "about": "", "why": None},
    {**{k: v for k, v in _READ.items() if k != "kind"}},          # the kind not answered
    {**{k: v for k, v in _READ.items() if k != "anchor"}},        # nor the main word
    {**_READ, "kind": True},
    {**_READ, "kind": "2"},
    {**_READ, "anchor": ["pigeons"]},
    {**_READ, "needs_book": "Horiki"},
    {**_READ, "path_words": [1]},
    {**_READ, "mirror": "false"},
    {**{k: v for k, v in _READ.items() if k != "joke_hidden"}},
    {**{k: v for k, v in _READ.items() if k != "ladder"}},        # a wide word with no ladder answered
    {**_READ, "ladder": {"slot": 1, "family": None, "first": None}},
    {**_READ, "sibling": ["poules"]},
])
def test_a_malformed_reading_raises(answer):
    with pytest.raises(LLMError, match="reading"):
        read_line(_Canned(answer), "Il marche dans ce lieu.", ["pigeons"], [], lang="fr")


def test_the_read_quotes_the_rules_and_tells_back_what_code_refused(monkeypatch):
    monkeypatch.setattr(llm, "taste", lambda: "TASTE")
    monkeypatch.setattr(llm, "skill_section", lambda heading: f"SECTION {heading}")
    claude = _Capture()
    read_line(claude, "le chat dort", ["chat", "dort"], ["« lune » is not one of the words that can be hidden"],
              lang="fr")
    prompt = claude.prompts[0]
    assert "TASTE" in prompt and "SECTION ## Stands alone" in prompt
    assert "words that can be hidden: chat, dort" in prompt
    assert "Told back of your earlier reading" in prompt and "« lune » is not one" in prompt
    assert all(f"{n} {name}" in prompt for n, name in KINDS.items())


def test_the_seven_kinds_are_the_taste_s_with_their_holes_and_their_starts():
    taste = llm.taste()
    headings = [line for line in taste.splitlines() if re.match(r"### \d\. ", line)]
    assert [h.split(". ", 1)[1].split(":")[0] for h in headings] == list(KINDS.values())
    for n, name in KINDS.items():
        section = llm.taste_section(f"### {n}. {name}")
        assert "**Holes and punch.**" in section and "**Start words.**" in section
        assert f"### {n + 1}. " not in section          # its section alone


def test_the_taste_holds_the_ladder_and_refuses_a_lottery_on_every_hole():
    ladder = llm.taste_section("### The narrowing ladder")
    assert "smaller family" in ladder and "refused, as the main word and as" in ladder
    assert "### " not in ladder.split("\n", 1)[1]
    # the user's rule: the words right around a hole writing it in refuse it, on every hole
    assert "refused on every hole" in llm.taste_section("### Per trio")


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
import re

import llm
from rules import Token


class _Answer:
    def __init__(self, answer):
        self.answer = answer

    def json(self, _prompt):
        return self.answer


_DAY = {"marked": "The [cat] [sat] on the [mat].", "kind": 2,
        "words": [{"word": "mat", "path": "where a cat sits", "path_words": ["cat"], "tags": ["one of a wide kind"]},
                  {"word": "cat", "path": "a pet", "path_words": ["mat"], "tags": []},
                  {"word": "sat", "path": "what it did", "path_words": ["mat"], "tags": ["readers write it in"]}]}


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


def test_the_comparison_lists_each_line_s_kind_main_word_paths_and_facts(monkeypatch):
    monkeypatch.setattr(llm, "taste", lambda: "TASTE")
    claude = _Capture()
    llm.choose_among(claude, [_DAY, {**_DAY, "kind": None}], lang="en")
    prompt = claude.prompts[0]
    assert "1. « The [cat] [sat] on the [mat]. »\n   kind 2, The build-up and the drop" in prompt
    assert "   - main word « mat »: where a cat sits (through « cat »); one of a wide kind" in prompt
    assert "   - « sat »: what it did (through « mat »); readers write it in" in prompt
    assert "2. « The [cat] [sat] on the [mat]. »\n   no kind" in prompt
    assert "A line with no kind\ngoes first only when, read aloud, it beats the built ones" in prompt
    assert "easy" not in prompt and "medium" not in prompt


# The two words chosen against the main word: two of the words offered, each with its path and
# the model's verdicts, or a decline; code checks the rest (`curate.choose_others`).
_WORD = {"word": " eleveur ", "path": " a trade ", "path_words": [" pratique ", ""], "mirror": False, "wide": False,
         "ladder": {"slot": "x", "family": None, "first": None}, "lands": " the breeder "}
_WIDE = {"word": "naturelles", "path": "gifts", "path_words": ["capacités"], "mirror": True, "wide": True,
         "ladder": {"slot": "gifts", "family": " the body's ", "first": None}}


@pytest.mark.parametrize("answer, expected", [
    ({"words": [_WORD, _WIDE], "why": "w"},
     {"words": [{"word": "eleveur", "path": "a trade", "path_words": ["pratique"], "mirror": False, "wide": False,
                 "ladder": None, "lands": "the breeder"},
                {"word": "naturelles", "path": "gifts", "path_words": ["capacités"], "mirror": True, "wide": True,
                 "ladder": {"slot": "gifts", "family": "the body's", "first": None}, "lands": ""}],
      "why": "w"}),
    ({"words": None, "why": "flat"}, {"words": None, "why": "flat"}),        # the line declined
    ({"words": [_WORD]}, None),                                               # one word
    ({"words": [_WORD, _WORD, _WORD]}, None),                                 # three
    ({"words": ["eleveur", "naturelles"]}, None),                             # no path, no verdicts
    ({"words": [_WORD, {**_WIDE, "mirror": "true"}]}, None),
    ({"words": [_WORD, {k: v for k, v in _WIDE.items() if k != "ladder"}]}, None),   # wide with no ladder answered
    ({"words": [_WORD, {**_WIDE, "path_words": "capacités"}]}, None),
    ({"why": "w"}, None),
    ([], None),
])
def test_choose_companions_takes_two_words_with_their_paths_or_a_decline(answer, expected):
    assert llm.choose_companions(_Answer(answer), "s", _A_READ, "notes", _POOL, [], lang="fr") == expected


_A_READ = {"kind": 2, "anchor": "pigeons", "path": "bred animals, made petty", "path_words": ["éleveur", "pratique"],
           "wide": True, "ladder": {"slot": "bred animals", "family": "creatures people keep", "first": "the ranks"}}
_POOL = [{"word": "éleveur", "options": [{"word": "fauconnier", "rank": 140}]},
         {"word": "naturelles", "options": [{"word": "culturelles", "rank": 150}, {"word": "innées", "rank": 170}]}]


@pytest.mark.parametrize("answer, expected", [
    ({"starts": {"cat": "dog"}, "why": "w"}, {"starts": {"cat": "dog"}, "unsaveable": None, "why": "w"}),
    ({"starts": {"cat": "wolf"}}, {"starts": {}, "unsaveable": None, "why": ""}),        # not a candidate
    ({"unsaveable": "cat", "why": "no path"}, {"starts": {}, "unsaveable": "cat", "why": "no path"}),
    ({"unsaveable": "lion", "why": "?"}, {"starts": {}, "unsaveable": None, "why": "?"}),   # no such hole
    ([], {"starts": {}, "unsaveable": None, "why": ""}),
])
def test_pick_starts_takes_listed_candidates_or_names_a_word_no_start_saves(answer, expected):
    assert llm.pick_starts(_Answer(answer), "The [cat].", [_HOLE], 2, lang="en") == expected


def test_the_start_step_reads_each_hole_s_role_path_and_ladder_and_its_kind_s_rule(monkeypatch):
    monkeypatch.setattr(llm, "taste", lambda: "TASTE")
    monkeypatch.setattr(llm, "start_rules", lambda: "RULES")
    other = {**_HOLE, "secret": "mat", "slug": "mat", "role": "other", "path": {"line": "where it sits",
                                                                                "words": ["sat"]},
             "ladder": {"slot": "a surface", "family": "floor coverings", "first": None}}
    claude = _Capture()
    llm.pick_starts(claude, "The [cat] on the [mat].", [_HOLE, other], 2, lang="en")
    prompt = claude.prompts[0]
    assert "Hole « cat », the MAIN word (slot: s)\n  its path: a pet (through « the »)\n  measured: n" in prompt
    assert "Hole « mat », one of the two others" in prompt
    assert "one of a wide kind: a surface › floor coverings › —" in prompt
    assert "The main word's start comes first, by the *Start words* of its kind, kind 2, *The build-up and the drop*" \
        in prompt
    assert "a start whose FIRST idea names its ladder's smaller family, never the whole kind" in prompt
    none = _Capture()
    llm.pick_starts(none, "The [cat].", [_HOLE], None, lang="en")
    assert "by the taste's *The start words* (the line has no kind)" in none.prompts[0]


def test_the_companion_question_shows_the_main_word_its_kind_the_bands_and_what_was_refused(monkeypatch):
    monkeypatch.setattr(llm, "taste", lambda: "TASTE")
    monkeypatch.setattr(llm, "laws", lambda: "LAWS")
    claude = _Capture()
    llm.choose_companions(claude, "un bon éleveur de [pigeons]", _A_READ, "most readers would split",
                          _POOL, ["« vie »: the words right around it write it in"], lang="fr")
    prompt = claude.prompts[0]
    assert "TASTE" in prompt and "LAWS" in prompt and "« un bon éleveur de [pigeons] »" in prompt
    assert "Its kind: 2. The build-up and the drop." in prompt
    assert "Its MAIN word « pigeons »: bred animals, made petty (through « éleveur », « pratique »)" in prompt
    assert "one of a wide kind: bred animals › creatures people keep › the ranks" in prompt
    assert "measured: most readers would split" in prompt
    assert "- « naturelles »: culturelles (150), innées (170)" in prompt
    assert "- « vie »: the words right around it write it in" in prompt
    assert "*The three words*" in prompt and "*Holes and punch* of kind 2" in prompt
    none = _Capture()
    llm.choose_companions(none, "s", {**_A_READ, "kind": None, "wide": False}, "n", _POOL, [], lang="fr")
    assert "Its kind: none of the seven." in none.prompts[0] and "*Lines that fit no kind*" in none.prompts[0]
    assert "Refused so far" not in none.prompts[0] and "one of a wide kind:" not in none.prompts[0]


class _Capture:
    """A fake Claude that keeps every prompt it is asked."""

    def __init__(self):
        self.prompts = []

    def json(self, prompt):
        self.prompts.append(prompt)
        return {"picks": [], "ranked": [1, 0], "about": "x", "stands_alone": True, "why": "", "known": False,
                "kind": None, "anchor": None,
                "line": None, "guesses": [], "expected": None, "choice": 1, "valid": True, "faulty": [],
                "starts": {}, "before": 0, "after": 0, "word": None}


def _tok(i, text, space=" "):
    return Token(i, text, text.lower(), "NOUN", text.lower(), False, space)


_TOKENS = [_tok(0, "the"), _tok(1, "cat", ""), _tok(2, ".")]
_HOLE = {"secret": "cat", "slug": "cat", "role": "main", "path": {"line": "a pet", "words": ["the"]},
         "ladder": None, "slot": "s", "notes": "n", "options": [{"word": "dog", "rank": 120}]}
QUESTIONS = {
    "pick_from_chunk": lambda c, lang: llm.pick_from_chunk(c, ["A line."], 6, lang=lang),
    "rank_sentences": lambda c, lang: llm.rank_sentences(c, [{"sentence": "A.", "why": "w"},
                                                             {"sentence": "B.", "why": "v"}], 20, lang=lang),
    "read_line": lambda c, lang: llm.read_line(c, "The cat.", ["cat"], ["told"], lang=lang),
    "widely_known": lambda c, lang: llm.widely_known(c, "The cat.", "Author", "Work", lang=lang),
    "choose_companions": lambda c, lang: llm.choose_companions(c, "The [cat].", _A_READ, "n", _POOL, ["told"],
                                                               lang=lang),
    "choose_among": lambda c, lang: llm.choose_among(c, [_DAY], lang=lang),
    "context_guesses": lambda c, lang: llm.context_guesses(c, _TOKENS, set(), 1, 6, lang=lang),
    "pick_form": lambda c, lang: llm.pick_form(c, "The cat.", "cat", ["n:s — nom, singulier"], lang=lang),
    "sentence_check": lambda c, lang: llm.sentence_check(c, "The dog.", ["dog"], lang=lang),
    "start_ideas": lambda c, lang: llm.start_ideas(c, "The dog.", [{"start": "dog", "secret": "cat"}], lang=lang),
    "pick_starts": lambda c, lang: llm.pick_starts(c, "The [cat].", [_HOLE], 2, lang=lang),
    "choose_excerpt": lambda c, lang: llm.choose_excerpt(c, "The cat.", {"before": ["B."], "after": []}, lang=lang),
    "pick_start": lambda c, lang: llm.pick_start(c, "The [____].", _HOLE, _HOLE["options"], kind=None, lang=lang,
                                                 others=[{"secret": "dog", "role": "other", "start": "wolf",
                                                          "notes": "n"}]),
    "would_say": lambda c, lang: llm.would_say(c, _TOKENS, set(), 1, "cat", lang=lang),
    "neighbours_complete": lambda c, lang: llm.neighbours_complete(c, "the ___ house", lang=lang),
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
