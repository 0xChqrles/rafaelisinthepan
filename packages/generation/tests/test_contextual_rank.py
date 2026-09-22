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

    def __init__(self, scores, truth=None, english=()):
        self.scores, self.truth = scores, scores if truth is None else truth
        self.english = set(english)  # labels the judge calls "not French"
        self.usage = {"input_tokens": 0, "output_tokens": 0}
        self.requests = 0
        self.model = "fake"
        self.calls = []

    def french(self, candidates):
        self.calls.append(("french", [c.label for c in candidates]))
        return [0.1 if c.label in self.english else 0.9 for c in candidates]

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


def test_flat_front_keeps_pairwise_order_and_replays_with_unchanged_geometry():
    scores = {"a": 3.0, "b": 3.0, "c": 3.0, "tied_tail": 3.0, "tail": 0.0}
    candidates = _cands(list(scores))
    judge = FakeJudge(scores, {"a": 1, "b": 2, "c": 3})
    ranked, record = cr.rerank(CTX, candidates, judge, pairwise_top=3)
    assert [r.label for r in ranked] == ["c", "b", "a", "tied_tail", "tail"]
    assert [r.similarity for r in ranked] == [3.0, 3.0, 3.0, 3.0, 0.0]
    replay = cr.ReplayJudge({"sentence": CTX.sentence, "before": [], "after": [],
                             "holes": [record]})
    again, _ = cr.rerank(CTX, candidates, replay, pairwise_top=3)
    assert again == ranked


def test_flat_front_equal_pairwise_verdicts_keep_static_tie_break():
    judge = FakeJudge({"a": 3.0, "b": 3.0, "c": 3.0, "tail": 0.0})
    ranked, _ = cr.rerank(CTX, _cands(list(judge.scores)), judge, pairwise_top=3)
    assert [r.label for r in ranked] == ["a", "b", "c", "tail"]


def test_flat_front_demotions_do_not_keep_pairwise_priority():
    scores = {"a": 3.0, "b": 3.0, "c": 3.0, "tail": 0.0}
    judge = FakeJudge(scores, {"a": 1, "b": 2, "c": 3}, english={"b", "c"})
    ranked, _ = cr.rerank(CTX, _cands(list(scores)), judge, pairwise_top=3)
    assert [r.label for r in ranked] == ["a", "b", "c", "tail"]
    assert [r.similarity for r in ranked] == [3.0, 0.0, 0.0, 0.0]


def test_a_front_label_that_is_not_french_is_demoted_to_the_tail_and_recorded():
    judge = FakeJudge({"retirement": 4.0, "pension": 3.0, "cotiser": 1.0}, english={"retirement"})
    ranked, rec = cr.rerank(CTX, _cands(["retirement", "pension", "cotiser"]), judge, pairwise_top=3)
    assert [r.label for r in ranked] == ["pension", "cotiser", "retirement"]
    assert ranked[-1].demoted and ranked[-1].similarity == 0.0
    assert rec["demoted"] == ["retirement"]
    assert rec["french"] == {"retirement:nc": 0.1, "pension:nc": 0.9, "cotiser:nc": 0.9}
    # only the front is asked
    judge = FakeJudge({"a": 3.0, "b": 2.0, "c": 1.0}, english={"c"})
    ranked, rec = cr.rerank(CTX, _cands(["a", "b", "c"]), judge, pairwise_top=2)
    assert [c for c in judge.calls if c[0] == "french"] == [("french", ["a", "b"])]
    assert not ranked[-1].demoted and "c:nc" not in rec["french"]


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


def test_jev_judge_asks_the_french_question_once_per_front_label(monkeypatch):
    judge = cr.JevJudge("k")
    seen = []
    monkeypatch.setattr(judge, "_call", lambda state, qs: seen.append((state, qs)) or
                        {k: {"type": "noul", "noul": 0.15 if "feeling" in qs[k]["instructions"] else 0.9} for k in qs})
    assert judge.french(_cands(["apparent", "feeling"])) == [0.9, 0.15]
    assert seen[0][0] == {"mots": ["apparent", "feeling"]} and len(seen[0][1]) == 2


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
    again, rec2 = cr.rerank(CTX, _cands(list(scores)), replay, pairwise_top=3)
    assert [r.label for r in again] == [r.label for r in ranked]
    assert rec2["french"] == rec["french"]  # the verdicts replay too
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
@pytest.mark.parametrize("repeated", [False, True])
def test_interactive_contextual_selection_without_inflection(monkeypatch, capsys,
                                                            with_resolver, repeated):
    import termios
    import tty
    from types import SimpleNamespace

    words = ["chat", "chien", "tigre"]
    ranking = [("félin", 0, .9), ("minou", 1, .8), ("loup", 2, .7)]
    cfg = gen_phrase.CONFIG["fr"].copy()
    cfg["module"] = SimpleNamespace(closest=lambda *a, **kw: ranking)
    judge = FakeJudge({"félin": 1.0, "minou": 3.0, "loup": .5})
    ranker = _ranker(judge)
    if repeated:
        words.append("chat.")
        # One occurrence is rejected, but selecting the other must hide BOTH.
        monkeypatch.setattr(ranker, "filter_candidates",
                            lambda _words, cands: [c for c in cands if c["pos"] != 3])
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
    assert len(holes) == (4 if repeated else 3)
    if repeated:
        assert [(h["pos"], h.get("suffix", "")) for h in holes
                if h["secret"]["slug"] == "chat"] == [(0, ""), (3, ".")]
    assert len([c for c in judge.calls if c[0] == "score"]) == 3
    assert bands.count(ranker.band) == 3
    assert all(h["start"]["word"] == "minou" for h in holes)
    assert all(rmap["minou"]["rank"] == 1 for rmap in ranks.values())
    assert len(ranker.records) == 3


@pytest.mark.parametrize("authoring", ["interactive", "batch", "explicit"])
def test_start_judge_reads_realized_forms_in_each_authoring_path(monkeypatch, authoring):
    import termios
    import tty
    from types import SimpleNamespace
    from test_inflect import TABLE

    words = ["grands", "évidents", "rouges"]
    vocab = words + ["jardin", "jardins", "lent", "pensée", "pensées"]
    lemmas = {"grands": ("grand:adj",), "évidents": ("évident:adj",),
              "rouges": ("rouge:nc",), "jardin": ("jardin:nc",),
              "jardins": ("jardin:nc",), "lent": ("lent:adj",),
              "pensée": ("pensée:nc",), "pensées": ("pensée:nc",)}
    families = gen_phrase.invert_lemmas(lemmas)
    donors = gen_phrase.DonorResolver(lemmas, families, vocab, set(vocab), "fr")
    forms = gen_phrase.FormResolver(
        TABLE, explicit={gen_phrase.slug(w): "adj:m:p" for w in words},
        typable=donors.typable)
    ranking = [("jardin", 0, .9), ("lent", 1, .8), ("pensée", 2, .7)]
    cfg = gen_phrase.CONFIG["fr"].copy()
    cfg["module"] = SimpleNamespace(closest=lambda *a, **kw: ranking)
    judge = FakeJudge({"jardin": 3., "lent": 1., "pensée": .5})
    judged = []

    def noul(state, questions):
        if "variantes" in state and "phrase" not in state:
            judged.extend(state["variantes"])
            return {f"v{i}": 0.9 if "jardins" in sentence.split() else 0.1
                    for i, sentence in enumerate(state["variantes"])}
        return {k: 0.9 if k.startswith("v") else 0.1 for k in questions}

    monkeypatch.setattr(judge, "noul", noul, raising=False)
    ranker = gen_phrase.ContextualRanker(judge, " ".join(words), model="fake")
    monkeypatch.setattr(gen_phrase, "start_band",
                        lambda _s, merged, _band: [(w, r) for w, r, _ in merged])
    monkeypatch.setattr(gen_phrase.sys, "stdin", SimpleNamespace(fileno=lambda: 0, isatty=lambda: False))
    if authoring == "interactive":
        monkeypatch.setattr(termios, "tcgetattr", lambda _fd: None)
        monkeypatch.setattr(termios, "tcsetattr", lambda *a: None)
        monkeypatch.setattr(tty, "setcbreak", lambda _fd: None)
        monkeypatch.setattr("builtins.input", lambda _prompt="": "")
        keys = iter(["ENTER", "1", "ENTER"] * 3)
        monkeypatch.setattr(gen_phrase, "_read_key", lambda _fd: next(keys))
        holes, ranks = gen_phrase.select_holes_interactive(
            words, cfg, "fr", None, vocab, None, set(vocab), lemmas, families,
            donors, forms, contextual=ranker)
    else:
        holes, ranks = gen_phrase.holes_from_words(
            words, words, cfg, "fr", None, vocab, None, set(vocab), lemmas, families,
            donors, forms, contextual=ranker,
            starts={gen_phrase.slug(w): "jardin" for w in words} if authoring == "explicit" else None)
    assert judged and all("jardin" not in sentence.split() for sentence in judged)
    assert all(h["start"]["word"] == "jardins" for h in holes)
    assert all(ranks[h["secret"]["slug"]]["jardins"]["rank"] == h["start_rank"] for h in holes)


# --- through gen_phrase ------------------------------------------------------------
RANKING = [("chien", 0, 0.9), ("félin", 1, 0.8), ("minou", 2, 0.7), ("côté", 3, 0.6),
           ("coté", 4, 0.5), ("tigre", 5, 0.4)]


def _ranker(judge):
    return gen_phrase.ContextualRanker(judge, "il prit un chat avant de partir.", model="fake")


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


# --- every question before any walk (#308: a walk is minutes and money) --------------
def test_a_question_that_dies_on_the_second_secret_precedes_the_first_walk(monkeypatch):
    from test_donor import FORMS, FR, KV, START_SENTENCE, TABLE, VOCAB, VSET, _resolver, _words
    walked, asked = [], []
    monkeypatch.setattr(FR["module"], "closest",
                        lambda w, *_a, **_k: walked.append(w) or [], raising=False)
    monkeypatch.setattr(gen_phrase.sys.stdin, "isatty", lambda: False, raising=False)

    def claim(secret, *_a, **_k):  # the #133 question: the second secret has no answer
        asked.append(secret)
        if len(asked) == 2:
            gen_phrase.die("la forme de « x » doit être explicite hors mode interactif")
        return ()
    monkeypatch.setattr(gen_phrase, "secret_claim", claim)
    with pytest.raises(SystemExit):
        gen_phrase.holes_from_words(
            ["doucement", "jardin", "amuse"], _words(START_SENTENCE), FR, "fr",
            kv=KV, V=VOCAB, M=object(), Vset=VSET, lemma_table=TABLE,
            forms_by_lemma=FORMS, donors=_resolver(interactive=False))
    assert asked == ["doucement", "jardin"]
    assert walked == []  # no ranking was computed: no judge call would have been paid


# --- the giveaway measure (threshold calibrated on real play, 2026-09-22) ------------------
def test_giveaway_is_the_mean_of_the_three_questions_on_the_blanked_sentence():
    seen = []

    class J:
        def noul(self, state, questions):
            seen.append((state, questions))
            return {"exact": 0.9, "syn": 0.6, "colloc": 0.3}
    assert cr.giveaway(J(), "le ____ se faisait", "silence") == pytest.approx(0.6)
    assert seen[0][0] == {"phrase_a_trou": "le ____ se faisait", "mot": "silence"}
    assert set(seen[0][1]) == {"exact", "syn", "colloc"}
    assert 0 < cr.GIVEAWAY_MAX < 1
