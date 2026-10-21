"""The curator's flow (2026-09-24): the judge's loose filter keeps reading order and the
model reads every line left; each line is read, its main word measured alone, two words
chosen against it, each word's other sense taken off its map, what fails told back; the day
is chosen by comparison; nothing is swapped; the giveaway judge is a note."""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

import _paths
import curate
import jev
from rules import Token

_OTHER_SENSE = curate.llm.other_sense   # the question itself, before any test fakes it


class FakeJudge:
    def __init__(self, table):
        self.table = table
        self.usage = {"input_tokens": 0, "output_tokens": 0}

    def noul(self, state, questions):
        out = {}
        for key, (instructions, _t, _f) in questions.items():
            i = int(instructions.split("phrases[")[1].split("]")[0])
            name = key.rstrip("0123456789")
            out[key] = self.table[state["phrases"][i]][name]
        return out


class Log(list):
    stamp = "test"   # the run's files are named after it

    def __call__(self, line):
        self.append(line)


@pytest.fixture(autouse=True)
def _free_bands(monkeypatch):
    """Every word's band on its map offers « <word>-start » at 150, unless a test says
    otherwise; the neighbours answer nothing usable; a word with a map is found to have no
    other sense, its map carrying the line's."""
    monkeypatch.setattr(curate, "band_of", lambda line, t, sims, pairs, lang: [{"word": f"{t.text}-start", "rank": 150}])
    monkeypatch.setattr(curate.llm, "neighbours_complete", lambda *_a, **_k: None)
    monkeypatch.setattr(curate.llm, "other_sense", lambda _c, _s, _w, _words, lang, off=(): (
        {"words": []} if off else {"used": "its one sense", "other": False, "words": [], "carried": True, "why": ""}))


def _giveaways(monkeypatch, scores=None):
    """Every word a line can hide is judged before the choice (the floor); a word the
    test does not name gets a path (0.3)."""
    monkeypatch.setattr(jev, "giveaway", lambda _j, _shown, word, lang: (scores or {}).get(word, 0.3))


def test_judge_sentences_removes_the_failing_and_keeps_reading_order():
    table = {
        "flat": {"autonome": 0.9, "image": 0.1, "celebre": 0.0},
        "dependent": {"autonome": 0.2, "image": 0.9, "celebre": 0.0},
        "famous": {"autonome": 0.9, "image": 0.9, "celebre": 0.8},
        "good": {"autonome": 0.6, "image": 0.7, "celebre": 0.1},
        "better": {"autonome": 0.5, "image": 0.9, "celebre": 0.1},
    }
    log = Log()
    kept = curate.judge_sentences(log, list(table), "fr", judge=FakeJudge(table))
    assert kept == ["good", "better"]          # reading order, never re-ranked by a score
    assert any("2 of 5" in line for line in log)


def test_the_model_reads_every_line_the_judge_keeps(monkeypatch):
    monkeypatch.setattr(curate, "CHUNK", 2)
    chunks = []
    monkeypatch.setattr(curate.llm, "pick_from_chunk", lambda _c, chunk, _n, lang: chunks.append(chunk) or [])
    monkeypatch.setattr(curate.llm, "rank_sentences", lambda _c, picks, _n, lang: picks)
    curate.shortlist(object(), Log(), ["a", "b", "c"], "fr")
    assert chunks == [["a", "b"], ["c"]]


def test_a_short_shortlist_is_ranked_before_comparing_batches():
    class Claude:
        calls = 0

        def json(self, prompt):
            self.calls += 1
            assert "Shortlist:" in prompt
            return {"ranked": list(range(7, -1, -1))}

    claude = Claude()
    picks = [{"sentence": str(i), "why": ""} for i in range(8)]
    ranked = curate.llm.rank_sentences(claude, picks, curate.SHORTLIST, lang="fr")
    assert claude.calls == 1
    assert [p["sentence"] for p in ranked] == [str(i) for i in range(7, -1, -1)]


def test_an_empty_ranking_keeps_the_reading_order_instead_of_losing_the_shortlist():
    # The question asks for an order, never a refusal: an empty answer is no judgement.
    class Claude:
        def json(self, _prompt):
            return {"ranked": []}

    picks = [{"sentence": str(i), "why": ""} for i in range(8)]
    assert curate.llm.rank_sentences(Claude(), picks, curate.SHORTLIST, lang="fr") == picks


def test_an_empty_list_asks_the_judge_nothing():
    assert curate.judge_sentences(Log(), [], "fr", judge=None) == []


def _line_tokens(*_a):
    from rules import Token
    words = [("le", "DET", True), ("chat", "NOUN", False), ("dort", "VERB", False),
             ("sur", "ADP", True), ("la", "DET", True), ("pierre", "NOUN", False),
             ("froide", "ADJ", False)]
    lemmas = {"dort": "dormir"}
    return [Token(i, w, lemmas.get(w, w), pos, w, stop) for i, (w, pos, stop) in enumerate(words)]


def _a_read(anchor="pierre", path_words=("froide",), **over):
    """A reading as `llm.read_line` returns it: the line stands alone, kind 5, its main word
    `anchor` reached through `path_words`; `over` changes any verdict."""
    return {"about": "a cat on a cold stone", "stands_alone": True, "why": "", "needs_book": [], "kind": 5,
            "anchor": anchor, "path": "what the cat sleeps on", "path_words": list(path_words), "wide": False,
            "ladder": None, "mirror": False, "joke_hidden": True, "sibling": None, **over}


def _read(monkeypatch, answer=None, asked=None):
    """The read answers `answer` (a reading, or a function of the sentence giving one)."""
    answer = answer or _a_read()
    monkeypatch.setattr(curate.llm, "read_line",
                        lambda _c, sentence, hideable, refused, lang: (asked if asked is not None else []).append(
                            (list(hideable), list(refused))) or (answer(sentence) if callable(answer) else answer))


def test_a_line_that_does_not_stand_alone_is_set_aside_before_its_giveaway_or_words(monkeypatch):
    monkeypatch.setattr(curate, "parse", _line_tokens)
    monkeypatch.setattr(curate.llm, "choose_companions", lambda *_a, **_k: pytest.fail("no words for a refused line"))
    monkeypatch.setattr(curate.llm, "choose_among", lambda *_a, **_k: pytest.fail("nothing to compare"))
    monkeypatch.setattr(jev, "giveaway", lambda *_a, **_k: pytest.fail("a line set aside pays nothing"))
    _read(monkeypatch, _a_read(stands_alone=False, why="leans on its page"))
    monkeypatch.setattr(curate, "build_day", lambda *a, **k: pytest.fail("a refused line is never built"))
    log = Log()
    path = curate.day(object(), log, [{"sentence": "Le chat dort sur la pierre froide."}], {"kind": "book"},
                      {"secrets": set(), "pairs": {}}, "", lambda w: True, "fr", judge=object(), sims=curate.Vectors())
    assert path is None
    assert any("set aside: does not stand alone: leans on its page" in line for line in log)



# --- the line READ before anything is paid for: the model's verdicts, applied by code -----

def _the_line():
    tokens = _line_tokens()
    return curate.new_line("Le chat dort sur la pierre froide.", tokens,
                           [t for t in tokens if t.text in ("chat", "dort", "pierre", "froide")])

@pytest.mark.parametrize("over, why", [
    ({}, None),
    ({"kind": None}, None),                                          # a line with no kind is kept
    ({"sibling": "brique"}, None),                                   # a sibling only warns
    ({"wide": True, "ladder": {"slot": "a surface", "family": "stones", "first": "the first one named"}}, None),
    ({"stands_alone": False, "why": "whose cat?"}, "does not stand alone: whose cat?"),
    ({"anchor": None}, "no word the line is about has a path"),
    ({"needs_book": ["Pierre"]}, "its main word « pierre » needs the work to mean anything"),
    ({"wide": True, "ladder": None}, "a lottery: « pierre » is one of a wide kind, and the slot shapes no kind"),
    ({"wide": True, "ladder": {"slot": "a surface", "family": None, "first": "x"}},
     "a lottery: « pierre » is one of a wide kind, and no smaller family a start can name"),
    ({"wide": True, "ladder": {"slot": "a surface", "family": "stones", "first": None}},
     "a lottery: « pierre » is one of a wide kind, and it is neither the first member players name nor one the "
     "ranks climb to"),
    ({"mirror": True}, "a mirror: « pierre » is the partner of a visible word, the first word players would type"),
    ({"joke_hidden": False}, "the joke reads with the main word hidden"),
    ({"needs_book": ["pierre"], "mirror": True}, "its main word « pierre » needs the work to mean anything"),
])
def test_the_read_sets_a_line_aside_on_each_verdict_in_order(monkeypatch, over, why):
    _read(monkeypatch, _a_read(**over))
    log = Log()
    read, refused = curate.read(object(), log, _the_line(), "fr")
    assert refused == why and read["anchor"] == _a_read(**over)["anchor"]


@pytest.mark.parametrize("over, told", [
    ({"anchor": "lune"}, "« lune » is not one of the words that can be hidden"),
    ({"path_words": ["sur"]}, "its path must run through 1 to 3 words of the line left in sight"),   # stop words only
    ({"path_words": ["pierre"]}, "« pierre » is not one"),           # the main word itself
    ({"path_words": ["la pierre"]}, "« la pierre » is not one"),     # not one word of the line
    ({"path_words": []}, "its path must run through 1 to 3 words of the line left in sight"),
    ({"path_words": ["chat", "dort", "froide", "chat"]}, "its path must run through 1 to 3 words"),   # four
])
def test_a_main_word_the_line_cannot_hide_or_a_path_out_of_sight_is_told_back(monkeypatch, over, told):
    answers = iter([_a_read(**over), _a_read()])
    asked = []
    monkeypatch.setattr(curate.llm, "read_line",
                        lambda _c, _s, hideable, refused, lang: asked.append((hideable, list(refused))) or next(answers))
    read, why = curate.read(object(), Log(), _the_line(), "fr")
    assert why is None and read["anchor"] == "pierre"
    assert asked[0] == (["chat", "dort", "pierre", "froide"], [])
    assert len(asked) == 2 and told in asked[1][1][0]


def test_a_stop_word_on_the_main_word_s_path_is_passed_over_never_told_back(monkeypatch):
    # « sur » is on the parser's stop list, which the model cannot know: always in sight, it is
    # dropped from the path, never a reason to ask again
    asked = []
    _read(monkeypatch, _a_read(path_words=("sur", "froide")), asked)
    read, why = curate.read(object(), Log(), _the_line(), "fr")
    assert why is None and read["path_words"] == ["froide"] and len(asked) == 1


def test_a_reading_told_back_read_rounds_times_sets_the_line_aside(monkeypatch):
    asked = []
    monkeypatch.setattr(curate.llm, "read_line",
                        lambda _c, _s, _h, refused, lang: asked.append(list(refused)) or None)   # a kind of 9
    read, why = curate.read(object(), Log(), _the_line(), "fr")
    assert curate.READ_ROUNDS == 3 and len(asked) == 3
    assert read is None and why.startswith("no usable reading in 3 asks (its kind must be a number from 1 to 7")
    assert len(asked[2]) == 2


def test_the_giveaway_is_paid_after_the_read_and_never_for_a_word_that_needs_the_work(monkeypatch):
    judged = []
    monkeypatch.setattr(jev, "giveaway", lambda _j, _shown, word, lang: judged.append(word) or 0.3)
    _read(monkeypatch, _a_read(needs_book=["chat"]))
    _measured(monkeypatch)
    offered = _against(monkeypatch, {"words": None, "why": "none"})
    monkeypatch.setattr(curate, "parse", _line_tokens)
    curate.day(object(), Log(), [{"sentence": "Le chat dort sur la pierre froide."}], {"kind": "book"},
               {"secrets": set(), "pairs": {}}, "", lambda w: True, "fr", judge=object(), sims=curate.Vectors())
    assert judged == ["dort", "pierre", "froide"]
    assert [a["pool"] for a in offered] == [["dort", "froide"]]        # the main word apart


def test_a_main_word_under_the_floor_sets_the_line_aside_with_no_clue(monkeypatch):
    offered, log = _day_on_the_line(monkeypatch, {"pierre": 0.07})
    assert offered == []
    assert any("set aside: no clue: the line gives no path to its main word « pierre » (0.07, under 0.1)" in line
               for line in log)


def test_a_bank_keeps_the_lines_set_aside_with_their_read_and_giveaways(monkeypatch):
    monkeypatch.setattr(curate, "parse", _line_tokens)
    _giveaways(monkeypatch, {"pierre": 0.07})
    _read(monkeypatch, lambda s: _a_read() if s.startswith("Le") else _a_read(stands_alone=False, why="whose cat?"))
    days, aside = curate.prepare(object(), Log(), _LINES, {"secrets": set(), "pairs": {}}, lambda w: True, "fr", [],
                                 judge=object(), sims=curate.Vectors())
    assert days == []
    assert [(line["sentence"], line["dropped"], bool(line["given"])) for line in aside] == [
        (_LINES[0]["sentence"], "no clue: the line gives no path to its main word « pierre » (0.07, under 0.1)", True),
        (_LINES[1]["sentence"], "does not stand alone: whose cat?", False)]
    assert aside[0]["read"]["anchor"] == "pierre" and aside[1]["read"]["stands_alone"] is False


def _day_of(words=("chat", "chien", "pierre"), *, sentence="un chat un chien une pierre", kind=2, ladders=None,
            expected=None, guesses=None):
    """A line and its three words as the start step reads them — `words`, the first the MAIN
    word, hidden in « un _ un _ une _ » — each measured plain: readers split (unless `expected`
    names the word they write; `guesses`, what else they put there), players say it, no
    crowd, the neighbours write « autre », no word of another sense on its map; each path
    through « un »; `ladders`, the words of a wide kind."""
    tokens = [Token(i, w, w, "NOUN" if i % 2 else "DET", w, not i % 2)
              for i, w in enumerate(["un", words[0], "un", words[1], "une", words[2]])]
    trio = tokens[1::2]
    line = {**curate.new_line(sentence, tokens, trio, {w: 0.3 for w in words}), "read": {**_a_read(words[0]),
                                                                                         "kind": kind}}
    m = line["measures"]
    for w in words:
        m.readings[w] = ((guesses or {}).get(w, []), (expected or {}).get(w))
        m.says[w], m.crowds[w], m.frames[w] = (0.8, None), None, [("un ___", "autre")]
        line["senses"][w] = {"used": "its one sense", "carried": True, "why": "", "off": []}
    checked = curate.Checked(trio, {w: {"line": f"to {w}", "words": ["un"]} for w in words}, ladders or {},
                             {w: f"n-{w}" for w in words}, {w: [] for w in words})
    return line, checked


@pytest.fixture(autouse=True)
def _runs(tmp_path, monkeypatch):
    """The run's files (the log, the other-sense file handed to gen_phrase) go to a test directory."""
    monkeypatch.setattr(_paths, "RUNS_DIR", tmp_path / "runs")


def _gen(log, words=("chat", "chien", "ours"), *, sentence="s", source=None, lang="fr", line=None, prior=None):
    """`generate` on a line hiding `words` (`line`: the line and its words, `_day_of`'s by default)."""
    line, checked = line or _day_of(words, sentence=sentence)
    return curate.generate(object(), log, line, checked, source or {}, lang, sims=curate.Vectors(), pairs={},
                           prior=prior)


def test_gen_phrase_takes_the_words_of_another_sense_off_each_map(monkeypatch):
    seen = []
    monkeypatch.setattr(curate.subprocess, "run", lambda cmd, **_k: seen.append(cmd) or type("C", (), {"returncode": 1, "stdout": "", "stderr": ""})())
    curate.run_gen_phrase("une phrase", ["a", "b", "c"], {}, {}, "fr", {"a": "x"}, other_sense="/runs/s.other-sense.json")
    assert seen[0][seen[0].index("--other-sense") + 1] == "/runs/s.other-sense.json"


def test_each_word_s_other_sense_goes_to_gen_phrase_and_the_command_logged_names_the_sidecar(tmp_path, monkeypatch):
    line, checked = _day_of()
    line["senses"]["chien"]["off"] = ["chienne", "toutou"]
    written = tmp_path / "out" / "lapin_loup_brique.json"
    handed = []

    def run(sentence, words, source, forms, lang, starts=None, other_sense=None):
        assert Path(other_sense).name.endswith(".spoilers.other-sense.json")   # keyed by the trio: a spoiler
        handed.append(json.loads(Path(other_sense).read_text(encoding="utf-8")))
        return SimpleNamespace(returncode=0, stderr="", stdout=f"écrite dans {written} :"), [
            "uv", "run", "scripts/gen_phrase.py", sentence, "--words", *words, "--other-sense", other_sense]

    monkeypatch.setattr(curate, "run_gen_phrase", run)
    monkeypatch.setattr(curate, "choose_starts", lambda *_a, **_k: {"chat": "lapin", "chien": "loup", "pierre": "brique"})
    monkeypatch.setattr(curate, "check_starts", lambda *_a, **_k: {})
    log = Log()
    assert _gen(log, line=(line, checked)) == str(written)
    assert handed[0] == {"chat": [], "chien": ["chienne", "toutou"], "pierre": []} and len(handed) == 2
    command = next(entry for entry in log if entry.startswith("- gen:phrase command: "))
    assert command.endswith(f"--other-sense {tmp_path / 'out' / 'lapin_loup_brique.other-sense.json'}`")


def test_a_banked_line_s_starts_go_on_the_first_run_and_are_never_chosen_again(tmp_path, monkeypatch):
    # its starts were chosen on the line maps gen_phrase writes (`--finish`): never chosen again
    written = _three_hole_draft(tmp_path)              # each banked start at rank 120, in its band
    runs = []
    monkeypatch.setattr(curate, "run_gen_phrase", lambda *a, **k: (
        runs.append(dict(a[5])), (SimpleNamespace(returncode=0, stderr="", stdout=f"écrite dans {written} :"), []))[1])
    monkeypatch.setattr(curate, "choose_starts", lambda *_a, **_k: pytest.fail("a banked line's starts are kept"))
    checked_with = []
    monkeypatch.setattr(curate, "check_starts", lambda *_a, **k: checked_with.append(_a[5]) or {})
    banked = {"chat": "lapin", "chien": "loup", "pierre": "brique"}
    log = Log()
    assert _gen(log, ("chat", "chien", "pierre"), prior=banked) == str(written)
    assert runs == [banked]                                  # one run, the banked starts on it
    assert checked_with == [{k: {w} for k, w in banked.items()}]   # their checks still run, every start tried
    assert "- start words as banked, on the maps they were chosen on: « lapin » for « chat », « loup » for « chien », " \
           "« brique » for « pierre »" in log


@pytest.mark.parametrize("moved, expected, fault", [
    # a word with two dictionary entries: gen_phrase claims the confirmed entry's other forms,
    # and a start banked at 100 on the curator's walk ships at 99, out of the band
    ({"chien": {"loup": {"word": "loup", "rank": 99}}}, None,
     "the start « loup » for « chien » is no longer in its band"),
    # the reader's word handed on the written map: the main word is never handed
    ({"chat": {"lapin": {"word": "lapin", "rank": 120}, "minou": {"word": "minou", "rank": 2}}}, {"chat": "minou"},
     "the line cannot be built: the main word « chat »: the word most readers write sits at rank 2 on its map: "
     "found in a guess or two"),
])
def test_banked_starts_that_do_not_stand_on_the_written_map_are_not_built(tmp_path, monkeypatch, moved, expected,
                                                                          fault):
    # read in code alone, before any check: the map written is not the one the starts were banked on
    written = _three_hole_draft(tmp_path)
    puzzle = json.loads(written.read_text(encoding="utf-8"))
    puzzle["ranks"].update(moved)
    written.write_text(json.dumps(puzzle), encoding="utf-8")
    sidecar = tmp_path / "draft.other-sense.json"
    sidecar.write_text("{}", encoding="utf-8")
    runs = []
    monkeypatch.setattr(curate, "run_gen_phrase", lambda *a, **k: (
        runs.append(1), (SimpleNamespace(returncode=0, stderr="", stdout=f"écrite dans {written} :"), []))[1])
    monkeypatch.setattr(curate, "choose_starts", lambda *_a, **_k: pytest.fail("never chosen again"))
    monkeypatch.setattr(curate, "check_starts", lambda *_a, **_k: pytest.fail("a line not built is not checked"))
    log = Log()
    line = _day_of(("chat", "chien", "pierre"), expected=expected)
    assert _gen(log, line=line, prior={"chat": "lapin", "chien": "loup", "pierre": "brique"}) is None
    assert len(runs) == 1 and not written.exists() and not sidecar.exists()
    assert f"- on the written map, {fault}: not the map the line was banked on — rebank it" in log


def test_a_banked_start_played_since_banking_is_traded_by_the_checks_not_refused(tmp_path, monkeypatch):
    # the archive's blacklist moved: still in its band, the start is check_starts' to trade
    written = _three_hole_draft(tmp_path)
    puzzle = json.loads(written.read_text(encoding="utf-8"))
    puzzle["ranks"]["chien"]["renard"] = {"word": "renard", "rank": 130}      # a start left to trade for
    written.write_text(json.dumps(puzzle), encoding="utf-8")
    monkeypatch.setattr(curate, "run_gen_phrase", lambda *a, **k: (
        SimpleNamespace(returncode=0, stderr="", stdout=f"écrite dans {written} :"), []))
    checked = []
    monkeypatch.setattr(curate, "check_starts", lambda *_a, **_k: checked.append(1) or {})
    line, trio = _day_of(("chat", "chien", "pierre"))
    banked = {"chat": "lapin", "chien": "loup", "pierre": "brique"}
    assert curate.generate(object(), Log(), line, trio, {}, "fr", sims=curate.Vectors(),
                           pairs={"chien": {"loup"}, "chat": {"souris"}}, prior=banked) == str(written)
    assert checked == [1]


def test_a_banked_start_gen_phrase_refuses_is_not_built_and_asks_for_a_rebank(monkeypatch):
    error = ("Erreur : --start : « loup » n'est pas un mot de départ possible pour « chien » (absent du vocabulaire "
             "du trou, ou le secret lui-même).")
    runs = []
    monkeypatch.setattr(curate, "run_gen_phrase", lambda *a, **k: (
        runs.append(1), (SimpleNamespace(returncode=1, stderr=error, stdout=""), []))[1])
    monkeypatch.setattr(curate, "choose_starts", lambda *_a, **_k: pytest.fail("never chosen again"))
    log = Log()
    assert _gen(log, ("chat", "chien", "pierre"), prior={"chat": "lapin", "chien": "loup", "pierre": "brique"}) is None
    assert len(runs) == 1
    assert ("- gen:phrase refused the banked start « loup »: the maps moved since the line was banked — rebank it"
            in log)


def test_a_line_unbuildable_on_the_written_map_erases_the_draft_and_is_not_built(tmp_path, monkeypatch):
    draft = tmp_path / "x_y_z.json"
    sidecar = tmp_path / "x_y_z.other-sense.json"
    runs = []

    def run(*_a, **_k):
        runs.append(1)
        draft.write_text(json.dumps({"holes": [], "ranks": {}}), encoding="utf-8")
        sidecar.write_text("{}", encoding="utf-8")
        return SimpleNamespace(returncode=0, stderr="", stdout=f"écrite dans {draft} :"), []

    def unbuildable(*_a, **_k):
        raise curate.Unbuildable("no start in its band gives it a path", word="ours")

    monkeypatch.setattr(curate, "run_gen_phrase", run)
    monkeypatch.setattr(curate, "choose_starts", unbuildable)
    monkeypatch.setattr(curate, "check_starts", lambda *_a, **_k: pytest.fail("nothing is swapped, nothing checked"))
    log = Log()
    assert _gen(log) is None
    assert not draft.exists() and not sidecar.exists() and len(runs) == 1
    assert "- on the written map, the line cannot be built: « ours »: no start in its band gives it a path" in log


def test_an_incomplete_start_choice_erases_the_draft(tmp_path, monkeypatch):
    draft = tmp_path / "x_y_z.json"
    sidecar = tmp_path / "x_y_z.other-sense.json"

    def run(*_a, **_k):
        draft.write_text("{}", encoding="utf-8")
        sidecar.write_text("{}", encoding="utf-8")
        return SimpleNamespace(returncode=0, stderr="", stdout=f"écrite dans {draft} :"), []

    monkeypatch.setattr(curate, "run_gen_phrase", run)
    monkeypatch.setattr(curate, "choose_starts", lambda *_a, **_k: None)
    monkeypatch.setattr(curate, "check_starts", lambda *_a, **_k: pytest.fail("an incomplete choice is not checked"))
    assert _gen(Log()) is None
    assert not draft.exists() and not sidecar.exists()


def test_a_puzzle_path_holding_a_space_is_read(tmp_path, monkeypatch):
    # gen_phrase prints an absolute path: a checkout under « My Projects » is still one path
    draft = str(tmp_path / "My Projects" / "x_y_z.json")
    stdout = f"\nPhrase (fr) écrite dans {draft} :\n  lapin^120 -> chat\n"
    seen = []
    monkeypatch.setattr(curate, "run_gen_phrase",
                        lambda *_a, **_k: (SimpleNamespace(returncode=0, stderr="", stdout=stdout), []))
    monkeypatch.setattr(curate, "choose_starts",
                        lambda _c, _l, path, *_a, **_k: seen.append(path) or {"chat": "lapin"})
    monkeypatch.setattr(curate, "check_starts", lambda _c, _l, path, *_a, **_k: seen.append(path) or {})
    assert _gen(Log()) == draft
    assert seen == [draft, draft]


def test_a_written_puzzle_whose_path_cannot_be_read_is_refused(monkeypatch):
    # The file on disk carries gen_phrase's own random starts, neither chosen nor checked:
    # never a candidate day.
    monkeypatch.setattr(curate, "run_gen_phrase",
                        lambda *_a, **_k: (SimpleNamespace(returncode=0, stderr="", stdout="Phrase (fr) écrite.\n"), []))
    monkeypatch.setattr(curate, "choose_starts", lambda *_a, **_k: pytest.fail("no path, no start choice"))
    monkeypatch.setattr(curate, "check_starts", lambda *_a, **_k: pytest.fail("no path, no check"))
    log = Log()
    assert _gen(log) is None
    assert any("path could not be read" in line for line in log)


def _three_hole_draft(tmp_path):
    puzzle = {
        "words": ["un", "chat", "un", "chien", "une", "pierre"],
        "holes": [
            {"pos": i, "secret": {"word": word, "slug": word}, "start": {"word": "départ"}}
            for i, word in ((1, "chat"), (3, "chien"), (5, "pierre"))
        ],
        "ranks": {word: {start: {"word": start, "rank": 120}} for word, start in
                  (("chat", "lapin"), ("chien", "loup"), ("pierre", "brique"))},
    }
    path = tmp_path / "draft.json"
    path.write_text(json.dumps(puzzle), encoding="utf-8")
    return path


def _two_of_three(shown):
    def pick(_claude, _marked, info, _kind, lang):
        shown.extend(info)
        return {"starts": {"chat": "lapin", "chien": "loup"}, "unsaveable": None, "why": ""}
    return pick


def _starts(path, day=None, **kw):
    """`choose_starts` on a written draft, for the line and words `day` (`_day_of`'s by default)."""
    line, checked = day or _day_of()
    return curate.choose_starts(object(), kw.pop("log", Log()), str(path), line, checked, {}, curate.Vectors(),
                                kw.pop("pairs", {}), lang="fr", **kw)


def test_the_start_step_reads_each_hole_s_role_path_and_the_line_s_kind(tmp_path, monkeypatch):
    path = _three_hole_draft(tmp_path)
    seen = {}

    def pick(_claude, _marked, info, kind, lang):
        seen.update(info=info, kind=kind)
        return {"starts": {"chat": "lapin", "chien": "loup", "pierre": "brique"}, "unsaveable": None, "why": ""}

    monkeypatch.setattr(curate.llm, "pick_starts", pick)
    ladder = {"slot": "s", "family": "f", "first": "x"}
    assert _starts(path, _day_of(ladders={"pierre": ladder})) == {"chat": "lapin", "chien": "loup", "pierre": "brique"}
    assert seen["kind"] == 2
    assert [(h["secret"], h["role"], h["path"], h["ladder"]) for h in seen["info"]] == [
        ("chat", "main", {"line": "to chat", "words": ["un"]}, None),
        ("chien", "other", {"line": "to chien", "words": ["un"]}, None),
        ("pierre", "other", {"line": "to pierre", "words": ["un"]}, ladder)]


def test_a_hole_left_without_a_start_is_asked_again_alone(tmp_path, monkeypatch):
    # A slip on one hole (a word not written as listed) costs one more question, not the
    # day and its map; the re-asked sentence shows the starts already chosen.
    path = _three_hole_draft(tmp_path)
    shown, asked = [], []
    monkeypatch.setattr(curate.llm, "pick_starts", _two_of_three(shown))

    def pick_one(_claude, marked, hole, options, refused="", *, kind, lang, others=None):
        asked.append((marked, hole["secret"], hole["role"], [o["word"] for o in options], kind, others))
        return "brique"

    monkeypatch.setattr(curate.llm, "pick_start", pick_one)
    assert _starts(path) == {"chat": "lapin", "chien": "loup", "pierre": "brique"}
    # the day as the first pick read it: every other hole's role, start and notes
    assert asked == [("un lapin un loup une [____]", "pierre", "other", ["brique"], 2,
                      [{"secret": "chat", "role": "main", "start": "lapin", "notes": "n-chat"},
                       {"secret": "chien", "role": "other", "start": "loup", "notes": "n-chien"}])]


def test_start_choice_requires_all_three_valid_candidates(tmp_path, monkeypatch):
    path = _three_hole_draft(tmp_path)
    shown = []
    monkeypatch.setattr(curate.llm, "pick_starts", _two_of_three(shown))
    monkeypatch.setattr(curate.llm, "pick_start", lambda *_a, **_k: None)
    log = Log()
    assert _starts(path, log=log) is None
    assert len(shown) == 3
    assert any("missing: pierre" in line for line in log)


@pytest.mark.parametrize("bandless, why, word", [
    ("pierre", "no start word in its band", "pierre"),
    ("chat", "the main word « chat »: no start word in its band", None),
])
def test_a_word_with_no_start_in_its_band_makes_the_line_unbuildable_before_any_question(tmp_path, monkeypatch,
                                                                                       bandless, why, word):
    path = _three_hole_draft(tmp_path)
    puzzle = json.loads(path.read_text(encoding="utf-8"))
    puzzle["ranks"][bandless] = {"x": {"word": "x", "rank": 40}}          # nearer than the band
    path.write_text(json.dumps(puzzle), encoding="utf-8")
    monkeypatch.setattr(curate.llm, "pick_starts", lambda *_a, **_k: pytest.fail("no question"))
    with pytest.raises(curate.Unbuildable) as raised:
        _starts(path)
    assert raised.value.why == why and raised.value.word == word


@pytest.mark.parametrize("named, why, word", [
    ("chat", "the main word « chat »: no start in its band gives it a path: only by spelling", None),
    ("chien", "no start in its band gives it a path: only by spelling", "chien"),
])
def test_a_word_no_start_gives_a_path_makes_the_line_unbuildable(tmp_path, monkeypatch, named, why, word):
    # the main word ends the line; one of the others the bank's start step chooses again
    path = _three_hole_draft(tmp_path)
    monkeypatch.setattr(curate.llm, "pick_starts", lambda *_a, **_k: {"starts": {}, "unsaveable": named,
                                                                      "why": "only by spelling"})
    with pytest.raises(curate.Unbuildable) as raised:
        _starts(path)
    assert (raised.value.why, raised.value.word) == (why, word)


# --- a secret/start pair is never played twice; every generated start is checked ---------

def _generated_draft(tmp_path, band, starts=None, first="un"):
    """The three-hole draft as a gen_phrase run left it: « chat »'s band holds `band`
    (nearest first), the holes show `starts`, the sentence opens on `first`."""
    path = _three_hole_draft(tmp_path)
    puzzle = json.loads(path.read_text(encoding="utf-8"))
    puzzle["words"][0] = first
    puzzle["ranks"]["chat"] = {word: {"word": word, "rank": 110 + 10 * i} for i, word in enumerate(band)}
    for hole, start in zip(puzzle["holes"], starts or ()):
        hole["start"]["word"] = start
    path.write_text(json.dumps(puzzle), encoding="utf-8")
    return path


def _pick_one(asked, choice):
    def pick(_claude, marked, hole, options, refused="", **_k):
        asked.append((marked, hole["secret"], [o["word"] for o in options], refused))
        return choice
    return pick


def _check(path, tried=None, day=None, **kw):
    """`check_starts` on a written draft, for the line and words `day` (`_day_of`'s by default)."""
    line, checked = day or _day_of()
    return curate.check_starts(object(), kw.pop("log", Log()), str(path), line, checked, tried or {}, curate.Vectors(),
                               kw.pop("pairs", {}), lang="fr", **kw)


def test_a_start_the_secret_was_played_with_is_never_offered(tmp_path, monkeypatch):
    path = _generated_draft(tmp_path, ["lapin", "souris"])
    shown = []

    def pick(_claude, _marked, info, _kind, lang):
        shown.extend(info)
        return {"starts": {"chat": "souris", "chien": "loup", "pierre": "brique"}, "unsaveable": None, "why": ""}

    monkeypatch.setattr(curate.llm, "pick_starts", pick)
    picked = _starts(path, pairs={"chat": {"lapin"}})
    assert [[o["word"] for o in h["options"]] for h in shown] == [["souris"], ["loup"], ["brique"]]
    assert picked == {"chat": "souris", "chien": "loup", "pierre": "brique"}


def test_a_generated_start_that_repeats_a_pair_is_refused_and_re_picked(tmp_path, monkeypatch):
    # Refused by code, with no question to the model; the re-pick is offered neither the refused
    # start, nor a start the hole has already shown, nor another pair already played.
    path = _generated_draft(tmp_path, ["lapin", "souris", "mulot", "rat"], starts=["lapin", "loup", "brique"])
    asked = []
    monkeypatch.setattr(curate.llm, "sentence_check", lambda *_a, **_k: pytest.fail("a played pair needs no model"))
    monkeypatch.setattr(curate.llm, "pick_start", _pick_one(asked, "rat"))
    repick = _check(path, {"chat": {"souris"}}, pairs={"chat": {"lapin", "mulot"}})
    assert repick == {"chat": "rat"}
    assert asked == [("un [____] un loup une brique", "chat", ["rat"],
                      "this secret was already played from this start word")]


def test_a_re_pick_reads_the_day_as_the_first_pick_does(tmp_path, monkeypatch):
    # The re-pick sees the hole's role and where the reader's nearest word lands, and every
    # other hole's notes and shown start: the day-level choice cannot be made without them.
    path = _generated_draft(tmp_path, ["souris", "lapin"], starts=["lapin", "loup", "brique"])
    seen = {}
    monkeypatch.setattr(curate.llm, "sentence_check",
                        lambda *_a, **_k: {"valid": False, "faulty": {"lapin": "un accord faux"}})

    def pick(_claude, _marked, hole, _options, refused="", *, kind, lang, others=None):
        seen.update(hole=hole, kind=kind, others=others)
        return "souris"

    monkeypatch.setattr(curate.llm, "pick_start", pick)
    assert _check(path, day=_day_of(guesses={"chat": ["souris"]})) == {"chat": "souris"}
    assert seen["hole"]["notes"].startswith("n-chat") and seen["hole"]["role"] == "main" and seen["kind"] == 2
    assert "the reader's nearest word « souris » sits at rank 110" in seen["hole"]["notes"]
    assert seen["others"] == [{"secret": "chien", "role": "other", "start": "loup", "notes": "n-chien"},
                              {"secret": "pierre", "role": "other", "start": "brique", "notes": "n-pierre"}]


def test_a_second_re_pick_sees_the_first_one_in_place(tmp_path, monkeypatch):
    # Two starts refused in one round: the hole asked second reads the day with the start
    # just re-picked, never the refused one.
    path = _generated_draft(tmp_path, ["souris", "lapin"], starts=["lapin", "loup", "brique"])
    puzzle = json.loads(path.read_text(encoding="utf-8"))
    puzzle["ranks"]["chien"]["renard"] = {"word": "renard", "rank": 130}
    path.write_text(json.dumps(puzzle), encoding="utf-8")
    monkeypatch.setattr(curate.llm, "sentence_check", lambda *_a, **_k: {
        "valid": False, "faulty": {"lapin": "un accord faux", "loup": "un accord faux"}})
    asked = []

    def pick(_claude, marked, hole, _options, others=None, **_k):
        asked.append((marked, hole["secret"], others))
        return {"chat": "souris", "chien": "renard"}[hole["secret"]]

    monkeypatch.setattr(curate.llm, "pick_start", pick)
    assert _check(path) == {"chat": "souris", "chien": "renard"}
    marked, secret, others = asked[1]
    assert (marked, secret) == ("un souris un [____] une brique", "chien")
    assert {"secret": "chat", "role": "main", "start": "souris", "notes": "n-chat"} in others


# Every hole is of a wide kind but the main word: the idea check asks them all.
_WIDE = {"slot": "s", "family": "f", "first": "x"}
_ALL_ASKED = _day_of(ladders={"chien": _WIDE, "pierre": _WIDE})


def test_start_words_the_sentence_check_passes_are_kept(tmp_path, monkeypatch):
    path = _generated_draft(tmp_path, ["lapin", "souris"], starts=["lapin", "loup", "brique"])
    checked, ideas = [], []
    monkeypatch.setattr(curate.llm, "sentence_check",
                        lambda _c, shown, starts, lang: checked.append((shown, starts)) or {"valid": True, "faulty": {}})
    monkeypatch.setattr(curate.llm, "start_ideas", lambda _c, shown, starts, lang: ideas.append((shown, starts))
                        or ({}, {"lapin", "loup", "brique"}))
    monkeypatch.setattr(curate.llm, "pick_start", lambda *_a, **_k: pytest.fail("nothing to re-pick"))
    log = Log()
    assert _check(path, day=_ALL_ASKED, log=log) == {}
    assert checked == [("un lapin un loup une brique", ["lapin", "loup", "brique"])]
    # each start's first idea is asked beside the hidden word it stands for
    assert ideas == [("un lapin un loup une brique", [{"start": "lapin", "secret": "chat"},
                                                      {"start": "loup", "secret": "chien"},
                                                      {"start": "brique", "secret": "pierre"}])]
    assert "- start ideas check: each start asked shares its first idea with its hidden word" in log


_ALL_JUDGED = {"lapin", "loup", "brique"}


def test_a_riddle_start_is_re_picked_with_its_reason(tmp_path, monkeypatch):
    # The user's reading (2026-10-14): a start carries ONE idea its hidden word shares, its
    # first one — « berceau » for « cercueil » shared only a side meaning.
    path = _generated_draft(tmp_path, ["lapin", "souris", "mulot"], starts=["lapin", "loup", "brique"])
    asked = []
    monkeypatch.setattr(curate.llm, "sentence_check", lambda *_a, **_k: {"valid": True, "faulty": {}})
    monkeypatch.setattr(curate.llm, "start_ideas",
                        lambda *_a, **_k: ({"lapin": "a riddle: a side meaning"}, _ALL_JUDGED))
    monkeypatch.setattr(curate.llm, "pick_start", _pick_one(asked, "souris"))
    log = Log()
    assert _check(path, log=log) == {"chat": "souris"}
    assert asked == [("un [____] un loup une brique", "chat", ["souris", "mulot"], "a riddle: a side meaning")]
    assert any("start « lapin » for « chat » refused: a riddle" in line for line in log)


def test_a_start_the_idea_check_could_not_judge_is_left_to_the_reviewer_never_passed(tmp_path, monkeypatch):
    path = _generated_draft(tmp_path, ["lapin", "souris"], starts=["lapin", "loup", "brique"])
    monkeypatch.setattr(curate.llm, "sentence_check", lambda *_a, **_k: {"valid": True, "faulty": {}})
    monkeypatch.setattr(curate.llm, "start_ideas", lambda *_a, **_k: ({}, {"loup"}))   # two unjudged
    monkeypatch.setattr(curate.llm, "pick_start", lambda *_a, **_k: pytest.fail("a doubt refuses nothing"))
    log = Log()
    assert _check(path, day=_ALL_ASKED, log=log) == {}
    assert "- start ideas check: no usable verdict for « lapin », « brique » — left to the reviewer" in log
    assert not any("each start asked" in line for line in log)


def test_a_start_the_idea_check_passed_is_never_asked_again(tmp_path, monkeypatch):
    # Asked again, a start it passed could fall to the answer's noise and spend a round.
    path = _generated_draft(tmp_path, ["lapin", "souris"], starts=["lapin", "loup", "brique"])
    asked = []
    monkeypatch.setattr(curate.llm, "sentence_check", lambda *_a, **_k: {"valid": True, "faulty": {}})
    monkeypatch.setattr(curate.llm, "start_ideas",
                        lambda _c, _s, starts, lang: asked.append([s["start"] for s in starts]) or ({}, _ALL_JUDGED))
    cleared = {"chien": {"loup"}}
    assert _check(path, day=_ALL_ASKED, cleared=cleared) == {}
    assert asked == [["lapin", "brique"]]
    assert cleared == {"chat": {"lapin"}, "chien": {"loup"}, "pierre": {"brique"}}
    asked.clear()
    assert _check(path, day=_ALL_ASKED, cleared=cleared) == {}
    assert asked == []                                   # every start cleared: no question at all


def test_a_start_with_no_verdict_is_asked_again_never_cleared(tmp_path, monkeypatch):
    # An unjudged start is not a pass: the next round asks it again.
    path = _generated_draft(tmp_path, ["lapin", "souris"], starts=["lapin", "loup", "brique"])
    asked = []
    answers = iter([({}, {"loup"}), ({}, _ALL_JUDGED)])
    monkeypatch.setattr(curate.llm, "sentence_check", lambda *_a, **_k: {"valid": True, "faulty": {}})
    monkeypatch.setattr(curate.llm, "start_ideas",
                        lambda _c, _s, starts, lang: asked.append([s["start"] for s in starts]) or next(answers))
    cleared = {}
    assert _check(path, day=_ALL_ASKED, cleared=cleared) == {}
    assert cleared == {"chien": {"loup"}}
    log = Log()
    assert _check(path, day=_ALL_ASKED, cleared=cleared, log=log) == {}
    assert asked == [["lapin", "loup", "brique"], ["lapin", "brique"]]
    assert "- start ideas check: each start asked shares its first idea with its hidden word" in log


def test_on_the_last_round_a_start_the_sentence_check_faults_is_still_re_picked(tmp_path, monkeypatch):
    # Only a riddle waits for the reviewer on the last round; a wrong or meaningless start never ships.
    path = _generated_draft(tmp_path, ["lapin", "souris"], starts=["lapin", "loup", "brique"])
    monkeypatch.setattr(curate.llm, "sentence_check",
                        lambda *_a, **_k: {"valid": False, "faulty": {"lapin": "un accord faux"}})
    monkeypatch.setattr(curate.llm, "start_ideas", lambda *_a, **_k: pytest.fail("a faulty sentence comes first"))
    monkeypatch.setattr(curate.llm, "pick_start", lambda *_a, **_k: "souris")
    log = Log()
    assert _check(path, last=True, log=log) == {"chat": "souris"}
    assert "- start « lapin » for « chat » refused: un accord faux" in log


def test_on_the_last_round_a_riddle_is_left_to_the_reviewer_not_traded_for_an_unread_start(tmp_path, monkeypatch):
    path = _generated_draft(tmp_path, ["lapin", "souris"], starts=["lapin", "loup", "brique"])
    monkeypatch.setattr(curate.llm, "sentence_check", lambda *_a, **_k: {"valid": True, "faulty": {}})
    monkeypatch.setattr(curate.llm, "start_ideas",
                        lambda *_a, **_k: ({"lapin": "a riddle: a side meaning"}, _ALL_JUDGED))
    monkeypatch.setattr(curate.llm, "pick_start", lambda *_a, **_k: pytest.fail("a re-pick now would ship unread"))
    log = Log()
    assert _check(path, last=True, log=log) == {}
    assert ("- start « lapin » for « chat »: a riddle: a side meaning — the last round, left to the reviewer"
            in log)


def test_the_idea_check_asks_the_main_word_and_each_word_of_a_wide_kind(tmp_path, monkeypatch):
    # The main word, whose path the day rests on, and a word of a wide kind, whose start must
    # name a smaller family (2026-10-20). Asked of every hole of the user's loved days, the
    # check called 17 of 57 starts riddles: the plain others are not asked.
    path = _generated_draft(tmp_path, ["lapin", "souris"], starts=["lapin", "loup", "brique"])
    asked = []
    monkeypatch.setattr(curate.llm, "sentence_check", lambda *_a, **_k: {"valid": True, "faulty": {}})
    monkeypatch.setattr(curate.llm, "start_ideas",
                        lambda _c, _s, starts, lang: asked.append([s["start"] for s in starts]) or ({}, _ALL_JUDGED))
    assert _check(path) == {}
    assert asked == [["lapin"]]
    asked.clear()
    assert _check(path, day=_day_of(ladders={"chien": _WIDE})) == {}
    assert asked == [["lapin", "loup"]]


def test_the_idea_check_waits_for_a_sentence_that_reads_right(tmp_path, monkeypatch):
    path = _generated_draft(tmp_path, ["lapin", "souris"], starts=["lapin", "loup", "brique"])
    monkeypatch.setattr(curate.llm, "sentence_check",
                        lambda *_a, **_k: {"valid": False, "faulty": {"lapin": "un accord faux"}})
    monkeypatch.setattr(curate.llm, "start_ideas", lambda *_a, **_k: pytest.fail("a faulty sentence comes first"))
    monkeypatch.setattr(curate.llm, "pick_start", lambda *_a, **_k: "souris")
    assert _check(path) == {"chat": "souris"}


def test_a_hole_whose_readers_land_far_is_noted_as_one_the_line_gives_little_of():
    # « cercueil »: readers write « sol », « parquet » (1010) — the start step must hear that
    # the line gives little.
    ranks = {"cercueil": {"word": "cercueil", "rank": 0}, "tombe": {"word": "tombe", "rank": 6},
             "parquet": {"word": "parquet", "rank": 1010}}
    far = "getting closer: the line gives little of this word"

    def notes(guesses, expected=None):
        line, checked = _day_of(("cercueil", "chien", "pierre"), guesses={"cercueil": guesses},
                                expected={"cercueil": expected})
        checked.context["cercueil"] = "readers would split"
        return curate._notes(ranks, checked.trio[0], line, checked, curate.Vectors())

    assert notes(["sol", "parquet"]).startswith("readers would split; the reader's nearest word « parquet » sits at "
                                                "rank 1010")
    assert notes(["sol", "parquet"]).endswith(far)
    assert far not in notes(["tombe", "parquet"])
    # a word the readers write themselves is handed over, never one the line gives little of
    assert far not in notes(["parquet"], expected="cercueil")
    assert notes([]) == "readers would split"


def test_a_start_the_sentence_check_faults_is_re_picked_from_the_rest_of_the_band(tmp_path, monkeypatch):
    path = _generated_draft(tmp_path, ["lapin", "souris", "mulot"], starts=["lapin", "loup", "brique"])
    asked = []
    monkeypatch.setattr(curate.llm, "sentence_check",
                        lambda *_a, **_k: {"valid": False, "faulty": {"lapin": "un accord faux"}})
    monkeypatch.setattr(curate.llm, "pick_start", _pick_one(asked, "souris"))
    assert _check(path) == {"chat": "souris"}
    assert asked == [("un [____] un loup une brique", "chat", ["souris", "mulot"], "un accord faux")]


def test_the_model_judges_the_sentence_and_the_re_pick_band_keeps_the_letter_rule(tmp_path, monkeypatch):
    # No mechanical refusal: « le effet » goes to the model like any start; the band the
    # re-pick chooses from still holds only words that can follow « le » — « ami » elides.
    path = _generated_draft(tmp_path, ["effet", "ami", "lapin"], starts=["effet", "loup", "brique"], first="le")
    asked, checked = [], []
    monkeypatch.setattr(curate.llm, "sentence_check", lambda _c, shown, _starts, lang: checked.append(shown) or
                        {"valid": False, "faulty": {"effet": "« le effet » n'est pas français"}})
    monkeypatch.setattr(curate.llm, "pick_start", _pick_one(asked, "lapin"))
    assert _check(path) == {"chat": "lapin"}
    assert checked == ["le effet un loup une brique"]
    assert asked == [("le [____] un loup une brique", "chat", ["lapin"], "« le effet » n'est pas français")]


def test_start_words_are_re_picked_at_most_start_rounds_times(monkeypatch):
    runs, checks = [], []
    monkeypatch.setattr(curate, "run_gen_phrase", lambda *_a, **_k: (
        runs.append(1), (SimpleNamespace(returncode=0, stderr="", stdout="écrite dans out/x_y_z.json :"), []))[1])
    monkeypatch.setattr(curate, "choose_starts", lambda *_a, **_k: {"chat": "lapin"})
    seen = []

    def check(*_a, **k):
        seen.append(k["cleared"])
        k["cleared"].setdefault("chien", set()).add(f"r{len(seen)}")
        checks.append(k["last"])
        return {"chat": f"start{len(checks)}"}

    monkeypatch.setattr(curate, "check_starts", check)
    assert curate.st.START_ROUNDS == 3
    # every check faults the start: three re-picks, then the draft is left to the reviewer
    assert _gen(Log()) == "out/x_y_z.json"
    assert len(checks) == 3 and len(runs) == 5     # the first run, the chosen starts, three re-picks
    assert checks == [False, False, True]          # the last check knows no check reads its re-pick
    # one record of the starts the idea check passed, kept across the rounds: never asked again
    assert all(c is seen[0] for c in seen) and seen[0]["chien"] == {"r1", "r2", "r3"}


# --- the words, the main word first: measured alone, then two chosen against it ----------
# (the user's own method, 2026-10-20: "there's always a word I'm sure I want to pick, then I
# chose 2 other words that works well with my first pick")

GARDEN = "Le chat dort sur la pierre froide du jardin."


def _garden_tokens(*_a):
    words = [("le", "DET", True), ("chat", "NOUN", False), ("dort", "VERB", False), ("sur", "ADP", True),
             ("la", "DET", True), ("pierre", "NOUN", False), ("froide", "ADJ", False), ("du", "ADP", True),
             ("jardin", "NOUN", False), (".", "PUNCT", False)]
    lemmas = {"dort": "dormir"}
    return [Token(i, w, lemmas.get(w, w), pos, "" if pos == "PUNCT" else w, stop) for i, (w, pos, stop) in enumerate(words)]


def _garden(read=None, **given):
    """« le chat dort sur la [pierre] froide du jardin. », read: its main word « pierre »,
    reached through « froide »; every word it can hide judged at 0.3 but where `given` says."""
    tokens = _garden_tokens()
    allowed = [t for t in tokens if t.slug in ("chat", "dort", "pierre", "froide", "jardin")]
    line = curate.new_line(GARDEN, tokens, allowed, {t.slug: given.get(t.slug, 0.3) for t in allowed})
    line["read"] = read or _a_read()
    return line


def _measured(monkeypatch, *, says=None, instead=None, expected=None, first=None):
    """The reader, the would-say test and the neighbours, faked: readers split but where
    `expected` names the word they write, players say each word at 0.8 but where `says`
    says, the neighbours write `first(fragment)` (« autre »). Returns what was asked."""
    asked = {"reader": [], "say": [], "neighbours": []}
    monkeypatch.setattr(curate.llm, "context_guesses", lambda _c, toks, _b, mark, _n, lang: (
        asked["reader"].append(toks[mark].text), ([], (expected or {}).get(toks[mark].text)))[1])
    monkeypatch.setattr(curate.llm, "would_say", lambda _c, _t, _b, _m, word, lang: (
        asked["say"].append(word), ((says or {}).get(word, 0.8), (instead or {}).get(word)))[1])
    monkeypatch.setattr(curate.llm, "neighbours_complete", lambda _c, fragment, lang: (
        asked["neighbours"].append(fragment), first(fragment) if first else "autre")[1])
    return asked


_PATHS = {"chat": ["dort"], "dort": ["chat"], "froide": ["jardin"], "jardin": ["froide"]}


def _two(a="chat", b="jardin", **verdicts):
    """Two words against the main word, each with its path through a word of the line (`_PATHS`);
    `verdicts` changes a word's: {word: {...}}."""
    return {"words": [{"word": w, "path": f"to {w}", "path_words": _PATHS.get(w, ["dort"]), "mirror": False, "wide": False,
                       "ladder": None, "lands": "", **verdicts.get(w, {})} for w in (a, b)], "why": "w"}


def _against(monkeypatch, *answers):
    """The two words against the main word, answered `answers` in turn; returns what each ask
    was shown: the line, the words offered, what was refused."""
    asked, given = [], iter(answers)
    monkeypatch.setattr(curate.llm, "choose_companions", lambda _c, marked, read, notes, pool, refused, lang: (
        asked.append({"marked": marked, "notes": notes, "pool": [p["word"] for p in pool],
                      "refused": list(refused)}), next(given))[1])
    return asked


def _choose(line=None, sims=None):
    """`choose_trio` on the garden line: (the checked trio or None, the line, the log)."""
    line = line or _garden()
    log = Log()
    return curate.choose_trio(object(), log, line, sims or curate.Vectors(), {}, "fr"), line, log


def test_two_words_are_chosen_against_the_main_word_and_kept_with_their_paths(monkeypatch):
    asked = _measured(monkeypatch)
    offered = _against(monkeypatch, _two())
    checked, line, _log = _choose()
    assert [t.text for t in checked.trio] == ["pierre", "chat", "jardin"]
    assert checked.paths == {"pierre": {"line": "what the cat sleeps on", "words": ["froide"]},
                             "chat": {"line": "to chat", "words": ["dort"]},
                             "jardin": {"line": "to jardin", "words": ["froide"]}}
    assert checked.ladders == {} and set(checked.context) == {"pierre", "chat", "jardin"}
    # the main word shown in brackets, the words that can be hidden with it, each with its band
    assert offered == [{"marked": "le chat dort sur la [pierre] froide du jardin.",
                        "notes": checked.context["pierre"], "pool": ["chat", "dort", "froide", "jardin"],
                        "refused": []}]
    # the main word measured alone first, then each word once; its neighbours asked again once
    # the others, hidden, cut its fragment
    assert asked["reader"] == ["pierre", "chat", "jardin"]
    assert asked["neighbours"] == ["dort sur la ___ froide du jardin", "dort sur la ___ froide du",
                                   "le ___ dort sur la", "froide du ___"]
    assert line["asks"] == 1 and "dropped" not in line


def test_a_stop_word_on_a_word_s_path_is_passed_over_and_left_out_of_its_path(monkeypatch):
    _measured(monkeypatch)
    offered = _against(monkeypatch, _two(chat={"path_words": ["sur", "dort"]}))
    checked, line, _log = _choose()
    assert checked.paths["chat"] == {"line": "to chat", "words": ["dort"]}
    assert len(offered) == 1 and line["asks"] == 1


@pytest.mark.parametrize("facts, why", [
    ({"expected": {"pierre": "pierre"}}, "most readers write it straight in"),
    ({"first": lambda f: "pierre" if "la ___ froide" in f else "autre"}, "the words right around it write it in"),
    ({"says": {"pierre": 0.45}, "crowd": 0.8}, "buried"),
    ({"expected": {"pierre": "caillou"}, "map": {"roche": {"word": "roche", "rank": 2}}, "known": True},
     "none of the words readers put in its blank (« caillou »)"),
    ({"expected": {"pierre": "caillou"}, "map": {"caillou": {"word": "caillou", "rank": 3}}},
     "the word most readers write sits at rank 3 on its map"),
    ({"bandless": True}, "no start word in its band"),
])
def test_a_fact_against_the_main_word_sets_the_line_aside_before_any_other_word(monkeypatch, facts, why):
    _measured(monkeypatch, says=facts.get("says"), expected=facts.get("expected"), first=facts.get("first"))
    if facts.get("bandless"):
        monkeypatch.setattr(curate, "band_of", lambda line, t, *_a: [] if t.text == "pierre" else [{"word": "x",
                                                                                                    "rank": 150}])
    monkeypatch.setattr(curate.llm, "choose_companions", lambda *_a, **_k: pytest.fail("the main word is never swapped"))
    sims = curate.Vectors(crowd=lambda t: facts.get("crowd"), known=lambda s: bool(facts.get("known")),
                          static_map=lambda t, off=frozenset(): facts.get("map"))
    checked, line, log = _choose(sims=sims)
    assert checked is None and line["dropped"].startswith("the main word « pierre »: ") and why in line["dropped"]
    assert any(entry.startswith("- set aside: the main word « pierre »") for entry in log)


def test_a_main_word_players_don_t_say_passes_and_a_reader_s_word_at_rank_four_hands_nothing(monkeypatch):
    _measured(monkeypatch, says={"pierre": 0.2}, expected={"pierre": "caillou"})
    _against(monkeypatch, _two())
    checked, _line, _log = _choose(sims=curate.Vectors(static_map=lambda t, off=frozenset(): {
        "caillou": {"word": "caillou", "rank": 4}}))
    assert [t.text for t in checked.trio] == ["pierre", "chat", "jardin"]
    assert checked.tags["pierre"] == ["a word players don't say"]


@pytest.mark.parametrize("answer, told", [
    (None, "the answer must name two of the words offered"),
    (_two("chat", "lune"), "two distinct words of those offered, never the main word: « chat », « lune »"),
    ({**_two(), "words": [_two()["words"][0], {**_two()["words"][1], "word": "pierre"}]}, "never the main word"),
    ({**_two(), "words": [_two()["words"][0]] * 2}, "two distinct words"),
    (_two(jardin={"path_words": ["sur"]}), "« jardin »: its path must run through 1 to 3 words of the line"),
    (_two(jardin={"path_words": ["jardin"]}), "never the word itself: « jardin » is not one"),
])
def test_an_answer_that_is_not_two_words_offered_each_with_its_path_is_told_back(monkeypatch, answer, told):
    _measured(monkeypatch)
    offered = _against(monkeypatch, answer, _two())
    checked, line, _log = _choose()
    assert [t.text for t in checked.trio] == ["pierre", "chat", "jardin"]
    assert told in offered[1]["refused"][0] and line["asks"] == 2


def test_a_decline_sets_the_line_aside(monkeypatch):
    _measured(monkeypatch)
    _against(monkeypatch, {"words": None, "why": "nothing goes with it"})
    checked, line, _log = _choose()
    assert checked is None and line["dropped"] == "no two words go with the main word: nothing goes with it"


@pytest.mark.parametrize("facts, verdicts, why", [
    ({"says": {"chat": 0.45}, "crowd": {"chat": 0.8}}, {}, "buried"),
    ({"first": lambda f: "chat" if f.startswith("le ___") else "autre"}, {}, "the words right around it write it in"),
    ({}, {"chat": {"mirror": True}}, "a mirror"),
    ({}, {"chat": {"wide": True, "ladder": {"slot": "pets", "family": None, "first": "x"}}},
     "a lottery: one of a wide kind, and no smaller family a start can name"),
    ({}, {"chat": {"wide": True, "ladder": None}}, "a lottery: one of a wide kind, and the slot shapes no kind"),
])
def test_a_fact_against_another_word_refuses_it_and_the_same_main_word_is_asked_again(monkeypatch, facts,
                                                                                         verdicts, why):
    # the neighbours veto and the narrowing ladder hold on every hole (user-decided 2026-10-13,
    # 2026-10-20): a word its neighbours write in is never the day's one handed word
    _measured(monkeypatch, says=facts.get("says"), first=facts.get("first"))
    offered = _against(monkeypatch, _two(**verdicts), _two("dort", "jardin"))
    sims = curate.Vectors(crowd=lambda t: (facts.get("crowd") or {}).get(t.text))
    checked, line, log = _choose(sims=sims)
    assert [t.text for t in checked.trio] == ["pierre", "dort", "jardin"]
    assert offered[1]["refused"][0].startswith("« chat »: ") and why in offered[1]["refused"][0]
    assert "chat" not in offered[1]["pool"]                     # it left the words to choose from
    assert any(entry.startswith("- « chat » refused: ") for entry in log)


def test_the_neighbours_of_each_hole_of_a_repeated_word_are_asked(monkeypatch):
    # a repeated word is one hole per occurrence: the words right around ANY of them writing
    # it in refuse it (« droit de ___ is no fun when it's vote », user-decided 2026-10-13)
    words = [("le", "DET", True), ("vote", "NOUN", False), ("des", "ADP", True), ("jeunes", "NOUN", False),
             ("comme", "ADP", True), ("le", "DET", True), ("droit", "NOUN", False), ("de", "ADP", True),
             ("vote", "NOUN", False), (".", "PUNCT", False)]
    tokens = [Token(i, w, w, pos, "" if pos == "PUNCT" else w, stop) for i, (w, pos, stop) in enumerate(words)]
    allowed = [t for t in tokens if t.slug in ("vote", "jeunes", "droit")]
    line = curate.new_line("Le vote des jeunes comme le droit de vote.", tokens, allowed,
                           {t.slug: 0.3 for t in allowed})
    line["read"] = _a_read("vote", ("jeunes",))
    asked = _measured(monkeypatch, first=lambda f: "vote" if f == "le droit de ___" else "autre")
    monkeypatch.setattr(curate.llm, "choose_companions", lambda *_a, **_k: pytest.fail("the main word is never swapped"))
    checked, line, _log = _choose(line)
    assert asked["neighbours"] == ["le ___ des jeunes comme", "le droit de ___"]
    assert checked is None and line["dropped"] == ("the main word « vote »: the words right around it write it in "
                                                   "(« le droit de ___ »): no search")


def test_a_word_that_cuts_the_main_word_s_neighbours_into_writing_it_is_refused_not_the_line(monkeypatch):
    # alone, « dort sur la ___ froide du jardin » writes nothing; « jardin » hidden too, « dort
    # sur la ___ froide du » writes « pierre »: the fault is « jardin »'s, the main word stays
    _measured(monkeypatch, first=lambda f: "pierre" if f == "dort sur la ___ froide du" else "autre")
    offered = _against(monkeypatch, _two(), {"words": None, "why": "nothing else"})
    checked, line, _log = _choose()
    assert offered[1]["refused"] == ["« jardin »: hidden too, it leaves the words right around the main word "
                                     "« pierre » writing it in (« dort sur la ___ froide du »)"]
    assert offered[1]["pool"] == ["chat", "dort", "froide"]          # « chat », out of its reach, stays
    assert checked is None and line["dropped"] == "no two words go with the main word: nothing else"


def test_a_word_right_beside_the_main_word_is_refused_and_two_others_side_by_side_are_told(monkeypatch):
    _measured(monkeypatch)
    offered = _against(monkeypatch, _two("chat", "froide"), _two("chat", "dort"), _two())
    checked, line, _log = _choose(_garden(_a_read(path_words=("dort",))))
    assert [t.text for t in checked.trio] == ["pierre", "chat", "jardin"] and line["asks"] == 3
    assert offered[1]["refused"] == ["« froide »: it sits right beside the main word « pierre »: one idea per hole"]
    # side by side, and each the other's only path: told back, nothing refused
    told = offered[2]["refused"][1]
    assert told.startswith("« chat · dort » against « pierre »: ") and "« chat » and « dort » sit side by side" in told
    assert "every word the path to « chat » runs through is hidden" in told
    assert "every word the path to « pierre » runs through is hidden" in told
    assert offered[2]["pool"] == ["chat", "dort", "jardin"]


@pytest.mark.parametrize("says, expected, told", [
    ({"chat": 0.2, "jardin": 0.3}, {}, "it hides 2 words players don't say (chat, jardin)"),
    ({"pierre": 0.2, "chat": 0.3}, {}, "it hides 2 words players don't say (pierre, chat)"),
    ({}, {"chat": "chat", "jardin": "jardin"}, "the line hands over 2 of its words (chat, jardin)"),
])
def test_what_holds_against_the_three_together_is_told_back_and_refuses_none(monkeypatch, says, expected, told):
    _measured(monkeypatch, says=says, expected=expected)
    offered = _against(monkeypatch, _two(), _two("dort", "jardin"))
    checked, _line, _log = _choose()
    assert [t.text for t in checked.trio] == ["pierre", "dort", "jardin"]
    assert told in offered[1]["refused"][0] and offered[1]["pool"] == ["chat", "dort", "froide", "jardin"]


def test_a_word_hiding_the_main_word_s_only_path_is_told_back(monkeypatch):
    # « aussi [involontaire] que la [transpiration] »: a locked pair
    # the main word reached only through « jardin »: no two words leave it in sight
    _measured(monkeypatch)
    offered = _against(monkeypatch, *[_two("chat", "jardin")] * 3)
    checked, line, _log = _choose(_garden(_a_read(path_words=("jardin",))))
    assert "every word the path to « pierre » runs through is hidden" in offered[1]["refused"][0]
    assert checked is None and line["dropped"].startswith("no two words against the main word survived 3 asks")


def test_the_line_is_set_aside_once_its_asks_are_spent(monkeypatch):
    _measured(monkeypatch)
    _against(monkeypatch, None, None, None)
    checked, line, _log = _choose()
    assert curate.COMPANION_ASKS == 3 and checked is None
    assert line["dropped"].startswith("no two words against the main word survived 3 asks (the answer must name")


def test_a_trio_found_at_fault_when_checked_again_is_never_written(monkeypatch):
    # finishing a line: its words checked once more on their maps, from the measures taken,
    # and nothing is swapped — a fault there stops the line before its puzzle is written
    _measured(monkeypatch)
    _against(monkeypatch, _two())
    checked, line, _log = _choose()
    line["measures"].says["jardin"], line["measures"].crowds["jardin"] = (0.45, None), 0.8   # buried, now
    monkeypatch.setattr(curate.llm, "widely_known", lambda *_a, **_k: pytest.fail("no page for a line not built"))
    monkeypatch.setattr(curate, "generate", lambda *_a, **_k: pytest.fail("never written"))
    log = Log()
    assert curate.build_day(object(), log, line, checked, {"kind": "book"}, {"pairs": {}}, "", {}, "fr",
                            sims=curate.Vectors(crowd=lambda t: line["measures"].crowds.get(t.slug))) is None
    assert any(entry.startswith("- the line cannot be built: « jardin »: buried") for entry in log)


def test_a_line_checked_again_before_its_puzzle_asks_nothing_it_was_measured_at(monkeypatch):
    asked = _measured(monkeypatch)
    _against(monkeypatch, _two())
    checked, line, _log = _choose()
    before = {k: list(v) for k, v in asked.items()}
    built = []
    monkeypatch.setattr(curate.llm, "widely_known", lambda *_a, **_k: {"known": False, "why": ""})
    monkeypatch.setattr(curate, "choose_page", lambda *_a, **_k: None)
    monkeypatch.setattr(curate, "excerpt_around", lambda *_a, **_k: None)
    monkeypatch.setattr(curate, "generate", lambda _c, _l, line, checked, *_a, **_k: built.append(
        [t.text for t in checked.trio]) or "out/x.json")
    assert curate.build_day(object(), Log(), line, checked, {"kind": "book"}, {"pairs": {}}, "", {}, "fr",
                            sims=curate.Vectors()) == "out/x.json"
    assert asked == before and built == [["pierre", "chat", "jardin"]]


def _free_draft(monkeypatch):
    """The draft the bank's start step reads, faked from the line: each hidden word with its
    band on its map."""
    def draft(line, trio, sims, lang):
        holes = [{"pos": t.i, "secret": {"word": t.text, "slug": t.slug}, "start": {"word": t.text, "slug": t.slug},
                  "start_rank": 0} for t in trio]
        return {"words": [t.text for t in line["tokens"]], "holes": sorted(holes, key=lambda h: h["pos"]),
                "ranks": {t.slug: {f"{t.slug}-start": {"word": f"{t.text}-start", "rank": 150}} for t in trio}}

    monkeypatch.setattr(curate, "static_draft", draft)
    monkeypatch.setattr(curate.llm, "sentence_check", lambda *_a, **_k: {"valid": True, "faulty": {}})
    monkeypatch.setattr(curate.llm, "start_ideas", lambda _c, _s, starts, lang: ({}, {s["start"] for s in starts}))


def test_in_the_bank_a_word_no_start_saves_is_refused_and_chosen_again_within_the_same_asks(monkeypatch):
    _measured(monkeypatch)
    _free_draft(monkeypatch)
    offered = _against(monkeypatch, _two(), _two("dort", "jardin"))
    answers = iter([{"starts": {}, "unsaveable": "chat", "why": "only by spelling"}, None])
    monkeypatch.setattr(curate.llm, "pick_starts", lambda _c, _m, holes, kind, lang: next(answers) or {
        "starts": {h["slug"]: h["options"][0]["word"] for h in holes}, "unsaveable": None, "why": ""})
    checked, line, _log = _choose()
    started = curate.bank_line(object(), Log(), line, checked, {"pairs": {}}, "fr", curate.Vectors())
    checked, picked, _draft = started
    assert [t.text for t in checked.trio] == ["pierre", "dort", "jardin"] and line["asks"] == 2
    assert offered[1]["refused"] == ["« chat »: no start in its band gives it a path: only by spelling"]
    assert picked == {"pierre": "pierre-start", "dort": "dort-start", "jardin": "jardin-start"}


def test_in_the_bank_a_main_word_no_start_saves_sets_the_line_aside(monkeypatch):
    _measured(monkeypatch)
    _free_draft(monkeypatch)
    _against(monkeypatch, _two())
    monkeypatch.setattr(curate.llm, "pick_starts", lambda *_a, **_k: {"starts": {}, "unsaveable": "pierre", "why": ""})
    checked, line, _log = _choose()
    assert curate.bank_line(object(), Log(), line, checked, {"pairs": {}}, "fr", curate.Vectors()) is None
    assert line["dropped"] == "the main word « pierre »: no start in its band gives it a path"


# --- the giveaway judge, read on real play: a floor, and a note for a hard hole -----------

def _day_on_the_line(monkeypatch, scores):
    """day() on « Le chat dort sur la pierre froide. » with the giveaways `scores`;
    returns (the words offered against the main word, the log)."""
    monkeypatch.setattr(curate, "parse", _line_tokens)
    _giveaways(monkeypatch, scores)
    _read(monkeypatch)
    _measured(monkeypatch)
    offered = []
    monkeypatch.setattr(curate.llm, "choose_companions",
                        lambda _c, _m, _r, _n, pool, _refused, lang: offered.append([p["word"] for p in pool]) or None)
    log = Log()
    curate.day(object(), log, [{"sentence": "Le chat dort sur la pierre froide."}], {"kind": "book"},
               {"secrets": set(), "pairs": {}}, "", lambda w: True, "fr", judge=object(), sims=curate.Vectors())
    return offered, log


def test_a_word_the_line_gives_no_path_to_is_never_offered(monkeypatch):
    # User-decided 2026-10-02: under GIVEAWAY_MIN the line leads nowhere near the word
    # (« bloated », « rapacity » beat a native speaker), so the model never sees it.
    assert jev.GIVEAWAY_MIN == 0.10
    offered, log = _day_on_the_line(monkeypatch, {"chat": 0.3, "dort": 0.09, "pierre": 0.10, "froide": 0.5})
    assert offered[0] == ["chat", "froide"]          # at the floor a word stays: « pierre », the main word
    assert any("no path to dort (0.09)" in line for line in log)


def test_a_line_the_floor_leaves_short_of_three_words_is_set_aside(monkeypatch):
    offered, log = _day_on_the_line(monkeypatch, {"chat": 0.05, "dort": 0.09})
    assert offered == []
    assert any("set aside: fewer than 3 words can be hidden (no path to chat (0.05), dort (0.09))" in line
               for line in log)


# --- the day is chosen among FINISHED lines (user-decided 2026-10-13) ---------------------

_LINES = [{"sentence": GARDEN}, {"sentence": "Un chat dort sur la pierre froide du jardin."}]


def _finished_lines(monkeypatch, order, build, alone=lambda s: True, says=None):
    """day() on two lines, the model choosing « chat » and « jardin » against « pierre » on each
    and ordering the finished lines `order`; `build(sentence)` is what building that line gives.
    Returns (the words the reader was asked, the days compared, the lines built)."""
    monkeypatch.setattr(curate, "parse", _garden_tokens)
    _giveaways(monkeypatch, {"pierre": 0.15})
    _read(monkeypatch, lambda s: _a_read(stands_alone=alone(s), why="" if alone(s) else "leans"))
    asked = _measured(monkeypatch, says=says)
    monkeypatch.setattr(curate.llm, "choose_companions", lambda *_a, **_k: _two())
    compared = []
    monkeypatch.setattr(curate.llm, "choose_among",
                        lambda _c, days, lang: compared.append(days) or {"order": order, "why": "w"})
    built = []
    monkeypatch.setattr(curate, "build_day", lambda _c, _l, line, checked, *_a, **k: built.append(
        (line["sentence"], [t.text for t in checked.trio])) or build(line["sentence"]))
    tried = []
    path = curate.day(object(), Log(), _LINES, {"kind": "book"}, {"secrets": set(), "pairs": {}}, "",
                      lambda w: True, "fr", tried=tried, judge=object(), sims=curate.Vectors())
    assert tried == [line["sentence"] for line in _LINES]
    return path, sorted(asked["reader"]), compared, built


def test_every_line_is_finished_before_the_day_is_chosen(monkeypatch):
    path, measured, compared, built = _finished_lines(monkeypatch, [1, 0], lambda s: "out/x_y_z.json",
                                                      says={"jardin": 0.2})
    # both lines' words were measured before the one comparison
    assert measured == ["chat", "chat", "jardin", "jardin", "pierre", "pierre"]
    assert len(compared) == 1 and len(compared[0]) == 2
    day = compared[0][0]
    assert day["marked"] == "le [chat] dort sur la [pierre] froide du [jardin]."   # the parsed tokens, hidden words marked
    assert day["kind"] == 5
    # the main word first, each with its path and its facts — no easy / medium / hard
    assert [(w["word"], w["path"], w["path_words"], w["tags"]) for w in day["words"]] == [
        ("pierre", "what the cat sleeps on", ["froide"], ["the line gives little of it"]),
        ("chat", "to chat", ["dort"], []),
        ("jardin", "to jardin", ["froide"], ["a word players don't say"])]
    # the first in the model's order is built, and only it
    assert path == "out/x_y_z.json" and built == [(_LINES[1]["sentence"], ["pierre", "chat", "jardin"])]


def test_the_next_line_in_the_order_is_built_when_the_first_cannot_be(monkeypatch):
    path, _measured_, _compared, built = _finished_lines(
        monkeypatch, [1, 0], lambda s: None if s == _LINES[1]["sentence"] else "out/x_y_z.json")
    assert path == "out/x_y_z.json"
    assert [s for s, _ in built] == [_LINES[1]["sentence"], _LINES[0]["sentence"]]


def test_a_line_refused_by_its_checks_is_never_compared(monkeypatch):
    _path, _measured_, compared, built = _finished_lines(monkeypatch, [0], lambda s: "out/x_y_z.json",
                                                         alone=lambda s: s == _LINES[1]["sentence"])
    assert len(compared[0]) == 1
    assert [s for s, _ in built] == [_LINES[1]["sentence"]]   # the one compared is the line that stands alone


def test_a_comparison_that_declines_every_line_builds_nothing(monkeypatch):
    path, _measured_, _compared, built = _finished_lines(monkeypatch, [], lambda s: "out/x_y_z.json")
    assert path is None and built == []


def test_a_hard_hole_is_told_the_line_gives_little_and_looks_in_the_same_band(monkeypatch):
    # User-decided 2026-10-08: a hole the line gives little of is told so, never sent to a
    # nearer band.
    assert jev.GIVEAWAY_HARD == 0.20
    _measured(monkeypatch)
    _against(monkeypatch, _two())
    checked, _line, _log = _choose(_garden(chat=0.19, jardin=0.20))
    assert "the line gives little of this word" in checked.context["chat"]
    assert "the line gives little" not in checked.context["jardin"]     # at the threshold a hole is not hard
    assert checked.tags["chat"] == ["the line gives little of it"] and checked.tags["jardin"] == []


def test_a_score_just_under_the_hard_bar_is_hard_and_never_printed_at_it(monkeypatch):
    # « divorce » (2026-10-10) sat at 0.1999…: hard, and its note said « at 0.20 ».
    _measured(monkeypatch)
    _against(monkeypatch, _two())
    checked, _line, _log = _choose(_garden(chat=0.19999999999999998))
    note = checked.context["chat"]
    assert "hands it over at 0.19" in note and "the line gives little of this word" in note
    assert "at 0.20" not in note


def test_the_word_players_say_instead_in_another_form_is_this_word(monkeypatch):
    # « sauva » scored 0.35 because readers would write « sauver »: the same word, which
    # finds the hole (a ranked group holds every form) — it played easy.
    _measured(monkeypatch, says={"chat": 0.3, "jardin": 0.1}, instead={"chat": "chats"})
    _against(monkeypatch, _two())
    checked, _line, _log = _choose()
    assert "this same word in another form" in checked.context["chat"]
    assert "a word players don't say" not in checked.context["chat"] and checked.tags["chat"] == []
    assert "a word players don't say" in checked.context["jardin"]


def test_a_rare_name_players_say_in_a_crowd_is_not_buried(monkeypatch):
    # « saint-bernard », said at 0.58 among commoner near-words
    _measured(monkeypatch, says={"jardin": 0.58})
    _against(monkeypatch, _two())
    checked, _line, _log = _choose(sims=curate.Vectors(crowd=lambda t: 0.83 if t.text == "jardin" else None))
    assert [t.text for t in checked.trio] == ["pierre", "chat", "jardin"]


@pytest.mark.parametrize("called, refused", [("jardins", True), ("jardinier", False)])
def test_a_word_the_neighbours_call_for_is_the_hidden_word_only_in_its_group(monkeypatch, called, refused):
    # « que devant une ___ de dix convives » calls for « table »: another word than
    # « tablée » (another group on its map), though one spelling is the other plus letters.
    _measured(monkeypatch, first=lambda f: called if f.endswith("___") else "autre")
    offered = _against(monkeypatch, _two(), _two("chat", "dort"), _two("chat", "dort"))
    _choose(sims=curate.Vectors(own=lambda t: frozenset({"jardin", "jardins"}) if t.text == "jardin" else None))
    assert (len(offered) > 1 and offered[1]["refused"][0].startswith("« jardin »")) == refused


def test_the_start_choice_offers_every_hole_the_same_band(tmp_path, monkeypatch):
    path = _three_hole_draft(tmp_path)
    puzzle = json.loads(path.read_text(encoding="utf-8"))
    for secret, (near, usual) in {"chat": ("souris", "lapin"), "chien": ("renard", "loup")}.items():
        puzzle["ranks"][secret] = {near: {"word": near, "rank": 70}, usual: {"word": usual, "rank": 120}}
    path.write_text(json.dumps(puzzle), encoding="utf-8")
    shown = []

    def pick(_claude, _marked, info, _kind, lang):
        shown.extend(info)
        return {"starts": {"chat": "lapin", "chien": "loup", "pierre": "brique"}, "unsaveable": None, "why": ""}

    monkeypatch.setattr(curate.llm, "pick_starts", pick)
    _starts(path)
    assert [[o["word"] for o in h["options"]] for h in shown] == [["lapin"], ["loup"], ["brique"]]


def test_an_unusable_page_cut_falls_back_to_three_sentences_a_side(monkeypatch):
    monkeypatch.setattr(curate.llm, "choose_excerpt", lambda *_a, **_k: None)
    window = {"before": ["B5.", "B4.", "B3.", "B2.", "B1."], "after": ["A1.", "A2.", "A3.", "A4.", "A5."]}
    assert curate.EXCERPT_SENTENCES == 3
    assert curate.choose_page(object(), Log(), "La ligne.", window, "fr") == {
        "before": ["B3.", "B2.", "B1."], "after": ["A1.", "A2.", "A3."]}


# --- the work is picked by rule, not by the model (user-decided 2026-09-20) --------------
from datetime import date, timedelta


def _work(file, kind="book", author="A"):
    return {"file": file, "kind": kind, "author": author, "title": file}


def test_pick_work_prefers_never_used_authors_then_the_longest_left():
    archive = {"last_used": {"a": date(2026, 9, 1), "b": date(2026, 9, 10)}, "last_music": date(2026, 9, 19)}
    index = {"books": {}}
    fresh = [_work("b.epub", author="B"), _work("a.epub", author="A"), _work("c.epub", author="C")]
    work, why = curate.pick_work(fresh, archive, index, date(2026, 9, 20))
    assert work["file"] == "c.epub" and "never used" in why
    fresh = fresh[:2]
    work, why = curate.pick_work(fresh, archive, index, date(2026, 9, 20))
    assert work["file"] == "a.epub" and "2026-09-01" in why


def test_pick_work_takes_a_song_when_no_music_day_is_recent():
    archive = {"last_used": {}, "last_music": date(2026, 9, 10)}
    fresh = [_work("book.epub"), _work("song.txt", kind="music", author="S")]
    work, why = curate.pick_work(fresh, archive, {"books": {}}, date(2026, 9, 20))
    assert work["kind"] == "music" and "music day" in why
    archive["last_music"] = date(2026, 9, 19)
    work, _why = curate.pick_work(fresh, archive, {"books": {}}, date(2026, 9, 20))
    assert work["kind"] == "book"


def test_pick_work_counts_a_run_that_proposed_the_author_as_seen():
    archive = {"last_used": {}, "last_music": date(2026, 9, 19)}
    index = {"books": {"a.epub": {"author": "A", "read": "2026-09-15T10:00:00"}}}
    fresh = [_work("a2.epub", author="A"), _work("b.epub", author="B")]
    work, _ = curate.pick_work(fresh, archive, index, date(2026, 9, 20))
    assert work["file"] == "b.epub"


def test_a_song_is_due_on_the_fourth_day_after_the_last_music_day():
    today = date(2026, 9, 20)
    fresh = [_work("book.epub"), _work("song.txt", kind="music", author="S")]

    def kind(last_music):
        return curate.pick_work(fresh, {"last_used": {}, "last_music": last_music}, {"books": {}}, today)[0]["kind"]

    assert curate.MUSIC_EVERY_DAYS == 4
    assert kind(today - timedelta(days=3)) == "book"
    assert kind(today - timedelta(days=4)) == "music"
    assert kind(None) == "music"                       # no music day yet


def test_the_artist_cooldown_reads_the_ledger_and_the_index_for_music_only():
    today = date(2026, 9, 30)
    song, book = _work("s.txt", kind="music", author="Népal"), _work("b.epub", author="Népal")
    nobody, nothing = {"last_used": {}}, {"books": {}}

    def used(days):       # the ledger's game day
        return {"last_used": {"nepal": today - timedelta(days=days)}}

    def proposed(days):   # a run's index entry
        return {"books": {"x.txt": {"author": "Népal", "read": f"{today - timedelta(days=days)}T10:00:00+00:00"}}}

    assert curate.in_cooldown(song, used(29), nothing, today)
    assert not curate.in_cooldown(song, used(30), nothing, today)
    assert curate.in_cooldown(song, nobody, proposed(29), today)
    assert not curate.in_cooldown(song, nobody, proposed(30), today)
    assert not curate.in_cooldown(book, used(1), proposed(1), today)    # books: never the same book, no clock


def test_choose_work_offers_only_what_is_neither_published_nor_mined_nor_cooling(monkeypatch):
    today = date(2026, 9, 30)
    works = [{"file": "hugo.epub", "kind": "book", "author": "Victor Hugo", "title": "Les Misérables"},
             {"file": "zola.epub", "kind": "book", "author": "Émile Zola", "title": "Germinal"},
             {"file": "nepal__trajectoire.txt", "kind": "music", "author": "Népal", "title": "Trajectoire"},
             {"file": "bove.epub", "kind": "book", "author": "Emmanuel Bove", "title": "Mes amis"}]
    archive = {"works": [{"author": "Victor Hugo", "work": "Les Misérables"}],       # published
               "last_used": {"nepal": today - timedelta(days=5)}, "last_music": today - timedelta(days=5)}
    index = {"books": {"zola.epub": {"read": "2026-08-01T10:00:00+00:00", "sentences": []}}}   # mined by a run
    offered = []
    monkeypatch.setattr(curate.shelf_mod, "list_works", lambda _shelf: works)
    monkeypatch.setattr(curate, "pick_work", lambda fresh, *_a: offered.extend(fresh) or (fresh[0], "why"))
    log = Log()
    work = curate.choose_work(log, SimpleNamespace(lang="fr", work=None), archive, index, today)
    assert [w["file"] for w in offered] == ["bove.epub"] and work["file"] == "bove.epub"
    assert any("artist cooldown (30 days) skips: Népal" in line for line in log)


# --- the giveaway judge, a note (calibrated on real play, 2026-09-22) --------------------
class _Tok:
    def __init__(self, i, text):
        self.i, self.text, self.slug = i, text, text.lower()


def test_giveaway_scores_judge_each_word_once_with_every_occurrence_blanked():
    toks = [_Tok(0, "le"), _Tok(1, "silence"), _Tok(2, "se"), _Tok(3, "faisait"), _Tok(4, "silence")]
    words = [toks[1], toks[3], toks[4]]
    occ = {"silence": {1, 4}, "faisait": {3}}
    asked = []

    class J:
        usage = {"input_tokens": 0, "output_tokens": 0}

        def noul(self, state, questions):
            asked.append(state)
            p = 0.8 if state["mot"] == "silence" else 0.2
            return {k: p for k in questions}
    scores = curate.giveaway_scores(toks, words, occ, "fr", judge=J())
    assert scores == pytest.approx({"silence": 0.8, "faisait": 0.2})  # a note: nothing is struck
    assert len(asked) == 2                                   # one judgement per distinct word
    assert asked[0]["phrase_a_trou"].count("____") == 2      # every occurrence blanked


# --- #317: the day's language reaches the judge and every question ----------------------

def test_the_judge_is_asked_in_the_line_s_language(monkeypatch):
    seen = []

    def score(judge, sentences, *, lang):
        seen.append(lang)
        return [{"autonome": 0.9, "image": 0.9, "celebre": 0.0} for _ in sentences]

    monkeypatch.setattr(jev, "score_sentences", score)
    assert curate.judge_sentences(Log(), ["A line.", "Another."], "en", judge=FakeJudge({})) == ["A line.", "Another."]
    assert seen == ["en"]


def test_the_giveaway_judge_reads_an_english_line_as_written(monkeypatch):
    from rules import Token
    seen = []

    def giveaway(judge, blanked, word, *, lang):
        seen.append((blanked, word, lang))
        return 0.1

    monkeypatch.setattr(jev, "giveaway", giveaway)
    toks = [Token(0, "The", "the", "DET", "the", True), Token(1, "dog", "dog", "NOUN", "dog", False, ""),
            Token(2, "'s", "'s", "PART", "s", True), Token(3, "bone", "bone", "NOUN", "bone", False, ""),
            Token(4, ".", ".", "PUNCT", "", False, "")]
    curate.giveaway_scores(toks, [toks[1]], {"dog": {1}}, "en", judge=FakeJudge({}))
    assert seen == [("the _____'s bone.", "dog", "en")]


def _english_tokens(*_a):
    words = [("I", "i", "PRON", True), ("think", "think", "VERB", False), ("the", "the", "DET", True),
             ("old", "old", "ADJ", False), ("cat", "cat", "NOUN", False), ("sleeps", "sleep", "VERB", False),
             ("on", "on", "ADP", True), ("cold", "cold", "ADJ", False), ("stone", "stone", "NOUN", False)]
    return [Token(i, w, lemma, pos, w.lower(), stop) for i, (w, lemma, pos, stop) in enumerate(words)]


def test_an_english_day_is_chosen_in_english_from_english_facts(monkeypatch):
    monkeypatch.setattr(curate, "parse", _english_tokens)
    seen = []
    monkeypatch.setattr(curate.llm, "choose_companions",
                        lambda _c, _m, _r, _n, pool, _refused, lang: seen.append((lang, [p["word"] for p in pool])))
    _giveaways(monkeypatch)
    _measured(monkeypatch)
    _read(monkeypatch, _a_read("stone", ["cold"]))
    curate.day(object(), Log(), [{"sentence": "I think the old cat sleeps on cold stone."}], {"kind": "book"},
               {"secrets": set(), "pairs": {}}, "", lambda w: True, "en", judge=object(), sims=curate.Vectors())
    assert seen[0] == ("en", ["old", "cat", "sleeps", "cold"])   # « think » is an English weak verb


def test_the_form_question_for_an_english_secret_is_asked_in_english(monkeypatch):
    # gen_phrase's #133 error keeps its French format for English; English cells parse the same.
    error = ("Erreur : la forme de « leaves » doit être explicite hors mode interactif (#133 : jamais "
             "déduite, même sans ambiguïté).\n"
             "         Analyses connues :\n"
             "           1) n:p  — nom, pluriel (leaf, leaves)\n"
             "           2) ind:pre:3s  — indicatif présent, 3e personne du singulier (leave, leaves)\n"
             "         Passe --form leaves=TRAIT (ou leaves=LEXÈME/TRAIT pour un trait partagé) — ex. "
             "--form leaves=n:p — ou --no-inflect pour désactiver l'accord.")
    runs = []

    def run(sentence, words, source, forms, lang, starts=None, other_sense=None):
        runs.append(dict(forms))
        return SimpleNamespace(returncode=1, stdout="", stderr=error if len(runs) == 1 else "boom"), []

    asked = []
    monkeypatch.setattr(curate, "run_gen_phrase", run)
    monkeypatch.setattr(curate.llm, "pick_form", lambda _c, sentence, word, choices, lang: asked.append((word, choices, lang)) or 2)
    _gen(Log(), ("leaves", "dawn", "she"), sentence="She leaves at dawn.", lang="en")
    assert asked == [("leaves", ["n:p — nom, pluriel (leaf, leaves)",
                                 "ind:pre:3s — indicatif présent, 3e personne du singulier (leave, leaves)"], "en")]
    assert runs[1] == {"leaves": "ind:pre:3s"}


def _no_analysis_error(word):
    # gen_phrase's #133 error for a word the forms table has no analysis for
    return (f"Erreur : la forme de « {word} » doit être explicite hors mode interactif (#133 : jamais "
            "déduite, même sans ambiguïté).\n"
            "         Aucune analyse connue dans la table.\n"
            f"         Passe --form {word}=TRAIT (ou {word}=LEXÈME/TRAIT pour un trait partagé) — ex. "
            f"--form {word}=cit — ou --no-inflect pour désactiver l'accord.")


def test_a_word_with_no_analysis_takes_the_citation_form_without_a_question(monkeypatch):
    # an -ly adverb, « famous »: nothing inflects, so no agreement — a fact, not a choice
    runs = []

    def run(sentence, words, source, forms, lang, starts=None, other_sense=None):
        runs.append(dict(forms))
        stderr = _no_analysis_error("famous") if len(runs) == 1 else "boom"
        return SimpleNamespace(returncode=1, stdout="", stderr=stderr), []

    monkeypatch.setattr(curate, "run_gen_phrase", run)
    monkeypatch.setattr(curate.llm, "pick_form", lambda *a, **k: pytest.fail("no analysis, no question"))
    log = Log()
    _gen(log, ("famous", "man", "slept"), sentence="A famous man slept.", lang="en")
    assert runs[1] == {"famous": curate.CITATION_FEATURE} == {"famous": "cit"}
    assert any("form of « famous »: cit" in line for line in log)


def test_a_citation_form_refused_again_gives_the_line_up(monkeypatch):
    runs = []
    monkeypatch.setattr(curate, "run_gen_phrase", lambda *a, **k: (
        runs.append(1), (SimpleNamespace(returncode=1, stdout="", stderr=_no_analysis_error("famous")), []))[1])
    log = Log()
    assert _gen(log, ("famous", "man", "slept"), sentence="A famous man slept.", lang="en") is None
    assert len(runs) == 2 and any("even as cit" in line for line in log)


# --- what the run cannot do without is checked before `--retry` erases anything ----------

def _attempt(tmp_path, monkeypatch):
    """A shelf holding one song, the index entry of the run that mined it and the candidate
    puzzle that run wrote — what `--retry` erases. Returns (index file, puzzle file)."""
    monkeypatch.setattr(_paths, "SHELF_ROOT", tmp_path / "shelf")
    monkeypatch.setattr(_paths, "GENERATION_OUTPUT_DIR", tmp_path / "output")
    monkeypatch.setattr(_paths, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(_paths, "VOCAB_DIR", tmp_path)
    (tmp_path / "fr.json").write_text("[]", encoding="utf-8")
    shelf = _paths.shelf_dir("fr")
    shelf.mkdir(parents=True)
    (shelf / "nepal__trajectoire.txt").write_text("artist: Népal\ntitle: Trajectoire\n---\nUne ligne.\n", encoding="utf-8")
    index = shelf / "index.json"
    index.write_text(json.dumps({"books": {"nepal__trajectoire.txt": {
        "read": "2026-09-01T10:00:00+00:00", "sentences": ["une ligne."], "author": "Népal"}}}), encoding="utf-8")
    draft = tmp_path / "output" / "fr" / "music" / "a_b_c.json"
    draft.parent.mkdir(parents=True)
    draft.write_text(json.dumps({"lang": "fr", "words": ["une", "ligne."], "holes": [],
                                 "source": {"kind": "music", "author": "Népal", "work": "Trajectoire"}}), encoding="utf-8")
    return index, draft


@pytest.mark.parametrize("retry", ["work", "sentence"])
@pytest.mark.parametrize("missing", ["ledger", "key"])
def test_a_retry_that_cannot_run_erases_nothing_and_asks_no_model(tmp_path, monkeypatch, capsys, missing, retry):
    index, draft = _attempt(tmp_path, monkeypatch)
    ledger = tmp_path / "published.jsonl"
    monkeypatch.setattr(_paths, "PUBLISHED_LEDGER", ledger)
    if missing == "key":
        ledger.write_text("", encoding="utf-8")
        monkeypatch.delenv("JEV_API_KEY", raising=False)
    else:
        monkeypatch.setenv("JEV_API_KEY", "k")
    monkeypatch.setattr(curate.llm, "validate", lambda: "max")
    monkeypatch.setattr(curate.llm, "Claude", lambda: pytest.fail("no model call in a run that cannot start"))
    monkeypatch.setattr(curate.sys, "argv",
                        ["curate", "--retry", str(draft) if retry == "sentence" else "nepal__trajectoire.txt"])
    before = index.read_text(encoding="utf-8")
    with pytest.raises(SystemExit) as stop:
        curate.main()
    assert stop.value.code == 1
    assert ("no publish ledger" if missing == "ledger" else "JEV_API_KEY") in capsys.readouterr().err
    assert draft.exists() and index.read_text(encoding="utf-8") == before


@pytest.mark.parametrize("mode", [["--finish", "abcd1234"], ["--rebank"]])
def test_finishing_or_rebanking_needs_no_jev_key(tmp_path, monkeypatch, mode):
    # neither asks Jev: the giveaways are stored with each line, and no map is ranked
    _attempt(tmp_path, monkeypatch)
    ledger = tmp_path / "published.jsonl"
    ledger.write_text("", encoding="utf-8")
    monkeypatch.setattr(_paths, "PUBLISHED_LEDGER", ledger)
    monkeypatch.delenv("JEV_API_KEY", raising=False)
    monkeypatch.setattr(curate.jev, "JevJudge", lambda *_a, **_k: pytest.fail("no judge"))
    monkeypatch.setattr(curate.llm, "validate", lambda: "max")
    monkeypatch.setattr(curate.llm, "Claude", lambda: SimpleNamespace(calls=0))
    monkeypatch.setattr(curate, "load_similarity", lambda lang: curate.Vectors())
    reached = []
    monkeypatch.setattr(curate, "finish_line", lambda *_a, **_k: reached.append("finish"))
    monkeypatch.setattr(curate, "rebank_works", lambda *_a, **_k: reached.append("rebank") or 2)
    monkeypatch.setattr(curate.sys, "argv", ["curate", *mode])
    with pytest.raises(SystemExit) as stop:
        curate.main()
    assert stop.value.code == 2 and reached == [mode[0].lstrip("-")]


def test_finish_builds_the_banked_line_with_its_starts_and_its_other_sense(monkeypatch):
    entry = {"id": "abcd1234", "work": "w.epub", "starts": {"pierre": "galet"}}
    book = {"file": "w.epub", "kind": "book", "author": "A", "title": "T"}
    line, checked = _day_of()
    monkeypatch.setattr(curate.bank, "load", lambda lang: [entry])
    monkeypatch.setattr(curate.shelf_mod, "list_works", lambda _shelf: [book])
    monkeypatch.setattr(curate.bank, "restore", lambda e, *_a: ((line, checked), None))
    monkeypatch.setattr(curate, "read_work", lambda *_a: "")
    built = []
    monkeypatch.setattr(curate, "build_day", lambda _c, _l, line, _ch, *_a, **k: built.append(
        (line["senses"], k["prior"])) or None)
    log = curate.Log("finish")
    curate.finish_line(object(), log, SimpleNamespace(lang="fr", finish="abcd1234"),
                       {"works": [], "last_used": {}, "secrets": set(), "pairs": {}}, date(2026, 10, 21),
                       {"books": {}}, lambda w: True, curate.Vectors())
    assert built == [(line["senses"], {"pierre": "galet"})]


# --- `--blind`: the chosen day is withheld from the log and stdout ---------------------------

def _attempted(tmp_path, monkeypatch, *, blind, success):
    """A run's log around one attempt; returns (the log, the main file's text)."""
    monkeypatch.setattr(_paths, "RUNS_DIR", tmp_path)
    log = curate.Log("stamp", blind=blind)
    log("- work: Népal — Trajectoire")
    log.begin_attempt()
    log("## « le chat dort »")
    log("- chosen: chat · dort")
    log.end_attempt(success, ["- player view: « le lapin rêve »", "- written: `out/lapin_reve.json`"])
    log("## After")
    return log, log.path.read_text(encoding="utf-8")


def test_a_blind_run_withholds_the_chosen_day_from_the_log_and_stdout(tmp_path, monkeypatch, capsys):
    log, main = _attempted(tmp_path, monkeypatch, blind=True, success=True)
    out = capsys.readouterr().out
    assert log.spoilers.read_text(encoding="utf-8") == "## « le chat dort »\n- chosen: chat · dort\n"
    assert "chat" not in main and "chat" not in out
    assert main.startswith("# Curation run stamp (blind)\n")
    for shown in ("- work: Népal — Trajectoire", "(details withheld)", "- player view: « le lapin rêve »",
                  "- written: `out/lapin_reve.json`", f"- full detail (SPOILERS): `{log.spoilers}`", "## After"):
        assert shown in main and shown in out


def test_a_blind_run_with_no_day_is_logged_in_full(tmp_path, monkeypatch, capsys):
    # a rejected sentence is not the puzzle: nothing to spoil
    log, main = _attempted(tmp_path, monkeypatch, blind=True, success=False)
    assert "## « le chat dort »\n- chosen: chat · dort\n## After\n" in main
    assert "- chosen: chat · dort" in capsys.readouterr().out
    assert "player view" not in main and not log.spoilers.exists()


def test_a_run_that_is_not_blind_holds_nothing_back(tmp_path, monkeypatch, capsys):
    log, main = _attempted(tmp_path, monkeypatch, blind=False, success=True)
    assert main == ("# Curation run stamp\n\n- work: Népal — Trajectoire\n## « le chat dort »\n"
                    "- chosen: chat · dort\n## After\n")
    assert "- chosen: chat · dort" in capsys.readouterr().out
    assert not log.spoilers.exists()


# --- on the written map: a fact found there stops the line, nothing is swapped -------------

def test_the_start_step_finds_the_line_unbuildable_when_its_map_hands_two_words_over(tmp_path, monkeypatch):
    # « pou » at rank 1 for « morpion » (2026-10-12): the reader's word at the top of the map
    path = _three_hole_draft(tmp_path)
    puzzle = json.loads(path.read_text(encoding="utf-8"))
    puzzle["ranks"]["chien"]["toutou"] = {"word": "toutou", "rank": 2}
    path.write_text(json.dumps(puzzle), encoding="utf-8")
    monkeypatch.setattr(curate.llm, "pick_starts", lambda *_a, **_k: pytest.fail("no start can make this day"))
    with pytest.raises(curate.Unbuildable) as raised:
        _starts(path, _day_of(("pierre", "chat", "chien"), expected={"chat": "chat", "chien": "toutou"}))
    assert raised.value.word is None
    assert raised.value.why == "the line hands over 2 of its words (chat, chien): at most one"


def test_the_main_word_handed_on_its_written_map_makes_the_line_unbuildable(tmp_path, monkeypatch):
    path = _three_hole_draft(tmp_path)
    puzzle = json.loads(path.read_text(encoding="utf-8"))
    puzzle["ranks"]["chat"]["minou"] = {"word": "minou", "rank": 1}
    path.write_text(json.dumps(puzzle), encoding="utf-8")
    monkeypatch.setattr(curate.llm, "pick_starts", lambda *_a, **_k: pytest.fail("no start can make this day"))
    with pytest.raises(curate.Unbuildable) as raised:
        _starts(path, _day_of(expected={"chat": "minou"}))
    assert raised.value.why == ("the main word « chat »: the word most readers write sits at rank 1 on its map: "
                                "found in a guess or two")


def test_one_word_handed_over_on_the_map_goes_on_to_the_starts(tmp_path, monkeypatch):
    path = _three_hole_draft(tmp_path)
    shown = []
    monkeypatch.setattr(curate.llm, "pick_starts", _two_of_three(shown))
    monkeypatch.setattr(curate.llm, "pick_start", lambda *_a, **_k: "brique")
    # « brique » sits at 120: past HANDED_RANK, so only « chat » is handed over
    picked = _starts(path, _day_of(("chien", "chat", "pierre"), expected={"chat": "chat", "pierre": "brique"}))
    assert picked == {"chat": "lapin", "chien": "loup", "pierre": "brique"}


# --- each word's other sense, taken off its map (user-decided 2026-10-21) -------------------
# "The main goal is actually to eliminate irrelevant meanings of a word": the model names the
# nearest words of another sense, they leave the word's map, and that map is the one checked,
# given its starts and written.

_PLAIN = {"pierre": {"word": "pierre", "rank": 0},
          **{f"w{i}": {"word": f"w{i}", "rank": i} for i in range(1, 1001)},
          "w1s": {"word": "w1", "rank": 1}}              # a second key of the first group: shown once


class _Senses:
    """A fake Claude answering the other-sense question (`llm.other_sense`, the real one): the
    n-th round names `named[n]` and says `carried[n]` (one bool: every round says it); the first
    answers `other`; the first `bad` answers are unusable. Keeps the words each round was
    shown."""

    def __init__(self, named=(), *, other=True, carried=True, bad=0):
        self.named, self.other, self.bad = list(named), other, bad
        self.carried = carried if isinstance(carried, list) else None
        self.always = carried
        self.shown = []

    def json(self, prompt):
        if self.bad:
            self.bad -= 1
            return {"words": "unreadable"}
        listed = prompt.split("Nearest words", 1)[1].split(": ", 1)[1].split("\n", 1)[0].split(", ")
        n = len(self.shown)
        self.shown.append(listed)
        words = self.named[n] if n < len(self.named) else []
        carried = self.always if self.carried is None else self.carried[n]
        why = "the map is all rocks" if carried else f"round {n + 1}: no rock word left"
        if n:
            return {"words": words, "carried": carried, "why": why}
        return {"senses": ["a stone", "a name"], "used": "a stone", "other": self.other, "words": words,
                "carried": carried, "why": why}


def _sense(monkeypatch, claude, line=None, plain=_PLAIN):
    """`curate.sense` of « pierre » on the garden line, on `plain` as its plain map. Returns
    (the verdict, the line, the log)."""
    monkeypatch.setattr(curate.llm, "other_sense", _OTHER_SENSE)
    line = line or _garden()
    log = Log()
    t = next(t for t in line["allowed"] if t.slug == "pierre")
    sims = curate.Vectors(static_map=lambda t, off=frozenset(): plain)
    return curate.sense(claude, log, line, t, sims, "fr"), line, log


def test_the_first_round_shows_the_plain_map_s_nearest_words_each_group_once_and_a_no_ends_it(monkeypatch):
    claude = _Senses([[]], other=False)
    verdict, line, log = _sense(monkeypatch, claude)
    assert curate.SENSE_TOP == 300 and len(claude.shown) == 1
    assert claude.shown[0] == [f"w{i}" for i in range(1, 301)]          # rank order, no secret, « w1 » once
    assert verdict == {"used": "a stone", "carried": True, "why": "the map is all rocks", "off": []}
    assert line["senses"]["pierre"] is verdict
    assert log == ["- other sense of « pierre »: the line uses it as a stone; no word of another sense set aside"]


def test_a_round_naming_few_words_ends_the_question(monkeypatch):
    claude = _Senses([["w3", "w9"]])
    verdict, _line, log = _sense(monkeypatch, claude)
    assert len(claude.shown) == 1 and verdict["off"] == ["w3", "w9"]
    assert "2 word(s) of another sense set aside (w3, w9)" in log[0]


def test_a_round_naming_sense_dig_words_digs_one_window_deeper_up_to_sense_rounds(monkeypatch):
    assert (curate.SENSE_DIG, curate.SENSE_ROUNDS) == (30, 4)
    rounds = [[f"w{i}" for i in range(1 + 30 * n, 31 + 30 * n)] for n in range(5)]   # 30 a round, the first ones
    claude = _Senses(rounds)
    verdict, _line, log = _sense(monkeypatch, claude)
    assert len(claude.shown) == 4                                      # never a fifth round
    assert claude.shown[1][:2] == ["w31", "w32"] and len(claude.shown[1]) == 300   # the words named taken off
    assert verdict["off"] == [f"w{i}" for i in range(1, 121)]
    assert "120 word(s) of another sense set aside (w1, w2, w3, w4, w5, …)" in log[0]
    # one word short of the bar: no deeper round
    claude = _Senses([rounds[0][:29]])
    assert _sense(monkeypatch, claude)[0]["off"] == rounds[0][:29] and len(claude.shown) == 1


def test_the_first_round_that_finds_the_line_s_sense_barely_on_the_map_ends_it_not_carried(monkeypatch):
    # « partir » for dying: the later rounds, shown a list already cleared, passed it "though
    # mourir and décéder are absent" — the first no stands, and nothing is asked after it.
    rounds = [[f"w{i}" for i in range(1 + 30 * n, 31 + 30 * n)] for n in range(4)]
    claude = _Senses(rounds, carried=[True, False, True, True])
    verdict, _line, log = _sense(monkeypatch, claude)
    assert len(claude.shown) == 2
    assert verdict == {"used": "a stone", "carried": False, "why": "round 2: no rock word left",
                       "off": [f"w{i}" for i in range(1, 61)]}
    assert log[0].endswith(" — its map barely carries that sense")
    claude = _Senses(rounds, carried=[False, True, True, True])
    assert _sense(monkeypatch, claude)[0]["carried"] is False and len(claude.shown) == 1


def test_words_the_round_did_not_show_are_never_set_aside(monkeypatch):
    claude = _Senses([["w1", "caillou", "w400", "W2", "w1"]])
    verdict, _line, _log = _sense(monkeypatch, claude)
    assert verdict["off"] == ["w1", "w2"]


def test_a_word_s_other_sense_is_asked_once_per_line(monkeypatch):
    claude = _Senses([["w3"]])
    verdict, line, _log = _sense(monkeypatch, claude)
    again, _line, log = _sense(monkeypatch, claude, line)
    assert again is verdict and len(claude.shown) == 1 and log == []


def test_an_unusable_answer_is_asked_once_more_then_no_verdict(monkeypatch):
    claude = _Senses([["w3"]], bad=1)
    assert _sense(monkeypatch, claude)[0]["off"] == ["w3"]
    claude = _Senses([["w3"]], bad=2)
    verdict, line, log = _sense(monkeypatch, claude)
    assert verdict is None and "pierre" not in line["senses"] and claude.shown == []
    assert log == ["- other sense of « pierre »: no usable answer, asked twice"]


def test_a_word_with_no_plain_map_is_not_asked(monkeypatch):
    claude = _Senses()
    verdict, line, _log = _sense(monkeypatch, claude, plain=None)
    assert verdict["off"] == [] and verdict["carried"] and claude.shown == [] and line["senses"] == {}


def _off_maps(seen, plain):
    """Vectors whose static map is `plain` with the keys of the words `off` taken off, each call
    kept in `seen` as (word, off)."""
    def static_map(t, off=frozenset()):
        seen.append((t.text, frozenset(off)))
        return {k: e for k, e in plain.items() if e["word"] not in off}
    return curate.Vectors(static_map=static_map)


def _answers(monkeypatch, **by_word):
    """The other-sense question answered per hidden word: {word: (words named, carried)}; any
    other word has no other sense."""
    asked = []

    def answer(_c, _s, word, _words, lang, off=()):
        asked.append(word)
        named, carried = by_word.get(word, ([], True))
        return {"used": f"{word}, as the line has it", "other": bool(named), "words": named, "carried": carried,
                "why": "too far from its map"}
    monkeypatch.setattr(curate.llm, "other_sense", answer)
    return asked


def test_a_main_word_whose_map_barely_carries_its_sense_in_the_line_sets_the_line_aside(monkeypatch):
    # « partir » for dying on a map of leaving: no start leads a player there
    _measured(monkeypatch)
    _answers(monkeypatch, pierre=([], False))
    monkeypatch.setattr(curate.llm, "choose_companions", lambda *_a, **_k: pytest.fail("the line is set aside"))
    checked, line, log = _choose(sims=_off_maps([], _PLAIN))
    assert checked is None and line["dropped"] == ("the main word « pierre »: the line uses it as pierre, as the line "
                                                   "has it, a sense its map barely carries — too far from its map")


def test_a_main_word_with_no_other_sense_verdict_is_never_hidden_unchecked(monkeypatch):
    _measured(monkeypatch)
    monkeypatch.setattr(curate.llm, "other_sense", lambda *_a, **_k: None)
    monkeypatch.setattr(curate.llm, "choose_companions", lambda *_a, **_k: pytest.fail("the line is set aside"))
    checked, line, _log = _choose(sims=_off_maps([], _PLAIN))
    assert checked is None and line["dropped"] == ("the main word « pierre »: no verdict on the sense the line uses "
                                                   "it in (no usable answer, asked twice)")


def test_the_main_word_s_facts_are_read_on_its_map_without_its_other_sense(monkeypatch):
    # the reader's « caillou » at rank 2 hands « pierre » over on the plain map; named as
    # another sense, it leaves the map, and the main word passes
    plain = {"pierre": {"word": "pierre", "rank": 0}, "roc": {"word": "roc", "rank": 1},
             "caillou": {"word": "caillou", "rank": 2}, "galet": {"word": "galet", "rank": 3}}
    _measured(monkeypatch, expected={"pierre": "caillou"})
    _against(monkeypatch, _two())
    seen = []
    _answers(monkeypatch, pierre=(["caillou"], True))
    checked, line, _log = _choose(sims=_off_maps(seen, plain))
    assert [t.text for t in checked.trio] == ["pierre", "chat", "jardin"]
    assert ("pierre", frozenset({"caillou"})) in seen
    assert line["senses"]["pierre"]["off"] == ["caillou"]


def test_on_its_plain_map_the_same_main_word_is_handed_over(monkeypatch):
    plain = {"pierre": {"word": "pierre", "rank": 0}, "caillou": {"word": "caillou", "rank": 2}}
    _measured(monkeypatch, expected={"pierre": "caillou"})
    _answers(monkeypatch)
    checked, line, _log = _choose(sims=_off_maps([], plain))
    assert checked is None and "the word most readers write sits at rank 2 on its map" in line["dropped"]


def test_a_word_chosen_against_the_main_word_whose_map_barely_carries_its_sense_is_refused(monkeypatch):
    _measured(monkeypatch)
    offered = _against(monkeypatch, _two(), _two("dort", "jardin"))
    asked = _answers(monkeypatch, chat=([], False))
    checked, line, log = _choose(sims=_off_maps([], _PLAIN))
    assert [t.text for t in checked.trio] == ["pierre", "dort", "jardin"] and line["asks"] == 2
    assert offered[1]["refused"] == ["« chat »: the line uses it as chat, as the line has it, a sense its map barely "
                                     "carries — too far from its map"]
    assert "chat" not in offered[1]["pool"]
    assert asked == ["pierre", "chat", "jardin", "dort"]                 # each word asked once
    assert set(line["senses"]) == {"pierre", "chat", "jardin", "dort"}


def test_the_trio_s_facts_and_its_check_before_writing_read_each_word_s_line_map(monkeypatch):
    _measured(monkeypatch)
    _against(monkeypatch, _two())
    _answers(monkeypatch, jardin=(["w7"], True))
    seen = []
    sims = _off_maps(seen, _PLAIN)
    checked, line, _log = _choose(sims=sims)
    assert ("jardin", frozenset({"w7"})) in seen and ("chat", frozenset()) in seen
    seen.clear()
    curate.check_words(object(), Log(), line, checked, sims, {}, "fr")
    assert sorted(seen) == [("chat", frozenset()), ("jardin", frozenset({"w7"})), ("pierre", frozenset())]
    # a word offered, never chosen, is read on its plain map
    assert curate.line_map(line, next(t for t in line["allowed"] if t.slug == "dort"), sims) == _PLAIN


def test_the_start_step_s_draft_holds_each_word_s_line_map(monkeypatch):
    import sys
    fake = SimpleNamespace(CONFIG={"fr": {}}, display_tokens=str.split,
                           locate_core=lambda token, s, cfg: (token, "", "") if token == s else None,
                           _make_hole=lambda core, prefix, suffix, pos, start, rank: {
                               "pos": pos, "secret": {"word": core, "slug": core}})
    monkeypatch.setitem(sys.modules, "gen_phrase", fake)
    line = _garden()
    line["sentence"] = "le chat dort sur la pierre froide du jardin"
    line["senses"] = {"pierre": {"used": "a stone", "carried": True, "why": "", "off": ["w1", "w2"]}}
    pierre = next(t for t in line["allowed"] if t.slug == "pierre")
    draft = curate.static_draft(line, [pierre], _off_maps([], _PLAIN), "fr")
    assert draft["holes"] == [{"pos": 5, "secret": {"word": "pierre", "slug": "pierre"}}]
    assert "w1" not in draft["ranks"]["pierre"] and "w1s" not in draft["ranks"]["pierre"]
    assert draft["ranks"]["pierre"]["w3"] == {"word": "w3", "rank": 3}

