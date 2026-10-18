"""The bank: a finished line kept as JSON comes back as the run held it, and a pull reads
it against today's archive."""

from datetime import date
import json

import pytest

import _paths
import bank
import curate
from rules import Token

SENTENCE = "The old dog sleeps under the warm stove"


def _tokens(sentence, lang):
    words = sentence.split()
    return [Token(i, w, w.lower(), "NOUN" if i in (2, 6, 7) else "ADJ" if i in (1, 5) else "VERB" if i == 3
                  else "DET", w.lower(), stop=i in (0, 4, 5)) for i, w in enumerate(words)]


@pytest.fixture
def fake_parse(monkeypatch, tmp_path):
    monkeypatch.setattr(bank, "parse", _tokens)
    monkeypatch.setattr(_paths, "BANK_DIR", tmp_path)


def _finished():
    tokens = _tokens(SENTENCE, "en")
    allowed = [t for t in tokens if t.slug in {"old", "dog", "sleeps", "stove", "warm"}]
    line = {"sentence": SENTENCE, "tokens": tokens, "allowed": allowed,
            "given": {"old": 0.3, "dog": 0.5, "sleeps": 0.4, "stove": 0.2, "warm": 0.35}, "pathless": []}
    measures = curate.Measures(readings={"dog": (["cat", "hound"], "cat")}, says={"dog": (0.8, None)},
                               crowds={"dog": 0.1}, neighbours={"dog": ("the old ___", "man")}, out={"old"})
    trio = [t for t in allowed if t.slug in ("dog", "sleeps", "stove")]
    checked = curate.Checked(trio, ["dog first"], 1, {"dog": "notes"}, {"dog": "medium"}, measures)
    return line, checked


def _archive(**over):
    return {"sentences": set(), "secrets": set(), "works": [], "pairs": {}, "last_used": {}, "last_music": None,
            **over}


def test_a_banked_line_comes_back_as_the_run_held_it(fake_parse):
    line, checked = _finished()
    book = {"file": "a.epub", "kind": "book", "author": "A", "title": "T"}
    bank.append("en", [bank.entry(book, line, checked)])
    [stored] = bank.load("en")
    assert json.loads(json.dumps(stored)) == stored
    restored, why = bank.restore(stored, _archive(), "en", lambda s: True, lambda t: None,
                                 curate.Measures, curate.Checked)
    assert why is None
    line2, checked2 = restored
    assert [t.slug for t in checked2.trio] == ["dog", "sleeps", "stove"]
    assert checked2.measures == checked.measures
    assert (checked2.chain, checked2.swaps, checked2.context, checked2.levels) == \
        (checked.chain, checked.swaps, checked.context, checked.levels)
    assert line2["given"] == line["given"]
    assert bank.works("en") == {"a.epub"}


def test_a_pull_skips_a_published_sentence_and_a_word_back_in_its_cooldown(fake_parse):
    line, checked = _finished()
    e = json.loads(json.dumps(bank.entry({"file": "a.epub", "kind": "book"}, line, checked)))
    args = ("en", lambda s: True, lambda t: None, curate.Measures, curate.Checked)
    published = _archive(sentences={bank.shelf_mod.sentence_key(SENTENCE)})
    assert bank.restore(e, published, *args)[0] is None
    restored, why = bank.restore(e, _archive(secrets={"stove"}), *args)
    assert restored is None and "stove" in why
    # a word the line gives no path to (under the floor) is never offered to a swap
    restored, _ = bank.restore(e, _archive(), *args)
    assert "stove" in {t.slug for t in restored[0]["allowed"]}
    e["given"]["warm"] = 0.0
    restored, _ = bank.restore(e, _archive(), *args)
    assert "warm" not in {t.slug for t in restored[0]["allowed"]}


def test_the_bank_keeps_the_calendar_s_mix_and_spreads_over_authors():
    today = date(2026, 10, 18)
    song = lambda f, a: {"file": f, "kind": "music", "author": a, "title": f}
    book = lambda f, a: {"file": f, "kind": "book", "author": a, "title": f}
    fresh = [song("s1", "X"), song("s2", "Y"), book("b1", "A"), book("b2", "B")]
    pick = lambda banked: curate.bank_pick(fresh, banked, _archive(), {"books": {}}, today)[0]
    assert pick([])["kind"] == "music"
    assert pick([song("s0", "X")])["kind"] == "book"
    # the song's turn: the artist with no banked song yet
    assert pick([song("s0", "X"), book("b0", "A"), book("b9", "C"), book("b8", "D")]) == song("s2", "Y")


def test_an_artist_s_next_song_waits_for_a_month_of_banked_works():
    today = date(2026, 10, 18)
    song = lambda f: {"file": f, "kind": "music", "author": "X", "title": f}
    book = lambda f: {"file": f, "kind": "book", "author": f, "title": f}
    fresh = [song("s1"), book("fresh")]
    pick = lambda banked: curate.bank_pick(fresh, banked, _archive(), {"books": {}}, today)[0]
    few = [song("s0")] + [book(f"b{i}") for i in range(10)]
    assert pick(few)["kind"] == "book"
    month = [song("s0")] + [book(f"b{i}") for i in range(curate.lyr.ARTIST_COOLDOWN_DAYS)]
    assert pick(month)["kind"] == "music"


def test_a_claimed_work_is_taken_until_released(fake_parse):
    assert bank.claimed("en") == set()
    bank.claim("en", "a.epub")
    bank.claim("en", "b.epub")
    assert bank.claimed("en") == {"a.epub", "b.epub"}
    bank.unclaim("en", "a.epub")
    assert bank.claimed("en") == {"b.epub"}


def test_the_lock_is_re_entrant_within_a_process(fake_parse):
    line, checked = _finished()
    with bank.locked("en"):
        bank.claim("en", "a.epub")  # takes the lock again: must not wait on itself
        bank.append("en", [bank.entry({"file": "a.epub", "kind": "book"}, line, checked)])
        assert bank.works("en") == {"a.epub"}
