"""The bank: a finished line kept as JSON comes back as the run held it, and finishing it
reads it against today's archive; a line set aside is kept with why; the page lists the
lines by kind; `--rebank` reads them again in place, with no judge."""

from datetime import date
import json
from types import SimpleNamespace

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


# A reading as `llm.read_line` returns it (`curate.read`).
_READ = {"about": "a dog asleep by the stove", "stands_alone": True, "why": "", "needs_book": [], "kind": 3,
         "anchor": "stove", "path": "where a dog sleeps warm", "path_words": ["dog"], "wide": False, "ladder": None,
         "mirror": False, "joke_hidden": True, "sibling": "oven"}


def _finished():
    tokens = _tokens(SENTENCE, "en")
    allowed = [t for t in tokens if t.slug in {"old", "dog", "sleeps", "stove", "warm"}]
    line = {"sentence": SENTENCE, "tokens": tokens, "allowed": allowed,
            "given": {"old": 0.3, "dog": 0.5, "sleeps": 0.4, "stove": 0.2, "warm": 0.35}, "pathless": [],
            "read": _READ}
    measures = curate.Measures(readings={"dog": (["cat", "hound"], "cat")}, says={"dog": (0.8, None)},
                               crowds={"dog": 0.1}, neighbours={"dog": ("the old ___", "man")}, out={"old"})
    trio = [t for t in allowed if t.slug in ("dog", "sleeps", "stove")]
    checked = curate.Checked(trio, ["dog first"], 1, {"dog": "notes"},
                             {"dog": "medium", "sleeps": "easy", "stove": "hard"}, measures)
    return line, checked


def _started():
    words = SENTENCE.lower().split()
    holes = [{"pos": i, "secret": {"word": w, "slug": w}, "start": {"word": s, "slug": s}, "start_rank": r}
             for i, (w, s, r) in {2: ("dog", "cat", 120), 3: ("sleeps", "naps", 150), 7: ("stove", "oven", 101)}.items()
             for _ in [0]]
    return {"starts": {"dog": "cat", "sleeps": "naps", "stove": "oven"},
            "draft": {"words": words, "holes": holes, "ranks": {}}}


def _archive(**over):
    return {"sentences": set(), "secrets": set(), "works": [], "pairs": {}, "last_used": {}, "last_music": None,
            **over}


def test_a_banked_line_comes_back_as_the_run_held_it(fake_parse):
    line, checked = _finished()
    book = {"file": "a.epub", "kind": "book", "author": "A", "title": "T"}
    bank.append("en", [bank.entry(book, line, checked, _started(), "en")])
    [stored] = bank.load("en")
    assert json.loads(json.dumps(stored)) == stored
    assert stored["taste"] == bank.taste_stamp() and len(stored["taste"]) == 8
    assert stored["read"] == {"kind": 3, "anchor": "stove", "about": "a dog asleep by the stove",
                              "path": "where a dog sleeps warm", "pathWords": ["dog"], "wide": False, "ladder": None,
                              "sibling": "oven", "needsBook": []}
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


def test_finishing_refuses_a_published_sentence_and_a_word_back_in_its_cooldown(fake_parse):
    line, checked = _finished()
    e = json.loads(json.dumps(bank.entry({"file": "a.epub", "kind": "book"}, line, checked, _started(), "en")))
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
    # a line the read set aside is never finished
    restored, why = bank.restore(bank.reread(e, _READ, "a mirror: « stove »"), _archive(), *args)
    assert restored is None and why == "it was set aside: a mirror: « stove »"


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
        bank.append("en", [bank.entry({"file": "a.epub", "kind": "book"}, line, checked, _started(), "en")])
        assert bank.works("en") == {"a.epub"}


def test_a_claim_dies_with_its_process(fake_parse):
    import subprocess, sys
    gone = subprocess.Popen([sys.executable, "-c", "pass"])
    gone.wait()
    bank.claims_file("en").write_text(f"dead.epub\t{gone.pid}\nlegacy.epub\n", encoding="utf-8")
    bank.claim("en", "mine.epub")
    assert bank.claimed("en") == {"legacy.epub", "mine.epub"}
    bank.unclaim("en", "mine.epub")
    assert bank.claimed("en") == {"legacy.epub"}


def test_a_work_that_banked_nothing_stays_mined_but_holds_no_line(fake_parse):
    line, checked = _finished()
    bank.append("en", [bank.empty({"file": "dry.epub", "kind": "book"}),
                       bank.entry({"file": "a.epub", "kind": "book"}, line, checked, _started(), "en")])
    assert bank.works("en") == {"dry.epub", "a.epub"}
    assert [e["work"] for e in bank.lines("en")] == ["a.epub"]


def test_a_banked_line_keeps_its_starts_and_reads_as_the_player_sees_it(fake_parse):
    line, checked = _finished()
    book = {"file": "a.epub", "kind": "book", "author": "A", "title": "T"}
    e = bank.entry(book, line, checked, _started(), "en")
    assert e["id"] == bank.line_id("a.epub", SENTENCE) and len(e["id"]) == 8
    assert e["starts"] == {"dog": "cat", "sleeps": "naps", "stove": "oven"}
    assert e["marked"] == "the old [dog] [sleeps] under the warm [stove]"
    assert e["shown"] == "the old cat naps under the warm oven"
    assert [(h["secret"], h["start"], h["startRank"], h["level"]) for h in e["holes"]] == \
        [("dog", "cat", 120, "medium"), ("sleeps", "naps", 150, "easy"), ("stove", "oven", 101, "hard")]
    bank.append("en", [e, bank.empty({"file": "dry.epub", "kind": "book"})])
    bank.render("en")
    page = bank.view_file("en").read_text(encoding="utf-8")
    assert f"`{e['id']}`" in page and "the old cat naps under the warm oven" in page
    assert "1 line(s) kept, 0 set aside, 0 not read yet, from 1 work(s)" in page and "dry.epub" not in page


def _aside(sentence="A cat. It sleeps.", why="does not stand alone: which cat?"):
    return bank.aside({"file": "b.epub", "kind": "book", "author": "B", "title": "U"},
                      {"sentence": sentence, "read": {**_READ, "stands_alone": False, "why": "which cat?",
                                                      "anchor": None}, "dropped": why, "given": {}}, "en")


def test_a_line_set_aside_counts_as_mined_but_is_no_line_and_keeps_its_inputs(fake_parse):
    line, checked = _finished()
    kept = bank.entry({"file": "a.epub", "kind": "book"}, line, checked, _started(), "en")
    struck = bank.reread(kept, {**_READ, "mirror": True}, "a mirror: « stove »")
    bank.append("en", [_aside(), struck])
    assert bank.works("en") == {"a.epub", "b.epub"} and bank.lines("en") == []
    assert struck["dropped"] == "a mirror: « stove »" and struck["read"]["anchor"] == "stove"
    assert (struck["given"], struck["measures"], struck["trio"]) == (kept["given"], kept["measures"], kept["trio"])
    # read again and kept: no longer set aside
    assert "dropped" not in bank.reread(struck, _READ, None)


def test_a_work_s_entries_are_replaced_in_place_and_nothing_else_moves(fake_parse):
    line, checked = _finished()
    one = bank.entry({"file": "a.epub", "kind": "book"}, line, checked, _started(), "en")
    two = {**one, "id": "two"}
    bank.append("en", [one, two, bank.empty({"file": "dry.epub", "kind": "book"}), _aside()])
    new = {**one, "id": "new"}
    bank.replace_work("en", "a.epub", [new])
    assert [(e["work"], e.get("id")) for e in bank.load("en")] == \
        [("a.epub", "new"), ("dry.epub", None), ("b.epub", _aside()["id"])]
    assert not bank.bank_file("en").with_name("en.jsonl.tmp").exists()


def test_stale_lines_are_those_never_read_or_read_under_another_taste(fake_parse):
    line, checked = _finished()
    current = bank.entry({"file": "a.epub", "kind": "book"}, line, checked, _started(), "en")
    older = {**current, "id": "older", "taste": "00000000"}
    unread = {k: v for k, v in current.items() if k not in ("taste", "read")} | {"id": "unread"}
    bank.append("en", [current, older, unread, _aside()])   # a line set aside before its words: no rebank
    assert [e["id"] for e in bank.stale("en")] == ["older", "unread"]


def test_the_page_lists_the_lines_by_kind_then_no_kind_then_set_aside_then_unread(fake_parse):
    line, checked = _finished()
    base = bank.entry({"file": "a.epub", "kind": "book", "author": "A", "title": "T"}, line, checked, _started(), "en")
    pairs = {**base, "id": "pairs1", "read": {**base["read"], "kind": 1, "anchor": "warm"}}
    fact = {**base, "id": "fact3"}
    loose = {**base, "id": "nokind", "read": {**base["read"], "kind": None}}
    unread = {k: v for k, v in base.items() if k not in ("taste", "read")} | {"id": "unread"}
    bank.append("en", [loose, fact, unread, _aside(), pairs])
    bank.render("en")
    page = bank.view_file("en").read_text(encoding="utf-8")
    order = [page.index(h) for h in ("## 1. Pairs and molds", "`pairs1`", "## 3. The small fact that proves a big thing",
                                     "`fact3`", "## No kind", "`nokind`", "## Set aside", "## Not read yet", "`unread`")]
    assert order == sorted(order)
    assert "3 line(s) kept, 1 set aside, 1 not read yet, from 2 work(s)" in page
    assert "## 2." not in page                                          # an empty kind is not listed
    fact_rows = page[page.index("`fact3`"):page.index("## No kind")]
    assert "main word « stove »: where a dog sleeps warm (through « dog »)" in fact_rows
    assert "**stove** ← oven" in fact_rows and "FLAG" not in fact_rows
    assert "sibling: « oven » makes the same joke (a warning)" in fact_rows
    pairs_rows = page[page.index("`pairs1`"):page.index("## 3.")]
    assert "FLAG: the trio it was banked with does not hide its main word" in pairs_rows
    assert "does not stand alone: which cat?" in page[page.index("## Set aside"):]
    assert "1 line(s) were never read, or were read under another taste" in page


def test_a_rebank_reads_the_stored_giveaways_and_never_asks_the_judge(fake_parse, monkeypatch, tmp_path):
    import contextual_rank
    monkeypatch.setattr(contextual_rank, "giveaway", lambda *_a, **_k: pytest.fail("the rebank never asks the judge"))
    monkeypatch.setattr(curate, "parse", _tokens)
    monkeypatch.setattr(_paths, "RUNS_DIR", tmp_path / "runs")
    shown = []
    verdicts = {SENTENCE: _READ, "The cold dog sleeps under the warm stove": {**_READ, "mirror": True}}
    monkeypatch.setattr(curate.llm, "read_line", lambda _c, sentence, hideable, refused, lang:
                        shown.append(hideable) or verdicts[sentence])
    line, checked = _finished()
    kept = {k: v for k, v in bank.entry({"file": "a.epub", "kind": "book"}, line, checked, _started(), "en").items()
            if k not in ("taste", "read")}
    kept["given"] = {"old": 0.3, "dog": 0.5, "warm": 0.35, "stove": 0.2}   # « sleeps » never judged: never offered
    mirror = {**kept, "id": "m", "sentence": "The cold dog sleeps under the warm stove"}
    published = {**kept, "id": "p", "sentence": "The young dog sleeps under the warm stove"}
    done = {**bank.entry({"file": "a.epub", "kind": "book"}, line, checked, _started(), "en"), "id": "d"}
    bank.append("en", [kept, mirror, published, done, _aside()])
    args = SimpleNamespace(lang="en", work=None)
    archive = _archive(secrets={"old"}, sentences={bank.shelf_mod.sentence_key(published["sentence"])})
    assert curate.rebank_works(object(), curate.Log("rebank"), args, archive, lambda s: True) == 0
    assert shown == [["dog", "warm", "stove"]] * 2                   # « old » cooling, « sleeps » unjudged
    after = {e.get("id"): e for e in bank.load("en")}
    assert [e.get("id") for e in bank.load("en")] == [kept["id"], "m", "p", "d", _aside()["id"]]
    assert after[kept["id"]]["read"]["anchor"] == "stove" and "dropped" not in after[kept["id"]]
    assert after["m"]["dropped"].startswith("a mirror")
    assert after["m"]["measures"] == json.loads(json.dumps(kept["measures"]))   # kept for a later rebank
    assert after["p"]["dropped"] == "the sentence was published"
    assert after["d"] == json.loads(json.dumps(done))                # read under today's taste: untouched
    assert bank.stale("en") == [] and bank.claimed("en") == set()
    # resumable: nothing left to read
    assert curate.rebank_works(object(), curate.Log("rebank2"), args, archive, lambda s: True) == 2
    assert len(shown) == 2
