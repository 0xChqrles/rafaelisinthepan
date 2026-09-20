"""CONTRACT (#308): contextual reranking of a hole's static groups by a judge.

  - the judge's score alone orders the map: a statically far group can be first, a
    statically close one last; static similarity never blends in;
  - exact ties fall back to static position, deterministically;
  - pass 2 (pairwise round-robin) re-orders pass 1's front, and the merged
    similarity series stays non-increasing so dq quantizes from it;
  - an English-dominant label is demoted to the tail (code rule, two corpora);
  - batching never changes a score; the lean request carries the rubric ONCE in the
    shared state and one short question per candidate;
  - a replay rebuilds the same order from the sidecar and refuses to guess;
  - through gen_phrase: rank 0 is the secret, aliases share their group's rank and
    dq, dq is quantized from the judge's similarities, key collisions resolve
    closest-first in the CONTEXTUAL order, the map's groups are the static walk's;
  - no judge = the static map, unchanged (gen_word's path).
"""

import json
from dataclasses import replace

import pytest

import contextual_rank as cr
import gen_phrase


class FakeJudge:
    """Scores from a table; pairwise verdicts from a hidden 'truth' order."""

    def __init__(self, scores, truth=None):
        self.scores, self.truth = scores, scores if truth is None else truth
        self.usage = {"input_tokens": 0, "output_tokens": 0}
        self.requests = 0
        self.model = "fake"
        self.calls = []

    def score(self, context, candidates):
        labels = [c.label for c in candidates]
        self.calls.append(("score", labels))
        return [self.scores[w] for w in labels]

    def compare(self, context, pairs):
        pairs = [(a.label, b.label) for a, b in pairs]
        self.calls.append(("compare", pairs))
        return [0.9 if self.truth.get(a, 0) > self.truth.get(b, 0)
                else 0.5 if self.truth.get(a, 0) == self.truth.get(b, 0) else 0.1
                for a, b in pairs]


CTX = cr.Context("il prit un chat avant de partir.", "chat", "chat")


def _cands(labels):
    return [cr.Candidate(f"{w}:nc", w, i) for i, w in enumerate(labels)]


def test_judge_score_alone_orders_the_candidates():
    # static order: chien, félin, minou, tigre ; the judge says minou is closest
    judge = FakeJudge({"chien": 1.0, "félin": 3.0, "minou": 3.5, "tigre": 0.2})
    ranked, _rec = cr.rerank(CTX, _cands(["chien", "félin", "minou", "tigre"]), judge,
                             pairwise_top=0)
    assert [r.label for r in ranked] == ["minou", "félin", "chien", "tigre"]
    # a statically far group came first, a statically closer one fell
    assert ranked[0].static_pos == 2 and ranked[2].static_pos == 0
    sims = [r.similarity for r in ranked]
    assert sims == sorted(sims, reverse=True)


def test_exact_ties_fall_back_to_static_position():
    judge = FakeJudge({"a": 2.0, "b": 2.0, "c": 2.0})
    ranked, _ = cr.rerank(CTX, _cands(["c", "a", "b"]), judge, pairwise_top=0)
    assert [r.label for r in ranked] == ["c", "a", "b"]


def test_pairwise_pass_reorders_the_front_and_keeps_similarity_non_increasing():
    scores = {"chien": 3.0, "félin": 2.9, "minou": 2.8, "tigre": 1.0, "loup": 0.5}
    truth = {"minou": 3, "félin": 2, "chien": 1}  # the judge's pairwise verdicts
    judge = FakeJudge(scores, truth)
    ranked, rec = cr.rerank(CTX, _cands(list(scores)), judge, pairwise_top=3)
    assert [r.label for r in ranked] == ["minou", "félin", "chien", "tigre", "loup"]
    sims = [r.similarity for r in ranked]
    assert sims == sorted(sims, reverse=True)
    # the front is mapped onto the pass-1 span it replaces: never above the best
    # pass-1 score, never below the front's last one, and above the tail
    assert sims[0] <= 3.0 and sims[2] >= 2.8 and sims[2] > sims[3]
    assert ranked[0].win_rate > ranked[2].win_rate
    # every pair judged exactly once, both orientations accepted by a replay
    assert len(rec["pairs"]) == 3
    assert set(rec["scores"]) == {f"{w}:nc" for w in scores}  # keyed by GROUP, not label


def test_pairwise_orientation_is_seeded_and_deterministic():
    judge = FakeJudge({})
    front = _cands([f"w{i}" for i in range(6)])
    a, _ = cr.pairwise_order(CTX, front, judge, seed=0)
    b, _ = cr.pairwise_order(CTX, front, judge, seed=0)
    assert judge.calls[0] == judge.calls[1] and a == b


def test_english_dominant_labels_are_demoted_to_the_tail():
    fr = {"retirement": 74904, "pension": 5350, "feeling": 17261, "cotiser": 20000}
    en = {"retirement": 2280, "pension": 4031, "feeling": 2302}
    foreign = cr.english_dominance(fr, en)
    assert foreign("retirement") and foreign("feeling")
    assert not foreign("pension")      # frequent in French
    assert not foreign("cotiser")      # not an English word
    assert not foreign("inconnu")      # absent from both: never demoted
    judge = FakeJudge({"retirement": 4.0, "pension": 3.0, "cotiser": 1.0})
    ranked, rec = cr.rerank(CTX, _cands(["retirement", "pension", "cotiser"]), judge,
                            pairwise_top=0, foreign=foreign)
    assert [r.label for r in ranked] == ["pension", "cotiser", "retirement"]
    assert ranked[-1].demoted and ranked[-1].similarity == 0.0
    assert rec["demoted"] == ["retirement"]


def test_jev_judge_batches_without_changing_scores_and_sends_the_lean_request(monkeypatch):
    judge = cr.JevJudge("k", workers=2)
    seen = []

    def fake_call(state, questions):
        seen.append((state, questions))
        return {f"c{i}": {"type": "score", "score": float(len(state["candidats"][i]))}
                for i in range(len(state["candidats"]))}
    monkeypatch.setattr(judge, "_call", fake_call)
    labels = [f"m{'o' * i}" for i in range(7)]
    monkeypatch.setattr(cr, "SCORE_BATCH", 3)
    assert judge.score(CTX, _cands(labels)) == [float(len(w)) for w in labels]
    assert len(seen) == 3  # 3 + 3 + 1
    state, questions = seen[0]
    # the rubric travels ONCE in the shared state; each question names one candidate
    assert state["consigne"] == cr.SCORE_INSTRUCTIONS and state["phrase"] == CTX.sentence
    assert set(questions) == {"c0", "c1", "c2"}
    assert questions["c1"]["criteria"] == cr.SCORE_LEVELS
    assert "candidats[1]" in questions["c1"]["instructions"]


def test_jev_judge_refuses_to_exist_without_a_key():
    with pytest.raises(cr.ContextualError):
        cr.JevJudge("")
    with pytest.raises(cr.ContextualError):
        cr.read_api_key({})
    assert cr.read_api_key({"JEV_API_KEY": " abc "}) == "abc"


def test_two_groups_sharing_a_lemma_string_keep_separate_scores_in_the_sidecar():
    judge = FakeJudge({"gai": 2.0})
    cands = [cr.Candidate("gai:adj", "gai", 0), cr.Candidate("gai:nc", "gai", 1)]
    _r, rec = cr.rerank(CTX, cands, judge, pairwise_top=0)
    assert set(rec["scores"]) == {"gai:adj", "gai:nc"}


def test_replay_rebuilds_the_same_order_and_never_guesses(tmp_path):
    scores = {"chien": 3.0, "félin": 2.9, "minou": 2.8, "tigre": 1.0}
    judge = FakeJudge(scores, {"minou": 2, "félin": 1})
    ranked, rec = cr.rerank(CTX, _cands(list(scores)), judge, pairwise_top=3)
    path = cr.write_sidecar(str(tmp_path / "p.contextual.json"), model="fake",
                            sentence=CTX.sentence, before=(), after=(), records=[rec],
                            usage=judge.usage)
    replay = cr.ReplayJudge(cr.load_sidecar(path))
    again, _ = cr.rerank(CTX, _cands(list(scores)), replay, pairwise_top=3)
    assert [r.label for r in again] == [r.label for r in ranked]
    assert [r.similarity for r in again] == pytest.approx([r.similarity for r in ranked])
    with pytest.raises(cr.ContextualError):
        cr.rerank(CTX, _cands(list(scores) + ["loup"]), replay, pairwise_top=0)
    other = cr.Context(CTX.sentence, "chien", "chien")
    with pytest.raises(cr.ContextualError):
        cr.rerank(other, _cands(list(scores)), replay, pairwise_top=0)


@pytest.mark.parametrize("change", [
    {"sentence": "le chat est une conversation en ligne."},
    {"before": ("Un autre contexte.",)},
    {"after": ("Une autre suite.",)},
    {"secret_label": "chatter"},
])
def test_replay_refuses_changed_context_for_scores_and_pairs(tmp_path, change):
    candidates = _cands(["chien", "félin"])
    judge = FakeJudge({"chien": 1.0, "félin": 3.0})
    _, record = cr.rerank(CTX, candidates, judge)
    path = cr.write_sidecar(str(tmp_path / "scores.json"), model="fake",
                            sentence=CTX.sentence, before=(), after=(),
                            records=[record], usage=judge.usage)
    replay = cr.ReplayJudge(cr.load_sidecar(path))
    changed = replace(CTX, **change)
    with pytest.raises(cr.ContextualError, match="diffère"):
        replay.score(changed, candidates)
    with pytest.raises(cr.ContextualError, match="diffère"):
        replay.compare(changed, [(candidates[0], candidates[1])])


@pytest.mark.parametrize("with_resolver", [False, True])
def test_interactive_contextual_selection_without_inflection(monkeypatch, capsys,
                                                            with_resolver):
    import termios
    import tty
    from types import SimpleNamespace

    words = ["chat", "chien", "tigre"]
    ranking = [("félin", 0, .9), ("minou", 1, .8), ("loup", 2, .7)]
    cfg = gen_phrase.CONFIG["fr"].copy()
    cfg["module"] = SimpleNamespace(closest=lambda *a, **kw: ranking)
    judge = FakeJudge({"félin": 1.0, "minou": 3.0, "loup": .5})
    ranker = _ranker(judge)
    forms = gen_phrase.FormResolver(None, interactive=True) if with_resolver else None
    monkeypatch.setattr(gen_phrase.sys, "stdin", SimpleNamespace(fileno=lambda: 0))
    monkeypatch.setattr(termios, "tcgetattr", lambda fd: None)
    monkeypatch.setattr(termios, "tcsetattr", lambda *a: None)
    monkeypatch.setattr(tty, "setcbreak", lambda fd: None)
    monkeypatch.setattr("builtins.input", lambda prompt="": "")
    bands = []

    def band(secret, merged, bounds):
        bands.append(bounds)
        return [(w, r) for w, r, _ in merged]

    monkeypatch.setattr(gen_phrase, "start_band", band)
    # Hover another word before selecting; cancel a start choice and return to
    # it to verify that selection, not hovering, triggers one judge call per hole.
    keys = iter(["RIGHT", "LEFT", "ENTER", "ESC", "ENTER", "1", "ENTER"]
                + ["ENTER", "1", "ENTER"] * 2)

    def key(fd):
        value = next(keys)
        if value in ("RIGHT", "LEFT"):
            assert judge.calls == []
        return value

    monkeypatch.setattr(gen_phrase, "_read_key", key)
    holes, ranks = gen_phrase.select_holes_interactive(
        words, cfg, "fr", kv=None, V=words, M=None, Vset=set(words),
        lemma_table={}, forms_by_lemma={}, forms=forms, contextual=ranker)
    assert len(holes) == 3
    assert len([c for c in judge.calls if c[0] == "score"]) == 3
    assert bands.count(ranker.band) == 3
    assert all(h["start"]["word"] == "minou" for h in holes)
    assert all(rmap["minou"]["rank"] == 1 for rmap in ranks.values())
    assert len(ranker.records) == 3


# --- through gen_phrase ------------------------------------------------------------
RANKING = [("chien", 0, 0.9), ("félin", 1, 0.8), ("minou", 2, 0.7), ("côté", 3, 0.6),
           ("coté", 4, 0.5), ("tigre", 5, 0.4)]


def _ranker(judge, foreign=None):
    return gen_phrase.ContextualRanker(judge, "il prit un chat avant de partir.",
                                       foreign=foreign, model="fake")


def test_contextual_map_keeps_the_static_groups_and_reorders_them_with_dq_from_the_judge():
    judge = FakeJudge({"chien": 1.0, "félin": 2.0, "minou": 3.0, "côté": 0.2,
                       "coté": 0.1, "tigre": 0.5})
    merged, rmap, groups = gen_phrase.build_puzzle_rank_map(
        "chat", RANKING, {}, {}, set(), contextual=_ranker(judge))
    assert rmap["chat"] == {"word": "chat", "rank": 0}          # secret, bare
    assert rmap["minou"]["rank"] == 1 and rmap["minou"]["dq"] == 255
    assert rmap["felin"]["rank"] == 2 and rmap["chien"]["rank"] == 3
    # the same groups as the static walk, none added: coté dissolved into côté
    # statically (slug collision, closest-first) and never reached the judge
    assert {e["word"] for e in rmap.values()} == {"chat", "chien", "félin", "minou",
                                                  "côté", "tigre"}
    assert [c[1] for c in judge.calls if c[0] == "score"][0] == \
        ["chien", "félin", "minou", "côté", "tigre"]
    # dq is quantized from the judge's geometry: the last kept group is 0
    last = max(e["rank"] for e in rmap.values())
    assert [e for e in rmap.values() if e["rank"] == last][0]["dq"] == 0
    assert len({e["rank"] for e in rmap.values()}) == 6  # 0 + five groups


PORTES_TABLE = {"porte": ("porte:nc",), "portes": ("porte:nc", "porter:v"),
                "porter": ("porter:v",)}
PORTES_FORMS = gen_phrase.invert_lemmas(PORTES_TABLE)


def test_an_ambiguous_alias_attaches_to_the_contextually_closer_group():
    # statically porte (rank 1) opens first and claims the shared key «portes»
    ranking = [("porte", 0, 0.9), ("porter", 1, 0.8)]
    static = gen_phrase.build_puzzle_rank_map(
        "chat", ranking, PORTES_TABLE, PORTES_FORMS, set(PORTES_TABLE))
    assert static[1]["portes"]["word"] == "porte" and static[1]["portes"]["rank"] == 1
    # the judge prefers porter: the alias follows it, and porte keeps its own key
    judge = FakeJudge({"porte": 1.0, "porter": 3.0})
    _m, rmap, _g = gen_phrase.build_puzzle_rank_map(
        "chat", ranking, PORTES_TABLE, PORTES_FORMS, set(PORTES_TABLE),
        contextual=_ranker(judge))
    assert rmap["portes"] == rmap["porter"] and rmap["porter"]["rank"] == 1
    assert rmap["porte"]["rank"] == 2 and rmap["porte"]["word"] == "porte"
    # the judge read LEMMAS, not surfaces
    assert judge.calls[0] == ("score", ["porte", "porter"])


def test_without_a_judge_the_map_is_the_static_one():
    static = gen_phrase.build_puzzle_rank_map("chat", RANKING, {}, {}, set())
    assert [e["word"] for e in sorted(static[1].values(), key=lambda e: e["rank"])][:4] \
        == ["chat", "chien", "félin", "minou"]


def test_the_ranker_reports_and_records_every_hole(capsys):
    judge = FakeJudge({"chien": 1.0, "félin": 2.0, "minou": 3.0, "côté": 0.2,
                       "coté": 0.1, "tigre": 0.5})
    ranker = _ranker(judge)
    gen_phrase.build_puzzle_rank_map("chat", RANKING, {}, {}, set(), contextual=ranker)
    ranker.print()
    out = capsys.readouterr().out
    assert "Classement contextuel : chat" in out and "minou" in out
    assert ranker.records[0]["secret"] == "chat" and ranker.records[0]["kept"] == 5
    assert json.dumps(ranker.records)  # the sidecar entry serializes


def test_lexeme_label_reads_the_lemma_off_an_opaque_key():
    assert gen_phrase.lexeme_label("voler:v") == "voler"
    assert gen_phrase.lexeme_label("chat") == "chat"
    assert gen_phrase.lexeme_label("dog") == "dog"


# --- the curator's pre-filters (#308, recall-checked 2026-09-20) --------------------
class FilteringJudge(FakeJudge):
    """A judge that also answers yes/no: P(yes) looked up by the words in the question
    (the variant text or the pair), so a test states each verdict outright."""

    def __init__(self, yes):
        super().__init__({})
        self.yes = yes          # substring of the question/variant -> probability
        self.noul_calls = []

    def noul(self, state, questions):
        self.noul_calls.append((state, questions))
        out = {}
        for key, (instructions, _t, _f) in questions.items():
            text = instructions
            if "variantes[" in instructions:
                i = int(instructions.split("variantes[")[1].split("]")[0])
                text = state["variantes"][i] + " " + instructions
            out[key] = next((p for needle, p in self.yes.items() if needle in text), 0.9)
        return out


WORDS = ["il", "prit", "un", "chat", "avant", "de", "partir."]


def test_shown_sentence_places_the_word_at_every_occurrence_with_its_affixes():
    assert cr.shown_sentence(["le", "chat.", "le", "chat"], [(1, "", "."), (3, "", "")], "____") \
        == "le ____. le ____"


def test_start_band_filter_drops_what_does_not_read_as_french_and_keeps_the_rest():
    judge = FilteringJudge({"un chien avant": 0.9, "un courir avant": 0.2, "un beau avant": 0.55})
    band = [("chien", 250), ("courir", 251), ("beau", 252)]
    kept, removed = cr.filter_start_band(judge, WORDS, [(3, "", "")], band)
    assert kept == [("chien", 250), ("beau", 252)]      # 0.55 >= START_FIT_MIN (0.5)
    assert removed == [("courir", 251, 0.2)]
    # the variants are the sentence with each candidate shown at the hole
    state = judge.noul_calls[0][0]
    assert state["variantes"][1] == "il prit un courir avant de partir."


def test_hole_candidate_filter_removes_words_whose_blank_breaks_the_sentence():
    judge = FilteringJudge({"mot retiré : « prit »": 0.3, "mot retiré : « chat »": 0.95})
    cands = [{"pos": 1, "secret": "prit", "prefix": "", "suffix": ""},
             {"pos": 3, "secret": "chat", "prefix": "", "suffix": ""}]
    kept, removed = cr.filter_hole_candidates(judge, WORDS, cands)
    assert [c["secret"] for c in kept] == ["chat"]
    assert removed == [("prit", 0.3)]
    assert judge.noul_calls[0][0]["variantes"][0] == "il _____ un chat avant de partir."


def test_same_concept_returns_one_probability_per_pair():
    judge = FilteringJudge({"« jardin » et « royaume »": 0.48, "« vide » et « refuge »": 0.7})
    probs = cr.same_concept(judge, " ".join(WORDS), [("jardin", "royaume"), ("vide", "refuge")])
    assert probs == {("jardin", "royaume"): 0.48, ("vide", "refuge"): 0.7}


def test_a_replay_judge_cannot_filter_and_the_ranker_steps_aside():
    replay = cr.ReplayJudge({"sentence": "s", "before": [], "after": [], "holes": []})
    assert not cr.can_filter(replay)
    ranker = gen_phrase.ContextualRanker(replay, "s", model="fake")
    assert ranker.start_band_filter(WORDS, [(3, "", "")]) is None
    cands = [{"pos": 3, "secret": "chat", "prefix": "", "suffix": ""}]
    assert ranker.filter_candidates(WORDS, cands) == cands
    assert ranker.blocked_by(["chien"], cands) == set()


def test_the_ranker_blocks_a_candidate_naming_a_committed_secrets_concept():
    judge = FilteringJudge({"« matou » et « chat »": 0.8, "« avant » et « chat »": 0.05})
    ranker = gen_phrase.ContextualRanker(judge, " ".join(WORDS), model="fake")
    cands = [{"pos": 3, "secret": "matou", "prefix": "", "suffix": ""},
             {"pos": 4, "secret": "avant", "prefix": "", "suffix": ""}]
    assert ranker.blocked_by(["chat"], cands) == {3}
    assert any("bloqués" in r and "matou" in r for r in ranker.reports)


def test_an_emptied_band_is_handed_back_whole_with_a_note():
    judge = FilteringJudge({"il prit": 0.1})  # everything reads badly
    ranker = gen_phrase.ContextualRanker(judge, " ".join(WORDS), model="fake")
    band = [("chien", 250), ("courir", 251)]
    assert ranker.start_band_filter(WORDS, [(3, "", "")])(band) == band
    assert any("bande entière" in r for r in ranker.reports)


def test_choose_start_draws_its_default_from_the_filtered_band(monkeypatch):
    monkeypatch.setattr(gen_phrase.sys.stdin, "isatty", lambda: False, raising=False)
    monkeypatch.setattr(gen_phrase, "start_band",
                        lambda _s, merged, *_b: [(w, r + 1) for w, r, _ in merged])
    merged = [("chien", 0, 0.9), ("courir", 1, 0.8), ("beau", 2, 0.7)]
    picked = {gen_phrase.choose_start("chat", merged, {}, {}, band=(1, 3),
                                      band_filter=lambda band: [b for b in band if b[0] != "courir"])
              for _ in range(20)}
    assert picked <= {"chien", "beau"}


# --- the judge is the DEFAULT for a French sentence (user-decided 2026-09-20) ---------
def test_a_french_run_without_a_key_dies_before_any_walk_unless_static(monkeypatch, capsys):
    monkeypatch.delenv("JEV_API_KEY", raising=False)
    args = type("A", (), {"contextual_replay": None, "contextual_model": "jev-latest",
                          "before": None, "after": None})()
    with pytest.raises(SystemExit):
        gen_phrase.build_contextual_ranker(args, "fr", "une phrase", ["a"])
    assert "JEV_API_KEY" in capsys.readouterr().err
    # --static is the explicit opt-out; en never builds a judge (main's rule)


def test_a_replay_on_english_is_refused(capsys):
    args = type("A", (), {"contextual_replay": "x.json", "contextual_model": "jev-latest",
                          "before": None, "after": None})()
    with pytest.raises(SystemExit):
        gen_phrase.build_contextual_ranker(args, "en", "a sentence", ["a"])
    assert "français" in capsys.readouterr().err


# --- the sentence pre-filter (scored on one whole book, 2026-09-20; not yet wired) ------
def test_score_sentences_asks_the_three_questions_per_sentence_and_keeps_order():
    judge = FilteringJudge({"phrases[0]` : La phrase se comprend": 0.2, "phrases[1]` : La phrase porte": 0.95})
    scores = cr.score_sentences(judge, ["a b c", "d e f", "g h i"], per_request=2)
    assert len(scores) == 3 and set(scores[0]) == {"autonome", "image", "celebre"}
    assert scores[0]["autonome"] == 0.2 and scores[1]["image"] == 0.95
    assert len(judge.noul_calls) == 2 and judge.noul_calls[1][0]["phrases"] == ["g h i"]


def test_sentence_filter_is_loose_and_removes_only_the_unreadable_the_flat_and_the_famous():
    ok = {"autonome": 0.4, "image": 0.31, "celebre": 0.5}
    assert cr.sentence_passes(ok)
    assert not cr.sentence_passes({**ok, "autonome": 0.3})
    assert not cr.sentence_passes({**ok, "image": 0.2})
    assert not cr.sentence_passes({**ok, "celebre": 0.7})
