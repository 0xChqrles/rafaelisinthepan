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
            return {"line": None, "why": "none"}

    claude = Claude()
    curate.llm.choose_day(claude, [{"sentence": "Le chat dort.", "allowed": ["chat", "dort", "lit"]}], [], lang="fr")
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
    return [Token(i, w, w, pos, w, stop) for i, (w, pos, stop) in enumerate(words)]


def test_a_chosen_line_that_does_not_stand_alone_is_told_back_and_nothing_is_built(monkeypatch):
    monkeypatch.setattr(curate, "parse", _line_tokens)
    asked = []

    def choose(_c, lines, refused, lang):
        asked.append(list(refused))
        return {"line": 0, "words": ["chat", "pierre", "froide"], "path": [], "why": "w"} if len(asked) == 1 else None

    monkeypatch.setattr(curate.llm, "choose_day", choose)
    _giveaways(monkeypatch)
    monkeypatch.setattr(curate.llm, "stands_alone", lambda _c, s, lang: {"ok": False, "about": "", "why": "leans on its page"})
    monkeypatch.setattr(curate, "build_day", lambda *a, **k: pytest.fail("a refused line is never built"))
    log = Log()
    path = curate.day(object(), log, [{"sentence": "Le chat dort sur la pierre froide."}], {"kind": "book"},
                      {"secrets": set(), "pairs": {}}, "", lambda w: True, lambda t: None, lambda t, w: None, "fr", judge=object())
    assert path is None
    assert asked[0] == [] and "does not stand alone" in asked[1][0]


def test_words_off_the_line_are_told_back(monkeypatch):
    monkeypatch.setattr(curate, "parse", _line_tokens)
    asked = []

    def choose(_c, lines, refused, lang):
        asked.append(list(refused))
        return {"line": 0, "words": ["chat", "lune", "pierre"], "path": [], "why": "w"} if len(asked) == 1 else None

    monkeypatch.setattr(curate.llm, "choose_day", choose)
    _giveaways(monkeypatch)
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

    def pick_one(_claude, marked, secret, options, **_k):
        asked.append((marked, secret, [o["word"] for o in options]))
        return "brique"

    monkeypatch.setattr(curate.llm, "pick_start", pick_one)
    picked = curate.choose_starts(object(), Log(), str(path), {}, {}, lambda _t: None, lang="fr")
    assert picked == {"chat": "lapin", "chien": "loup", "pierre": "brique"}
    assert asked == [("un lapin un loup une [____]", "pierre", ["brique"])]


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
    # Refused by code, with no grammar question; the re-pick is offered neither the refused
    # start, nor a start the hole has already shown, nor another pair already played.
    path = _generated_draft(tmp_path, ["lapin", "souris", "mulot", "rat"], starts=["lapin", "loup", "brique"])
    asked = []
    monkeypatch.setattr(curate.llm, "grammar_check", lambda *_a, **_k: pytest.fail("a played pair needs no model"))
    monkeypatch.setattr(curate.llm, "pick_start", _pick_one(asked, "rat"))
    repick = curate.check_starts(object(), Log(), str(path), {"chat": {"souris"}}, {}, lambda _t: None,
                                 pairs={"chat": {"lapin", "mulot"}}, lang="fr")
    assert repick == {"chat": "rat"}
    assert asked == [("un [____] un loup une brique", "chat", ["rat"],
                      "this secret was already played from this start word")]


def test_start_words_the_grammar_check_passes_are_kept(tmp_path, monkeypatch):
    path = _generated_draft(tmp_path, ["lapin", "souris"], starts=["lapin", "loup", "brique"])
    checked = []
    monkeypatch.setattr(curate.llm, "grammar_check",
                        lambda _c, shown, starts, lang: checked.append((shown, starts)) or {"valid": True, "faulty": {}})
    monkeypatch.setattr(curate.llm, "pick_start", lambda *_a, **_k: pytest.fail("nothing to re-pick"))
    assert curate.check_starts(object(), Log(), str(path), {}, {}, lambda _t: None, lang="fr") == {}
    assert checked == [("un lapin un loup une brique", ["lapin", "loup", "brique"])]


def test_a_start_the_grammar_check_faults_is_re_picked_from_the_rest_of_the_band(tmp_path, monkeypatch):
    path = _generated_draft(tmp_path, ["lapin", "souris", "mulot"], starts=["lapin", "loup", "brique"])
    asked = []
    monkeypatch.setattr(curate.llm, "grammar_check",
                        lambda *_a, **_k: {"valid": False, "faulty": {"lapin": "un accord faux"}})
    monkeypatch.setattr(curate.llm, "pick_start", _pick_one(asked, "souris"))
    assert curate.check_starts(object(), Log(), str(path), {}, {}, lambda _t: None, lang="fr") == {"chat": "souris"}
    assert asked == [("un [____] un loup une brique", "chat", ["souris", "mulot"], "un accord faux")]


def test_a_start_that_breaks_the_letter_rule_is_refused_before_any_grammar_question(tmp_path, monkeypatch):
    # « le effet » is never French: code knows it, and the model is only asked for another
    # start — « ami » elides after « le » too, so it is not offered either.
    path = _generated_draft(tmp_path, ["effet", "ami", "lapin"], starts=["effet", "loup", "brique"], first="le")
    asked = []
    monkeypatch.setattr(curate.llm, "grammar_check", lambda *_a, **_k: pytest.fail("the letter rule needs no model"))
    monkeypatch.setattr(curate.llm, "pick_start", _pick_one(asked, "lapin"))
    assert curate.check_starts(object(), Log(), str(path), {}, {}, lambda _t: None, lang="fr") == {"chat": "lapin"}
    assert asked == [("le [____] un loup une brique", "chat", ["lapin"],
                      "« le effet » : « le » s'élide devant une voyelle")]


def test_start_words_are_re_picked_at_most_start_rounds_times(monkeypatch):
    runs, checks = [], []
    monkeypatch.setattr(curate, "run_gen_phrase", lambda *_a, **_k: (
        runs.append(1), (SimpleNamespace(returncode=0, stderr="", stdout="écrite dans out/x_y_z.json :"), []))[1])
    monkeypatch.setattr(curate, "choose_starts", lambda *_a, **_k: {"chat": "lapin"})
    monkeypatch.setattr(curate, "check_starts", lambda *_a, **_k: checks.append(1) or {"chat": f"start{len(checks)}"})
    assert curate.st.START_ROUNDS == 3
    # every check faults the start: three re-picks, then the draft is left to the reviewer
    assert curate.generate(object(), Log(), "s", ["chat", "chien", "ours"], {}, "fr") == "out/x_y_z.json"
    assert len(checks) == 3 and len(runs) == 5     # the first run, the chosen starts, three re-picks


# --- a word no start can save is swapped, REPLACE_ROUNDS times at most --------------------

def _build_day(monkeypatch, generate, log, given=None):
    """build_day on a song's line with chat · dort · pierre chosen and « froide » left to
    swap in, each word's giveaway judged before the choice (`given`, 0.3 by default);
    returns (its result, the words the reader was asked)."""
    tokens = _line_tokens()
    allowed = [t for t in tokens if t.text in ("chat", "dort", "pierre", "froide")]
    asked = []
    monkeypatch.setattr(curate.llm, "widely_known", lambda *_a, **_k: {"known": False, "why": ""})
    monkeypatch.setattr(curate.llm, "context_guesses",
                        lambda _c, toks, _blanks, mark, _n, lang: asked.append(toks[mark].text) or ([], None))
    monkeypatch.setattr(curate, "generate", generate)
    line = {"sentence": "Le chat dort sur la pierre froide.", "tokens": tokens, "allowed": allowed,
            "given": given or {t.slug: 0.3 for t in allowed}}
    path = curate.build_day(object(), log, line, allowed[:3], ["chat: le sujet"], {"kind": "music"}, {"pairs": {}},
                            "", {"kind": "music"}, lambda t: None, lambda t, w: None, "fr",
                            "old.contextual.json")
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


def test_a_day_is_given_up_after_replace_rounds_swaps(monkeypatch):
    calls = []

    def generate(_c, _l, _sentence, words, *_a, **_k):
        calls.append(words)
        raise curate.Replace(words[2], "froide" if words[2] == "pierre" else "pierre", "no start saves it")

    log = Log()
    path, _asked = _build_day(monkeypatch, generate, log)
    assert curate.REPLACE_ROUNDS == 2
    assert path is None and any("no start words could save this day" in line for line in log)
    assert calls == [["chat", "dort", "pierre"], ["chat", "dort", "froide"], ["chat", "dort", "pierre"]]


# --- the giveaway judge, read on real play: a floor, and a nearer start for a hard hole ----

def _day_on_the_line(monkeypatch, scores):
    """day() on « Le chat dort sur la pierre froide. » with the giveaways `scores`;
    returns (the words offered to the model, the log)."""
    monkeypatch.setattr(curate, "parse", _line_tokens)
    _giveaways(monkeypatch, scores)
    offered = []
    monkeypatch.setattr(curate.llm, "choose_day",
                        lambda _c, lines, _refused, lang: offered.append(lines[0]["allowed"]) or None)
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


def test_a_hard_hole_draws_its_start_from_nearer_and_the_model_is_told(monkeypatch):
    # User-decided 2026-10-02: the hard days a bit easier, the easy days as they are.
    assert contextual_rank.GIVEAWAY_HARD == 0.20
    seen = {}

    def generate(_c, _l, _sentence, _words, _source, _lang, context, *_a, hard, **_k):
        seen.update(context=context, hard=hard)
        return "out/x_y_z.json"

    _build_day(monkeypatch, generate, Log(), given={"chat": 0.19, "dort": 0.20, "pierre": 0.5, "froide": 0.5})
    assert seen["hard"] == {"chat"}                            # at the threshold a hole is not hard
    assert "start candidates come from nearer (ranks 50-100)" in seen["context"]["chat"]
    assert "nearer" not in seen["context"]["dort"]


def test_the_start_choice_offers_a_hard_hole_the_nearer_band(tmp_path, monkeypatch):
    path = _three_hole_draft(tmp_path)
    puzzle = json.loads(path.read_text(encoding="utf-8"))
    for secret, (near, usual) in {"chat": ("souris", "lapin"), "chien": ("renard", "loup")}.items():
        puzzle["ranks"][secret] = {near: {"word": near, "rank": 70}, usual: {"word": usual, "rank": 120}}
    path.write_text(json.dumps(puzzle), encoding="utf-8")
    shown = []

    def pick(_claude, _marked, info, _chain, lang):
        shown.extend(info)
        return {"starts": {"chat": "souris", "chien": "loup", "pierre": "brique"}, "replace": None, "why": ""}

    monkeypatch.setattr(curate.llm, "pick_starts", pick)
    curate.choose_starts(object(), Log(), str(path), {}, {}, lambda _t: None, lang="fr", hard={"chat"})
    assert [[o["word"] for o in h["options"]] for h in shown] == [["souris"], ["loup"], ["brique"]]


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

    def choose(_c, lines, refused, lang):
        seen.append((lang, lines[0]["allowed"]))
        return None

    monkeypatch.setattr(curate.llm, "choose_day", choose)
    _giveaways(monkeypatch)
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
