"""The curator's flow (2026-09-24): the judge's loose filter keeps reading order and the
model reads every line left; the day is chosen by comparison, and a refused choice is
told back; the start-word step may swap a word; the giveaway judge is a note."""

import json
from types import SimpleNamespace

import pytest

import _paths  # puts generation/scripts on sys.path (contextual_rank)
import contextual_rank
import curate


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
    def __call__(self, line):
        self.append(line)


@pytest.fixture(autouse=True)
def _no_unsaid_swap(monkeypatch):
    """The swap before the ranking answers nothing usable unless a test says otherwise."""
    monkeypatch.setattr(curate.llm, "drop_unsaid", lambda *_a, **_k: None)
    monkeypatch.setattr(curate.llm, "drop_handed", lambda *_a, **_k: None)
    monkeypatch.setattr(curate.llm, "neighbours_complete", lambda *_a, **_k: None)


def _giveaways(monkeypatch, scores=None):
    """Every word a line can hide is judged before the choice (the floor); a word the
    test does not name gets a path (0.3)."""
    monkeypatch.setattr(contextual_rank, "giveaway", lambda _j, _shown, word, lang: (scores or {}).get(word, 0.3))


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


def test_day_choice_prompt_has_no_hard_substitutability_veto():
    class Claude:
        prompt = ""

        def json(self, prompt):
            self.prompt = prompt
            return {"words": None, "why": "none"}

    claude = Claude()
    curate.llm.choose_words(claude, {"sentence": "Le chat dort.", "allowed": ["chat", "dort", "lit"]}, [], lang="fr")
    assert "## The quotation rule" in claude.prompt
    assert "Exactly three distinct words" in claude.prompt
    assert "Every secret must pass the substitutability test" not in claude.prompt
    assert "Reject a secret when" not in claude.prompt


def test_an_empty_list_asks_the_judge_nothing():
    assert curate.judge_sentences(Log(), [], "fr", judge=None) == []


def _line_tokens(*_a):
    from rules import Token
    words = [("le", "DET", True), ("chat", "NOUN", False), ("dort", "VERB", False),
             ("sur", "ADP", True), ("la", "DET", True), ("pierre", "NOUN", False),
             ("froide", "ADJ", False)]
    lemmas = {"dort": "dormir"}
    return [Token(i, w, lemmas.get(w, w), pos, w, stop) for i, (w, pos, stop) in enumerate(words)]


def _alone(monkeypatch, ok=True):
    monkeypatch.setattr(curate.llm, "stands_alone",
                        lambda _c, s, lang: {"ok": ok, "about": "", "why": "" if ok else "leans on its page"})


def test_a_line_that_does_not_stand_alone_is_refused_before_its_words_are_chosen(monkeypatch):
    monkeypatch.setattr(curate, "parse", _line_tokens)
    monkeypatch.setattr(curate.llm, "choose_words", lambda *_a, **_k: pytest.fail("no words for a refused line"))
    monkeypatch.setattr(curate.llm, "choose_among", lambda *_a, **_k: pytest.fail("nothing to compare"))
    _giveaways(monkeypatch)
    _alone(monkeypatch, ok=False)
    monkeypatch.setattr(curate, "build_day", lambda *a, **k: pytest.fail("a refused line is never built"))
    log = Log()
    path = curate.day(object(), log, [{"sentence": "Le chat dort sur la pierre froide."}], {"kind": "book"},
                      {"secrets": set(), "pairs": {}}, "", lambda w: True, lambda t: None, lambda t, w: None, "fr", judge=object())
    assert path is None
    assert any("does not stand alone — leans on its page" in line for line in log)


def test_words_off_the_line_are_told_back(monkeypatch):
    monkeypatch.setattr(curate, "parse", _line_tokens)
    asked = []

    def choose(_c, line, refused, lang):
        asked.append(list(refused))
        return {"words": ["chat", "lune", "pierre"], "path": [], "why": "w"} if len(asked) == 1 else None

    monkeypatch.setattr(curate.llm, "choose_words", choose)
    _giveaways(monkeypatch)
    _alone(monkeypatch)
    curate.day(object(), Log(), [{"sentence": "Le chat dort sur la pierre froide."}], {"kind": "book"},
               {"secrets": set(), "pairs": {}}, "", lambda w: True, lambda t: None, lambda t, w: None, "fr", judge=object())
    assert "distinct words of the line" in asked[1][0]


def test_a_rerun_replays_the_previous_sidecar_instead_of_paying_the_judge(monkeypatch):
    seen = []
    monkeypatch.setattr(curate.subprocess, "run", lambda cmd, **_k: seen.append(cmd) or type("C", (), {"returncode": 1, "stdout": "", "stderr": ""})())
    curate.run_gen_phrase("une phrase", ["a", "b", "c"], {}, {}, "fr", {"a": "x"},
                          replay=curate._sidecar("/out/x_y_z.json"))
    assert "--contextual-replay" in seen[0]
    assert seen[0][seen[0].index("--contextual-replay") + 1] == "/out/x_y_z.contextual.json"
    curate.run_gen_phrase("une phrase", ["a", "b", "c"], {}, {}, "fr")
    assert "--contextual-replay" not in seen[1]


def test_a_swap_from_the_start_step_erases_the_draft(tmp_path, monkeypatch):
    draft = tmp_path / "x_y_z.json"
    sidecar = tmp_path / "x_y_z.contextual.json"

    def run(*_a, **_k):
        draft.write_text(json.dumps({"holes": [], "ranks": {}}), encoding="utf-8")
        sidecar.write_text("{}", encoding="utf-8")
        return SimpleNamespace(returncode=0, stderr="", stdout=f"écrite dans {draft} :"), []

    def swap(*_a, **_k):
        raise curate.Replace("ours", "loup", "no start saves it")

    monkeypatch.setattr(curate, "run_gen_phrase", run)
    monkeypatch.setattr(curate, "choose_starts", swap)
    with pytest.raises(curate.Replace) as caught:
        curate.generate(object(), Log(), "s", ["chat", "chien", "ours"], {}, "fr")
    assert (caught.value.secret, caught.value.with_) == ("ours", "loup")
    assert not draft.exists() and not sidecar.exists()


def test_an_incomplete_start_choice_erases_the_draft(tmp_path, monkeypatch):
    draft = tmp_path / "x_y_z.json"
    sidecar = tmp_path / "x_y_z.contextual.json"

    def run(*_a, **_k):
        draft.write_text("{}", encoding="utf-8")
        sidecar.write_text("{}", encoding="utf-8")
        return SimpleNamespace(returncode=0, stderr="", stdout=f"écrite dans {draft} :"), []

    monkeypatch.setattr(curate, "run_gen_phrase", run)
    monkeypatch.setattr(curate, "choose_starts", lambda *_a, **_k: None)
    monkeypatch.setattr(curate, "check_starts", lambda *_a, **_k: pytest.fail("an incomplete choice is not checked"))
    assert curate.generate(object(), Log(), "s", ["chat", "chien", "ours"], {}, "fr") is None
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
    assert curate.generate(object(), Log(), "s", ["chat", "chien", "ours"], {}, "fr") == draft
    assert seen == [draft, draft]


def test_a_written_puzzle_whose_path_cannot_be_read_is_refused(monkeypatch):
    # The file on disk carries gen_phrase's own random starts, neither chosen nor checked:
    # never a candidate day.
    monkeypatch.setattr(curate, "run_gen_phrase",
                        lambda *_a, **_k: (SimpleNamespace(returncode=0, stderr="", stdout="Phrase (fr) écrite.\n"), []))
    monkeypatch.setattr(curate, "choose_starts", lambda *_a, **_k: pytest.fail("no path, no start choice"))
    monkeypatch.setattr(curate, "check_starts", lambda *_a, **_k: pytest.fail("no path, no check"))
    log = Log()
    assert curate.generate(object(), log, "s", ["chat", "chien", "ours"], {}, "fr") is None
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
    def pick(_claude, _marked, info, _chain, lang):
        shown.extend(info)
        return {"starts": {"chat": "lapin", "chien": "loup"}, "replace": None, "why": ""}
    return pick


def test_a_hole_left_without_a_start_is_asked_again_alone(tmp_path, monkeypatch):
    # A slip on one hole (a word not written as listed) costs one more question, not the
    # day and its map; the re-asked sentence shows the starts already chosen.
    path = _three_hole_draft(tmp_path)
    shown, asked = [], []
    monkeypatch.setattr(curate.llm, "pick_starts", _two_of_three(shown))

    def pick_one(_claude, marked, secret, options, others=None, **_k):
        asked.append((marked, secret, [o["word"] for o in options], others))
        return "brique"

    monkeypatch.setattr(curate.llm, "pick_start", pick_one)
    picked = curate.choose_starts(object(), Log(), str(path), {"chat": "n-chat", "chien": "n-chien"}, {},
                                  lambda _t: None, lang="fr")
    assert picked == {"chat": "lapin", "chien": "loup", "pierre": "brique"}
    # the day as the first pick read it: every other hole's start and notes
    assert asked == [("un lapin un loup une [____]", "pierre", ["brique"],
                      [{"secret": "chat", "start": "lapin", "notes": "n-chat"},
                       {"secret": "chien", "start": "loup", "notes": "n-chien"}])]


def test_start_choice_requires_all_three_valid_candidates(tmp_path, monkeypatch):
    path = _three_hole_draft(tmp_path)
    shown = []
    monkeypatch.setattr(curate.llm, "pick_starts", _two_of_three(shown))
    monkeypatch.setattr(curate.llm, "pick_start", lambda *_a, **_k: None)
    log = Log()
    assert curate.choose_starts(object(), log, str(path), {}, {}, lambda _t: None, lang="fr") is None
    assert len(shown) == 3
    assert any("missing: pierre" in line for line in log)


def test_a_hole_with_no_candidate_asks_for_a_replacement():
    class Claude:
        prompt = ""

        def json(self, prompt):
            self.prompt = prompt
            return {"replace": {"secret": "pierre", "with": "une", "why": "no start fits"}}

    claude = Claude()
    holes = [{"secret": "pierre", "slug": "pierre", "options": [], "notes": ""}]
    answer = curate.llm.pick_starts(claude, "une [pierre]", holes, None, lang="fr")
    assert "NONE — no start fits this slot; name a replacement" in claude.prompt
    assert answer["replace"]["secret"] == "pierre"


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
    def pick(_claude, marked, secret, options, refused="", **_k):
        asked.append((marked, secret, [o["word"] for o in options], refused))
        return choice
    return pick


def test_a_start_the_secret_was_played_with_is_never_offered(tmp_path, monkeypatch):
    path = _generated_draft(tmp_path, ["lapin", "souris"])
    shown = []

    def pick(_claude, _marked, info, _chain, lang):
        shown.extend(info)
        return {"starts": {"chat": "souris", "chien": "loup", "pierre": "brique"}, "replace": None, "why": ""}

    monkeypatch.setattr(curate.llm, "pick_starts", pick)
    picked = curate.choose_starts(object(), Log(), str(path), {}, {}, lambda _t: None,
                                  pairs={"chat": {"lapin"}}, lang="fr")
    assert [[o["word"] for o in h["options"]] for h in shown] == [["souris"], ["loup"], ["brique"]]
    assert picked == {"chat": "souris", "chien": "loup", "pierre": "brique"}


def test_a_generated_start_that_repeats_a_pair_is_refused_and_re_picked(tmp_path, monkeypatch):
    # Refused by code, with no question to the model; the re-pick is offered neither the refused
    # start, nor a start the hole has already shown, nor another pair already played.
    path = _generated_draft(tmp_path, ["lapin", "souris", "mulot", "rat"], starts=["lapin", "loup", "brique"])
    asked = []
    monkeypatch.setattr(curate.llm, "sentence_check", lambda *_a, **_k: pytest.fail("a played pair needs no model"))
    monkeypatch.setattr(curate.llm, "pick_start", _pick_one(asked, "rat"))
    repick = curate.check_starts(object(), Log(), str(path), {"chat": {"souris"}}, {}, lambda _t: None,
                                 pairs={"chat": {"lapin", "mulot"}}, lang="fr")
    assert repick == {"chat": "rat"}
    assert asked == [("un [____] un loup une brique", "chat", ["rat"],
                      "this secret was already played from this start word")]


def test_a_re_pick_reads_the_day_as_the_first_pick_does(tmp_path, monkeypatch):
    # The re-pick sees where the reader's nearest word lands, and every other hole's notes
    # and shown start: the day-level choice cannot be made without them.
    path = _generated_draft(tmp_path, ["souris", "lapin"], starts=["lapin", "loup", "brique"])
    seen = {}
    monkeypatch.setattr(curate.llm, "sentence_check",
                        lambda *_a, **_k: {"valid": False, "faulty": {"lapin": "un accord faux"}})

    def pick(_claude, _marked, _secret, _options, context="", others=None, **_k):
        seen.update(context=context, others=others)
        return "souris"

    monkeypatch.setattr(curate.llm, "pick_start", pick)
    context = {"chat": "n-chat", "chien": "n-chien", "pierre": "n-pierre"}
    assert curate.check_starts(object(), Log(), str(path), {}, context, lambda _t: None, lang="fr",
                               fillers={"chat": ["souris"]}) == {"chat": "souris"}
    assert seen["context"].startswith("n-chat")
    assert "the reader's nearest word « souris » sits at rank 110" in seen["context"]
    assert seen["others"] == [{"secret": "chien", "start": "loup", "notes": "n-chien"},
                              {"secret": "pierre", "start": "brique", "notes": "n-pierre"}]


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

    def pick(_claude, marked, secret, _options, others=None, **_k):
        asked.append((marked, secret, others))
        return {"chat": "souris", "chien": "renard"}[secret]

    monkeypatch.setattr(curate.llm, "pick_start", pick)
    assert curate.check_starts(object(), Log(), str(path), {}, {}, lambda _t: None,
                               lang="fr") == {"chat": "souris", "chien": "renard"}
    marked, secret, others = asked[1]
    assert (marked, secret) == ("un souris un [____] une brique", "chien")
    assert {"secret": "chat", "start": "souris", "notes": "nothing measured"} in others


# Every hole's notes say the line gives little of its word: the idea check asks them all.
_LITTLE = {k: f"readers would split; {curate.rules.GIVES_LITTLE}" for k in ("chat", "chien", "pierre")}


def test_start_words_the_sentence_check_passes_are_kept(tmp_path, monkeypatch):
    path = _generated_draft(tmp_path, ["lapin", "souris"], starts=["lapin", "loup", "brique"])
    checked, ideas = [], []
    monkeypatch.setattr(curate.llm, "sentence_check",
                        lambda _c, shown, starts, lang: checked.append((shown, starts)) or {"valid": True, "faulty": {}})
    monkeypatch.setattr(curate.llm, "start_ideas", lambda _c, shown, starts, lang: ideas.append((shown, starts))
                        or ({}, {"lapin", "loup", "brique"}))
    monkeypatch.setattr(curate.llm, "pick_start", lambda *_a, **_k: pytest.fail("nothing to re-pick"))
    log = Log()
    assert curate.check_starts(object(), log, str(path), {}, _LITTLE, lambda _t: None, lang="fr") == {}
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
    assert curate.check_starts(object(), log, str(path), {}, _LITTLE, lambda _t: None, lang="fr") == {"chat": "souris"}
    assert asked == [("un [____] un loup une brique", "chat", ["souris", "mulot"], "a riddle: a side meaning")]
    assert any("start « lapin » for « chat » refused: a riddle" in line for line in log)


def test_a_start_the_idea_check_could_not_judge_is_left_to_the_reviewer_never_passed(tmp_path, monkeypatch):
    path = _generated_draft(tmp_path, ["lapin", "souris"], starts=["lapin", "loup", "brique"])
    monkeypatch.setattr(curate.llm, "sentence_check", lambda *_a, **_k: {"valid": True, "faulty": {}})
    monkeypatch.setattr(curate.llm, "start_ideas", lambda *_a, **_k: ({}, {"loup"}))   # two unjudged
    monkeypatch.setattr(curate.llm, "pick_start", lambda *_a, **_k: pytest.fail("a doubt refuses nothing"))
    log = Log()
    assert curate.check_starts(object(), log, str(path), {}, _LITTLE, lambda _t: None, lang="fr") == {}
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
    assert curate.check_starts(object(), Log(), str(path), {}, _LITTLE, lambda _t: None, lang="fr", cleared=cleared) == {}
    assert asked == [["lapin", "brique"]]
    assert cleared == {"chat": {"lapin"}, "chien": {"loup"}, "pierre": {"brique"}}
    asked.clear()
    assert curate.check_starts(object(), Log(), str(path), {}, _LITTLE, lambda _t: None, lang="fr", cleared=cleared) == {}
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
    assert curate.check_starts(object(), Log(), str(path), {}, _LITTLE, lambda _t: None, lang="fr", cleared=cleared) == {}
    assert cleared == {"chien": {"loup"}}
    log = Log()
    assert curate.check_starts(object(), log, str(path), {}, _LITTLE, lambda _t: None, lang="fr", cleared=cleared) == {}
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
    assert curate.check_starts(object(), log, str(path), {}, {}, lambda _t: None, lang="fr",
                               last=True) == {"chat": "souris"}
    assert "- start « lapin » for « chat » refused: un accord faux" in log


def test_on_the_last_round_a_riddle_is_left_to_the_reviewer_not_traded_for_an_unread_start(tmp_path, monkeypatch):
    path = _generated_draft(tmp_path, ["lapin", "souris"], starts=["lapin", "loup", "brique"])
    monkeypatch.setattr(curate.llm, "sentence_check", lambda *_a, **_k: {"valid": True, "faulty": {}})
    monkeypatch.setattr(curate.llm, "start_ideas",
                        lambda *_a, **_k: ({"lapin": "a riddle: a side meaning"}, _ALL_JUDGED))
    monkeypatch.setattr(curate.llm, "pick_start", lambda *_a, **_k: pytest.fail("a re-pick now would ship unread"))
    log = Log()
    assert curate.check_starts(object(), log, str(path), {}, _LITTLE, lambda _t: None, lang="fr", last=True) == {}
    assert ("- start « lapin » for « chat »: a riddle: a side meaning — the last round, left to the reviewer"
            in log)


def test_the_idea_check_asks_only_where_the_line_gives_little(tmp_path, monkeypatch):
    # Asked of every hole of the user's loved days, the check called 17 of 57 starts riddles;
    # on the holes the line gives little of, 2 — and « berceau » for « cercueil ».
    path = _generated_draft(tmp_path, ["lapin", "souris"], starts=["lapin", "loup", "brique"])
    asked = []
    monkeypatch.setattr(curate.llm, "sentence_check", lambda *_a, **_k: {"valid": True, "faulty": {}})
    monkeypatch.setattr(curate.llm, "start_ideas",
                        lambda _c, _s, starts, lang: asked.append([s["start"] for s in starts]) or ({}, _ALL_JUDGED))
    context = {"chien": f"readers would split; {curate.rules.GIVES_LITTLE} (such holes played hard on real play)"}
    assert curate.check_starts(object(), Log(), str(path), {}, context, lambda _t: None, lang="fr") == {}
    assert asked == [["loup"]]
    asked.clear()
    log = Log()
    assert curate.check_starts(object(), log, str(path), {}, {}, lambda _t: None, lang="fr") == {}
    assert asked == [] and not any("start ideas check" in line for line in log)


def test_the_idea_check_waits_for_a_sentence_that_reads_right(tmp_path, monkeypatch):
    path = _generated_draft(tmp_path, ["lapin", "souris"], starts=["lapin", "loup", "brique"])
    monkeypatch.setattr(curate.llm, "sentence_check",
                        lambda *_a, **_k: {"valid": False, "faulty": {"lapin": "un accord faux"}})
    monkeypatch.setattr(curate.llm, "start_ideas", lambda *_a, **_k: pytest.fail("a faulty sentence comes first"))
    monkeypatch.setattr(curate.llm, "pick_start", lambda *_a, **_k: "souris")
    assert curate.check_starts(object(), Log(), str(path), {}, {}, lambda _t: None, lang="fr") == {"chat": "souris"}


def test_a_hole_whose_readers_land_far_is_noted_as_one_the_line_gives_little_of():
    # « cercueil »: readers write « sol », « parquet » (1010) — the start step must hear that
    # the line gives little, and pick from the word's direct meaning (« cadavre »).
    ranks = {"cercueil": {"word": "cercueil", "rank": 0}, "tombe": {"word": "tombe", "rank": 6},
             "parquet": {"word": "parquet", "rank": 1010}}
    far = "the line gives little of this word, and its start comes from the word's direct meaning"
    notes = curate._notes(ranks, "cercueil", {"cercueil": "readers would split"}, {"cercueil": ["sol", "parquet"]})
    assert notes.startswith("readers would split; the reader's nearest word « parquet » sits at rank 1010")
    assert notes.endswith(far)
    assert far not in curate._notes(ranks, "cercueil", {}, {"cercueil": ["tombe", "parquet"]})
    # a word the readers write themselves is handed over, never one the line gives little of
    handed = {"cercueil": "most readers would write the secret itself"}
    assert far not in curate._notes(ranks, "cercueil", handed, {"cercueil": ["parquet"]})
    assert curate._notes(ranks, "cercueil", {}, {}) == "nothing measured"


def test_a_start_the_sentence_check_faults_is_re_picked_from_the_rest_of_the_band(tmp_path, monkeypatch):
    path = _generated_draft(tmp_path, ["lapin", "souris", "mulot"], starts=["lapin", "loup", "brique"])
    asked = []
    monkeypatch.setattr(curate.llm, "sentence_check",
                        lambda *_a, **_k: {"valid": False, "faulty": {"lapin": "un accord faux"}})
    monkeypatch.setattr(curate.llm, "pick_start", _pick_one(asked, "souris"))
    assert curate.check_starts(object(), Log(), str(path), {}, {}, lambda _t: None, lang="fr") == {"chat": "souris"}
    assert asked == [("un [____] un loup une brique", "chat", ["souris", "mulot"], "un accord faux")]


def test_the_model_judges_the_sentence_and_the_re_pick_band_keeps_the_letter_rule(tmp_path, monkeypatch):
    # No mechanical refusal: « le effet » goes to the model like any start; the band the
    # re-pick chooses from still holds only words that can follow « le » — « ami » elides.
    path = _generated_draft(tmp_path, ["effet", "ami", "lapin"], starts=["effet", "loup", "brique"], first="le")
    asked, checked = [], []
    monkeypatch.setattr(curate.llm, "sentence_check", lambda _c, shown, _starts, lang: checked.append(shown) or
                        {"valid": False, "faulty": {"effet": "« le effet » n'est pas français"}})
    monkeypatch.setattr(curate.llm, "pick_start", _pick_one(asked, "lapin"))
    assert curate.check_starts(object(), Log(), str(path), {}, {}, lambda _t: None, lang="fr") == {"chat": "lapin"}
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
    assert curate.generate(object(), Log(), "s", ["chat", "chien", "ours"], {}, "fr") == "out/x_y_z.json"
    assert len(checks) == 3 and len(runs) == 5     # the first run, the chosen starts, three re-picks
    assert checks == [False, False, True]          # the last check knows no check reads its re-pick
    # one record of the starts the idea check passed, kept across the rounds: never asked again
    assert all(c is seen[0] for c in seen) and seen[0]["chien"] == {"r1", "r2", "r3"}


# --- a word no start can save is swapped, REPLACE_ROUNDS times at most --------------------

def _build_day(monkeypatch, generate, log, given=None, says=None, instead=None, crowds=None, asked_say=None,
               unmapped=lambda t, fillers: None, words=("chat", "dort", "pierre", "froide"), own=lambda t: None):
    """build_day on a song's line with chat · dort · pierre chosen and « froide » left to
    swap in, each word's giveaway judged before the choice (`given`, 0.3 by default) and
    the chance a player says it (`says`, 0.8 by default); returns (its result, the words
    the reader was asked)."""
    tokens = _line_tokens()
    allowed = [t for t in tokens if t.text in words]
    asked = []
    monkeypatch.setattr(curate.llm, "widely_known", lambda *_a, **_k: {"known": False, "why": ""})
    monkeypatch.setattr(curate.llm, "context_guesses",
                        lambda _c, toks, _blanks, mark, _n, lang: asked.append(toks[mark].text) or ([], None))
    monkeypatch.setattr(curate.llm, "would_say",
                        lambda _c, _toks, _blanks, _mark, word, lang: (asked_say if asked_say is not None else []).append(word)
                        or ((says or {}).get(word, 0.8), (instead or {}).get(word)))
    monkeypatch.setattr(curate, "generate", generate)
    line = {"sentence": "Le chat dort sur la pierre froide.", "tokens": tokens, "allowed": allowed,
            "given": given or {t.slug: 0.3 for t in allowed}}
    path = curate.build_day(object(), log, line, allowed[:3], ["chat: le sujet"], {"kind": "music"}, {"pairs": {}},
                            "", {"kind": "music"}, lambda t: None, lambda t, w: None, "fr",
                            "old.contextual.json", crowd=lambda t: (crowds or {}).get(t.text), unmapped=unmapped,
                            own=own)
    return path, asked


def test_a_swapped_word_rebuilds_the_day_and_only_the_new_word_is_measured(monkeypatch):
    calls = []

    def generate(_c, _l, _sentence, words, *_a, replay, chain, **_k):
        calls.append((words, replay, chain))
        if len(calls) == 1:
            raise curate.Replace("pierre", "froide", "too far")
        return "out/x_y_z.json"

    path, asked = _build_day(monkeypatch, generate, Log())
    assert path == "out/x_y_z.json"
    # another trio: the erased draft's scores no longer apply, and the chain says what changed
    assert calls == [(["chat", "dort", "pierre"], "old.contextual.json", ["chat: le sujet"]),
                     (["chat", "dort", "froide"], None, ["froide replaces pierre: too far", "chat: le sujet"])]
    # the two words kept are not read again
    assert asked == ["chat", "dort", "pierre", "froide"]


def test_two_words_players_dont_say_get_one_swapped_before_the_ranking_is_paid(monkeypatch):
    # The taste keeps at most one: the model names which one goes, before gen_phrase runs,
    # so the ranking is paid once, for the trio that is built.
    calls, shown = [], []

    def drop(_c, marked, holes, unsaid, others, _chain, lang):
        shown.append((marked, [h["secret"] for h in holes], unsaid, others))
        return {"secret": "pierre", "with": "froide", "why": "the rare one"}

    def generate(_c, _l, _sentence, words, *_a, replay, chain, **_k):
        calls.append((words, replay, chain))
        return "out/x_y_z.json"

    monkeypatch.setattr(curate.llm, "drop_unsaid", drop)
    path, asked = _build_day(monkeypatch, generate, Log(), says={"pierre": 0.1, "dort": 0.2})
    assert path == "out/x_y_z.json"
    assert calls == [(["chat", "dort", "froide"], None, ["froide replaces pierre: the rare one", "chat: le sujet"])]
    assert shown[0][1:] == (["chat", "dort", "pierre"], ["dort", "pierre"], ["froide"])
    assert "[pierre]" in shown[0][0] and "[froide]" not in shown[0][0]
    assert len(shown) == 1          # the new trio holds one such word: nothing more is asked
    assert asked == ["chat", "dort", "pierre", "froide"]


def test_a_trio_with_at_most_one_word_players_dont_say_is_never_questioned(monkeypatch):
    # An easy word is the start step's to tune (a medium start), never a swap: a loved day
    # keeps its plain words around the punch.
    monkeypatch.setattr(curate.llm, "drop_unsaid", lambda *_a, **_k: pytest.fail("no swap to ask for"))
    path, _asked = _build_day(monkeypatch, lambda *_a, **_k: "out/x_y_z.json", Log(), says={"pierre": 0.1})
    assert path == "out/x_y_z.json"


def test_the_word_players_say_instead_in_another_form_is_this_word(monkeypatch):
    # « sauva » scored 0.35 because readers would write « sauver »: the same word, which
    # finds the hole (a ranked group holds every form) — it played easy.
    monkeypatch.setattr(curate.llm, "drop_unsaid", lambda *_a, **_k: pytest.fail("one word players don't say"))
    seen = {}

    def generate(_c, _l, _sentence, _words, _source, _lang, context, *_a, **_k):
        seen.update(context)
        return "out/x_y_z.json"

    _build_day(monkeypatch, generate, Log(), says={"dort": 0.3, "pierre": 0.1}, instead={"dort": "dormir"})
    assert "this same word in another form" in seen["dort"] and "a word players don't say" not in seen["dort"]
    assert "a word players don't say" in seen["pierre"] and "this trio hides" not in seen["pierre"]


def test_a_buried_word_is_refused_by_code_and_replaced_before_the_ranking(monkeypatch):
    # « charnier »: half-said and among commoner near-words — players circle them and stall.
    calls, said = [], []
    monkeypatch.setattr(curate.llm, "replace_word",
                        lambda _c, _m, _h, word, others, _chain, lang, refused: {"with": "froide", "why": "said"})

    def generate(_c, _l, _sentence, words, *_a, replay, chain, **_k):
        calls.append((words, chain[0]))
        return "out/x_y_z.json"

    path, _asked = _build_day(monkeypatch, generate, Log(), says={"pierre": 0.45},
                              crowds={"pierre": 0.8, "chat": 0.2}, asked_say=said)
    assert path == "out/x_y_z.json"
    assert calls == [(["chat", "dort", "froide"], "froide replaces pierre: buried among commoner near-words (said)")]
    assert said.count("pierre") == 2 and said.count("chat") == 1   # asked twice only in a crowd


def test_a_rare_name_players_say_in_a_crowd_is_not_buried(monkeypatch):
    monkeypatch.setattr(curate.llm, "replace_word", lambda *_a, **_k: pytest.fail("not buried"))
    path, _ = _build_day(monkeypatch, lambda *_a, **_k: "out/x_y_z.json", Log(), says={"pierre": 0.58},
                         crowds={"pierre": 0.83})
    assert path == "out/x_y_z.json"


def test_a_day_is_given_up_after_replace_rounds_swaps(monkeypatch):
    calls = []
    swaps = iter([("sur", "pierre"), ("dort", "froide"), ("chat", "la")])   # a fresh word each time

    def generate(_c, _l, _sentence, words, *_a, **_k):
        calls.append(words)
        raise curate.Replace(*next(swaps), "no start saves it")

    log = Log()
    path, _asked = _build_day(monkeypatch, generate, log, words=("chat", "dort", "sur", "la", "pierre", "froide"))
    assert curate.REPLACE_ROUNDS == 2
    assert path is None and any("no trio of this line survived its swaps" in line for line in log)
    assert calls == [["chat", "dort", "sur"], ["chat", "dort", "pierre"], ["chat", "froide", "pierre"]]


def test_a_word_swapped_out_never_comes_back(monkeypatch):
    # « imprésario » refused as buried, swapped for « organisé », then brought back by the
    # next swap and refused again: the line's swaps were spent undoing each other.
    offered = []
    monkeypatch.setattr(curate.llm, "replace_word",
                        lambda _c, _m, _h, word, others, _chain, lang, refused:
                        offered.append(list(others)) or {"with": "froide" if word == "pierre" else "pierre", "why": "w"})
    log = Log()
    path, _asked = _build_day(monkeypatch, lambda *_a, **_k: pytest.fail("no trio is built"), log,
                              says={"pierre": 0.45, "froide": 0.45}, crowds={"pierre": 0.8, "froide": 0.8})
    assert path is None
    assert offered == [["froide"], []]          # once out, « pierre » is no longer offered
    assert any("brings back a word already swapped out of this line" in line for line in log)


@pytest.mark.parametrize("called, refused", [("pierreux", False), ("pierres", True)])
def test_a_word_the_neighbours_call_for_is_the_hidden_word_only_in_its_group(monkeypatch, called, refused):
    # « que devant une ___ de dix convives » calls for « table »: another word than
    # « tablée » (another group on its map), though one spelling is the other plus letters.
    asked = []
    monkeypatch.setattr(curate.llm, "neighbours_complete", lambda _c, fragment, lang: called)
    monkeypatch.setattr(curate.llm, "replace_word", lambda *_a, **_k: asked.append(1) or None)
    path, _ = _build_day(monkeypatch, lambda *_a, **_k: "out/x_y_z.json", Log(),
                         own=lambda t: frozenset({"pierre", "pierres"}) if t.text == "pierre" else None)
    assert (path is None, bool(asked)) == (refused, refused)


# --- the giveaway judge, read on real play: a floor, and a note for a hard hole -----------

def _day_on_the_line(monkeypatch, scores):
    """day() on « Le chat dort sur la pierre froide. » with the giveaways `scores`;
    returns (the words offered to the model, the log)."""
    monkeypatch.setattr(curate, "parse", _line_tokens)
    _giveaways(monkeypatch, scores)
    _alone(monkeypatch)
    offered = []
    monkeypatch.setattr(curate.llm, "choose_words",
                        lambda _c, line, _refused, lang: offered.append(line["allowed"]) or None)
    log = Log()
    curate.day(object(), log, [{"sentence": "Le chat dort sur la pierre froide."}], {"kind": "book"},
               {"secrets": set(), "pairs": {}}, "", lambda w: True, lambda t: None, lambda t, w: None, "fr",
               judge=object())
    return offered, log


def test_a_word_the_line_gives_no_path_to_is_never_offered(monkeypatch):
    # User-decided 2026-10-02: under GIVEAWAY_MIN the line leads nowhere near the word
    # (« bloated », « rapacity » beat a native speaker), so the model never sees it.
    assert contextual_rank.GIVEAWAY_MIN == 0.10
    offered, log = _day_on_the_line(monkeypatch, {"chat": 0.3, "dort": 0.09, "pierre": 0.10, "froide": 0.5})
    assert offered == [["chat", "pierre", "froide"]]          # at the floor a word stays
    assert any("no path to dort (0.09)" in line for line in log)


def test_a_line_the_floor_leaves_short_of_three_words_is_skipped(monkeypatch):
    offered, log = _day_on_the_line(monkeypatch, {"chat": 0.05, "dort": 0.09})
    assert offered == []
    assert any("fewer than 3 words can be hidden (no path to chat (0.05), dort (0.09))" in line for line in log)


# --- the day is chosen among FINISHED lines (user-decided 2026-10-13) ---------------------

_LINES = [{"sentence": "Le chat dort sur la pierre froide."}, {"sentence": "Un chat dort sur la pierre froide."}]


def _finished_lines(monkeypatch, order, build, alone=lambda s: True, says=None):
    """day() on two lines, the model picking chat · dort · pierre on each and ordering the
    finished lines `order`; `build(sentence)` is what building that line gives. Returns
    (the words the reader was asked, the days compared, the lines built and their swaps)."""
    monkeypatch.setattr(curate, "parse", _line_tokens)
    _giveaways(monkeypatch, {"pierre": 0.15})
    monkeypatch.setattr(curate.llm, "stands_alone",
                        lambda _c, s, lang: {"ok": alone(s), "about": "", "why": "" if alone(s) else "leans"})
    monkeypatch.setattr(curate.llm, "choose_words",
                        lambda _c, line, _r, lang: {"words": ["chat", "dort", "pierre"], "path": ["chat: le sujet"],
                                                    "why": "w"})
    measured = []
    monkeypatch.setattr(curate.llm, "context_guesses",
                        lambda _c, toks, _b, mark, _n, lang: measured.append(toks[mark].text) or ([], None))
    monkeypatch.setattr(curate.llm, "would_say",
                        lambda _c, _t, _b, _m, word, lang: ((says or {}).get(word, 0.8), None))
    compared = []
    monkeypatch.setattr(curate.llm, "choose_among",
                        lambda _c, days, lang: compared.append(days) or {"order": order, "why": "w"})
    built = []
    monkeypatch.setattr(curate, "build_day",
                        lambda _c, _l, line, trio, chain, *_a, **k: built.append((line["sentence"], k["swaps"]))
                        or build(line["sentence"]))
    tried = []
    path = curate.day(object(), Log(), _LINES, {"kind": "book"}, {"secrets": set(), "pairs": {}}, "",
                      lambda w: True, lambda t: None, lambda t, w: None, "fr", tried=tried, judge=object())
    assert tried == [line["sentence"] for line in _LINES]
    return path, sorted(measured), compared, built


def test_every_line_is_finished_before_the_day_is_chosen(monkeypatch):
    path, measured, compared, built = _finished_lines(monkeypatch, [1, 0], lambda s: "out/x_y_z.json",
                                                      says={"dort": 0.2})
    # both lines' words were measured before the one comparison
    assert measured == ["chat", "chat", "dort", "dort", "pierre", "pierre"]
    assert len(compared) == 1 and len(compared[0]) == 2
    day = compared[0][0]
    assert day["marked"] == "le [chat] [dort] sur la [pierre] froide"   # the parsed tokens, hidden words marked
    assert [w["word"] for w in day["words"]] == ["chat", "dort", "pierre"]
    assert [w["level"] for w in day["words"]] == ["medium", "hard: a word players don't say",
                                                 "hard: the line gives little of it"]
    assert day["path"] == ["chat: le sujet"]
    # the first in the model's order is built, and only it
    assert path == "out/x_y_z.json" and built == [(_LINES[1]["sentence"], 0)]


def test_the_next_line_in_the_order_is_built_when_the_first_cannot_be(monkeypatch):
    path, _measured, _compared, built = _finished_lines(
        monkeypatch, [1, 0], lambda s: None if s == _LINES[1]["sentence"] else "out/x_y_z.json")
    assert path == "out/x_y_z.json"
    assert [s for s, _ in built] == [_LINES[1]["sentence"], _LINES[0]["sentence"]]


def test_a_line_refused_by_its_checks_is_never_compared(monkeypatch):
    _path, _measured, compared, built = _finished_lines(monkeypatch, [0], lambda s: "out/x_y_z.json",
                                                        alone=lambda s: s == _LINES[1]["sentence"])
    assert len(compared[0]) == 1
    assert [s for s, _ in built] == [_LINES[1]["sentence"]]   # the one compared is the line that stands alone


def test_a_comparison_that_declines_every_line_builds_nothing(monkeypatch):
    path, _measured, _compared, built = _finished_lines(monkeypatch, [], lambda s: "out/x_y_z.json")
    assert path is None and built == []


def test_a_swap_before_the_comparison_is_counted_when_the_day_is_built(monkeypatch):
    # The swaps before the ranking and the start step's share REPLACE_ROUNDS.
    monkeypatch.setattr(curate.llm, "drop_unsaid",
                        lambda *_a, **_k: {"secret": "pierre", "with": "froide", "why": "the rare one"})
    _path, _measured, compared, built = _finished_lines(monkeypatch, [0, 1], lambda s: "out/x_y_z.json",
                                                        says={"pierre": 0.1, "dort": 0.2})
    assert [w["word"] for w in compared[0][0]["words"]] == ["chat", "dort", "froide"]
    assert compared[0][0]["path"][0] == "froide replaces pierre: the rare one"
    assert built == [(_LINES[0]["sentence"], 1)]


def test_a_hard_hole_is_told_the_line_gives_little_and_looks_in_the_same_band(monkeypatch):
    # User-decided 2026-10-08: how much the line gives decides which KIND of start (the
    # taste: the word's direct meaning), never a nearer band.
    assert contextual_rank.GIVEAWAY_HARD == 0.20
    seen = {}

    def generate(_c, _l, _sentence, _words, _source, _lang, context, *_a, **k):
        seen.update(context=context, kwargs=k)
        return "out/x_y_z.json"

    _build_day(monkeypatch, generate, Log(), given={"chat": 0.19, "dort": 0.20, "pierre": 0.5, "froide": 0.5})
    assert "the line gives little of this word" in seen["context"]["chat"]
    assert "the line gives little" not in seen["context"]["dort"]     # at the threshold a hole is not hard
    assert "hard" not in seen["kwargs"] and "nearer" not in seen["context"]["chat"]


def test_a_score_just_under_the_hard_bar_is_hard_and_never_printed_at_it(monkeypatch):
    # « divorce » (2026-10-10) sat at 0.1999…: hard, and its note said « at 0.20 ».
    seen = {}

    def generate(_c, _l, _sentence, _words, _source, _lang, context, *_a, **_k):
        seen.update(context=context)
        return "out/x_y_z.json"

    _build_day(monkeypatch, generate, Log(),
               given={"chat": 0.19999999999999998, "dort": 0.3, "pierre": 0.5, "froide": 0.5})
    note = seen["context"]["chat"]
    assert "hands it over at 0.19" in note and "the line gives little of this word" in note
    assert "at 0.20" not in note


def test_two_words_players_dont_say_are_told_to_the_start_step_one_is_not(monkeypatch):
    # User-decided 2026-10-06: one such word is a hard day (a loved day may hide one); two
    # made the worst days; the taste (not code) says how many to keep.
    seen = {}

    def generate(_c, _l, _sentence, _words, _source, _lang, context, *_a, **_k):
        seen.update(context)
        return "out/x_y_z.json"

    _build_day(monkeypatch, generate, Log(), says={"chat": 0.3})
    assert "a word players don't say" in seen["chat"] and "keep at most one" not in seen["chat"]
    _build_day(monkeypatch, generate, Log(), says={"chat": 0.3, "pierre": 0.2})
    for word in ("chat", "pierre"):
        assert "this trio hides 2 words players don't say (chat, pierre)" in seen[word]
    assert "keep at most one" not in seen["dort"] and "says this exact word at 0.80" in seen["dort"]


def test_the_start_choice_offers_every_hole_the_same_band(tmp_path, monkeypatch):
    path = _three_hole_draft(tmp_path)
    puzzle = json.loads(path.read_text(encoding="utf-8"))
    for secret, (near, usual) in {"chat": ("souris", "lapin"), "chien": ("renard", "loup")}.items():
        puzzle["ranks"][secret] = {near: {"word": near, "rank": 70}, usual: {"word": usual, "rank": 120}}
    path.write_text(json.dumps(puzzle), encoding="utf-8")
    shown = []

    def pick(_claude, _marked, info, _chain, lang):
        shown.extend(info)
        return {"starts": {"chat": "lapin", "chien": "loup", "pierre": "brique"}, "replace": None, "why": ""}

    monkeypatch.setattr(curate.llm, "pick_starts", pick)
    curate.choose_starts(object(), Log(), str(path), {}, {}, lambda _t: None, lang="fr")
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


def test_a_replay_that_covers_another_trio_is_dropped(tmp_path, monkeypatch):
    # the same sentence and page, another trio: « loup » was scored, « ours » is asked
    side = tmp_path / "x.contextual.json"
    side.write_text(json.dumps({"sentence": "s", "before": [], "after": [],
                                "holes": [{"secret": w} for w in ("chat", "chien", "loup")]}), encoding="utf-8")
    seen = []
    monkeypatch.setattr(curate, "run_gen_phrase",
                        lambda *a, **k: (seen.append(k.get("replay")), (type("C", (), {"returncode": 1, "stdout": "", "stderr": "boom"})(), []))[1])
    log = Log()
    curate.generate(object(), log, "s", ["chat", "chien", "ours"], {}, "fr", replay=str(side))
    assert seen[0] is None and not side.exists() and any("another trio" in l for l in log)


@pytest.mark.parametrize("change", [None, "sentence", "before", "after"])
def test_retry_reuses_scores_only_for_unchanged_context(tmp_path, monkeypatch, change):
    sentence = "Le chat regarde le chien et le loup."
    words = ["chat", "chien", "loup"]
    excerpt = {"before": ["Avant."], "after": ["Après."]}
    sidecar = tmp_path / "draft.contextual.json"
    sidecar.write_text(json.dumps({
        "sentence": sentence, **excerpt,
        "holes": [{"secret": w, "secret_label": w, "scores": {}, "pairs": {}}
                  for w in words],
    }), encoding="utf-8")
    if change == "sentence":
        sentence = "Un chat regarde le chien et le loup."
    elif change:
        excerpt[change] = ["Une autre page."]
    seen = []
    output = str(tmp_path / "new.json")

    def run(sentence, words, source, forms, lang, starts, replay=None):
        seen.append(replay)
        if replay:
            # Use the generator's validator: a stale replay must never reach it.
            judge = contextual_rank.ReplayJudge(contextual_rank.load_sidecar(replay))
            context = contextual_rank.Context(sentence, "chat", "chat",
                                               tuple(excerpt["before"]), tuple(excerpt["after"]), lang="fr")
            judge.score(context, [])
        return SimpleNamespace(returncode=0, stderr="", stdout=f"écrite dans {output} :"), []

    monkeypatch.setattr(curate, "run_gen_phrase", run)
    monkeypatch.setattr(curate, "choose_starts", lambda *a, **k: None)
    monkeypatch.setattr(curate, "check_starts", lambda *a, **k: pytest.fail("an incomplete choice is not checked"))
    result = curate.generate(object(), Log(), sentence, words, {"excerpt": excerpt}, "fr",
                             replay=str(sidecar))
    assert result is None
    assert seen == [str(sidecar) if change is None else None]


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

    monkeypatch.setattr(contextual_rank, "score_sentences", score)
    assert curate.judge_sentences(Log(), ["A line.", "Another."], "en", judge=FakeJudge({})) == ["A line.", "Another."]
    assert seen == ["en"]


def test_the_giveaway_judge_reads_an_english_line_as_written(monkeypatch):
    from rules import Token
    seen = []

    def giveaway(judge, blanked, word, *, lang):
        seen.append((blanked, word, lang))
        return 0.1

    monkeypatch.setattr(contextual_rank, "giveaway", giveaway)
    toks = [Token(0, "The", "the", "DET", "the", True), Token(1, "dog", "dog", "NOUN", "dog", False, ""),
            Token(2, "'s", "'s", "PART", "s", True), Token(3, "bone", "bone", "NOUN", "bone", False, ""),
            Token(4, ".", ".", "PUNCT", "", False, "")]
    curate.giveaway_scores(toks, [toks[1]], {"dog": {1}}, "en", judge=FakeJudge({}))
    assert seen == [("the _____'s bone.", "dog", "en")]


def _english_tokens(*_a):
    from rules import Token
    words = [("I", "i", "PRON", True), ("think", "think", "VERB", False), ("the", "the", "DET", True),
             ("old", "old", "ADJ", False), ("cat", "cat", "NOUN", False), ("sleeps", "sleep", "VERB", False),
             ("on", "on", "ADP", True), ("cold", "cold", "ADJ", False), ("stone", "stone", "NOUN", False)]
    return [Token(i, w, lemma, pos, w.lower(), stop) for i, (w, lemma, pos, stop) in enumerate(words)]


def test_an_english_day_is_chosen_in_english_from_english_facts(monkeypatch):
    monkeypatch.setattr(curate, "parse", _english_tokens)
    seen = []

    def choose(_c, line, refused, lang):
        seen.append((lang, line["allowed"]))
        return None

    monkeypatch.setattr(curate.llm, "choose_words", choose)
    _giveaways(monkeypatch)
    _alone(monkeypatch)
    curate.day(object(), Log(), [{"sentence": "I think the old cat sleeps on cold stone."}], {"kind": "book"},
               {"secrets": set(), "pairs": {}}, "", lambda w: True, lambda t: None, lambda t, w: None, "en", judge=object())
    assert seen == [("en", ["old", "cat", "sleeps", "cold", "stone"])]   # « think » is an English weak verb


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

    def run(sentence, words, source, forms, lang, starts=None, replay=None):
        runs.append(dict(forms))
        return SimpleNamespace(returncode=1, stdout="", stderr=error if len(runs) == 1 else "boom"), []

    asked = []
    monkeypatch.setattr(curate, "run_gen_phrase", run)
    monkeypatch.setattr(curate.llm, "pick_form", lambda _c, sentence, word, choices, lang: asked.append((word, choices, lang)) or 2)
    curate.generate(object(), Log(), "She leaves at dawn.", ["leaves", "dawn", "she"], {}, "en")
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

    def run(sentence, words, source, forms, lang, starts=None, replay=None):
        runs.append(dict(forms))
        stderr = _no_analysis_error("famous") if len(runs) == 1 else "boom"
        return SimpleNamespace(returncode=1, stdout="", stderr=stderr), []

    monkeypatch.setattr(curate, "run_gen_phrase", run)
    monkeypatch.setattr(curate.llm, "pick_form", lambda *a, **k: pytest.fail("no analysis, no question"))
    log = Log()
    curate.generate(object(), log, "A famous man slept.", ["famous", "man", "slept"], {}, "en")
    assert runs[1] == {"famous": curate.CITATION_FEATURE} == {"famous": "cit"}
    assert any("form of « famous »: cit" in line for line in log)


def test_a_citation_form_refused_again_gives_the_line_up(monkeypatch):
    runs = []
    monkeypatch.setattr(curate, "run_gen_phrase", lambda *a, **k: (
        runs.append(1), (SimpleNamespace(returncode=1, stdout="", stderr=_no_analysis_error("famous")), []))[1])
    log = Log()
    assert curate.generate(object(), log, "A famous man slept.", ["famous", "man", "slept"], {}, "en") is None
    assert len(runs) == 2 and any("even as cit" in line for line in log)


def test_a_stale_replay_runs_the_judge_again_instead_of_losing_the_line(tmp_path, monkeypatch):
    # A retried draft's saved judge scores predate a change of the word tables (#317):
    # gen_phrase's replay refuses a group it never scored. The line is rebuilt with a
    # fresh judge run, never given up, and the stale scores are dropped.
    sidecar = tmp_path / "old.contextual.json"
    sidecar.write_text(json.dumps({"sentence": "s", "before": [], "after": [],
                                   "holes": [{"secret": w} for w in ("chat", "chien", "ours")]}),
                       encoding="utf-8")
    replays = []

    def run(sentence, words, source, forms, lang, starts=None, replay=None):
        replays.append(replay)
        if replay:
            return SimpleNamespace(returncode=1, stdout="", stderr=(
                "Erreur : classement contextuel impossible pour « chat » : rejeu : le groupe "
                "felin:nc n'a pas de score pour « chat »")), []
        return SimpleNamespace(returncode=1, stdout="", stderr="boom"), []

    monkeypatch.setattr(curate, "run_gen_phrase", run)
    log = Log()
    assert curate.generate(object(), log, "s", ["chat", "chien", "ours"], {}, "fr",
                           replay=str(sidecar)) is None  # "boom" afterwards: refused
    assert replays == [str(sidecar), None]
    assert not sidecar.exists()
    assert any("the judge runs again" in line for line in log)


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


def test_a_trio_whose_line_hands_over_two_words_swaps_one_before_the_ranking(monkeypatch):
    # 2026-10-12: a Desproges line solved in ten seconds — two words handed over, the third
    # near; the model swaps one of the handed-over words before the ranking is paid for.
    asked, built = {}, []

    def drop(_c, _marked, _holes, handed, allowed, *_a, **_k):
        asked["handed"] = handed
        return {"secret": "chat", "with": allowed[0], "why": "dull"}

    def generate(_c, _l, _sentence, words, *_a, **_k):
        built.append(words)
        return "out/x.json"

    monkeypatch.setattr(curate.llm, "drop_handed", drop)
    monkeypatch.setattr(curate.rules, "reading", lambda t, *_a, **_k: (
        "most readers would write the secret itself" if t.text in ("chat", "dort") else "readers would split"))
    path, _ = _build_day(monkeypatch, generate, Log())
    assert asked["handed"] == ["chat", "dort"]
    assert built and "chat" not in built[0]


def test_one_handed_over_word_goes_straight_on(monkeypatch):
    monkeypatch.setattr(curate.llm, "drop_handed", lambda *_a, **_k: pytest.fail("one handed-over word"))
    monkeypatch.setattr(curate.rules, "reading", lambda t, *_a, **_k: (
        "most readers would write the secret itself" if t.text == "chat" else "readers would split"))
    path, _ = _build_day(monkeypatch, lambda *_a, **_k: "out/x.json", Log())
    assert path == "out/x.json"



def test_a_word_none_of_whose_reader_words_is_on_its_map_is_replaced_before_the_ranking(monkeypatch):
    # « laisse », 2026-10-12: its vector is the verb's, so its map never held « chaîne » —
    # every first guess landed past it. Refused on the free map, before the ranking is paid.
    asked, calls = {}, []

    def replace(_c, _m, _h, word, others, _chain, lang, refused):
        asked.update(word=word, refused=refused)
        return {"with": "froide", "why": "on its map"}

    def generate(_c, _l, _sentence, words, *_a, chain, **_k):
        calls.append((words, chain[0]))
        return "out/x.json"

    monkeypatch.setattr(curate.llm, "replace_word", replace)
    path, _ = _build_day(monkeypatch, generate, Log(),
                         unmapped=lambda t, fillers: ["caillou"] if t.text == "pierre" else None)
    assert path == "out/x.json"
    assert asked["word"] == "pierre" and "« caillou »" in asked["refused"] and "is on its map" in asked["refused"]
    assert calls == [(["chat", "dort", "froide"],
                      "froide replaces pierre: no word readers put there is on its map (on its map)")]


def test_a_map_that_hands_two_holes_over_swaps_one_after_the_ranking(monkeypatch):
    # « pou » at rank 1 for « morpion »: the start step's map hands two holes over; the
    # draft is erased (generate re-raises) and the model swaps one.
    calls, asked = [], {}

    def generate(_c, _l, _sentence, words, *_a, **_k):
        calls.append(words)
        if len(calls) == 1:
            raise curate.Handed(["chat", "dort"], {"chat": "most readers write « minou », rank 1 in its map",
                                                   "dort": "most readers write it straight in"})
        return "out/x.json"

    def drop(_c, _m, holes, handed, allowed, *_a, **_k):
        asked.update(handed=handed, notes={h["secret"]: h["notes"] for h in holes})
        return {"secret": "dort", "with": allowed[0], "why": "dull"}

    monkeypatch.setattr(curate.llm, "drop_handed", drop)
    path, _ = _build_day(monkeypatch, generate, Log())
    assert path == "out/x.json"
    assert asked["handed"] == ["chat", "dort"] and "rank 1 in its map" in asked["notes"]["chat"]
    assert calls == [["chat", "dort", "pierre"], ["chat", "froide", "pierre"]]


def test_the_start_step_raises_handed_when_its_map_hands_two_holes_over(tmp_path, monkeypatch):
    path = _three_hole_draft(tmp_path)
    puzzle = json.loads(path.read_text(encoding="utf-8"))
    puzzle["ranks"]["chien"]["toutou"] = {"word": "toutou", "rank": 2}
    path.write_text(json.dumps(puzzle), encoding="utf-8")
    monkeypatch.setattr(curate.llm, "pick_starts", lambda *_a, **_k: pytest.fail("no start can make this day"))
    with pytest.raises(curate.Handed) as raised:
        curate.choose_starts(object(), Log(), str(path), {"chat": "most readers would write the secret itself"}, {},
                             lambda _t: None, lang="fr", expected={"chien": "toutou", "pierre": "brique"})
    assert raised.value.words == ["chat", "chien"]
    assert raised.value.facts["chien"] == "most readers write « toutou », rank 2 in its map"


def test_one_hole_handed_over_on_the_map_goes_on_to_the_starts(tmp_path, monkeypatch):
    path = _three_hole_draft(tmp_path)
    shown = []
    monkeypatch.setattr(curate.llm, "pick_starts", _two_of_three(shown))
    monkeypatch.setattr(curate.llm, "pick_start", lambda *_a, **_k: "brique")
    # « brique » sits at 120: past HANDED_RANK, so only « chat » is handed over
    picked = curate.choose_starts(object(), Log(), str(path), {"chat": "most readers would write the secret itself"},
                                  {}, lambda _t: None, lang="fr", expected={"pierre": "brique"})
    assert picked == {"chat": "lapin", "chien": "loup", "pierre": "brique"}


def test_a_word_its_neighbours_hand_over_is_replaced_before_the_ranking(monkeypatch):
    # « le droit de ___ » is « vote » for anyone (2026-10-13): no search. The model sees the
    # words around the hole only, and writes the hidden word first.
    asked, fragments, calls = {}, [], []

    def first(_c, fragment, lang):
        fragments.append(fragment)
        return "pierre" if "___ froide" in fragment else "autre"

    def replace(_c, _m, _h, word, others, _chain, lang, refused):
        asked.update(word=word, refused=refused)
        return {"with": "froide", "why": "searched"}

    def generate(_c, _l, _sentence, words, *_a, chain, **_k):
        calls.append((words, chain[0]))
        return "out/x.json"

    monkeypatch.setattr(curate.llm, "neighbours_complete", first)
    monkeypatch.setattr(curate.llm, "replace_word", replace)
    path, _ = _build_day(monkeypatch, generate, Log())
    assert path == "out/x.json"
    assert "sur la ___ froide" in fragments          # the words around it, nothing else
    assert asked["word"] == "pierre" and "« sur la ___ froide » is « pierre »" in asked["refused"]
    assert calls == [(["chat", "dort", "froide"], "froide replaces pierre: its neighbours hand it over (searched)")]


def test_the_start_step_reads_an_in_memory_draft_and_shows_banked_starts(tmp_path, monkeypatch):
    # A banked line is given its starts on a draft held in memory (no puzzle written), and
    # finishing it shows each banked start with where it now stands on the ranked map.
    draft = json.loads(_three_hole_draft(tmp_path).read_text(encoding="utf-8"))
    draft["ranks"]["chien"]["renard"] = {"word": "renard", "rank": 40}
    shown = []
    monkeypatch.setattr(curate.llm, "pick_starts", _two_of_three(shown))
    monkeypatch.setattr(curate.llm, "pick_start", lambda *_a, **_k: "brique")
    picked = curate.choose_starts(object(), Log(), draft, {}, {}, lambda _t: None, lang="fr",
                                  prior={"chat": "lapin", "chien": "renard", "pierre": "galet"})
    assert picked == {"chat": "lapin", "chien": "loup", "pierre": "brique"}
    prior = {h["slug"]: h["prior"] for h in shown}
    assert prior == {"chat": {"word": "lapin", "rank": 120, "candidate": True},
                     "chien": {"word": "renard", "rank": 40, "candidate": False},
                     "pierre": {"word": "galet", "rank": None, "candidate": False}}


def test_a_banked_start_is_shown_to_the_start_step_with_the_rule_to_keep_it():
    class Claude:
        prompt = ""

        def json(self, prompt):
            self.prompt = prompt
            return {"starts": {"pierre": "brique"}, "why": ""}

    plain = Claude()
    hole = {"secret": "pierre", "slug": "pierre", "options": [{"word": "brique", "rank": 120}], "notes": ""}
    curate.llm.pick_starts(plain, "une [pierre]", [hole], None, lang="fr")
    assert "chosen before this map was ranked" not in plain.prompt and curate.llm.PRIOR_RULE not in plain.prompt
    banked = Claude()
    curate.llm.pick_starts(banked, "une [pierre]",
                           [{**hole, "prior": {"word": "galet", "rank": 260, "candidate": False}}], None, lang="fr")
    assert "chosen before this map was ranked: « galet » (rank 260 on this map, no longer a candidate" in banked.prompt
    assert curate.llm.PRIOR_RULE in banked.prompt
