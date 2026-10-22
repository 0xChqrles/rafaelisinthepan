"""CONTRACT: the curator's two Jev questions, the sentence filter and the giveaway.

  - every question is asked in the line's language: French byte-for-byte the calibrated
    requests, English its twin with its own state keys (#317);
  - the sentence filter asks its three questions per sentence and keeps reading order;
    it is loose, and removes only the unreadable, the flat and the famous;
  - the giveaway is the mean of its three questions on the blanked sentence;
  - a judge that cannot answer is a hard error, never a guess: a throttled or
    unreachable service is retried with capped backoff, any other refusal is not.
"""

import io
import itertools
import json
import sys
import urllib.error

import pytest

import jev


class FilteringJudge:
    """A judge that answers yes/no: P(yes) looked up by the words in the question (the
    sentence asked about, or the question itself), so a test states each verdict outright."""

    def __init__(self, yes):
        self.yes = yes          # substring of the question -> probability
        self.noul_calls = []

    def noul(self, state, questions):
        self.noul_calls.append((state, questions))
        return {key: next((p for needle, p in self.yes.items() if needle in instructions), 0.9)
                for key, (instructions, _t, _f) in questions.items()}


# --- the request: French byte-for-byte the calibrated one -----------------------------------
def test_a_french_giveaway_sends_the_calibrated_request_byte_for_byte(monkeypatch):
    sent = []

    def urlopen(request, timeout):
        sent.append(request.data)
        return io.BytesIO(json.dumps({"answers": {k: {"noul": 0.5} for k in ("exact", "syn", "colloc")},
                                      "usage": {}}).encode("utf-8"))
    monkeypatch.setattr(jev.urllib.request, "urlopen", urlopen)
    assert jev.giveaway(jev.JevJudge("k"), "le _____ se faisait", "silence", lang="fr") == pytest.approx(0.5)
    calibrated = (
        '{"state": {"phrase_a_trou": "le _____ se faisait", "mot": "silence"}, "model": "jev-latest", '
        '"questions": {"exact": {"type": "noul", "instructions": "Un lecteur qui lit `phrase_a_trou` sans aucun '
        'autre indice écrirait-il spontanément le mot `mot` (ou une de ses formes) dans le blanc ?", "criteria": '
        '{"true": "La plupart des lecteurs écriraient ce mot", "false": "Les lecteurs écriraient autre chose, ou '
        'hésiteraient entre des mots très différents"}}, "syn": {"type": "noul", "instructions": "Un lecteur qui '
        'lit `phrase_a_trou` sans aucun autre indice écrirait-il spontanément le mot `mot` OU un synonyme direct '
        'de ce mot dans le blanc ?", "criteria": {"true": "La plupart des lecteurs écriraient ce mot ou un '
        'synonyme direct", "false": "Les lecteurs écriraient des mots d\'un autre sens, ou hésiteraient entre des '
        'idées différentes"}}, "colloc": {"type": "noul", "instructions": "Dans `phrase_a_trou`, les mots voisins '
        'du blanc forment-ils avec `mot` une expression figée ou une association très fréquente qui le rend '
        'presque automatique ?", "criteria": {"true": "Oui, l\'expression ou l\'association appelle ce mot", '
        '"false": "Non, beaucoup de mots différents iraient aussi bien"}}}}')
    assert sent == [calibrated.encode("utf-8")]


def test_a_french_sentence_filter_sends_the_calibrated_questions():
    judge = FilteringJudge({})
    jev.score_sentences(judge, ["Le chat dort."], lang="fr")
    state, questions = judge.noul_calls[0]
    assert state == {"phrases": ["Le chat dort."]}
    assert questions == {
        "autonome0": ("Pour la phrase `phrases[0]` : La phrase se comprend-elle seule, sans le texte qui l'entoure ?",
                      "On saisit la scène ou l'idée sans rien d'autre",
                      "Elle dépend d'un antécédent, d'un nom propre ou d'un fait absent"),
        "image0": ("Pour la phrase `phrases[0]` : La phrase porte-t-elle une image concrète ou un retournement ?",
                   "Une image, une chute ou une tension qu'on a envie de partager",
                   "Plate, abstraite ou purement descriptive"),
        "celebre0": ("Pour la phrase `phrases[0]` : Est-ce une citation célèbre, largement connue et reprise ?",
                     "Une phrase-culte qu'un lecteur reconnaît", "Une phrase ordinaire de l'œuvre")}


# --- the wire: retries, refusals, usage (a judge that cannot answer is a HARD error) ----
def _wire(monkeypatch, outcomes):
    """Script the judge's HTTP: each request takes the next of `outcomes` — a dict is
    the JSON body answered, an exception is raised. Returns (requests sent, waits
    asked for); nothing is sent and nothing sleeps."""
    outcomes = iter(outcomes)
    sent, waits = [], []

    def urlopen(request, timeout):
        sent.append(request)
        outcome = next(outcomes)
        if isinstance(outcome, Exception):
            raise outcome
        return io.BytesIO(json.dumps(outcome).encode("utf-8"))
    monkeypatch.setattr(jev.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(jev.time, "sleep", waits.append)
    return sent, waits


def _refusal(code):
    return urllib.error.HTTPError(jev.JEV_URL, code, "refused", {}, io.BytesIO(b"no"))


ANSWER = {"answers": {"c0": {"noul": 0.5}}, "usage": {"input_tokens": 7, "output_tokens": 1}}


@pytest.mark.parametrize("hiccup", [lambda: _refusal(429), lambda: _refusal(529),
                                    lambda: urllib.error.URLError("connection reset")],
                         ids=["429", "529", "transport"])
def test_a_throttled_or_unreachable_judge_is_retried_and_the_answer_counted_once(
        monkeypatch, hiccup):
    sent, waits = _wire(monkeypatch, [hiccup(), ANSWER])
    judge = jev.JevJudge("k")
    assert judge._call({}, {}) == ANSWER["answers"]
    assert len(sent) == 2 and len(waits) == 1
    assert judge.requests == 1
    assert judge.usage == {"input_tokens": 7, "output_tokens": 1}


def test_a_refused_request_is_a_hard_error_without_a_retry(monkeypatch):
    sent, waits = _wire(monkeypatch, [_refusal(400), ANSWER])
    judge = jev.JevJudge("k")
    with pytest.raises(jev.JevError, match="400"):
        judge._call({}, {})
    assert len(sent) == 1 and waits == []
    assert judge.requests == 0


def test_a_judge_that_stays_down_is_a_hard_error_once_every_try_is_spent(monkeypatch):
    sent, waits = _wire(monkeypatch, (urllib.error.URLError("down") for _ in itertools.count()))
    judge = jev.JevJudge("k")
    with pytest.raises(jev.JevError, match="unreachable"):
        judge._call({}, {}, tries=4)
    assert len(sent) == 4 and len(waits) == 3  # no wait after the last try
    # throttled to the end is the same hard error
    sent, waits = _wire(monkeypatch, (_refusal(429) for _ in itertools.count()))
    with pytest.raises(jev.JevError, match="429"):
        judge._call({}, {}, tries=4)
    assert len(sent) == 4 and len(waits) == 3
    # the backoff grows, then stops growing: it is capped
    sent, waits = _wire(monkeypatch, (urllib.error.URLError("down") for _ in itertools.count()))
    with pytest.raises(jev.JevError):
        judge._call({}, {})
    assert len(sent) == len(waits) + 1
    assert waits == sorted(waits) and waits[0] < waits[-1] == waits[-2]
    assert judge.requests == 0


def test_token_usage_is_exact_when_the_worker_threads_report_together(monkeypatch):
    # Every request reports one token each way, from WORKERS threads at once. The
    # switch interval is shortened so that counters updated without a guard lose some.
    body = json.dumps({"answers": {}, "usage": {"input_tokens": 1, "output_tokens": 1}})
    monkeypatch.setattr(jev.urllib.request, "urlopen",
                        lambda request, timeout: io.BytesIO(body.encode("utf-8")))
    judge = jev.JevJudge("k")
    interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    try:
        judge._batched(list(range(4000)), 1, lambda _batch: [judge._call({}, {})])
    finally:
        sys.setswitchinterval(interval)
    assert judge.requests == 4000
    assert judge.usage == {"input_tokens": 4000, "output_tokens": 4000}


def test_noul_batches_its_questions_and_keeps_every_key(monkeypatch):
    judge = jev.JevJudge("k", workers=2)
    seen = []

    def fake_call(state, questions):
        seen.append(questions)
        return {k: {"noul": int(k[1:]) / 100} for k in questions}
    monkeypatch.setattr(judge, "_call", fake_call)
    monkeypatch.setattr(jev, "NOUL_BATCH", 3)
    questions = {f"q{i}": (f"question {i}", "yes", "no") for i in range(7)}
    assert judge.noul({"phrases": []}, questions) == {f"q{i}": i / 100 for i in range(7)}
    assert sorted(len(batch) for batch in seen) == [1, 3, 3]          # the batches run on worker threads
    first = next(batch for batch in seen if "q1" in batch)
    assert first["q1"] == {"type": "noul", "instructions": "question 1", "criteria": {"true": "yes", "false": "no"}}


def test_jev_judge_refuses_to_exist_without_a_key():
    with pytest.raises(jev.JevError):
        jev.JevJudge("")
    with pytest.raises(jev.JevError):
        jev.read_api_key({})
    assert jev.read_api_key({"JEV_API_KEY": " abc "}) == "abc"


# --- English: the same questions in English, with English state keys (#317) -----------
def test_every_template_speaks_its_own_state_keys():
    for lang in jev.LANGUAGES.values():
        texts = " ".join([lang.sentence_prefix] + [q for q, _t, _f in lang.giveaway_questions.values()])
        for role in ("sentences", "blanked", "word"):
            assert f"`{lang.keys[role]}" in texts, (lang.code, role)
        assert set(lang.sentence_questions) == set(jev.SENTENCE_KEYS)
        assert set(lang.giveaway_questions) == {"exact", "syn", "colloc"}


def test_the_english_sentence_filter_asks_in_english():
    judge = FilteringJudge({})
    jev.score_sentences(judge, ["the rain fell on the old roof."], lang="en")
    state, questions = judge.noul_calls[0]
    assert state == {"sentences": ["the rain fell on the old roof."]}
    assert all(q.startswith("For the sentence `sentences[0]`: ") for q, _t, _f in questions.values())


def test_an_unknown_language_has_no_judge():
    with pytest.raises(jev.JevError):
        jev.language("de")


# --- the sentence pre-filter (scored on one whole book, 2026-09-20) ------------------------
def test_score_sentences_asks_the_three_questions_per_sentence_and_keeps_order():
    judge = FilteringJudge({"phrases[0]` : La phrase se comprend": 0.2, "phrases[1]` : La phrase porte": 0.95})
    scores = jev.score_sentences(judge, ["a b c", "d e f", "g h i"], lang="fr", per_request=2)
    assert len(scores) == 3 and set(scores[0]) == {"autonome", "image", "celebre"}
    assert scores[0]["autonome"] == 0.2 and scores[1]["image"] == 0.95
    assert len(judge.noul_calls) == 2 and judge.noul_calls[1][0]["phrases"] == ["g h i"]


def test_sentence_filter_is_loose_and_removes_only_the_unreadable_the_flat_and_the_famous():
    ok = {"autonome": 0.4, "image": 0.31, "celebre": 0.5}
    assert jev.sentence_passes(ok)
    assert not jev.sentence_passes({**ok, "autonome": 0.3})
    assert not jev.sentence_passes({**ok, "image": 0.2})
    assert not jev.sentence_passes({**ok, "celebre": 0.7})


# --- the giveaway measure (threshold calibrated on real play, 2026-09-22) ------------------
def test_giveaway_is_the_mean_of_the_three_questions_on_the_blanked_sentence():
    seen = []

    class J:
        def noul(self, state, questions):
            seen.append((state, questions))
            return {"exact": 0.9, "syn": 0.6, "colloc": 0.3}
    assert jev.giveaway(J(), "le ____ se faisait", "silence", lang="fr") == pytest.approx(0.6)
    assert seen[0][0] == {"phrase_a_trou": "le ____ se faisait", "mot": "silence"}
    assert set(seen[0][1]) == {"exact", "syn", "colloc"}
    assert jev.giveaway(J(), "the ____ fell", "rain", lang="en") == pytest.approx(0.6)
    assert seen[1][0] == {"blanked_sentence": "the ____ fell", "word": "rain"}
    assert seen[1][1] == jev.ENGLISH.giveaway_questions
