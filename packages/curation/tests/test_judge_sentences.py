"""The curator's flow (2026-09-24): the judge's loose filter keeps reading order and the
model reads every line left; the day is chosen by comparison, and a refused choice is
told back; the start-word step may swap a word; the giveaway judge is a note."""

import json
from types import SimpleNamespace

import pytest

import _paths  # noqa: F401 — puts generation/scripts on sys.path (contextual_rank)
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
    curate.shortlist(object(), Log(), ["a", "b", "c"], set(), "fr")
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
    return [Token(i, w, w, pos, "dep", 0, w, stop) for i, (w, pos, stop) in enumerate(words)]


def test_a_chosen_line_that_does_not_stand_alone_is_told_back_and_nothing_is_built(monkeypatch):
    monkeypatch.setattr(curate, "parse", _line_tokens)
    asked = []

    def choose(_c, lines, refused, lang):
        asked.append(list(refused))
        return {"line": 0, "words": ["chat", "pierre", "froide"], "path": [], "why": "w"} if len(asked) == 1 else None

    monkeypatch.setattr(curate.llm, "choose_day", choose)
    monkeypatch.setattr(curate.llm, "stands_alone", lambda _c, s, lang: {"ok": False, "about": "", "why": "leans on its page"})
    monkeypatch.setattr(curate, "build_day", lambda *a, **k: pytest.fail("a refused line is never built"))
    log = Log()
    path = curate.day(object(), log, [{"sentence": "Le chat dort sur la pierre froide."}], {"kind": "book"},
                      {"secrets": set(), "pairs": {}}, "", lambda w: True, lambda t: None, lambda t, w: None, "fr")
    assert path is None
    assert asked[0] == [] and "does not stand alone" in asked[1][0]


def test_words_off_the_line_are_told_back(monkeypatch):
    monkeypatch.setattr(curate, "parse", _line_tokens)
    asked = []

    def choose(_c, lines, refused, lang):
        asked.append(list(refused))
        return {"line": 0, "words": ["chat", "lune", "pierre"], "path": [], "why": "w"} if len(asked) == 1 else None

    monkeypatch.setattr(curate.llm, "choose_day", choose)
    curate.day(object(), Log(), [{"sentence": "Le chat dort sur la pierre froide."}], {"kind": "book"},
               {"secrets": set(), "pairs": {}}, "", lambda w: True, lambda t: None, lambda t, w: None, "fr")
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


# --- the work is picked by rule, not by the model (user-decided 2026-09-20) --------------
from datetime import date


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


def test_a_replay_that_covers_another_trio_is_dropped(tmp_path, monkeypatch):
    side = tmp_path / "x.contextual.json"
    side.write_text('{"holes": [{"secret": "chat"}, {"secret": "chien"}, {"secret": "loup"}]}', encoding="utf-8")
    seen = []
    monkeypatch.setattr(curate, "run_gen_phrase",
                        lambda *a, **k: (seen.append(k.get("replay")), (type("C", (), {"returncode": 1, "stdout": "", "stderr": "boom"})(), []))[1])
    monkeypatch.setattr(curate, "MAX_GEN_RUNS", 0)
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
    toks = [Token(0, "The", "the", "DET", "det", 1, "the", True), Token(1, "dog", "dog", "NOUN", "nsubj", 3, "dog", False, ""),
            Token(2, "'s", "'s", "PART", "case", 1, "s", True), Token(3, "bone", "bone", "NOUN", "ROOT", 3, "bone", False, ""),
            Token(4, ".", ".", "PUNCT", "punct", 3, "", False, "")]
    curate.giveaway_scores(toks, [toks[1]], {"dog": {1}}, "en", judge=FakeJudge({}))
    assert seen == [("the _____'s bone.", "dog", "en")]


def _english_tokens(*_a):
    from rules import Token
    words = [("I", "i", "PRON", True), ("think", "think", "VERB", False), ("the", "the", "DET", True),
             ("old", "old", "ADJ", False), ("cat", "cat", "NOUN", False), ("sleeps", "sleep", "VERB", False),
             ("on", "on", "ADP", True), ("cold", "cold", "ADJ", False), ("stone", "stone", "NOUN", False)]
    return [Token(i, w, lemma, pos, "dep", 0, w.lower(), stop) for i, (w, lemma, pos, stop) in enumerate(words)]


def test_an_english_day_is_chosen_in_english_from_english_facts(monkeypatch):
    monkeypatch.setattr(curate, "parse", _english_tokens)
    seen = []

    def choose(_c, lines, refused, lang):
        seen.append((lang, lines[0]["allowed"]))
        return None

    monkeypatch.setattr(curate.llm, "choose_day", choose)
    curate.day(object(), Log(), [{"sentence": "I think the old cat sleeps on cold stone."}], {"kind": "book"},
               {"secrets": set(), "pairs": {}}, "", lambda w: True, lambda t: None, lambda t, w: None, "en")
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
