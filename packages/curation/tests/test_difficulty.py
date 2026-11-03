"""CONTRACT: the difficulty forecast (user-decided 2026-10-22). Each hidden word is read once
per sample from what players will see — the line with its starts, the true line, its start
and the nearest words of its map — the answers kept by the question's hash and averaged in log
tries; code fits those reads on the played days (recent days weighing more, English as the
French fit plus an offset) and turns a day's reads into real-play numbers, clipped to the play
record's caps."""

from datetime import date, timedelta
import json
import math
import random

import pytest

import _paths
import difficulty
import llm


# --- what one hidden word is read on -------------------------------------------------------

# « l'ours dort près du feu, l'ours rêve. »: « ours » hidden twice, « feu » and « rêve » once,
# each hole keeping the text glued to its word.
_PUZZLE = {
    "lang": "fr",
    "words": ["l'ours", "dort", "près", "du", "feu,", "l'ours", "rêve."],
    "holes": [
        {"pos": 0, "secret": {"word": "ours", "slug": "ours"}, "start": {"word": "loup", "slug": "loup"},
         "start_rank": 120, "prefix": "l'"},
        {"pos": 4, "secret": {"word": "feu", "slug": "feu"}, "start": {"word": "braise", "slug": "braise"},
         "start_rank": 150, "suffix": ","},
        {"pos": 5, "secret": {"word": "ours", "slug": "ours"}, "start": {"word": "loup", "slug": "loup"},
         "start_rank": 120, "prefix": "l'"},
        {"pos": 6, "secret": {"word": "rêve", "slug": "reve"}, "start": {"word": "songe", "slug": "songe"},
         "start_rank": 130, "suffix": "."},
    ],
    "ranks": {
        "ours": {"ours": {"word": "ours", "rank": 0}, "ourse": {"word": "ourse", "rank": 1},
                 "ourses": {"word": "ourses", "rank": 1},           # a second key of rank 1: its word is not shown
                 **{f"w{i}": {"word": f"w{i}", "rank": i} for i in range(2, 30)}},
        "feu": {"feu": {"word": "feu", "rank": 0}, "flamme": {"word": "flamme", "rank": 1}},
        "reve": {"reve": {"word": "rêve", "rank": 0}, "songe": {"word": "songe", "rank": 130}},
    },
}


def test_a_map_s_nearest_are_its_first_fifteen_ranks_each_under_its_first_key_s_word():
    near = difficulty.nearest(_PUZZLE["ranks"]["ours"])
    assert difficulty.TOP_N == 15 and len(near) == 15
    assert near[:3] == [(1, "ourse"), (2, "w2"), (3, "w3")] and near[-1] == (15, "w15")   # rank 0 left out


def test_the_material_is_the_line_as_first_seen_and_as_true_this_word_marked_at_every_occurrence():
    m = difficulty.material(_PUZZLE, "ours")
    assert m["seen"] == "l'[>> loup <<] dort près du [braise], l'[>> loup <<] [songe]."
    assert m["true"] == "l'{>> ours <<} dort près du {feu}, l'{>> ours <<} {rêve}."
    assert (m["secret"], m["start"], m["start_rank"]) == ("ours", "loup", 120)
    assert m["top"] == difficulty.nearest(_PUZZLE["ranks"]["ours"])
    other = difficulty.material(_PUZZLE, "reve")
    assert other["seen"] == "l'[loup] dort près du [braise], l'[loup] [>> songe <<]."
    assert other["true"] == "l'{ours} dort près du {feu}, l'{ours} {>> rêve <<}."


def test_a_played_day_is_read_on_the_nearest_words_its_record_carries():
    played = {**{k: v for k, v in _PUZZLE.items() if k != "ranks"}, "nearest": {"ours": [[1, "ourse"], [2, "grizzli"]]}}
    assert difficulty.material(played, "ours")["top"] == [(1, "ourse"), (2, "grizzli")]


def test_a_puzzle_s_hidden_words_are_its_distinct_secrets_in_the_line_s_order():
    assert difficulty.secrets(_PUZZLE) == ["ours", "feu", "reve"]


_MATERIAL = {"secret": "ours", "start": "loup", "start_rank": 120, "seen": "l'[>> loup <<] dort",
             "true": "l'{>> ours <<} dort", "top": [(1, "ourse"), (2, "grizzli")]}


def test_the_prompt_shows_the_true_line_the_line_as_seen_the_start_and_the_nearest_words():
    prompt = llm.difficulty_prompt(_MATERIAL, lang="fr")
    assert "THE HIDDEN WORD (French)" in prompt
    assert "  line: « l'{>> ours <<} dort »\n  players first saw: « l'[>> loup <<] dort »" in prompt
    assert "  hidden word: « ours »; its start « loup » at rank 120" in prompt
    assert "  nearest on its map: 1 ourse, 2 grizzli" in prompt


def test_only_an_english_prompt_names_its_players():
    audience = "its players come from every English-speaking country"
    assert audience in llm.difficulty_prompt(_MATERIAL, lang="en")
    assert audience not in llm.difficulty_prompt(_MATERIAL, lang="fr")


def test_the_question_is_worded_as_it_was_calibrated():
    # The answers seed the calibration, kept by the prompt's sha256: a change here is a new
    # question, and `pnpm curate --calibrate` must read every played day again.
    assert difficulty.key_of(llm.difficulty_prompt(_MATERIAL, lang="fr")) == \
        "5917bb3ec66caa7e5cd2efc7c97566613cf913c3fe3ddf5daad442e1a211cfcd"
    assert difficulty.key_of(llm.difficulty_prompt(_MATERIAL, lang="en")) == \
        "85ea73ce3c59a8a80750bbf08886a457e395811cf869cc1de0ef017036e5bdfe"


# --- the answer, and the read --------------------------------------------------------------

class _Claude:
    """A model answering `answers` in turn, counting the questions."""

    def __init__(self, *answers):
        self.answers, self.calls = list(answers), 0

    def json(self, _prompt):
        self.calls += 1
        return self.answers.pop(0)


def _says(tries, found=0.5):
    return {"typical_tries": tries, "found_within_30": found, "why": "w"}


@pytest.mark.parametrize("answer, kept", [
    (_says(5, 0.6), True),
    (_says(1, 0), True),
    (_says(20, 1), True),
    (_says("5"), False),                  # not a number
    (_says(True), False),                 # a boolean is no number
    (_says(5, False), False),
    (_says(0.5), False),                  # tries outside 1 to 20
    (_says(21), False),
    (_says(5, -0.1), False),              # a share outside 0 to 1
    (_says(5, 1.1), False),
    ({"typical_tries": 5}, False),
    ([5, 0.5], False),
])
def test_an_answer_is_kept_only_with_its_tries_from_1_to_20_and_its_share_from_0_to_1(answer, kept):
    got = llm.hole_difficulty(_Claude(answer), "q")
    assert (got is not None) == kept
    if kept:
        assert got == {"typical_tries": float(answer["typical_tries"]),
                       "found_within_30": float(answer["found_within_30"]), "why": "w"}


def test_a_read_is_the_mean_of_its_samples_log_tries():
    assert difficulty.SAMPLES == 2
    claude = _Claude(_says(4), _says(9))
    assert difficulty.read(claude, _MATERIAL, "fr") == pytest.approx(math.log(6))   # the geometric mean
    assert claude.calls == 2


def test_a_kept_answer_is_never_asked_again():
    first = difficulty.read(_Claude(_says(4), _says(9)), _MATERIAL, "fr")
    difficulty._answers = None                   # a later process: the answers come off the file
    rows = [json.loads(r) for r in _paths.READS_FILE.read_text(encoding="utf-8").splitlines()]
    assert [(r["key"], r["sample"]) for r in rows] == [(difficulty.key_of(llm.difficulty_prompt(_MATERIAL, lang="fr")),
                                                       s) for s in (0, 1)]
    assert difficulty.read(_Claude(), _MATERIAL, "fr") == first          # nothing asked: no answer left to give
    assert difficulty.read(None, _MATERIAL, "fr") == first
    # another language is another question
    assert difficulty.read(None, _MATERIAL, "en") is None


def test_without_a_model_a_read_missing_a_sample_is_none():
    assert difficulty.read(None, _MATERIAL, "fr") is None
    claude = _Claude(_says(4), None, None)         # the second sample has no usable answer, asked twice
    assert difficulty.read(claude, _MATERIAL, "fr") is None and claude.calls == 3
    assert difficulty.read(None, _MATERIAL, "fr") is None        # the first sample alone is kept


def test_an_unusable_answer_is_asked_once_more():
    claude = _Claude({"typical_tries": "many"}, _says(5), _says(5))
    assert difficulty.read(claude, _MATERIAL, "fr") == pytest.approx(math.log(5)) and claude.calls == 3


def test_a_puzzle_s_reads_are_by_slug_and_none_when_one_word_has_none():
    claude = _Claude(*[_says(t) for t in (2, 2, 8, 8, 4, 4)])
    assert difficulty.reads(claude, _PUZZLE, "fr") == pytest.approx(
        {"ours": math.log(2), "feu": math.log(8), "reve": math.log(4)})
    assert claude.calls == 6                     # « ours », twice in the line, is read once
    difficulty._answers = None
    _paths.READS_FILE.unlink()
    assert difficulty.reads(_Claude(_says(2), _says(2), None, None), _PUZZLE, "fr") is None


# --- the calibration, on played days -------------------------------------------------------

LATEST = date(2026, 10, 20)


def _day(age, rs, *, intercept=0.5, players=10, lang="fr"):
    """A played day `age` days before LATEST whose numbers follow its reads `rs` exactly: its log
    tries to finish 0.5 + 0.7·hardest + 0.2·second (plus `intercept` − 0.5), its share finished
    0.9 − 0.1·hardest − 0.05·second; each word's log tries 0.3 + 0.9·read, found within 30 by
    1 − 0.15·read."""
    h, s = sorted(rs.values(), reverse=True)[:2]
    return ({"day": (LATEST - timedelta(days=age)).isoformat(), "lang": lang, "players": players,
             "logTries30": intercept + 0.7 * h + 0.2 * s, "finished": 0.9 - 0.1 * h - 0.05 * s,
             "found": {k: {"logTries20": 0.3 + 0.9 * r, "within30": 1.0 - 0.15 * r} for k, r in rs.items()}}, rs)


def _days(n, ages=None, seed=1, **kw):
    rng = random.Random(seed)
    return [_day(age, {k: rng.uniform(0.5, 3.0) for k in "abc"}, **kw) for age in (ages or range(n))]


def test_the_fit_recovers_a_known_truth():
    cal = difficulty.fit(_days(20))
    assert cal.day_tries.coef == pytest.approx((0.5, 0.7, 0.2)) and cal.day_tries.rmse == pytest.approx(0, abs=1e-9)
    assert cal.day_finished.coef == pytest.approx((0.9, -0.1, -0.05))
    assert cal.word_tries.coef == pytest.approx((0.3, 0.9)) and cal.word_within.coef == pytest.approx((1.0, -0.15))
    assert (cal.days, cal.latest, cal.english) == (20, LATEST.isoformat(), None)


def test_a_fit_needs_min_days_french_days():
    assert difficulty.MIN_DAYS == 10
    assert difficulty.fit(_days(difficulty.MIN_DAYS - 1)) is None
    assert difficulty.fit(_days(difficulty.MIN_DAYS)) is not None


def test_recent_days_count_more(monkeypatch):
    # the players changed: days a hundred days back, read alike, played one log try easier
    # than the latest
    old = _days(10, ages=range(100, 110), intercept=0.0)
    new = _days(10, ages=range(10), intercept=1.0)
    assert difficulty.HALF_LIFE_DAYS == 30
    weighed = difficulty.fit(old + new).day_tries.coef[0]
    monkeypatch.setattr(difficulty, "HALF_LIFE_DAYS", 1e9)             # every day alike
    flat = difficulty.fit(old + new).day_tries.coef[0]
    assert flat == pytest.approx(0.5, abs=0.05) and weighed > 0.85


def test_the_english_offset_is_how_much_harder_english_words_played_on_days_of_three_players_or_more():
    english = [({"day": "2026-10-19", "lang": "en", "players": 3,
                 "found": {"a": {"logTries20": 0.3 + 0.9 * 1.0 + 0.4}, "b": {"logTries20": 0.3 + 0.9 * 2.0 + 0.4}}},
                {"a": 1.0, "b": 2.0}),
               ({"day": "2026-10-18", "lang": "en", "players": 2,               # too few players: left out
                 "found": {"a": {"logTries20": 9.0}}}, {"a": 1.0})]
    assert difficulty.fit(_days(20), english).english == pytest.approx(0.4)


def _calibration(english=None):
    """A calibration with a spread: a word's log tries = its read, found within 30 by
    1.2 − 0.3·read (± 0.1)."""
    fit = difficulty.Fit
    return difficulty.Calibration(word_tries=fit((0.0, 1.0), 0.3), word_within=fit((1.2, -0.3), 0.1),
                                  day_tries=fit((0.0, 0.8, 0.4), 0.3), day_finished=fit((1.4, -0.2, -0.1), 0.1),
                                  english=english, days=20, latest=LATEST.isoformat())


def test_an_english_forecast_reads_harder_by_the_offset_and_says_it_is_not_calibrated_on_english_players():
    rs = [1.0, 1.5, 2.0]
    fr = difficulty.forecast(_calibration(0.4), rs, "fr")
    en = difficulty.forecast(_calibration(0.4), rs, "en")
    assert fr["calibrated"] is True and en["calibrated"] is False
    for w_en, w_fr in zip(en["words"], fr["words"]):
        assert math.log(w_en["tries"]) - math.log(w_fr["tries"]) == pytest.approx(0.4)
    assert en["tries"] > fr["tries"] and en["finished"] < fr["finished"]


@pytest.mark.parametrize("rs", [[50.0, 50.0, 50.0], [-50.0, -50.0, -50.0]])
def test_a_forecast_stays_inside_the_play_record_s_caps(rs):
    fc = difficulty.forecast(_calibration(), rs, "fr")
    cap = lambda n: n + 1e-9                     # clipped in log tries: e^(ln 30) is 30 to the last bit
    assert 1 <= fc["low"] <= fc["tries"] <= fc["high"] <= cap(difficulty.DAY_CAP) and difficulty.DAY_CAP == 30
    assert 0 <= fc["finished_low"] <= fc["finished"] <= fc["finished_high"] <= 1
    assert all(1 <= w["tries"] <= cap(difficulty.HOLE_CAP) and 0 <= w["wall"] <= 1 for w in fc["words"])
    assert difficulty.HOLE_CAP == 20


def test_a_word_s_wall_chance_rises_with_its_read():
    walls = [w["wall"] for w in difficulty.forecast(_calibration(), [0.5, 1.5, 2.0, 2.5, 3.5], "fr")["words"]]
    assert walls == sorted(walls) and len(set(walls)) == len(walls)
    assert walls[0] < 0.01 and walls[-1] > 0.99      # found within 30 by 1.05, then by 0.15


def _fc(high, calibrated=True):
    return {"tries": 12, "low": 6, "high": high, "finished": 0.6, "finished_low": 0.4, "finished_high": 0.8,
            "words": [{"tries": 8, "wall": 0.1}, {"tries": 18, "wall": 0.7}], "calibrated": calibrated}


def test_a_forecast_in_words_names_each_word_and_prints_the_cap_as_30_plus():
    line = difficulty.describe(_fc(30), ["ours", "feu"])
    assert line == ("a typical player finishes in about 12 tries (6 to 30+), 60% of the players finish (40% to 80%); "
                    "« ours » about 8 tries, 10% chance most players never find it; « feu » about 18 tries, 70% "
                    "chance most players never find it")
    assert "(6 to 20)" in difficulty.describe(_fc(20), ["ours", "feu"])
    assert difficulty.describe(_fc(20, calibrated=False), ["ours", "feu"]).endswith(
        " — calibrated on French players, not English ones")


def test_a_blind_forecast_names_the_words_by_their_place_in_the_line():
    rs = {"ours": 1.0, "feu": 2.0, "reve": 1.5}
    blind = difficulty.text(_calibration(), _PUZZLE, rs, "fr", blind=True)
    assert "« word 1 »" in blind and "« word 3 »" in blind and "ours" not in blind
    assert "« ours »" in difficulty.text(_calibration(), _PUZZLE, rs, "fr")
    assert difficulty.text(None, _PUZZLE, rs, "fr") is None and difficulty.text(_calibration(), _PUZZLE, None, "fr") is None


def test_the_drift_is_the_fit_on_older_days_checked_on_the_latest_ones():
    # the latest days played 0.3 log tries harder than the fit on the older ones says
    older = _days(12, ages=range(40, 52))
    latest = _days(5, ages=range(5), seed=3, intercept=0.8)
    assert difficulty.DRIFT_DAYS == 28
    check = difficulty.drift(older + latest)
    assert check["n"] == 5
    assert check["bias"] == pytest.approx(-0.3) and check["rmse"] == pytest.approx(0.3)
    assert check["finished_bias"] == pytest.approx(0)


def test_no_drift_when_either_side_is_too_thin():
    assert difficulty.drift([]) is None
    assert difficulty.drift(_days(12, ages=range(40, 52))) is None                       # nothing newer
    assert difficulty.drift(_days(9, ages=range(40, 49)) + _days(5, seed=3)) is None     # too few older


def test_the_played_days_are_read_from_the_record_and_a_day_with_an_unread_word_is_counted_apart():
    record = [{**{k: v for k, v in _PUZZLE.items() if k != "ranks"}, "day": d, "lang": lang,
               "nearest": {s: difficulty.nearest(_PUZZLE["ranks"][s]) for s in _PUZZLE["ranks"]}}
              for d, lang in (("2026-10-02", "fr"), ("2026-10-01", "fr"), ("2026-10-01", "en"))]
    _paths.PLAY_RECORD.parent.mkdir(parents=True, exist_ok=True)
    _paths.PLAY_RECORD.write_text("\n".join(json.dumps(d, ensure_ascii=False) for d in record) + "\n", encoding="utf-8")
    assert [(d["day"], d["lang"]) for d in difficulty.played()] == [("2026-10-01", "en"), ("2026-10-01", "fr"),
                                                                    ("2026-10-02", "fr")]
    assert [d["day"] for d in difficulty.played("fr")] == ["2026-10-01", "2026-10-02"]
    # « ours » and « rêve » read, « feu » not: nothing is asked without a model
    for s, t in (("ours", 2), ("reve", 4)):
        difficulty.read(_Claude(_says(t), _says(t)), difficulty.material(record[0], s), "fr")
    assert difficulty.read_played(None, "fr") == ([], 2)
    difficulty.read(_Claude(_says(8), _says(8)), difficulty.material(record[0], "feu"), "fr")
    days, missing = difficulty.read_played(None, "fr")
    assert missing == 0 and [d["day"] for d, _ in days] == ["2026-10-01", "2026-10-02"]
    assert days[0][1] == pytest.approx({"ours": math.log(2), "feu": math.log(8), "reve": math.log(4)})
